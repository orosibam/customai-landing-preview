/**
 * 스테이지 단독 실행기.
 *
 * 파이프라인 전체를 돌리지 않고 한 단계만 따로 돌려본다. 개발 중에도,
 * 운영에서 특정 단계가 실패했을 때 재현할 때도 쓴다.
 *
 *   npx tsx src/stage.ts s1
 *   npx tsx src/stage.ts s9 --run-id=<uuid>
 *   npx tsx src/stage.ts s10
 */

import { closeBrowser } from './lib/browser.js';
import { openRun } from './lib/supabase.js';
import { pickProducts } from './stages/s1-pick-products.js';
import { publish } from './stages/s9-publish.js';
import { collectMetrics } from './stages/s10-collect-metrics.js';
import { runDaily } from './run-daily.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const STAGES: Record<string, () => Promise<void>> = {
  s1: async () => {
    const runId = arg('run-id') ?? (await openRun(new Date().toISOString().slice(0, 10)));
    await pickProducts(runId);
  },
  s9: async () => {
    const runId = arg('run-id');
    if (!runId) throw new Error('s9 는 --run-id=<uuid> 가 필요합니다.');
    await publish(runId);
  },
  s10: async () => {
    await collectMetrics(Number(arg('lookback') ?? 14));
  },
  all: runDaily,
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const stage = name ? STAGES[name] : undefined;

  if (!stage) {
    console.error(`사용법: npx tsx src/stage.ts <${Object.keys(STAGES).join('|')}> [--run-id=<uuid>]`);
    console.error('\nS2~S7은 앞 단계의 산출물이 필요해서 단독 실행 대신 `all` 로 돌립니다.');
    process.exit(1);
  }

  try {
    await stage();
  } finally {
    await closeBrowser();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
