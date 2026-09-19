import { DUPLICATE_MODE, dailySlotCount } from './config.js';
import { db, logStage, must, openRun } from './lib/supabase.js';
import { closeBrowser } from './lib/browser.js';
import { estimateCostUsd } from './lib/llm.js';
import { pickProducts, type Slot } from './stages/s1-pick-products.js';
import { findReferences } from './stages/s2-find-references.js';
import { extractBlueprint } from './stages/s3-extract-blueprint.js';
import { collectAssets } from './stages/s4-collect-assets.js';
import { writeScript } from './stages/s5-write-script.js';
import { narrateScript } from './stages/s6-narrate.js';
import { render } from './stages/s7-render.js';

/**
 * 매일 도는 오케스트레이터.
 *
 * S1~S7까지 돌린 뒤 **승인 대기 상태로 멈춘다.** 배포(S9)는 사람이 대시보드에서
 * 승인 버튼을 눌러야 시작된다. 이게 "생성 100% 자동 + 배포만 승인" 의 구현이다.
 *
 * 슬롯 하나가 실패해도 나머지는 계속 간다. 하루치가 통째로 날아가는 것보다
 * 8개라도 올라가는 편이 낫다.
 */

interface SlotOutcome {
  slot: Slot;
  ok: boolean;
  error?: string;
}

async function channelIdFor(key: string): Promise<string> {
  const row = await must(
    `채널 조회 (${key})`,
    db().from('channels').select('id').eq('key', key).single(),
  );
  return (row as { id: string }).id;
}

async function processSlot(runId: string, slot: Slot): Promise<void> {
  const references = await findReferences(slot);
  const best = references[0];
  if (!best) throw new Error('레퍼런스가 비어 있습니다.');

  const blueprint = await extractBlueprint(best);
  const { assets, assignments } = await collectAssets(slot, blueprint);
  const script = await writeScript(slot, blueprint);
  const narration = await narrateScript(slot, script);

  const channelId = await channelIdFor(slot.channel.key);
  await render({ runId, slot, script, narration, assets, assignments, channelId });
}

export async function runDaily(): Promise<void> {
  const runDate = new Date().toISOString().slice(0, 10);
  const runId = await openRun(runDate);

  console.log(`\n=== ${runDate} 실행 시작 (슬롯 ${dailySlotCount()}개${DUPLICATE_MODE ? ', 복제 모드' : ''}) ===\n`);

  const startedAt = Date.now();
  const outcomes: SlotOutcome[] = [];

  try {
    const slots = await pickProducts(runId);
    await logStage(runId, { stage: 'S1', ok: true, ms: Date.now() - startedAt });

    for (const slot of slots) {
      const slotStart = Date.now();
      try {
        await processSlot(runId, slot);
        outcomes.push({ slot, ok: true });
        await logStage(runId, {
          stage: `slot:${slot.channel.key}`,
          ok: true,
          ms: Date.now() - slotStart,
          note: slot.product.title_ko,
        });
      } catch (e) {
        const error = (e as Error).message;
        console.error(`\n슬롯 실패 [${slot.channel.key}] ${slot.product.title_ko}\n  ${error}\n`);
        outcomes.push({ slot, ok: false, error });
        await logStage(runId, {
          stage: `slot:${slot.channel.key}`,
          ok: false,
          ms: Date.now() - slotStart,
          note: error,
        });
      }
    }
  } catch (e) {
    await logStage(runId, { stage: 'S1', ok: false, ms: Date.now() - startedAt, note: (e as Error).message });
    await db().from('runs').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', runId);
    await closeBrowser();
    throw e;
  }

  const succeeded = outcomes.filter((o) => o.ok).length;
  const cost = estimateCostUsd();

  await db()
    .from('runs')
    .update({
      // 하나라도 성공했으면 승인 대기. 전부 실패했으면 실패로 남긴다.
      status: succeeded > 0 ? 'awaiting_approval' : 'failed',
      cost_usd: cost,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);

  await closeBrowser();

  console.log(`\n=== 완료: ${succeeded}/${outcomes.length}개 생성 · LLM 비용 약 $${cost.toFixed(2)} ===`);
  if (succeeded > 0) {
    console.log('대시보드에서 승인하면 배포됩니다.\n');
  }
  for (const o of outcomes.filter((x) => !x.ok)) {
    console.log(`  실패 [${o.slot.channel.key}] ${o.slot.product.title_ko}: ${o.error}`);
  }

  // 전부 실패했으면 CI를 빨갛게 만든다. 조용히 성공한 척하지 않는다.
  if (succeeded === 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDaily().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
