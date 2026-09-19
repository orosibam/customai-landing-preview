import { askJson } from '../../lib/llm.js';
import { detectFormalEndings, splitIntoLines } from '../../lib/korean.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 카피라이터.
 *
 * 설계도의 골격은 손대지 않고 말만 새로 쓴다. 검증된 구조를 지키는 게 이 자리의 전부다.
 *
 * 화법은 타겟에 따라 완전히 갈린다. 시니어 대상이면 자기 경험을 섞은 스토리텔링이
 * 잘 먹히고, 한 문장에 정보를 하나만 담아야 따라온다. 일반 대상이면 정반대로
 * 첫 1.5초에 결론을 던지고 정보 밀도를 높게 가져간다.
 */

const BASE_CHARTER = `너는 한국 쇼핑 숏폼의 카피라이터다.

무슨 일이 있어도 지키는 것:
1. 구어체만 쓴다. "~해요 / ~거든요 / ~더라고요 / ~죠" 로 끝낸다.
   "~합니다 / ~입니다 / ~습니다" 는 쓰지 않는다. 광고 낭독처럼 들린다.
2. 설계도의 컷 구성과 설득 순서를 그대로 따른다. 네가 바꿀 것은 문장뿐이다.
3. 숫자와 단위는 아라비아 숫자로 쓴다. 발음 변환은 뒷공정이 한다.
4. 검증되지 않은 효능을 단언하지 않는다. "무조건", "100% 효과", "최저가" 같은
   단정은 쓰지 않는다. 광고 심의에 걸린다.
5. 원본의 문장을 베끼지 않는다. 너에게 넘어온 건 말의 흐름이지 대본이 아니다.`;

interface ScriptResponse {
  lines: { text: string; cut_index: number }[];
  cta: string;
  hook_rationale: string;
}

export const writer: TeamMember = {
  id: 'writer',
  role: '카피라이터',
  expertise: '설계도 구조를 지키면서 타겟에 맞는 한국어 화법으로 각색한다',
  charter: BASE_CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const { blueprint, product, audience } = brief;
    if (!blueprint || !product) throw new HandoffError('writer', '설계도나 상품이 넘어오지 않았습니다.');

    // 분석가가 남긴 흐름 메모를 그대로 재료로 쓴다.
    const flowNote = brief.notes.find((n) => n.from === 'analyst')?.message ?? '';

    const charter = `${BASE_CHARTER}

이번 건의 타겟은 **${audience.label}** 이다.
${audience.toneGuidance}

한 문장은 ${audience.sentenceChars.min}~${audience.sentenceChars.max}자로 쓴다.`;

    const prompt = `설계도에 맞춰 한국어 나레이션을 써라.

상품: ${product.titleKo}
가격: ${product.priceKrw ? `${product.priceKrw.toLocaleString()}원` : '미정'}
이 상품을 고른 이유: ${product.rationale}

설계도:
- 훅 유형: ${blueprint.hookType}
- 설득 순서: ${blueprint.appealOrder.join(' → ')}
- 컷 구성:
${JSON.stringify(
  blueprint.cuts.map((c, i) => ({
    cut_index: i,
    purpose: c.purpose,
    shot: c.shot,
    duration_sec: Number((c.t[1] - c.t[0]).toFixed(1)),
  })),
  null,
  2,
)}

분석가 메모: ${flowNote}

각 컷에 올라갈 문장을 쓴다. 컷 길이에 맞춰 — ${audience.minCutSec}초 컷에 한두 문장.
purpose 가 hook 인 컷의 문장이 "${blueprint.hookType}" 방식으로 시선을 잡아야 한다.

{"lines":[{"text":"","cut_index":0}],"cta":"","hook_rationale":"훅을 이렇게 쓴 이유 한 문장"}`;

    let parsed: ScriptResponse | null = null;

    // 문어체가 섞이면 다시 시킨다. 정규식으로 어미를 고치면 비문이 나온다.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const candidate = await askJson<ScriptResponse>(prompt, {
        tier: 'reasoning',
        system: charter,
        maxTokens: 2000,
      });
      const formal = candidate.lines.flatMap((l) => detectFormalEndings(l.text));
      if (formal.length === 0) {
        parsed = candidate;
        break;
      }
      console.warn(`카피라이터 시도 ${attempt}: 문어체(${formal.join(', ')}) → 재작성`);
    }

    if (!parsed) throw new HandoffError('writer', '3회 연속 문어체로 나왔습니다.', true);

    // 긴 문장은 한 번 더 쪼갠다. 타입캐스트는 문장이 길수록 억양이 무너진다.
    const lines: { idx: number; text: string; cutIndex: number }[] = [];
    for (const line of parsed.lines) {
      for (const chunk of splitIntoLines(line.text, audience.sentenceChars.min, audience.sentenceChars.max)) {
        lines.push({ idx: lines.length, text: chunk, cutIndex: line.cut_index });
      }
    }
    for (const chunk of splitIntoLines(parsed.cta, audience.sentenceChars.min, audience.sentenceChars.max)) {
      lines.push({ idx: lines.length, text: chunk, cutIndex: blueprint.cuts.length - 1 });
    }

    const row = await must(
      '대본 저장',
      db()
        .from('scripts')
        .insert({
          blueprint_id: blueprint.id,
          product_id: product.id,
          lines,
          cta: parsed.cta,
        })
        .select('id')
        .single(),
    );

    return withNote(
      { ...brief, script: { id: (row as { id: string }).id, lines, cta: parsed.cta } },
      'writer',
      `${lines.length}문장. 훅: "${lines[0]?.text ?? ''}" — ${parsed.hook_rationale}`,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const script = brief.script;
    if (!script) return fail('대본이 비어 있습니다.');
    if (script.lines.length === 0) return fail('문장이 하나도 없습니다.');

    const problems: string[] = [];
    const warnings: string[] = [];

    const formal = script.lines.flatMap((l) => detectFormalEndings(l.text));
    if (formal.length > 0) problems.push(`문어체 어미가 남아 있습니다: ${formal.join(', ')}`);

    const { max } = brief.audience.sentenceChars;
    const tooLong = script.lines.filter((l) => l.text.length > max + 6);
    if (tooLong.length > 0) {
      warnings.push(`${tooLong.length}문장이 ${max}자를 크게 넘습니다. 억양이 무너질 수 있습니다.`);
    }

    // 훅이 첫 문장이다. 여기가 약하면 나머지는 아무도 안 본다.
    const hook = script.lines[0]?.text ?? '';
    if (hook.length < 6) problems.push('첫 문장이 너무 짧아 훅 역할을 못 합니다.');

    const banned = ['무조건', '100%', '최저가', '완치', '부작용 없'];
    const hits = banned.filter((b) => script.lines.some((l) => l.text.includes(b)));
    if (hits.length > 0) {
      problems.push(`심의에 걸릴 표현이 있습니다: ${hits.join(', ')}`);
    }

    return { ok: problems.length === 0, problems, warnings };
  },
};
