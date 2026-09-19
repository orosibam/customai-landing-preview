import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storagePath } from '../config.js';
import { narrate, type NarrationResult } from '../lib/typecast.js';
import { concatAudio } from '../lib/ffmpeg.js';
import { uploadFile } from '../lib/storage.js';
import { db, must } from '../lib/supabase.js';
import type { Slot } from './s1-pick-products.js';
import type { Script } from './s5-write-script.js';

/**
 * S6 — 나레이션 (타입캐스트)
 *
 * 문장별로 합성하는 게 핵심이다. 통으로 뽑으면 문장별 길이를 알 수 없고,
 * 그러면 자막 싱크를 맞출 방법이 사라져 원본 방법론처럼 별도 싱크 도구
 * (브루)가 필요해진다. 문장별 실측 길이를 받아두면 그 값이 그대로
 * 자막 타임스탬프가 된다.
 *
 * 문장 사이 공백은 0이다 — 원본: "쇼츠에서 이 공백이 있으면 사람들은 되게 루즈해한다."
 * concatAudio 가 무음 없이 이어붙이므로 별도 처리가 필요 없다.
 */

export interface Narration {
  id: string;
  scriptId: string;
  lineDurations: number[];
  totalDurationSec: number;
  fullAudioLocalPath: string;
  fullAudioStoragePath: string;
  mode: NarrationResult['mode'];
  warnings: string[];
}

export async function narrateScript(slot: Slot, script: Script): Promise<Narration> {
  const dir = await mkdtemp(join(tmpdir(), 'narration-'));

  const result = await narrate(
    script.lines.map((l) => l.text),
    { presetKey: slot.channel.voicePreset, outDir: dir },
  );

  const warnings = result.lines.filter((l) => l.warning).map((l) => `[${l.idx}] ${l.warning}`);
  for (const w of warnings) console.warn(`S6 ${w}`);

  // 공백 없이 이어붙인다.
  const fullLocal = join(dir, 'full.wav');
  await concatAudio(
    result.lines.map((l) => l.audioPath),
    fullLocal,
    join(dir, 'list.txt'),
  );

  const fullRemote = storagePath.narrationFull(slot.product.id, script.id);
  await uploadFile(fullLocal, fullRemote);

  const lineRemotes: string[] = [];
  for (const line of result.lines) {
    const remote = storagePath.narrationLine(slot.product.id, script.id, line.idx);
    await uploadFile(line.audioPath, remote);
    lineRemotes.push(remote);
  }

  const durations = result.lines.map((l) => l.durationSec);

  const row = await must(
    '나레이션 저장',
    db()
      .from('narrations')
      .insert({
        script_id: script.id,
        voice_preset: slot.channel.voicePreset,
        line_audio_paths: lineRemotes,
        line_durations: durations,
        full_audio_path: fullRemote,
        total_duration_sec: result.totalDurationSec,
        source_mode: result.mode,
      })
      .select('id')
      .single(),
  );

  console.log(
    `S6: 나레이션 ${result.lines.length}문장 / ${result.totalDurationSec.toFixed(1)}초 ` +
      `(${result.mode} 경로)${warnings.length > 0 ? ` · 경고 ${warnings.length}건` : ''}`,
  );

  return {
    id: (row as { id: string }).id,
    scriptId: script.id,
    lineDurations: durations,
    totalDurationSec: result.totalDurationSec,
    fullAudioLocalPath: fullLocal,
    fullAudioStoragePath: fullRemote,
    mode: result.mode,
    warnings,
  };
}
