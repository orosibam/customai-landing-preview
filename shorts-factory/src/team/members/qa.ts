import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLIP_SEC, VIDEO } from '../../config.js';
import { probe } from '../../lib/ffmpeg.js';
import { downloadFile } from '../../lib/storage.js';
import { db } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 품질 검수.
 *
 * 승인 화면에 올라가도 되는지 판정한다. 사람이 하루 10개를 다 돌려볼 수는 없으니,
 * 명백히 잘못된 건 여기서 걸러낸다.
 *
 * 앞 담당자들이 각자 자기 구간을 검수했지만, 그건 자기 산출물 기준이다.
 * 이 자리는 **완성본 하나를 놓고** 본다 — 길이, 규격, 싱크, 그리고
 * 앞 공정 전체가 남긴 경고가 쌓여 있지 않은지.
 */

export const qa: TeamMember = {
  id: 'qa',
  role: '품질 검수',
  expertise: '완성본이 승인 큐에 올라갈 자격이 있는지 판정한다',
  charter:
    '너는 품질 검수 담당이다. 통과시키는 것보다 막는 것이 네 일이다. ' +
    '애매하면 막는다 — 잘못 나간 영상은 되돌릴 수 없지만, 막힌 영상은 다시 만들면 된다.',

  async work(brief: Brief): Promise<Brief> {
    const render = brief.render;
    if (!render) throw new HandoffError('qa', '렌더 결과가 넘어오지 않았습니다.');

    const dir = await mkdtemp(join(tmpdir(), 'qa-'));
    const local = await downloadFile(render.storagePath, join(dir, 'final.mp4'));
    const info = await probe(local);

    const notes: string[] = [];

    if (info.durationSec < VIDEO.minDurationSec) {
      notes.push(`길이 ${info.durationSec.toFixed(1)}초 < 하한 ${VIDEO.minDurationSec}초`);
    }
    if (info.durationSec > VIDEO.maxDurationSec) {
      notes.push(`길이 ${info.durationSec.toFixed(1)}초 > 상한 ${VIDEO.maxDurationSec}초`);
    }
    if (info.width !== VIDEO.width || info.height !== VIDEO.height) {
      notes.push(`해상도 ${info.width}x${info.height} (기대 ${VIDEO.width}x${VIDEO.height})`);
    }
    if (!info.hasAudio) {
      notes.push('오디오 트랙 없음');
    }

    // 나레이션이 영상보다 길면 뒷문장이 잘려 말이 끊긴다.
    const narrationSec = brief.narration?.totalDurationSec ?? 0;
    if (narrationSec > info.durationSec + 0.5) {
      notes.push(
        `나레이션(${narrationSec.toFixed(1)}초)이 영상(${info.durationSec.toFixed(1)}초)보다 깁니다. 문장이 잘립니다.`,
      );
    }

    // 자막 줄 수와 나레이션 문장 수가 어긋나면 싱크가 밀린다.
    const lineCount = brief.script?.lines.length ?? 0;
    const durationCount = brief.narration?.lineDurations.length ?? 0;
    if (lineCount !== durationCount) {
      notes.push(`문장 ${lineCount}개 / 오디오 ${durationCount}개 불일치 — 자막 싱크가 어긋납니다.`);
    }

    // 컷 상한은 편집 단계에서 이미 막히지만, 최종본 기준으로 한 번 더 본다.
    const cutCount = brief.blueprint?.cuts.length ?? 0;
    if (cutCount > 0 && info.durationSec / cutCount > MAX_CLIP_SEC + 0.5) {
      notes.push(`컷당 평균 ${(info.durationSec / cutCount).toFixed(1)}초로 상한을 넘습니다.`);
    }

    // 앞 공정이 남긴 경고(caveat)가 쌓여 있으면 사람이 직접 봐야 한다.
    const caveats = brief.notes.filter((n) => n.caveat).map((n) => `${n.from}: ${n.caveat}`);
    if (caveats.length >= 2) {
      notes.push(`앞 공정 경고 ${caveats.length}건 누적 — 개별 확인 필요: ${caveats.join(' / ')}`);
    }

    const passed = notes.length === 0;

    await db()
      .from('renders')
      .update({ qc_passed: passed, qc_notes: notes })
      .eq('id', render.id);

    return withNote(
      brief,
      'qa',
      passed
        ? `검수 통과 — ${info.durationSec.toFixed(1)}초, ${info.width}x${info.height}`
        : `검수 보류 ${notes.length}건: ${notes.join(' / ')}`,
      passed ? undefined : '일괄 승인에서 제외됩니다. 대시보드에서 개별 확인하세요.',
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    // 검수 담당은 자기 판정을 다시 뒤집지 않는다. 결과가 기록됐는지만 확인한다.
    if (!brief.render) return fail('렌더가 없습니다.');
    const { data } = await db()
      .from('renders')
      .select('qc_passed, qc_notes')
      .eq('id', brief.render.id)
      .maybeSingle();

    const row = data as { qc_passed: boolean; qc_notes: string[] } | null;
    if (!row) return fail('검수 결과가 기록되지 않았습니다.');

    return {
      ok: true, // 검수 실패여도 파이프라인은 멈추지 않는다. 승인 화면에 올라가되 일괄 승인에서 빠진다.
      problems: [],
      warnings: row.qc_passed ? [] : row.qc_notes,
    };
  },
};
