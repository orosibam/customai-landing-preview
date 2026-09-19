import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLIP_SEC, VIDEO, storagePath } from '../config.js';
import { concatClips, mux, probe, thumbnail, trimToPortrait } from '../lib/ffmpeg.js';
import { writeAss, type SubtitleLine } from '../lib/subtitles.js';
import { downloadFile, uploadFile } from '../lib/storage.js';
import { db, must } from '../lib/supabase.js';
import type { Slot } from './s1-pick-products.js';
import type { Asset, CutAssignment } from './s4-collect-assets.js';
import type { Script } from './s5-write-script.js';
import type { Narration } from './s6-narrate.js';

/**
 * S7 — 렌더
 *
 * 원본 방법론의 캡컷 작업(클립 5개 + 음성 + 자막을 9:16으로 합치기)을 ffmpeg 로 옮긴 것.
 *
 * 자막 타임스탬프는 S6가 준 문장별 실측 길이를 누적해서 만든다.
 * 별도 싱크 도구가 필요 없는 이유다.
 *
 * 컷 길이 상한은 trimToPortrait 이 강제한다. 여기서 우회 경로를 만들지 않는다.
 */

export interface RenderResult {
  id: string;
  channelKey: string;
  storagePath: string;
  thumbPath: string;
  durationSec: number;
  qcPassed: boolean;
  qcNotes: string[];
}

export interface RenderInput {
  runId: string;
  slot: Slot;
  script: Script;
  narration: Narration;
  assets: Asset[];
  assignments: CutAssignment[];
  channelId: string;
}

export async function render(input: RenderInput): Promise<RenderResult> {
  const { runId, slot, script, narration, assets, assignments, channelId } = input;
  const dir = await mkdtemp(join(tmpdir(), 'render-'));
  const byId = new Map(assets.map((a) => [a.id, a]));

  // 1. 각 컷을 잘라 9:16으로 정규화한다.
  //    trimToPortrait 이 MAX_CLIP_SEC 을 넘는 요청을 거부하므로,
  //    설계도가 아무리 긴 컷을 요구해도 여기서 막힌다.
  const clipPaths: string[] = [];
  for (const [i, a] of assignments.entries()) {
    const asset = byId.get(a.assetId);
    if (!asset) throw new Error(`컷 ${i} 에 배정된 소재를 찾을 수 없습니다: ${a.assetId}`);

    const src = join(dir, `src-${i}.mp4`);
    await downloadFile(asset.storagePath, src);

    const out = join(dir, `cut-${String(i).padStart(2, '0')}.mp4`);
    await trimToPortrait(src, out, a.startSec, a.durationSec);
    clipPaths.push(out);
  }

  // 2. 이어붙인다.
  const silentVideo = join(dir, 'video.mp4');
  await concatClips(clipPaths, silentVideo, join(dir, 'clips.txt'));

  // 3. 자막. 문장별 실측 길이를 그대로 쓴다.
  const subtitleLines: SubtitleLine[] = script.lines.map((line, i) => ({
    text: line.text,
    durationSec: narration.lineDurations[i] ?? 1.5,
  }));
  const assPath = join(dir, 'subs.ass');
  await writeAss(subtitleLines, assPath);

  // 4. 나레이션 + 자막을 합친다.
  const narrationLocal = join(dir, 'narration.wav');
  await downloadFile(narration.fullAudioStoragePath, narrationLocal);

  const finalPath = join(dir, 'final.mp4');
  await mux({
    video: silentVideo,
    narration: narrationLocal,
    subtitles: assPath,
    output: finalPath,
  });

  // 5. 품질 게이트. 여기를 통과하지 못하면 승인 큐에 올라가지 않는다.
  const info = await probe(finalPath);
  const qcNotes = runQc(info, narration, assignments);
  const qcPassed = qcNotes.length === 0;

  const thumbLocal = join(dir, 'thumb.jpg');
  await thumbnail(finalPath, thumbLocal, Math.min(1.0, info.durationSec / 2));

  const renderId = crypto.randomUUID();
  const videoRemote = storagePath.render(runId, renderId);
  const thumbRemote = storagePath.thumb(runId, renderId);
  await uploadFile(finalPath, videoRemote);
  await uploadFile(thumbLocal, thumbRemote);

  const row = await must(
    '렌더 저장',
    db()
      .from('renders')
      .insert({
        id: renderId,
        run_id: runId,
        narration_id: narration.id,
        channel_id: channelId,
        storage_path: videoRemote,
        thumb_path: thumbRemote,
        duration_sec: info.durationSec,
        qc_passed: qcPassed,
        qc_notes: qcNotes,
        approval_status: 'pending',
      })
      .select('id')
      .single(),
  );

  console.log(
    `S7: ${slot.channel.key} 렌더 완료 — ${info.durationSec.toFixed(1)}초, ` +
      `QC ${qcPassed ? '통과' : `실패 (${qcNotes.length}건)`}`,
  );
  if (!qcPassed) for (const n of qcNotes) console.warn(`   ${n}`);

  return {
    id: (row as { id: string }).id,
    channelKey: slot.channel.key,
    storagePath: videoRemote,
    thumbPath: thumbRemote,
    durationSec: info.durationSec,
    qcPassed,
    qcNotes,
  };
}

/**
 * 품질 검사.
 *
 * 사람이 10개를 다 돌려볼 수는 없으니, 명백히 잘못된 건 기계가 먼저 걸러낸다.
 * 여기를 통과한 것만 대시보드 승인 큐에 올라간다.
 */
function runQc(
  info: { durationSec: number; width: number; height: number; hasAudio: boolean },
  narration: Narration,
  assignments: CutAssignment[],
): string[] {
  const notes: string[] = [];

  if (info.durationSec < VIDEO.minDurationSec) {
    notes.push(`길이 ${info.durationSec.toFixed(1)}초가 하한 ${VIDEO.minDurationSec}초 미만입니다.`);
  }
  if (info.durationSec > VIDEO.maxDurationSec) {
    notes.push(`길이 ${info.durationSec.toFixed(1)}초가 상한 ${VIDEO.maxDurationSec}초를 넘습니다.`);
  }
  if (info.width !== VIDEO.width || info.height !== VIDEO.height) {
    notes.push(`해상도가 ${info.width}x${info.height} 입니다 (기대: ${VIDEO.width}x${VIDEO.height}).`);
  }
  if (!info.hasAudio) {
    notes.push('오디오 트랙이 없습니다.');
  }

  // 나레이션이 영상보다 길면 뒷부분이 잘려 문장이 끊긴다.
  if (narration.totalDurationSec > info.durationSec + 0.5) {
    notes.push(
      `나레이션(${narration.totalDurationSec.toFixed(1)}초)이 영상(${info.durationSec.toFixed(1)}초)보다 깁니다. ` +
        `문장이 잘립니다.`,
    );
  }

  // 상한 위반은 렌더 단계에서 이미 막히지만, 이중으로 확인한다.
  const overLimit = assignments.filter((a) => a.durationSec > MAX_CLIP_SEC);
  if (overLimit.length > 0) {
    notes.push(`컷 ${overLimit.length}개가 ${MAX_CLIP_SEC}초 상한을 넘습니다.`);
  }

  if (narration.warnings.length > 0) {
    notes.push(`나레이션 길이 경고 ${narration.warnings.length}건 — 발음 정규화 확인 필요.`);
  }

  return notes;
}
