import { CHANNELS, dailySlotCount } from '../config.js';
import { audienceFor, PLATFORM_DEFAULT_AUDIENCE, type AudienceKey } from '../lib/audience.js';
import { closeBrowser } from '../lib/browser.js';
import { estimateCostUsd } from '../lib/llm.js';
import { db, logStage, openRun } from '../lib/supabase.js';
import { PRODUCTION_LINE } from './index.js';
import { HandoffError, type Brief } from './types.js';

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

/** 슬롯 하나를 라인에 태운다. 담당자마다 작업 → 자기검수 순으로 돈다. */
async function runLine(brief: Brief, slotLabel: string): Promise<Brief> {
  let current = brief;

  for (const member of PRODUCTION_LINE) {
    const startedAt = Date.now();
    current = await member.work(current);

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

    console.log(`\n=== 완성: ${done.product?.titleKo} ===`);
    console.log(`실행 id: ${runId}`);
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
