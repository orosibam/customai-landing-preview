import { askJson } from '../../lib/llm.js';
import { detectFormalEndings, estimateDurationSec, splitIntoLines } from '../../lib/korean.js';
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

/**
 * 나레이션 목표 길이(초).
 *
 * 검수는 55초에서 떨어뜨린다. 목표를 그 턱에 두면 추정 오차 몇 초에 매번 걸리므로
 * 여유를 두고 잡는다. 원본 방법론도 30~55초 구간을 쓴다.
 */
const TARGET_SEC = 42;

/** korean.ts 의 estimateDurationSec 과 같은 값이어야 한다. 다르면 한쪽이 통과시킨 걸 다른 쪽이 떨어뜨린다. */
const SYLLABLES_PER_SEC = 6.2;

/** 문장이 너무 많으면 컷당 체류가 짧아져 무슨 말인지 안 들린다. */
const MAX_LINES = 10;

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

    // 길이 예산.
    //
    // 24차 제작이 여기서 걸렸다 — 나레이션이 74.4초로 나왔고 쇼츠 상한(55초)을
    // 넘겼다. 컷이 10개였고 "컷 길이에 맞춰 한두 문장" 이라고만 적어 보냈더니
    // 16문장이 나왔다. **총량을 아무도 안 보고 있었다.**
    //
    // 초당 음절 수는 korean.ts 의 추정식과 같은 값을 쓴다. 두 곳이 다른 수를
    // 쓰면 한쪽이 통과시킨 걸 다른 쪽이 떨어뜨린다.
    const charBudget = Math.floor(TARGET_SEC * SYLLABLES_PER_SEC);
    const maxLines = Math.max(4, Math.min(blueprint.cuts.length, MAX_LINES));

    const prompt = `설계도에 맞춰 한국어 나레이션을 써라.

상품: ${product.titleKo}
가격: ${product.priceKrw ? `${product.priceKrw.toLocaleString()}원` : '미정'}
이 상품을 고른 이유: ${product.rationale}

설계도:
- 훅 유형: ${blueprint.hookType}
- 소구 포인트 (원본이 주장한 것과 그걸 증명한 방식):
${blueprint.appeals.map((a, i) => `  ${i + 1}. ${a.point}  ← 화면: ${a.shown_as}`).join('\n')}
  · 이 주장들을 **같은 순서로** 다시 해라. 주장 자체는 그 상품의 사실이므로 가져온다.
  · 다만 문장은 새로 쓴다. 원본 대사를 번역하는 게 아니라 한국어로 다시 말하는 것이다.
- 컷 구성:
${JSON.stringify(
  blueprint.cuts.map((c, i) => ({
    cut_index: i,
    purpose: c.purpose,
    shot: c.shot,
    action: c.action,
    duration_sec: Number((c.t[1] - c.t[0]).toFixed(1)),
  })),
  null,
  2,
)}

분석가 메모: ${flowNote}

각 컷에 올라갈 문장을 쓴다.

## 첫 문장 (여기서 승부가 끝난다)

purpose 가 hook 인 컷의 문장이 "${blueprint.hookType}" 방식으로 시선을 잡아야 한다.

**제품명으로 시작하지 마라.** 홈스토리(쇼핑쇼츠로 실제로 버는 채널) 상위 영상을
계측했더니 **제목이 제품명으로 시작하는 게 한 건도 없었다.** 전부 이 넷 중 하나로 연다:

  · 관계 — 누구 때문에 알게 됐는지로 연다 ("시누이가 쓰길래", "남편한테 사줬더니")
  · 정보격차 — 나만 몰랐다는 자리에 시청자를 놓는다 ("대부분 모르는", "나만 몰랐던")
  · 서사중단 — 말을 하다 끊는다 ("이거 쓰고 나서는..")
  · 개인경험 — 내가 겪은 일로 연다 ("3년 쓰던 거 버렸어요")

제품 설명은 훅이 아니다. "무선 고압 세척기입니다" 로 시작하면 아무도 안 본다.
시청자가 **자기 얘기라고 느끼는 순간**이 있어야 다음 컷까지 간다.

## 길이 예산 (제일 중요)

읽었을 때 **전부 합쳐 ${TARGET_SEC}초 안에 끝나야 한다.** 한국어는 초당 약 6음절이라
**한글 ${charBudget}자가 상한**이다. CTA 까지 포함한 수치다.

- 문장은 최대 ${maxLines}개. 컷이 ${blueprint.cuts.length}개라고 컷마다 두 문장씩
  쓰면 예산을 훌쩍 넘는다. **컷 하나에 문장 하나가 기본이고**, 짧은 컷은 문장 없이
  화면만 가도 된다.
- 넘칠 것 같으면 설명을 버려라. 쇼츠에서 잘리는 건 언제나 설명이지 훅이 아니다.

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
    const ctaStart = lines.length;
    for (const chunk of splitIntoLines(parsed.cta, audience.sentenceChars.min, audience.sentenceChars.max)) {
      lines.push({ idx: lines.length, text: chunk, cutIndex: blueprint.cuts.length - 1 });
    }

    // 예산을 넘으면 **여기서 자른다.**
    //
    // 프롬프트로 부탁만 해두면 언젠가 또 넘친다(24차가 74.4초였다). 넘친 걸
    // 성우까지 들고 가면 합성 비용을 다 쓰고 검수에서 떨어진다.
    //
    // 무엇을 버리는가: 훅(첫 문장)과 CTA(마지막 묶음)는 남기고 **가운데에서
    // 제일 긴 문장**부터 버린다. 쇼츠에서 잘리는 건 언제나 설명이지 훅이 아니고,
    // CTA 가 없으면 링크를 눌러야 할 이유가 사라져 영상 자체가 무의미해진다.
    const budget = () => lines.reduce((sum, l) => sum + estimateDurationSec(l.text), 0);
    const dropped: string[] = [];

    while (budget() > TARGET_SEC && lines.length - (lines.length - ctaStart) > 2) {
      const middle = lines.slice(1, ctaStart);
      if (middle.length === 0) break;
      const longest = middle.reduce((a, b) =>
        estimateDurationSec(b.text) > estimateDurationSec(a.text) ? b : a,
      );
      const at = lines.indexOf(longest);
      if (at < 0) break;
      dropped.push(lines[at]!.text);
      lines.splice(at, 1);
      lines.forEach((l, i) => (l.idx = i));
    }

    if (dropped.length > 0) {
      console.warn(
        `대본이 예산(${TARGET_SEC}초)을 넘어 ${dropped.length}문장을 잘랐습니다. ` +
          `남은 추정 ${budget().toFixed(1)}초.\n` +
          dropped.map((t) => `   버림: "${t}"`).join('\n'),
      );
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

    // 제품명으로 여는 훅은 실측으로 틀린 게 확인됐다.
    //
    // 홈스토리 상위 영상을 계측했더니 제목이 제품명으로 시작하는 게 한 건도 없었다.
    // 프롬프트로 적어 보내도 LLM 은 설명형으로 돌아가는 버릇이 있어서, 여기서 한 번 더 본다.
    // 경고로만 둔다 — 상품명 단어가 훅 안에 자연스럽게 섞이는 경우도 있어서
    // 기계적으로 떨어뜨리면 멀쩡한 훅까지 버린다.
    const productWords = (brief.product?.titleKo ?? '')
      .replace(/[()]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (productWords.some((w) => hook.startsWith(w))) {
      warnings.push(
        `훅이 제품명("${hook.slice(0, 14)}…")으로 시작합니다. ` +
          `홈스토리 상위 영상은 관계·정보격차·서사중단·개인경험 중 하나로 엽니다.`,
      );
    }

    const banned = ['무조건', '100%', '최저가', '완치', '부작용 없'];
    const hits = banned.filter((b) => script.lines.some((l) => l.text.includes(b)));
    if (hits.length > 0) {
      problems.push(`심의에 걸릴 표현이 있습니다: ${hits.join(', ')}`);
    }

    return { ok: problems.length === 0, problems, warnings };
  },
};
