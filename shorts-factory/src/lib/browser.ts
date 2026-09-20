import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * 브라우저 자동화 공통 래퍼.
 *
 * 레퍼런스 수집(틱톡·인스타), 타입캐스트(API 불가 시), 네이버/인스타/틱톡 업로드가
 * 전부 이걸 쓴다. 세션은 저장된 storageState 로 복원하고, 만료되면 호출부가
 * 사람이 다시 로그인하도록 대시보드에 작업을 띄운다.
 */

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: process.env.HEADFUL !== 'true',
      // 컨테이너 환경에서 필요한 최소 플래그만.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    });
  }
  return browser;
}

export interface SessionOptions {
  /** Playwright storageState JSON. 저장된 로그인 세션을 복원할 때 쓴다. */
  storageState?: string;
  locale?: string;
  timezone?: string;
}

export async function newContext(opts: SessionOptions = {}): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.newContext({
    viewport: { width: 1440, height: 900 },
    locale: opts.locale ?? 'ko-KR',
    timezoneId: opts.timezone ?? 'Asia/Seoul',
    ...(opts.storageState ? { storageState: JSON.parse(opts.storageState) } : {}),
  });
}

/**
 * 세션이 살아있는지 확인한다.
 * 로그인 페이지로 튕기면 만료된 것으로 본다 — 호출부는 이걸 받아서
 * `channels.blocked_reason` 에 사유를 남기고 사람 손을 부른다.
 */
export async function isSessionAlive(page: Page, loggedInSelector: string): Promise<boolean> {
  try {
    await page.waitForSelector(loggedInSelector, { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

export class SessionExpiredError extends Error {
  /**
   * @param target  어느 사이트인지. 짧게 — 이 값이 문장에 그대로 끼워진다.
   * @param hint    이번 건에서 무엇을 하면 되는지. 사이트마다 복구 방법이 달라서
   *                (재로그인 / 세션 다시 뜨기 / 콘솔 방식으로 우회) 호출부가 알려준다.
   *                생략하면 기존 문구 그대로다.
   */
  constructor(
    public readonly target: string,
    public readonly hint?: string,
  ) {
    super(
      `${target} 세션이 만료되었습니다. ` +
        (hint ?? '대시보드에서 재로그인이 필요합니다.'),
    );
    this.name = 'SessionExpiredError';
  }
}

/**
 * 브라우저 프로필 폴더를 그대로 쓰는 컨텍스트.
 *
 * 왜 storageState 로 부족한가: 샤오홍슈는 쿠키만 옮겨서는 로그인이 넘어가지 않는다.
 * 실측에서 쿠키 31개를 저장해 복원했는데도 검색 페이지가 「登录后查看搜索结果」
 * (로그인해야 검색 결과를 볼 수 있습니다) 로 떴다. localStorage 와 브라우저 프로필에
 * 묶인 값이 더 있다는 뜻이다.
 *
 * 프로필 폴더를 통째로 재사용하면 쿠키·localStorage·IndexedDB 가 전부 따라온다.
 * 대신 이 컨텍스트는 공유 브라우저를 쓸 수 없어 매번 새로 띄운다 — 느리지만
 * 로그인이 실제로 유지되는 쪽이 낫다.
 */
export async function withPersistentContext<T>(
  userDataDir: string,
  opts: Omit<SessionOptions, 'storageState'>,
  fn: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1440, height: 900 },
    locale: opts.locale ?? 'ko-KR',
    timezoneId: opts.timezone ?? 'Asia/Seoul',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/** 컨텍스트를 쓰고 반드시 닫는다. */
export async function withContext<T>(
  opts: SessionOptions,
  fn: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const ctx = await newContext(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/** 사람처럼 잠깐 쉰다. 스크롤·클릭 사이에 최소한의 간격을 둔다. */
export async function pause(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await new Promise((r) => setTimeout(r, ms));
}
