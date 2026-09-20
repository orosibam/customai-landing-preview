import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storagePath } from '../../config.js';
import { narrate } from '../../lib/typecast.js';
import { concatAudio } from '../../lib/ffmpeg.js';
import { uploadFile } from '../../lib/storage.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 성우 연출.
 *
 * 타입캐스트를 쓰되, 기본값 그대로 뽑으면 너무 느려서 시청자가 중간에 나간다.
 * 속도를 1.2~1.3배로 올리고 문장 사이 공백을 없애는 게 이 자리의 핵심 작업이다.
 *
 * 문장별로 합성하는 이유: 문장마다 실제 길이를 알아야 자막 타임스탬프가 나온다.
 * 통으로 뽑으면 그 정보가 사라져서 별도 싱크 도구가 필요해진다.
 */

export const voice: TeamMember = {
  id: 'voice',
  role: '성우 연출',
  expertise: '타입캐스트 속도·피치·끊어읽기를 타겟에 맞춰 조율한다',
  charter:
    '너는 AI 성우 연출 담당이다. 기계 티가 나는 지점은 목소리가 아니라 ' +
    '읽을 수 없는 표기와 느린 속도, 문장 사이 공백이다. 그 셋을 잡는 것이 네 일이다.',

  async work(brief: Brief): Promise<Brief> {
    const { script, audience, channel } = brief;
    if (!script) throw new HandoffError('voice', '대본이 넘어오지 않았습니다.');

    const dir = await mkdtemp(join(tmpdir(), 'voice-'));

    const result = await narrate(
      script.lines.map((l) => l.text),
      {
        presetKey: channel.voicePreset,
        outDir: dir,
        // 타겟별 속도. 시니어라고 느리게 가는 게 아니라, 기본값이 워낙 느려서
        // 오히려 올려야 끝까지 본다.
        speedOverride: audience.speechRate,
      },
    );

    const warnings = result.lines.filter((l) => l.warning).map((l) => `[${l.idx}] ${l.warning}`);
    for (const w of warnings) console.warn(`성우 연출 ${w}`);

    // 공백 없이 이어붙인다.
    const fullLocal = join(dir, 'full.wav');
    await concatAudio(result.lines.map((l) => l.audioPath), fullLocal, join(dir, 'list.txt'));

    const fullRemote = storagePath.narrationFull(brief.runId, script.id);
    await uploadFile(fullLocal, fullRemote);

    const lineRemotes: string[] = [];
    for (const line of result.lines) {
      const remote = storagePath.narrationLine(brief.runId, script.id, line.idx);
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
          voice_preset: channel.voicePreset,
          line_audio_paths: lineRemotes,
          line_durations: durations,
          full_audio_path: fullRemote,
          total_duration_sec: result.totalDurationSec,
          source_mode: result.mode,
        })
        .select('id')
        .single(),
    );

    return withNote(
      {
        ...brief,
        narration: {
          id: (row as { id: string }).id,
          lineDurations: durations,
          totalDurationSec: result.totalDurationSec,
          audioPath: fullLocal,
        },
      },
      'voice',
      `${result.lines.length}문장 / ${result.totalDurationSec.toFixed(1)}초 ` +
        `(속도 ${audience.speechRate}배, ${result.mode} 경로)`,
      warnings.length > 0 ? `길이 이상 ${warnings.length}건 — 발음 정규화가 놓친 표기가 있습니다.` : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const narration = brief.narration;
    if (!narration) return fail('나레이션이 비어 있습니다.');

    const problems: string[] = [];
    const warnings: string[] = [];

    if (narration.lineDurations.length !== (brief.script?.lines.length ?? 0)) {
      problems.push(
        `문장 수(${brief.script?.lines.length})와 오디오 수(${narration.lineDurations.length})가 다릅니다. ` +
          `자막 싱크가 어긋납니다.`,
      );
    }
    if (narration.totalDurationSec < 15) {
      problems.push(`나레이션이 ${narration.totalDurationSec.toFixed(1)}초로 너무 짧습니다.`);
    }
    if (narration.totalDurationSec > 55) {
      problems.push(`나레이션이 ${narration.totalDurationSec.toFixed(1)}초로 쇼츠 길이를 넘습니다.`);
    }

    // 비정상적으로 짧은 문장은 성우가 건너뛴 것일 수 있다.
    const suspicious = narration.lineDurations.filter((d) => d < 0.4).length;
    if (suspicious > 0) warnings.push(`${suspicious}개 문장이 0.4초 미만입니다. 누락 가능성.`);

    return { ok: problems.length === 0, problems, warnings };
  },
};
