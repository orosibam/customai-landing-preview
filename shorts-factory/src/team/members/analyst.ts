import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askJson } from '../../lib/llm.js';
import { extractFrames } from '../../lib/ffmpeg.js';
import { downloadTikTokVideo } from '../../lib/scrapers/tiktok-discovery.js';
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

const CHARTER = `너는 숏폼 광고의 구조를 분해하는 분석가다.

**구조만** 뽑는다. 대사, 자막 문구, 등장 인물, 브랜드명, 구체적인 영상 내용은
기록하지 않는다. 우리가 재현할 것은 "어떤 순서로 무엇을 보여주는가" 라는 골격이지
그 영상 자체가 아니다.

shot 필드는 화면 유형을 일반적인 말로 적는다.
  좋은 예: "문제 상황 클로즈업", "제품 등장, 손 개입", "사용 전후 비교", "질감 매크로샷"
  나쁜 예: 특정 인물 묘사, 특정 배경 묘사, 화면에 뜬 문구를 그대로 옮기기

대사를 받아적을 때는 예외다. 카피라이터가 말의 **구조**(어떤 순서로 설득했는지)를
참고해야 하므로 흐름을 요약해 넘기되, 문장을 그대로 베껴 쓰지는 않는다.`;

interface BlueprintResponse {
  hook_type: string;
  hook_duration_sec: number;
  cuts: { t: [number, number]; shot: string; purpose: string }[];
  appeal_order: string[];
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

    const images = await sampleFrames(reference.url).catch((e) => {
      console.warn(`프레임 추출 실패, 캡션만으로 진행: ${(e as Error).message}`);
      return [] as { base64: string; mediaType: 'image/jpeg' }[];
    });

    const { audience } = brief;

    const parsed = await askJson<BlueprintResponse>(
      `이 숏폼의 구조를 분해해라.

원본 조회수: ${(reference.views ?? 0).toLocaleString()}회
캡션: ${reference.caption || '(없음)'}
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
- cuts: [{t:[시작,끝], shot:"화면 유형", purpose:"hook|problem|solution_reveal|proof|benefit|price|cta"}]
- appeal_order: 소구 포인트 순서 (한국어 명사구 배열)
- narrative_flow: 말이 어떤 순서로 설득했는지 2~3문장 요약.
  문장을 그대로 옮기지 말고 흐름만 적는다. (예: "자기 경험으로 문제 제기 → 제품 등장 →
  사용 과정 묘사 → 결과 감탄 → 같은 취향 사람 지목")
- climax_at_sec: 임팩트가 가장 큰 지점. 모르면 null.
- cta_position: "end" / "mid" / "both"

{"hook_type":"","hook_duration_sec":0,"cuts":[],"appeal_order":[],"narrative_flow":"","climax_at_sec":null,"cta_position":"end"}`,
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
          appeal_order: parsed.appeal_order,
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
          appealOrder: parsed.appeal_order,
        },
      },
      'analyst',
      `${parsed.hook_type} 훅 / 컷 ${cuts.length}개 / 설득 순서 [${parsed.appeal_order.join(' → ')}]. ` +
        `흐름: ${parsed.narrative_flow}`,
      images.length === 0 ? '원본 영상을 못 받아 캡션만으로 추론했습니다. 정확도가 떨어집니다.' : undefined,
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

async function sampleFrames(
  videoUrl: string,
): Promise<{ base64: string; mediaType: 'image/jpeg' }[]> {
  const dir = await mkdtemp(join(tmpdir(), 'analyst-'));
  const videoPath = join(dir, 'ref.mp4');
  await downloadTikTokVideo(videoUrl, videoPath);
  await extractFrames(videoPath, join(dir, 'frame-%02d.jpg'), 8);

  const files = (await readdir(dir)).filter((f) => f.startsWith('frame-')).sort();
  return Promise.all(
    files.map(async (f) => ({
      base64: (await readFile(join(dir, f))).toString('base64'),
      mediaType: 'image/jpeg' as const,
    })),
  );
}
