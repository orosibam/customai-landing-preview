import { chromium, type BrowserContext, type Page } from 'playwright';
import { optionalEnv } from './config.js';

/**
 * 인스타그램에서 **해외에서 터진 릴스**를 찾을 수 있는지 재는 도구.
 *
 * ## 왜 인스타인가
 *
 * 발굴 담당은 원래 틱톡을 봤는데 두 가지가 겹쳤다. 러너에서 틱톡이 게시물 목록을
 * 로그인 없이 안 내주고(실측: 12번 스크롤에 0건), 사용자 쪽 틱톡 로그인도 지금
 * 안 된다. 그래서 인스타로 옮긴다.
 *
 * ## 무엇을 재는가
 *
 * 경로마다 로그인이 필요한지, 릴스 링크가 몇 개 나오는지를 따로 잰다.
 * 비로그인으로 되는 경로가 하나라도 있으면 사람 손이 줄어든다.
 *
 *   1. 해시태그 탐색    — 대개 로그인을 요구한다. 그래도 확인한다
 *   2. 공개 계정 릴스탭 — 일부는 비로그인으로 보인다
 *   3. 임베드 엔드포인트 — /p/<id>/embed/captioned/ 는 로그인 없이 열린다.
 *      다만 **id 를 알아야** 하므로 발굴이 아니라 상세 확인용이다
 *
 * 세션이 있으면(INSTAGRAM_STORAGE_STATE) 같은 경로를 로그인 상태로 한 번 더 재서
 * "세션이 있으면 몇 건" 을 함께 낸다. 그래야 세션을 넣을 가치가 있는지 판단된다.
 *
 * 출력은 구조만 — 릴스 URL 은 경로 모양까지만 찍는다.
 *
 * 실행:  npx tsx src/probe-instagram.ts carcleaning
 */

const TAG = process.argv[2] ?? 'carcleaning';

/** 해외 생활용품·청소 계열에서 릴스가 많이 도는 공개 계정. 발굴 후보 경로 확인용. */
const PUBLIC_ACCOUNTS = ['cleanwithme', 'homehacks'];

const LOGIN_MARKERS = [
  '/accounts/login',
  'Log in to Instagram',
  'Sign up to see',
  'Log In',
  '로그인',
];

function shape(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search ? ` ?(${u.search.length - 1}자)` : ''}`;
  } catch {
    return '(파싱 불가)';
  }
}

interface RouteResult {
  label: string;
  reels: number;
  needsLogin: boolean;
}

async function probeRoute(page: Page, label: string, url: string): Promise<RouteResult> {
  console.log(`\n── ${label} ─────────────────────────────`);
  console.log(`   ${shape(url)}`);

  const res = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 이동 실패: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return { label, reels: 0, needsLogin: false };

  await page.waitForTimeout(6_000);

  const landed = page.url();
  const html = await page.content();
  const visible = await page.locator('body').innerText().catch(() => '');

  console.log(
    `   HTTP ${res.status()} / HTML ${html.length.toLocaleString()}자 / 보이는 텍스트 ${visible.length.toLocaleString()}자`,
  );
  if (landed !== url) console.log(`   → 튕긴 곳: ${shape(landed)}`);

  const needsLogin =
    landed.includes('/accounts/login') ||
    LOGIN_MARKERS.some((m) => visible.includes(m)) ;

  // 릴스 링크만 센다. 정지 이미지 게시물은 설계도 추출에 못 쓴다.
  const reels: string[] = await page.$$eval('a[href*="/reel/"]', (ns) =>
    [...new Set(ns.map((n) => (n as HTMLAnchorElement).href))],
  );

  console.log(`   릴스 링크 ${reels.length}개 / 로그인 요구: ${needsLogin ? '예' : '아니오'}`);
  for (const r of reels.slice(0, 3)) console.log(`     · ${shape(r)}`);
  if (reels.length === 0) {
    console.log(`   화면 앞부분: ${visible.replace(/\s+/g, ' ').slice(0, 180) || '(비어 있음)'}`);
  }

  return { label, reels: reels.length, needsLogin };
}

async function runRoutes(ctx: BrowserContext, mode: string): Promise<RouteResult[]> {
  const page = await ctx.newPage();
  const out: RouteResult[] = [];

  console.log(`\n════════ ${mode} ════════`);

  out.push(
    await probeRoute(page, `해시태그 #${TAG}`, `https://www.instagram.com/explore/tags/${TAG}/`),
  );
  await page.waitForTimeout(3_000);

  for (const acct of PUBLIC_ACCOUNTS) {
    out.push(await probeRoute(page, `공개 계정 @${acct} 릴스탭`, `https://www.instagram.com/${acct}/reels/`));
    await page.waitForTimeout(3_000);
  }

  await page.close();
  return out;
}

async function main(): Promise<void> {
  console.log(`인스타그램에서 터진 릴스를 발굴할 수 있는지 잽니다.`);
  console.log(`해시태그: #${TAG}`);

  const browser = await chromium.launch({
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const baseOpts = {
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  };

  let anon: RouteResult[] = [];
  let withSession: RouteResult[] = [];

  try {
    const ctx = await browser.newContext(baseOpts);
    anon = await runRoutes(ctx, '비로그인');
    await ctx.close();

    const state = optionalEnv('INSTAGRAM_STORAGE_STATE', '');
    if (state) {
      const ctx2 = await browser.newContext({ ...baseOpts, storageState: JSON.parse(state) });
      withSession = await runRoutes(ctx2, '세션 있음');
      await ctx2.close();
    } else {
      console.log(`\n════════ 세션 있음 ════════`);
      console.log(`   INSTAGRAM_STORAGE_STATE 가 없어 건너뜁니다.`);
      console.log(`   npm run capture instagram 으로 세션을 뜬 뒤 Secrets 에 넣으면 여기도 잽니다.`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n═══ 정리 ═══`);
  const line = (r: RouteResult): string =>
    `${r.label.padEnd(30)} 릴스 ${String(r.reels).padStart(3)}개  ${r.needsLogin ? '로그인 요구' : ''}`;
  console.log(`[비로그인]`);
  for (const r of anon) console.log(`  ${line(r)}`);
  if (withSession.length) {
    console.log(`[세션 있음]`);
    for (const r of withSession) console.log(`  ${line(r)}`);
  }

  const anonBest = Math.max(0, ...anon.map((r) => r.reels));
  const sessionBest = Math.max(0, ...withSession.map((r) => r.reels));

  if (anonBest > 0) {
    console.log(`\n→ 비로그인으로 릴스를 ${anonBest}개까지 얻었습니다. 세션 없이 발굴이 가능합니다.`);
  } else if (sessionBest > 0) {
    console.log(`\n→ 비로그인은 0건이지만 세션이 있으면 ${sessionBest}개 나옵니다. 세션이 필요합니다.`);
  } else {
    // 조용히 넘어가지 않는다. 여기가 0이면 발굴 단계를 다시 설계해야 한다.
    throw new Error(
      `모든 경로에서 릴스를 한 건도 못 얻었습니다.\n` +
        `   세션이 없으면 넣어보고, 세션이 있는데도 0이면 경로 설계를 바꿔야 합니다.`,
    );
  }
}

main().catch((e: Error) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
