/**
 * 실행기.
 *
 *   npx tsx src/stage.ts team          팀 구성 출력
 *   npx tsx src/stage.ts daily         오늘치 제작 (승인 대기까지)
 *   npx tsx src/stage.ts publish --run-id=<uuid>
 *   npx tsx src/stage.ts metrics
 *   npx tsx src/stage.ts report        성과 요약
 */

import { closeBrowser } from './lib/browser.js';
import { db } from './lib/supabase.js';
import { describeTeam } from './team/index.js';
import { runDailyTeam } from './team/orchestrator.js';
import { publishApproved } from './team/members/publisher.js';
import { buildReport, collectMetrics, formatReport } from './team/members/growth.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** 승인 대기 중인 가장 최근 실행을 찾는다. */
async function latestAwaitingRun(): Promise<string | null> {
  const { data } = await db()
    .from('runs')
    .select('id')
    .eq('status', 'awaiting_approval')
    .order('run_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

const COMMANDS: Record<string, () => Promise<void>> = {
  team: async () => {
    console.log(`\n${describeTeam()}\n`);
  },

  daily: async () => {
    await runDailyTeam();
  },

  publish: async () => {
    const runId = arg('run-id') ?? (await latestAwaitingRun());
    if (!runId) {
      console.log('승인 대기 중인 실행이 없습니다.');
      return;
    }
    const { ok, failed, deferred } = await publishApproved(runId);
    console.log(`배포: 성공 ${ok}건, 실패 ${failed}건, 대기 ${deferred}건`);
    // 대기는 실패가 아니다. 예정 시각이 아직 안 된 것뿐이라 30분 뒤 다시 집는다.
    if (ok === 0 && failed > 0) process.exitCode = 1;
  },

  metrics: async () => {
    await collectMetrics(Number(arg('lookback') ?? 14));
  },

  report: async () => {
    console.log(`\n${formatReport(await buildReport())}\n`);
  },
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const command = name ? COMMANDS[name] : undefined;

  if (!command) {
    console.error(`사용법: npx tsx src/stage.ts <${Object.keys(COMMANDS).join('|')}> [--run-id=<uuid>]`);
    process.exit(1);
  }

  try {
    await command();
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
