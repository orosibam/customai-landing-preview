import { CHANNELS, dailySlotCount } from '../config.js';
import { audienceFor, PLATFORM_DEFAULT_AUDIENCE, type AudienceKey } from '../lib/audience.js';
import { closeBrowser } from '../lib/browser.js';
import { estimateCostUsd } from '../lib/llm.js';
import { mkdir } from 'node:fs/promises';
import { downloadFile } from '../lib/storage.js';
import { db, logStage, openRun } from '../lib/supabase.js';
import { PRODUCTION_LINE } from './index.js';
import { HandoffError, type Brief, type TeamMember } from './types.js';

/**
 * 작업 배분과 진행 관리.
 *
 * 매일 슬롯(채널 × 편수)을 만들어 제작 라인에 흘린다. 담당자 한 명이 막히면
 * 그 건만 중단되고 나머지 슬롯은 계속 간다 — 하루치가 통째로 날아가는 것보다
 * 8편이라도 올라가는 편이 낫다.
 *
 * 라인 끝에서 멈춘다. 배포는 사람이 승인한 뒤에 따로 돈다.
 */

export interface SlotOutcome {
  channelKey: string;
  slotIndex: number;
  ok: boolean;
  /** 어느 담당자에게서 막혔는가 */
  failedAt?: string;
  error?: string;
  productTitle?: string;
  handoffs: { from: string; message: string; caveat?: string }[];
}

function buildSlots(runId: string): Brief[] {
  const slots: Brief[] = [];
  for (const channel of CHANNELS) {
    const key: AudienceKey =
      channel.audience ?? PLATFORM_DEFAULT_AUDIENCE[channel.platform] ?? 'general';
    for (let i = 0; i < channel.dailyCount; i++) {
      slots.push({ runId, channel, audience: audienceFor(key), notes: [] });
    }
  }
  return slots;
}

/**
 * 후보를 몇 번까지 갈아끼울 것인가.
 *
 * 소싱 담당이 후보를 3개 들고 오므로 3이면 전부 써본다. 그 이상은 재발굴이라
 * 인스타 탐색을 다시 돌게 되고, 한 편에 8분 넘게 쓰는 건 하루 8편짜리 공장에
 * 맞지 않는다.
 */
const MAX_CANDIDATE_TRIES = 3;

/** 한 후보로 라인 끝까지 가본다. 담당자마다 작업 → 자기검수 순으로 돈다. */
async function runPass(brief: Brief, slotLabel: string, line: TeamMember[]): Promise<Brief> {
  let current = brief;

  for (const member of line) {
    const startedAt = Date.now();
    try {
      current = await member.work(current);
    } catch (e) {
      // 퇴짜를 놓은 담당자는 자기가 무엇을 거절했는지 모른다 — 알고 있는 건
      // 여기다. 어떤 상품이 왜 떨어졌는지 브리프에 적어서 다시 던진다.
      // 소싱 담당이 이 목록을 보고 "같은 이유로 떨어질 것" 을 피한다.
      if (e instanceof HandoffError && e.retryable && current.product) {
        throw new CandidateRejected(current, {
          titleKo: current.product.titleKo,
          by: member.id,
          reason: e.message,
        });
      }
      throw e;
    }

    const review = await member.review(current);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (!review.ok) {
      throw new HandoffError(
        member.id,
        `자기검수 불합격 (${elapsed}초): ${review.problems.join(' / ')}`,
      );
    }
    for (const w of review.warnings) {
      console.warn(`  ${slotLabel} [${member.role}] 경고: ${w}`);
    }
    console.log(`  ${slotLabel} [${member.role}] 완료 (${elapsed}초)`);
  }

  return current;
}

/** 퇴짜 맞은 후보와, 그때까지의 브리프를 함께 들고 올라간다. */
class CandidateRejected extends Error {
  constructor(
    readonly brief: Brief,
    readonly rejection: { titleKo: string; by: string; reason: string },
  ) {
    super(rejection.reason);
    this.name = 'CandidateRejected';
  }
}

/**
 * 슬롯 하나를 라인에 태운다. 후보가 떨어지면 다음 후보로 다시 돈다.
 *
 * ## 왜 필요한가
 *
 * HandoffError 에 `retryable` 플래그가 처음부터 있었는데 **아무도 읽지 않았다.**
 * 6차 제작이 그래서 멈췄다 — 제휴 담당이 "태양광 팬 모자는 한국에 같은 물건이
 * 없다" 며 retryable 로 던졌고(그 판단은 옳다), 그대로 실행이 끝났다. 소싱 담당이
 * 후보 20건을 긁어왔는데 1순위 하나가 안 팔린다고 나머지를 안 써본 것이다.
 *
 * 쓰지 않는 플래그는 "재시도한다" 는 거짓말이므로, 읽거나 없애야 했다. 읽기로 했다.
 */
export async function runLine(
  brief: Brief,
  slotLabel: string,
  // 테스트가 가짜 라인을 넣을 수 있게 열어뒀다. 후보 재시도는 "아래에서 퇴짜가
  // 났을 때만" 도는 경로라, 실제 실행에서는 몇 번에 한 번씩만 지나간다.
  // 그런 길일수록 틀린 채로 오래 남으므로 테스트로 눌러둔다.
  line: TeamMember[] = PRODUCTION_LINE,
): Promise<Brief> {
  let current = brief;

  for (let attempt = 1; attempt <= MAX_CANDIDATE_TRIES; attempt++) {
    try {
      return await runPass(current, slotLabel, line);
    } catch (e) {
      if (!(e instanceof CandidateRejected)) throw e;

      const rejected = [...(current.rejected ?? []), e.rejection];
      // 남은 후보는 마지막으로 돈 브리프가 들고 있다. 여기서 버리면 다음 회차가
      // 처음부터 발굴하게 된다.
      current = { ...e.brief, rejected, shortlist: e.brief.shortlist ?? [] };

      const remaining = current.shortlist?.length ?? 0;
      if (attempt === MAX_CANDIDATE_TRIES || remaining === 0) {
        throw new HandoffError(
          e.rejection.by,
          `후보 ${attempt}건이 모두 떨어졌습니다 (남은 후보 ${remaining}건).\n` +
            rejected.map((r) => `     · ${r.titleKo} — ${r.reason.split('\n')[0]}`).join('\n'),
          true,
        );
      }

      console.warn(
        `  ${slotLabel} "${e.rejection.titleKo}" 퇴짜 (${e.rejection.by}). ` +
          `다음 후보로 다시 돕니다 (${attempt}/${MAX_CANDIDATE_TRIES}, 남은 후보 ${remaining}건).`,
      );
    }
  }

  // for 문은 위에서 반드시 return 하거나 던진다. 여기는 도달하지 않는다.
  throw new HandoffError('orchestrator', '후보 재시도 루프가 비정상 종료했습니다.');
}

/**
 * 한 편만 만든다.
 *
 * 하루치 8편을 돌리기 전에 **한 편이 끝까지 가는지** 봐야 한다. 8개를 동시에 돌리면
 * 어느 단계가 왜 막혔는지 로그가 섞여서 안 보이고, 막히는 곳이 있으면 LLM 비용을
 * 8배로 태우고 나서 알게 된다.
 *
 * 채널은 인자로 고른다. 안 고르면 첫 번째 채널을 쓴다.
 */
export async function runOne(channelKey?: string): Promise<SlotOutcome> {
  const channel = channelKey
    ? CHANNELS.find((c) => c.key === channelKey)
    : CHANNELS[0];

  if (!channel) {
    throw new Error(
      `채널 "${channelKey}" 를 찾을 수 없습니다. ` +
        `가능한 값: ${CHANNELS.map((c) => c.key).join(', ')}`,
    );
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const runId = await openRun(runDate);
  const key: AudienceKey =
    channel.audience ?? PLATFORM_DEFAULT_AUDIENCE[channel.platform] ?? 'general';
  const brief: Brief = { runId, channel, audience: audienceFor(key), notes: [] };

  console.log(`\n=== 한 편 제작: ${channel.key} (${channel.category}) ===\n`);
  const label = `[${channel.key}]`;
  const startedAt = Date.now();

  try {
    const done = await runLine(brief, label);
    await db()
      .from('runs')
      .update({
        status: 'awaiting_approval',
        cost_usd: estimateCostUsd(),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    // 완성본은 Supabase 스토리지에만 올라간다. 한 편 모드에서는 눈으로 봐야 하므로
    // 로컬에도 떨군다 — Actions 아티팩트로 받아 재생하려면 파일이 작업 폴더에 있어야 한다.
    let localCopy = '';
    if (done.render?.storagePath) {
      localCopy = `out/${(done.product?.titleKo ?? 'shorts').replace(/[^\w가-힣]+/g, '-')}.mp4`;
      try {
        await mkdir('out', { recursive: true });
        await downloadFile(done.render.storagePath, localCopy);
      } catch (e) {
        // 내려받기 실패가 제작 실패는 아니다. 다만 조용히 넘기면 아티팩트가 빈 채로
        // 올라가고 "영상이 안 나왔다" 로 오해하게 된다.
        console.warn(`완성본을 로컬로 못 받았습니다: ${(e as Error).message}`);
        localCopy = '';
      }
    }

    console.log(`\n=== 완성: ${done.product?.titleKo} ===`);
    console.log(`실행 id: ${runId}`);
    if (localCopy) console.log(`파일: ${localCopy} (${done.render?.durationSec.toFixed(1)}초)`);
    for (const n of done.notes) {
      console.log(`  [${n.from}] ${n.message}`);
      if (n.caveat) console.log(`      주의: ${n.caveat}`);
    }
    console.log(`LLM 비용 약 $${estimateCostUsd().toFixed(2)} · ${((Date.now() - startedAt) / 1000).toFixed(0)}초`);

    return {
      channelKey: channel.key,
      slotIndex: 0,
      ok: true,
      ...(done.product?.titleKo ? { productTitle: done.product.titleKo } : {}),
      handoffs: done.notes.map((n) => ({
        from: n.from,
        message: n.message,
        ...(n.caveat ? { caveat: n.caveat } : {}),
      })),
    };
  } catch (e) {
    const failedAt = e instanceof HandoffError ? e.member : 'unknown';
    await db()
      .from('runs')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', runId);
    // 어디서 막혔는지가 전부다. 이 정보 없이 다시 돌리면 같은 곳에서 또 막힌다.
    console.error(`\n=== 중단: [${failedAt}] 단계 ===`);
    console.error((e as Error).message);
    throw e;
  } finally {
    await closeBrowser();
  }
}

export async function runDailyTeam(): Promise<SlotOutcome[]> {
  const runDate = new Date().toISOString().slice(0, 10);
  const runId = await openRun(runDate);

  console.log(
    `\n=== ${runDate} 제작 시작 · 슬롯 ${dailySlotCount()}개 ===\n`,
  );

  const slots = buildSlots(runId);
  const outcomes: SlotOutcome[] = [];

  for (const [index, brief] of slots.entries()) {
    const label = `[${index + 1}/${slots.length} ${brief.channel.key}]`;
    console.log(`${label} 시작 — ${brief.audience.label}`);

    const startedAt = Date.now();
    try {
      const done = await runLine(brief, label);
      outcomes.push({
        channelKey: brief.channel.key,
        slotIndex: index,
        ok: true,
        productTitle: done.product?.titleKo,
        handoffs: done.notes.map((n) => ({
          from: n.from,
          message: n.message,
          ...(n.caveat ? { caveat: n.caveat } : {}),
        })),
      });
      await logStage(runId, {
        stage: `slot:${brief.channel.key}:${index}`,
        ok: true,
        ms: Date.now() - startedAt,
        note: done.product?.titleKo ?? '',
      });
      console.log(`${label} 완료 — ${done.product?.titleKo}\n`);
    } catch (e) {
      const failedAt = e instanceof HandoffError ? e.member : 'unknown';
      const message = (e as Error).message;
      outcomes.push({
        channelKey: brief.channel.key,
        slotIndex: index,
        ok: false,
        failedAt,
        error: message,
        handoffs: [],
      });
      await logStage(runId, {
        stage: `slot:${brief.channel.key}:${index}`,
        ok: false,
        ms: Date.now() - startedAt,
        note: message,
      });
      console.error(`${label} 중단 — ${message}\n`);
    }
  }

  const succeeded = outcomes.filter((o) => o.ok).length;
  const cost = estimateCostUsd();

  await db()
    .from('runs')
    .update({
      status: succeeded > 0 ? 'awaiting_approval' : 'failed',
      cost_usd: cost,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);

  await closeBrowser();

  console.log(`=== ${succeeded}/${outcomes.length}편 완성 · LLM 비용 약 $${cost.toFixed(2)} ===`);

  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    console.log('\n막힌 지점:');
    // 어느 담당자에게서 자주 막히는지가 다음에 손볼 곳이다.
    const byMember = new Map<string, number>();
    for (const f of failures) {
      byMember.set(f.failedAt ?? '?', (byMember.get(f.failedAt ?? '?') ?? 0) + 1);
      console.log(`  ${f.channelKey}: [${f.failedAt}] ${f.error}`);
    }
    console.log('\n담당자별 실패 횟수:');
    for (const [member, count] of [...byMember].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${member}: ${count}건`);
    }
  }

  if (succeeded > 0) {
    console.log('\n대시보드에서 승인하면 배포됩니다.');
  } else {
    process.exitCode = 1;
  }

  return outcomes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyTeam().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
