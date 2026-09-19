import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * 브라우저 자동화 공통 래퍼.
 *
 * 레퍼런스 수집, 타오바오 소재 수집, 타입캐스트(API 불가 시), 네이버/인스타/틱톡 업로드가
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
  constructor(public readonly target: string) {
    super(`${target} 세션이 만료되었습니다. 대시보드에서 재로그인이 필요합니다.`);
    this.name = 'SessionExpiredError';
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
