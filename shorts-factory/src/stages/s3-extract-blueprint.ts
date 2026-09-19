import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askJson } from '../lib/llm.js';
import { extractFrames } from '../lib/ffmpeg.js';
import { db, must } from '../lib/supabase.js';
import type { StoredReference } from './s2-find-references.js';

/**
 * S3 — 설계도 추출
 *
 * 레퍼런스에서 가져오는 것은 **구조뿐**이다. 훅의 형태, 컷의 개수와 길이,
 * 소구 순서, 클라이맥스 위치. 원본의 화면·음성·문장은 쓰지 않는다 —
 * 화면은 S4의 타오바오 클립이, 문장은 S5의 한국어 생성이 채운다.
 *
 * 이 설계도가 시스템의 심장이다. 원본 방법론에서 GPT가 백지에서 쓰던 대본 자리를
 * "이미 돈으로 검증된 구조" 로 바꾸는 지점.
 */

export interface Cut {
  t: [number, number];
  shot: string;
  purpose: string;
}

export interface Blueprint {
  id: string;
  referenceId: string;
  sourcePlatform: string;
  hookType: string;
  hookDurationSec: number;
  cuts: Cut[];
  appealOrder: string[];
  climaxAtSec: number | null;
  ctaPosition: string;
}

const FRAME_COUNT = 8;

async function sampleFrames(videoUrl: string): Promise<{ base64: string; mediaType: 'image/jpeg' }[]> {
  const dir = await mkdtemp(join(tmpdir(), 'blueprint-'));
  const videoPath = join(dir, 'ref.mp4');

  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`레퍼런스 영상 다운로드 실패 (${res.status})`);
  await writeFile(videoPath, Buffer.from(await res.arrayBuffer()));

  await extractFrames(videoPath, join(dir, 'frame-%02d.jpg'), FRAME_COUNT);

  const files = (await readdir(dir)).filter((f) => f.startsWith('frame-')).sort();
  return Promise.all(
    files.map(async (f) => ({
      base64: (await readFile(join(dir, f))).toString('base64'),
      mediaType: 'image/jpeg' as const,
    })),
  );
}

interface BlueprintResponse {
  hook_type: string;
  hook_duration_sec: number;
  cuts: Cut[];
  appeal_order: string[];
  climax_at_sec: number | null;
  cta_position: string;
}

const SYSTEM = `너는 숏폼 광고의 구조를 분해하는 분석가다.

분석 대상의 **구조만** 뽑아낸다. 대사, 자막 문구, 등장 인물, 브랜드명, 구체적인
영상 내용은 기록하지 않는다. 우리가 재현할 것은 "어떤 순서로 무엇을 보여주는가"
라는 골격이지, 그 영상 자체가 아니다.

shot 필드는 화면 유형을 일반적인 말로 적는다.
  좋은 예: "문제 상황 클로즈업", "제품 등장, 손 개입", "사용 전후 비교", "질감 매크로샷"
  나쁜 예: 특정 인물 묘사, 특정 배경 묘사, 화면에 뜬 문구 그대로 옮기기`;

export async function extractBlueprint(reference: StoredReference): Promise<Blueprint> {
  const images = reference.video_url ? await sampleFrames(reference.video_url).catch((e) => {
    console.warn(`프레임 추출 실패, 캡션만으로 진행: ${(e as Error).message}`);
    return [];
  }) : [];

  if (images.length === 0) {
    console.warn(
      `레퍼런스 ${reference.external_url} 의 영상을 못 받았습니다. ` +
        `캡션만으로 구조를 추론하므로 정확도가 떨어집니다.`,
    );
  }

  const prompt = `이 숏폼의 구조를 분해해라.

플랫폼: ${reference.platform}
캡션: ${reference.caption || '(없음)'}
아웃라이어 배수: ${reference.outlier_score.toFixed(1)}배 (팔로워 대비 이만큼 터졌다)
${images.length > 0 ? `\n첨부된 ${images.length}장은 영상에서 시간 순으로 뽑은 프레임이다.` : ''}

다음을 JSON으로:
- hook_type: 첫 1~2초가 시선을 잡는 방식. 아래 중 하나를 고르거나 비슷한 형태를 새로 명명.
  problem_shock(문제 상황 충격) / result_first(결과 먼저 보여주기) /
  curiosity_gap(정보 공백) / satisfying_motion(만족스러운 동작) /
  price_reveal(가격 충격) / comparison(비교)
- hook_duration_sec: 훅 구간 길이 (보통 1.0~2.0)
- cuts: 컷 배열. 각 컷은 {t:[시작초, 끝초], shot:"화면 유형", purpose:"역할"}.
  전체 길이는 25~45초. 컷은 5~9개.
  purpose 는 hook / problem / solution_reveal / proof / benefit / price / cta 중에서.
- appeal_order: 소구 포인트가 나오는 순서. 한국어 명사구 배열.
- climax_at_sec: 가장 임팩트가 큰 지점(초). 모르면 null.
- cta_position: "end" / "mid" / "both" 중 하나.

{"hook_type":"...","hook_duration_sec":0,"cuts":[],"appeal_order":[],"climax_at_sec":0,"cta_position":"end"}`;

  const parsed = await askJson<BlueprintResponse>(prompt, {
    tier: 'reasoning',
    system: SYSTEM,
    images,
    maxTokens: 3000,
  });

  if (!Array.isArray(parsed.cuts) || parsed.cuts.length < 4) {
    throw new Error(`설계도의 컷이 너무 적습니다 (${parsed.cuts?.length ?? 0}개). 재시도가 필요합니다.`);
  }

  const row = await must(
    '설계도 저장',
    db()
      .from('blueprints')
      .insert({
        reference_id: reference.id,
        hook_type: parsed.hook_type,
        hook_duration_sec: parsed.hook_duration_sec,
        cuts: parsed.cuts,
        appeal_order: parsed.appeal_order,
        climax_at_sec: parsed.climax_at_sec,
        cta_position: parsed.cta_position,
      })
      .select('id')
      .single(),
  );

  await db().from('references').update({ used_at: new Date().toISOString() }).eq('id', reference.id);

  console.log(
    `S3: 설계도 추출 — ${parsed.hook_type}, 컷 ${parsed.cuts.length}개, ` +
      `소구순서 [${parsed.appeal_order.join(' → ')}]`,
  );

  return {
    id: (row as { id: string }).id,
    referenceId: reference.id,
    sourcePlatform: reference.platform,
    hookType: parsed.hook_type,
    hookDurationSec: parsed.hook_duration_sec,
    cuts: parsed.cuts,
    appealOrder: parsed.appeal_order,
    climaxAtSec: parsed.climax_at_sec,
    ctaPosition: parsed.cta_position,
  };
}
