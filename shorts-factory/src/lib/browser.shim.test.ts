import { strict as assert } from 'node:assert';
import { withContext, closeBrowser } from './browser.js';

/**
 * `__name is not defined` 회귀 테스트.
 *
 * tsx(esbuild)가 함수 이름 보존용으로 주입하는 `__name` 헬퍼는 node 쪽에만 있는데,
 * Playwright 는 evaluate 콜백을 문자열로 직렬화해 브라우저에서 실행한다. 그래서
 * 콜백 안에 함수 선언이 하나라도 있으면 브라우저에서 ReferenceError 로 터진다.
 *
 * 이것 때문에 인스타 릴스 읽기가 전부 실패해 발굴이 0건이 됐고, 첫 단계라
 * 파이프라인이 통째로 멈췄다. 심을 넣어 고쳤는데, 고쳤다고 믿는 것과 도는 것은
 * 다르므로 아래처럼 **실제로 함수를 선언하는 콜백**으로 확인한다.
 */
async function main(): Promise<void> {
  const ok = await withContext({}, async (ctx) => {
    const page = await ctx.newPage();
    await page.goto('about:blank');
    return page.evaluate(() => {
      // 이 한 줄이 esbuild 에서 __name(...) 호출로 바뀐다. 심이 없으면 여기서 터진다.
      const helper = (x: number): number => x * 2;
      return helper(21);
    });
  });

  assert.equal(ok, 42, 'evaluate 안에서 함수를 선언해도 터지지 않아야 한다');
  await closeBrowser();
  console.log('✓ evaluate 안 함수 선언 — __name 심 정상');
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
