import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLIP_SEC, MIN_SOURCE_COUNT, storagePath } from '../config.js';
import { collectClips, downloadClip } from '../lib/scrapers/taobao.js';
import { probe } from '../lib/ffmpeg.js';
import { uploadFile } from '../lib/storage.js';
import { db, must } from '../lib/supabase.js';
import { askJson } from '../lib/llm.js';
import type { Slot } from './s1-pick-products.js';
import type { Blueprint } from './s3-extract-blueprint.js';

/**
 * S4 — 타오바오 소재 수집
 *
 * 설계도가 요구하는 컷들을 실제 화면으로 채울 클립을 모은다.
 * 원본 방법론 그대로 판매자 상품 영상을 쓰되, 각 소스는 렌더 단계에서
 * MAX_CLIP_SEC(5초) 이내로만 잘려 나간다.
 *
 * 소스가 적으면 소스당 사용 길이가 길어져 그 상한에 걸리므로,
 * MIN_SOURCE_COUNT 미만이면 여기서 멈춘다.
 */

export interface Asset {
  id: string;
  storagePath: string;
  localPath: string;
  durationSec: number;
  sourceUrl: string;
  productUrl: string;
  shotTags: string[];
}

/** 설계도의 컷 하나에 배정된 소재. */
export interface CutAssignment {
  cutIndex: number;
  assetId: string;
  /** 소스 클립에서 잘라낼 시작 지점(초) */
  startSec: number;
  /** 사용 길이(초). 항상 MAX_CLIP_SEC 이하. */
  durationSec: number;
}

export async function collectAssets(slot: Slot, blueprint: Blueprint): Promise<{
  assets: Asset[];
  assignments: CutAssignment[];
}> {
  const keywordZh = slot.product.title_zh;
  if (!keywordZh) throw new Error(`상품 "${slot.product.title_ko}" 에 중국어 표기가 없습니다 (S1 확인).`);

  const clips = await collectClips({ keywordZh });
  const dir = await mkdtemp(join(tmpdir(), 'assets-'));
  const assets: Asset[] = [];

  for (const [idx, clip] of clips.entries()) {
    const localPath = join(dir, `src-${idx}.mp4`);
    try {
      await downloadClip(clip.videoUrl, localPath);
      const info = await probe(localPath);
      // 너무 짧아서 5초를 못 떼어낼 클립은 쓸모가 없다.
      if (info.durationSec < MAX_CLIP_SEC) {
        console.warn(`클립 ${idx} 가 ${info.durationSec.toFixed(1)}초로 짧아 건너뜁니다.`);
        continue;
      }

      const remotePath = storagePath.asset(slot.product.id, slot.product.id, idx);
      await uploadFile(localPath, remotePath);

      const row = await must(
        '소재 저장',
        db()
          .from('assets')
          .insert({
            product_id: slot.product.id,
            source_url: clip.videoUrl,
            source_site: 'taobao',
            storage_path: remotePath,
            duration_sec: info.durationSec,
            width: info.width,
            height: info.height,
            shot_tags: [],
          })
          .select('id')
          .single(),
      );

      assets.push({
        id: (row as { id: string }).id,
        storagePath: remotePath,
        localPath,
        durationSec: info.durationSec,
        sourceUrl: clip.videoUrl,
        productUrl: clip.productUrl,
        shotTags: [],
      });
    } catch (e) {
      console.warn(`클립 ${idx} 처리 실패: ${(e as Error).message}`);
    }
  }

  if (assets.length < MIN_SOURCE_COUNT) {
    throw new Error(
      `사용 가능한 소재가 ${assets.length}개뿐입니다 (최소 ${MIN_SOURCE_COUNT}개). ` +
        `소스가 부족하면 소스당 사용 길이가 ${MAX_CLIP_SEC}초 상한을 넘게 됩니다.`,
    );
  }

  const assignments = await assignCuts(assets, blueprint);
  console.log(`S4: 소재 ${assets.length}개 수집, 컷 ${assignments.length}개 배정`);
  return { assets, assignments };
}

interface AssignResponse {
  assignments: { cut_index: number; asset_index: number; start_sec: number }[];
}

/**
 * 설계도의 각 컷에 어떤 소재의 어느 구간을 쓸지 정한다.
 *
 * 컷 길이는 설계도가 정한 길이를 따르되 MAX_CLIP_SEC 로 잘라낸다.
 * 설계도가 6초짜리 컷을 요구해도 5초로 줄어든다 — 그 상한이 공정이용 근거이기 때문에
 * 설계도보다 우선한다.
 */
async function assignCuts(assets: Asset[], blueprint: Blueprint): Promise<CutAssignment[]> {
  const parsed = await askJson<AssignResponse>(
    `상품 영상 클립 ${assets.length}개를 설계도의 컷에 배정해라.

설계도 컷:
${JSON.stringify(blueprint.cuts.map((c, i) => ({ cut_index: i, shot: c.shot, purpose: c.purpose })), null, 2)}

사용 가능한 클립 (전체 길이, 초):
${JSON.stringify(assets.map((a, i) => ({ asset_index: i, duration_sec: Number(a.durationSec.toFixed(1)) })), null, 2)}

규칙:
- 모든 컷에 클립을 하나씩 배정한다.
- 같은 클립을 여러 컷에 써도 되지만, 연속된 두 컷에 같은 클립을 쓰지 않는다 (화면이 안 바뀐 것처럼 보인다).
- start_sec 은 그 클립에서 잘라낼 시작 지점. 클립 길이 - ${MAX_CLIP_SEC} 이하여야 한다.
- 클립 맨 앞 0.5초는 피한다 (보통 페이드인이라 흐리다).

{"assignments":[{"cut_index":0,"asset_index":0,"start_sec":0.5}]}`,
    { tier: 'fast', maxTokens: 2000 },
  );

  const result: CutAssignment[] = [];
  for (const [cutIndex, cut] of blueprint.cuts.entries()) {
    const match = parsed.assignments.find((a) => a.cut_index === cutIndex);
    const asset = assets[match?.asset_index ?? cutIndex % assets.length] ?? assets[0]!;

    const plannedDuration = cut.t[1] - cut.t[0];
    // 설계도가 길게 잡았어도 상한이 이긴다.
    const durationSec = Math.min(plannedDuration, MAX_CLIP_SEC);

    const maxStart = Math.max(0, asset.durationSec - durationSec);
    const startSec = Math.min(Math.max(match?.start_sec ?? 0.5, 0.5), maxStart);

    result.push({ cutIndex, assetId: asset.id, startSec, durationSec });
  }
  return result;
}
