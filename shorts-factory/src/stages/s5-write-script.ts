import { askJson } from '../lib/llm.js';
import { detectFormalEndings, splitIntoLines } from '../lib/korean.js';
import { db, must } from '../lib/supabase.js';
import type { Slot } from './s1-pick-products.js';
import type { Blueprint } from './s3-extract-blueprint.js';

/**
 * S5 — 한국어 대본
 *
 * 설계도의 구조는 절대 건드리지 않고 문장만 새로 쓴다. 검증된 골격을 지키는 게
 * 이 단계의 전부다. 훅 유형이 problem_shock 이면 한국어 문장도 문제 상황으로
 * 시작해야 하고, 소구 순서가 [불편함 → 즉시해결 → 가격] 이면 그 순서를 지켜야 한다.
 *
 * 동시에 타입캐스트가 자연스럽게 읽을 수 있는 형태로 나와야 한다 —
 * 구어체 어미, 짧은 문장. 문어체가 섞이면 S6가 거부하고 재생성을 요구한다.
 */

export interface ScriptLine {
  idx: number;
  /** 화면 자막 + 나레이션 원문 */
  text: string;
  /** 이 문장이 어느 컷 위에 올라가는지 */
  cutIndex: number;
}

export interface Script {
  id: string;
  lines: ScriptLine[];
  cta: string;
}

const SYSTEM = `너는 한국 쇼핑 쇼츠의 나레이션을 쓴다.

지켜야 할 것:
1. 구어체만 쓴다. "~해요 / ~거든요 / ~더라고요 / ~죠" 로 끝낸다.
   "~합니다 / ~입니다 / ~습니다" 는 절대 쓰지 않는다. 광고 낭독처럼 들린다.
2. 한 문장은 12~18자. 길면 AI 성우의 억양이 무너진다.
3. 첫 문장이 전부다. 1.5초 안에 스크롤을 멈추게 해야 한다.
4. 숫자와 단위는 아라비아 숫자로 그대로 쓴다 (발음 변환은 후처리가 한다).
5. 과장하지 않는다. "무조건", "100% 효과", "최저가" 같은 단정은 쓰지 않는다.
   검증되지 않은 효능을 단언하면 광고 심의에 걸린다.`;

interface ScriptResponse {
  lines: { text: string; cut_index: number }[];
  cta: string;
}

export async function writeScript(
  slot: Slot,
  blueprint: Blueprint,
): Promise<Script> {
  const cutSummary = blueprint.cuts.map((c, i) => ({
    cut_index: i,
    purpose: c.purpose,
    shot: c.shot,
    duration_sec: Number((c.t[1] - c.t[0]).toFixed(1)),
  }));

  const prompt = `아래 설계도에 맞춰 한국어 나레이션을 써라.

상품: ${slot.product.title_ko}
가격: ${slot.product.price_krw ? `${slot.product.price_krw.toLocaleString()}원` : '미정'}
채널 카테고리: ${slot.channel.category}
이 상품을 고른 이유: ${slot.product.score_reason ?? '-'}

설계도 (이 구조를 그대로 따른다):
- 훅 유형: ${blueprint.hookType}
- 훅 길이: ${blueprint.hookDurationSec}초
- 소구 순서: ${blueprint.appealOrder.join(' → ')}
- CTA 위치: ${blueprint.ctaPosition}
- 컷 구성:
${JSON.stringify(cutSummary, null, 2)}

각 컷에 올라갈 문장을 쓴다. 컷 길이에 맞게 — 3초 컷에는 한 문장, 5초 컷에는 두 문장까지.
purpose 가 hook 인 컷의 문장이 "${blueprint.hookType}" 방식으로 시선을 잡아야 한다.
cta 는 마지막에 붙일 행동 유도 한 문장.

{"lines":[{"text":"...","cut_index":0}],"cta":"..."}`;

  let parsed: ScriptResponse | null = null;

  // 문어체가 섞이면 한 번 더 시킨다. 정규식으로 고치면 비문이 되므로 다시 쓰게 한다.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = await askJson<ScriptResponse>(prompt, {
      tier: 'reasoning',
      system: SYSTEM,
      maxTokens: 2000,
    });

    const formal = candidate.lines.flatMap((l) => detectFormalEndings(l.text));
    if (formal.length === 0) {
      parsed = candidate;
      break;
    }
    console.warn(`S5 시도 ${attempt}: 문어체 어미 발견 (${formal.join(', ')}) → 재생성`);
  }

  if (!parsed) {
    throw new Error('대본이 3회 연속 문어체로 나왔습니다. SYSTEM 프롬프트를 점검하세요.');
  }

  // 모델이 긴 문장을 내놓는 경우가 있어 한 번 더 쪼갠다.
  const lines: ScriptLine[] = [];
  for (const line of parsed.lines) {
    for (const chunk of splitIntoLines(line.text)) {
      lines.push({ idx: lines.length, text: chunk, cutIndex: line.cut_index });
    }
  }
  for (const chunk of splitIntoLines(parsed.cta)) {
    lines.push({ idx: lines.length, text: chunk, cutIndex: blueprint.cuts.length - 1 });
  }

  const row = await must(
    '대본 저장',
    db()
      .from('scripts')
      .insert({
        blueprint_id: blueprint.id,
        product_id: slot.product.id,
        lines,
        cta: parsed.cta,
      })
      .select('id')
      .single(),
  );

  console.log(`S5: 대본 ${lines.length}문장 — "${lines[0]?.text ?? ''}"`);
  return { id: (row as { id: string }).id, lines, cta: parsed.cta };
}
