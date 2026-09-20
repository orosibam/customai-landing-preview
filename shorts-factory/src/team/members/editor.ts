import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLIP_SEC, MIRROR_FOOTAGE, VIDEO, ZOOM_FOOTAGE, storagePath } from '../../config.js';
import { concatClips, extractFrames, mux, probe, thumbnail, trimToPortrait } from '../../lib/ffmpeg.js';
import { DEFAULT_STYLE, writeAss, type SubtitleLine } from '../../lib/subtitles.js';
import { downloadFile, uploadFile } from '../../lib/storage.js';
import { db, must } from '../../lib/supabase.js';
import { askJson } from '../../lib/llm.js';
import { readFile, readdir } from 'node:fs/promises';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 편집자.
 *
 * 설계도의 각 컷에 소재를 배정하고, 잘라서 이어붙이고, 자막과 나레이션을 얹는다.
 * 원본 방법론이 캡컷으로 하던 일을 그대로 옮긴 것이다.
 *
 * 타겟에 따라 손이 갈리는 지점: 시니어는 소스 속도를 올리되 컷 전환은 적게 가져가고
 * 자막을 훨씬 크게 쓴다. 일반 타겟은 반대로 컷을 촘촘히 가져간다.
 *
 * 컷 길이 상한은 trimToPortrait 이 강제한다. 설계도가 더 긴 컷을 요구해도 거기서 막힌다.
 */

interface AssignResponse {
  assignments: {
    cut_index: number;
    asset_index: number;
    start_sec: number;
    /** 설계도의 action 과 실제로 맞는 소재를 찾았는가. false 면 근사치를 쓴 것이다. */
    matched?: boolean;
  }[];
}

export const editor: TeamMember = {
  id: 'editor',
  role: '편집자',
  expertise: '컷에 소재를 배정하고 자막·나레이션을 얹어 최종본을 만든다',
  charter:
    '너는 숏폼 편집자다. 같은 화면이 연달아 나오면 시청자가 이탈한다. ' +
    '연속된 컷에는 서로 다른 소재를 쓰고, 각 소재에서 가장 잘 보이는 구간을 고른다.',

  async work(brief: Brief): Promise<Brief> {
    const { blueprint, script, narration, footage, audience, channel } = brief;
    if (!blueprint || !script || !narration || !footage) {
      throw new HandoffError('editor', '앞 공정 산출물이 빠졌습니다.');
    }

    const dir = await mkdtemp(join(tmpdir(), 'edit-'));

    // 소재 길이를 읽어 배정 근거로 쓴다.
    const assetInfos = await Promise.all(
      footage.assetIds.map(async (id, i) => {
        const local = footage.localPaths[i] ?? join(dir, `asset-${i}.mp4`);
        const info = await probe(local);
        return { id, index: i, localPath: local, durationSec: info.durationSec };
      }),
    );

    // 소재에 무엇이 찍혔는지 모르면 배정이 사실상 무작위가 된다.
    // 설계도가 "지퍼를 끝까지 당겨 연다" 라고 적어줘도, 길이만 보고 고르면
    // 전혀 다른 장면이 그 자리에 들어간다. 그래서 프레임을 뽑아 눈으로 본다.
    // 소재가 많을수록 소재당 프레임을 줄인다. 소재 풀을 12개로 늘렸는데 그대로
    // 3장씩 뽑으면 36장이 되어 비용이 뛴다. 총량을 30장 안쪽으로 맞추되,
    // 소재당 최소 2장은 보장한다 — 1장만 보면 그게 정지 화면인지 동작 중인지 모른다.
    const FRAME_BUDGET = 30;
    const framesPerAsset = Math.max(2, Math.min(3, Math.floor(FRAME_BUDGET / Math.max(assetInfos.length, 1))));

    const assetViews = await Promise.all(
      assetInfos.map(async (a) => {
        const dir = await mkdtemp(join(tmpdir(), `frames-${a.index}-`));
        await extractFrames(a.localPath, join(dir, 'f-%02d.jpg'), framesPerAsset).catch(() => {});
        const files = await readdir(dir).catch(() => [] as string[]);
        const images = await Promise.all(
          files
            .filter((f) => f.endsWith('.jpg'))
            .sort()
            .slice(0, framesPerAsset)
            .map(async (f) => ({
              mediaType: 'image/jpeg' as const,
              base64: (await readFile(join(dir, f))).toString('base64'),
            })),
        );
        return { index: a.index, durationSec: a.durationSec, images };
      }),
    );

    const withFrames = assetViews.filter((v) => v.images.length > 0);
    const allImages = withFrames.flatMap((v) => v.images);

    const parsed = await askJson<AssignResponse>(
      `설계도의 컷에 소재를 배정해라.

${
  withFrames.length > 0
    ? `첨부 이미지는 소재에서 뽑은 프레임이다. 소재 순서대로 ${withFrames
        .map((v) => `${v.index}번 ${v.images.length}장`)
        .join(', ')} 이다.
**각 소재에 무엇이 어떻게 움직이는지 보고, 설계도의 action 과 가장 가까운 것을 골라라.**
길이만 보고 고르지 마라 — 그러면 전혀 다른 장면이 들어간다.`
    : '⚠️ 소재 프레임을 못 뽑았다. 길이만 보고 배정할 수밖에 없으니 다양성이라도 확보해라.'
}

컷:
${JSON.stringify(
  blueprint.cuts.map((c, i) => ({
    cut_index: i,
    purpose: c.purpose,
    shot: c.shot,
    action: c.action,
    framing: c.framing,
  })),
  null,
  2,
)}

소재 (전체 길이, 초):
${JSON.stringify(assetInfos.map((a) => ({ asset_index: a.index, duration_sec: Number(a.durationSec.toFixed(1)) })), null, 2)}

규칙:
- 모든 컷에 소재를 하나씩 배정한다.
- **action 이 맞는 것을 우선한다.** 맞는 소재가 없으면 가장 비슷한 것을 고르고
  그 컷의 matched 를 false 로 표시해라.
- **같은 소재를 두 컷에 쓰지 않는다.** 소재는 컷 수보다 넉넉히 있으니 전부 다른 걸
  골라라. 화면이 안 바뀐 것처럼 보이는 문제도 있지만, 한 소스에서 ${MAX_CLIP_SEC}초를
  넘게 쓰게 되는 게 더 큰 문제다.
- start_sec 은 그 소재에서 그 동작이 실제로 보이는 지점으로 잡는다.
  (소재 길이 - ${MAX_CLIP_SEC}) 이하여야 한다.
- 맨 앞 0.5초는 피한다. 보통 페이드인이라 흐리다.

{"assignments":[{"cut_index":0,"asset_index":0,"start_sec":0.5,"matched":true}]}`,
      { tier: 'reasoning', images: allImages, maxTokens: 2000 },
    );

    const unmatched = (parsed.assignments ?? []).filter((a) => a.matched === false).length;

    // 컷을 잘라 정규화한다.
    const clipPaths: string[] = [];

    // 한 소재를 두 컷에 쓰면 그 소스에서 나가는 총 길이가 MAX_CLIP_SEC 을 넘는다.
    // 상한의 근거가 "각 영상에서 3~5초만" 이므로, 컷당 5초를 지켜도 같은 소스를
    // 두 번 쓰면 근거가 무너진다. 소재 풀이 5개뿐일 땐 재사용이 불가피했는데
    // 이제 FOOTAGE_POOL_SIZE 만큼 확보하므로 안 그래도 된다.
    const usedAssets = new Set<number>();

    /** 이미 쓴 소재면 아직 안 쓴 것 중 가장 가까운 번호로 옮긴다. */
    const pickUnused = (wanted: number): number => {
      if (!usedAssets.has(wanted)) return wanted;
      for (let step = 1; step < assetInfos.length; step++) {
        for (const cand of [wanted + step, wanted - step]) {
          const idx = ((cand % assetInfos.length) + assetInfos.length) % assetInfos.length;
          if (!usedAssets.has(idx)) return idx;
        }
      }
      // 컷이 소재보다 많으면 재사용 말고는 길이 없다. 그 사실을 숨기지 않는다.
      console.warn(
        `소재 ${assetInfos.length}개로 컷 ${blueprint.cuts.length}개를 채우느라 소재를 재사용합니다. ` +
          `같은 소스에서 ${MAX_CLIP_SEC}초를 넘게 쓰게 되므로 소재를 더 확보하는 게 맞습니다.`,
      );
      return wanted;
    };

    for (const [cutIndex, cut] of blueprint.cuts.entries()) {
      const match = parsed.assignments.find((a) => a.cut_index === cutIndex);
      const assetIndex = pickUnused(match?.asset_index ?? cutIndex % assetInfos.length);
      usedAssets.add(assetIndex);

      const asset = assetInfos[assetIndex] ?? assetInfos[0]!;
      const local = await ensureLocal(asset, dir, footage.assetIds[assetIndex]);

      // 설계도가 길게 잡았어도 상한이 이긴다. 타겟 최소 체류 시간도 함께 반영한다.
      const planned = cut.t[1] - cut.t[0];
      const durationSec = Math.min(Math.max(planned, audience.minCutSec), MAX_CLIP_SEC);

      const sourceNeeded = durationSec * audience.footageRate;
      const maxStart = Math.max(0, asset.durationSec - sourceNeeded);
      const startSec = Math.min(Math.max(match?.start_sec ?? 0.5, 0.5), maxStart);

      const out = join(dir, `cut-${String(cutIndex).padStart(2, '0')}.mp4`);
      await trimToPortrait(local, out, startSec, durationSec, {
        speed: audience.footageRate,
        mirror: MIRROR_FOOTAGE,
        zoom: ZOOM_FOOTAGE,
      });
      clipPaths.push(out);
    }

    const silentVideo = join(dir, 'video.mp4');
    await concatClips(clipPaths, silentVideo, join(dir, 'clips.txt'));

    // 자막 타임스탬프는 성우 연출이 준 문장별 실측 길이를 그대로 쓴다.
    const subtitleLines: SubtitleLine[] = script.lines.map((line, i) => ({
      text: line.text,
      durationSec: narration.lineDurations[i] ?? 1.5,
    }));
    const assPath = join(dir, 'subs.ass');
    await writeAss(subtitleLines, assPath, {
      ...DEFAULT_STYLE,
      fontSize: audience.subtitleFontSize,
      outlineWidth: audience.subtitleOutline,
    }, audience.subtitleMaxCharsPerLine);

    const narrationLocal = join(dir, 'narration.wav');
    await downloadFile(
      (await narrationPath(narration.id)) ?? '',
      narrationLocal,
    ).catch(async () => {
      // 같은 실행 안이면 로컬 파일이 아직 살아있다.
      const { copyFile } = await import('node:fs/promises');
      await copyFile(narration.audioPath, narrationLocal);
      return narrationLocal;
    });

    const finalPath = join(dir, 'final.mp4');
    await mux({ video: silentVideo, narration: narrationLocal, subtitles: assPath, output: finalPath });

    const info = await probe(finalPath);
    const thumbLocal = join(dir, 'thumb.jpg');
    await thumbnail(finalPath, thumbLocal, Math.min(1.0, info.durationSec / 2));

    const renderId = crypto.randomUUID();
    const videoRemote = storagePath.render(brief.runId, renderId);
    const thumbRemote = storagePath.thumb(brief.runId, renderId);
    await uploadFile(finalPath, videoRemote);
    await uploadFile(thumbLocal, thumbRemote);

    const channelId = await channelIdFor(channel.key);

    await must(
      '렌더 저장',
      db()
        .from('renders')
        .insert({
          id: renderId,
          run_id: brief.runId,
          narration_id: narration.id,
          channel_id: channelId,
          storage_path: videoRemote,
          thumb_path: thumbRemote,
          duration_sec: info.durationSec,
          // 품질 판정은 검수 담당이 한다. 편집자는 만들기만 한다.
          qc_passed: false,
          approval_status: 'pending',
        })
        .select('id')
        .single(),
    );

    return withNote(
      { ...brief, render: { id: renderId, storagePath: videoRemote, durationSec: info.durationSec } },
      'editor',
      `${info.durationSec.toFixed(1)}초 / 컷 ${clipPaths.length}개 / 소스속도 ${audience.footageRate}배 / ` +
        `자막 ${audience.subtitleFontSize}px`,
      // 동작이 안 맞는 컷은 "설계도를 따라한 것처럼 보이지만 실은 다른 영상" 이 되는
      // 지점이다. 조용히 넘기면 왜 안 터지는지 나중에 알 수 없다.
      unmatched > 0
        ? `컷 ${unmatched}개는 설계도의 동작과 맞는 소재가 없어 근사치를 썼습니다. ` +
          `소재를 더 모으거나 상품을 바꾸면 재현도가 올라갑니다.`
        : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const render = brief.render;
    if (!render) return fail('렌더 결과가 없습니다.');

    const problems: string[] = [];
    if (render.durationSec < VIDEO.minDurationSec) {
      problems.push(`길이 ${render.durationSec.toFixed(1)}초가 하한 ${VIDEO.minDurationSec}초 미만입니다.`);
    }
    if (render.durationSec > VIDEO.maxDurationSec) {
      problems.push(`길이 ${render.durationSec.toFixed(1)}초가 상한 ${VIDEO.maxDurationSec}초를 넘습니다.`);
    }
    return { ok: problems.length === 0, problems, warnings: [] };
  },
};

async function ensureLocal(
  asset: { localPath: string; index: number },
  dir: string,
  assetId: string | undefined,
): Promise<string> {
  const { access } = await import('node:fs/promises');
  try {
    await access(asset.localPath);
    return asset.localPath;
  } catch {
    if (!assetId) throw new Error(`소재 ${asset.index} 의 로컬 파일도 ID도 없습니다.`);
    const { data } = await db().from('assets').select('storage_path').eq('id', assetId).single();
    const remote = (data as { storage_path: string } | null)?.storage_path;
    if (!remote) throw new Error(`소재 ${assetId} 의 저장 경로를 찾을 수 없습니다.`);
    return downloadFile(remote, join(dir, `asset-${asset.index}.mp4`));
  }
}

async function narrationPath(narrationId: string): Promise<string | null> {
  const { data } = await db()
    .from('narrations')
    .select('full_audio_path')
    .eq('id', narrationId)
    .maybeSingle();
  return (data as { full_audio_path: string } | null)?.full_audio_path ?? null;
}

async function channelIdFor(key: string): Promise<string> {
  const row = await must(
    `채널 조회 (${key})`,
    db().from('channels').select('id').eq('key', key).single(),
  );
  return (row as { id: string }).id;
}
