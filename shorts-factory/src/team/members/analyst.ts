import { askJson } from '../../lib/llm.js';
import { captureReelFrames } from '../../lib/scrapers/instagram-discovery.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 구조 분석가.
 *
 * 터진 원본에서 **골격만** 뜯어낸다. 대사도 화면도 가져오지 않는다.
 * 훅이 어떤 형태였는지, 컷이 몇 개였는지, 어떤 순서로 설득했는지 — 그 배치만
 * 다음 담당자에게 넘긴다.
 *
 * 컷 개수와 길이는 타겟에 따라 다르게 잡는다. 시니어 대상이면 컷을 적게 쓰고
 * 하나를 오래 물고 있는 쪽이 오히려 끝까지 본다.
 */

const CHARTER = `너는 숏폼 광고를 분해해 **다시 만들 수 있는 설계도**로 바꾸는 분석가다.

## 얼마나 자세히 베끼는가

골격만 적으면 재현이 안 된다. "제품 등장" 같은 말로는 편집자가 어떤 소재를 써야 할지
고를 수 없고, 결국 전혀 다른 영상이 나온다. **동작 단위로 적는다.**

  ✗ 너무 성김: "제품 등장, 손 개입"
  ✓ 재현 가능: "한 손으로 지퍼를 끝까지 당겨 연다"

  ✗ 너무 성김: "사용 전후 비교"
  ✓ 재현 가능: "얼룩진 면을 화면 왼쪽에, 닦아낸 면을 오른쪽에 붙여 보여준다"

편집자는 이 문장을 들고 같은 동작이 찍힌 소재를 찾는다. 그러니 **무엇이 어떻게
움직이는지**가 적혀 있어야 한다. 카메라 움직임·화면 분할·손의 개입 여부까지 적는다.

## 그래도 가져오지 않는 것 — 선은 여기다

  · 원본 영상의 화면(픽셀) — 우리는 다른 소재로 같은 동작을 다시 찍은 걸 쓴다
  · 대사·자막 문구를 그대로 옮기기 — 흐름만 적고 문장은 카피라이터가 새로 쓴다
  · 등장 인물의 외모·옷차림, 특정 배경, 브랜드명, 화면에 뜬 로고나 문구

즉 **"무엇을 어떤 순서로 어떻게 보여주는가"는 최대한 자세히, "그 화면 자체와 그 말
자체"는 하나도** 가져오지 않는다. 같은 동작을 다른 소재로 다시 구성하는 것이다.

## 소구 포인트

"가격" 같은 이름표만 남기지 마라. **무엇을 주장했고 그걸 화면으로 어떻게 증명했는지**를
같이 적는다. 카피라이터가 그 주장을 한국어로 다시 쓰고, 편집자가 그 증명 장면을
소재에서 찾는다. 주장 자체는 그 상품의 사실이므로 가져와도 된다 — 베끼면 안 되는 건
그 주장을 표현한 문장이다.`;

interface BlueprintResponse {
  hook_type: string;
  hook_duration_sec: number;
  cuts: {
    t: [number, number];
    /** 화면 유형 (거시적 분류) */
    shot: string;
    /** 프레임 안에서 실제로 일어나는 동작. 편집자가 이걸로 소재를 고른다. */
    action: string;
    /** 카메라·화면 구성 (고정 / 천천히 줌인 / 좌우 분할 / 위에서 내려다봄 …) */
    framing: string;
    purpose: string;
  }[];
  /** 무엇을 주장했고 화면으로 어떻게 증명했는가 */
  appeals: { point: string; shown_as: string }[];
  narrative_flow: string;
  climax_at_sec: number | null;
  cta_position: string;
}

export const analyst: TeamMember = {
  id: 'analyst',
  role: '구조 분석가',
  expertise: '터진 영상에서 훅 유형과 컷 배치, 설득 순서를 뽑아낸다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const reference = brief.reference;
    if (!reference) throw new HandoffError('analyst', '레퍼런스가 넘어오지 않았습니다.');

    let frameFailure = '';
    let capturedCaption = '';
    const images = await sampleFrames(reference.url)
      .then((r) => {
        capturedCaption = r.caption;
        return r.images;
      })
      .catch((e) => {
        frameFailure = (e as Error).message;
        console.warn(`릴스 화면 캡처 실패: ${frameFailure}`);
        return [] as { base64: string; mediaType: 'image/jpeg' }[];
      });

    // 프레임도 없고 캡션도 없으면 **원본에서 읽은 게 하나도 없다.**
    //
    // 그런데도 설계도는 나온다 — LLM 이 상품명만 보고 그럴듯하게 지어내기 때문이다.
    // 그러면 "해외에서 터진 구조를 베낀다" 는 이 시스템의 전제가 조용히 사라진 채로
    // 영상이 계속 나가고, 나중에 성과를 볼 때 "이 설계도가 먹혔다" 는 판단이
    // 통째로 거짓이 된다.
    //
    // 멈추지는 않는다(영상 자체는 만들 수 있다). 대신 크게 적어 승인 화면까지
    // 올려보낸다. 사람이 보고 판단할 몫이다.
    // 프레임이 없으면 **만들지 않는다.**
    //
    // 예전에는 경고만 남기고 진행했다. 그러면 LLM 이 상품명만 보고 설계도를
    // 지어내고, 영상은 멀쩡히 나온다 — "해외에서 터진 구조를 베낀다" 는 이
    // 시스템의 전제가 통째로 사라진 채로. 그건 평범한 창작 대본 생성기이고,
    // 그 차이가 이 프로젝트의 존재 이유다.
    //
    // 그래서 멈춘다. retryable 이라 소싱 담당이 다른 릴스로 다시 간다.
    if (images.length === 0) {
      throw new HandoffError(
        'analyst',
        `원본 릴스에서 화면을 한 장도 못 읽었습니다 — 설계도를 만들지 않습니다.\n` +
          `   ${frameFailure || '(캡처를 시도하지 않았습니다)'}\n` +
          `   릴스: ${reference.url}\n` +
          `   여기서 그냥 진행하면 상품명만 보고 지어낸 구조가 나옵니다. ` +
          `이 파이프라인은 "이미 터진 구조를 베끼는 것" 이 전제라, 그걸 잃으면 만들 이유가 없습니다.`,
        true,
      );
    }

    // 캡션은 캡처할 때 같이 주워온 걸 우선한다 — 수집 시점의 DB 값보다 최신이다.
    const caption = capturedCaption.trim() || reference.caption?.trim() || '';

    const { audience } = brief;

    const parsed = await askJson<BlueprintResponse>(
      `이 숏폼의 구조를 분해해라.

원본 조회수: ${(reference.views ?? 0).toLocaleString()}회
캡션: ${caption || '(없음)'}
상품: ${brief.product?.titleKo ?? '-'}
${images.length > 0 ? `첨부 ${images.length}장은 영상에서 시간순으로 뽑은 프레임이다.` : ''}

이 설계도로 만들 우리 영상의 타겟은 **${audience.label}** 이다.
- 컷 개수는 ${audience.cutCount.min}~${audience.cutCount.max}개로 잡는다.
- 컷 하나는 최소 ${audience.minCutSec}초는 유지한다. 그보다 짧으면 못 따라온다.
- 전체 길이 25~45초.

다음을 JSON으로:
- hook_type: problem_shock / result_first / curiosity_gap / satisfying_motion /
  price_reveal / comparison 중 하나, 또는 비슷한 형태를 새로 명명
- hook_duration_sec: 훅 구간 길이
- cuts: [{t:[시작,끝], shot:"화면 유형", action:"프레임 안에서 일어나는 동작",
    framing:"카메라·화면 구성", purpose:"hook|problem|solution_reveal|proof|benefit|price|cta"}]
  · action 은 편집자가 같은 동작의 소재를 찾는 데 쓴다. 동작 단위로 구체적으로.
    예: "한 손으로 지퍼를 끝까지 당겨 연다", "천으로 표면을 세 번 문지른다"
  · 인물 외모·옷·배경·브랜드는 적지 않는다. 움직임만 적는다.
- appeals: [{point:"무엇을 주장했는가", shown_as:"그걸 화면으로 어떻게 증명했는가"}]
  · 순서대로. 예: {point:"물이 스며들지 않는다", shown_as:"물을 붓고 3초 뒤 털어낸다"}
- narrative_flow: 말이 어떤 순서로 설득했는지 2~3문장 요약.
  문장을 그대로 옮기지 말고 흐름만 적는다. (예: "자기 경험으로 문제 제기 → 제품 등장 →
  사용 과정 묘사 → 결과 감탄 → 같은 취향 사람 지목")
- climax_at_sec: 임팩트가 가장 큰 지점. 모르면 null.
- cta_position: "end" / "mid" / "both"

{"hook_type":"","hook_duration_sec":0,"cuts":[],"appeals":[],"narrative_flow":"","climax_at_sec":null,"cta_position":"end"}`,
      { tier: 'reasoning', system: CHARTER, images, maxTokens: 3000 },
    );

    const cuts = parsed.cuts ?? [];
    if (cuts.length < audience.cutCount.min) {
      throw new HandoffError(
        'analyst',
        `컷이 ${cuts.length}개뿐입니다 (${brief.audience.label} 최소 ${audience.cutCount.min}개).`,
        true,
      );
    }

    const row = await must(
      '설계도 저장',
      db()
        .from('blueprints')
        .insert({
          reference_id: reference.id,
          hook_type: parsed.hook_type,
          hook_duration_sec: parsed.hook_duration_sec,
          cuts,
          // 컬럼이 appeal_order 였는데 담기는 건 순서가 아니라 주장·증명 쌍이다.
          // 0007 에서 이름을 내용에 맞췄다.
          appeals: parsed.appeals ?? [],
          narrative_flow: parsed.narrative_flow ?? null,
          climax_at_sec: parsed.climax_at_sec,
          cta_position: parsed.cta_position,
        })
        .select('id')
        .single(),
    );

    await db().from('references').update({ used_at: new Date().toISOString() }).eq('id', reference.id);

    return withNote(
      {
        ...brief,
        blueprint: {
          id: (row as { id: string }).id,
          hookType: parsed.hook_type,
          cuts,
          appeals: parsed.appeals,
        },
      },
      'analyst',
      `${parsed.hook_type} 훅 / 컷 ${cuts.length}개 / ` +
      `소구 [${(parsed.appeals ?? []).map((a) => a.point).join(' → ')}]. ` +
        `흐름: ${parsed.narrative_flow}`,
      images.length < 4
        ? `원본 릴스에서 ${images.length}장만 읽었습니다. 컷 전환을 다 못 봤을 수 있습니다.`
        : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const bp = brief.blueprint;
    if (!bp) return fail('설계도가 비어 있습니다.');

    const { cutCount, minCutSec } = brief.audience;
    const problems: string[] = [];
    const warnings: string[] = [];

    if (bp.cuts.length < cutCount.min) {
      problems.push(`컷 ${bp.cuts.length}개는 ${brief.audience.label} 최소 ${cutCount.min}개 미만입니다.`);
    }
    if (bp.cuts.length > cutCount.max) {
      warnings.push(`컷 ${bp.cuts.length}개는 ${brief.audience.label}에게 다소 많습니다.`);
    }

    const tooShort = bp.cuts.filter((c) => c.t[1] - c.t[0] < minCutSec);
    if (tooShort.length > 0) {
      warnings.push(`${tooShort.length}개 컷이 ${minCutSec}초보다 짧습니다. 편집자가 늘려야 합니다.`);
    }

    const hasHook = bp.cuts.some((c) => c.purpose === 'hook');
    if (!hasHook) problems.push('훅 컷이 지정되지 않았습니다.');

    return { ok: problems.length === 0, problems, warnings };
  },
};

/**
 * 릴스에서 프레임을 얻는다 — **화면을 찍는다.**
 *
 * 예전엔 영상 파일을 받아 ffmpeg 으로 프레임을 떴다. 인스타가 영상을 조각으로
 * 쪼개 보내기 때문에 그 방식은 계속 "Invalid data found" 로 실패했고, 그때마다
 * 설계도가 상품명만 보고 지어내졌다. 우리는 원본 픽셀을 한 프레임도 쓰지 않으므로
 * 파일이 필요 없다 — 브라우저가 그려낸 화면을 찍으면 된다.
 */
async function sampleFrames(
  reelUrl: string,
): Promise<{ images: { base64: string; mediaType: 'image/jpeg' }[]; caption: string }> {
  const { frames, caption } = await captureReelFrames(reelUrl, 8);
  return {
    images: frames.map((b) => ({
      base64: b.toString('base64'),
      mediaType: 'image/jpeg' as const,
    })),
    caption,
  };
}
