import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { withContext, withPersistentContext, pause, SessionExpiredError } from '../browser.js';
import { optionalEnv } from '../../config.js';
import { db, must } from '../supabase.js';
import type { LinkPlatform } from './linkstore.js';

/**
 * 소재 링크 수확 — 자동판.
 *
 * ## 왜 이게 필요한가
 *
 * 샤오홍슈·1688 둘 다 **비로그인으로는 키워드 검색이 안 된다.** 홈피드는 열리지만
 * 무작위라 조준이 안 되고(980건에 적중 0건), 1688 검색 페이지는 HTML 이 껍데기라
 * 상품 데이터가 없다. 검증된 유일한 경로는 **로그인된 브라우저에서 검색 결과의
 * href 를 통째로 긁는 것**이다.
 *
 * ## 그런데 그걸 사람이 할 이유는 없다
 *
 * 처음엔 브라우저 콘솔에 붙여넣는 코드(`harvest/*.js`)로 만들었는데, 그건 매번
 * 사람이 창을 열고 검색하고 붙여넣어야 한다. 이 프로젝트엔 이미 그 문제를 푸는
 * 장치가 있다 — `npm run capture` 로 **로그인을 한 번만** 하면 세션이 저장되고,
 * 그 다음부터는 자동화가 그 세션으로 움직인다. 틱톡·네이버가 이미 그렇게 돈다.
 *
 * 그래서 사람이 하는 일은 「로그인 1회」로 줄고, 검색·스크롤·수집·저장은 여기서 한다.
 *
 * ## href 를 자르지 않는다
 *
 * `a.href` 프로퍼티를 읽는다 — 절대 URL 로 해석되면서 쿼리스트링이 보존된다.
 * `getAttribute('href')` 를 쓰면 상대경로가 나와 토큰이 깨진다. note id 만 남기고
 * xsec_token 을 버리면 그 링크는 전부 404 이고, 실제로 그렇게 55건을 날린 적이 있다.
 *
 * ## 막히면 조용히 넘어가지 않는다
 *
 * 샤오홍슈는 자동화 브라우저를 감지해 로그인 벽을 다시 띄울 수 있다. 그 경우
 * `SessionExpiredError` 를 던진다 — 0건을 성공으로 위장하면 며칠 뒤 "영상은 나갔는데
 * 소재가 다 똑같다" 로 돌아온다. 끝까지 막히면 `harvest/*.js` 콘솔 방식이 남아 있다.
 */

export interface HarvestResult {
  platform: LinkPlatform;
  keyword: string;
  /** 페이지에서 긁은 링크 수 */
  found: number;
  /** DB 에 새로 들어간 수 (이미 있던 건 제외) */
  inserted: number;
}

interface SiteSpec {
  storageEnv: string;
  /** npm run capture 가 세션을 떨구는 이름 (.sessions/<key>.json, .sessions/<key>-profile/) */
  sessionKey: string;
  label: string;
  searchUrl: (keyword: string) => string;
  /** 이 패턴에 맞는 href 만 남긴다 */
  keep: (url: string) => boolean;
  /** 로그인 벽이 떴는지 */
  blockedText: string[];
  locale: string;
  timezone: string;
}

/**
 * 자동 수확이 가능한 곳만 적는다.
 *
 * 알리익스프레스·타오바오는 여기 없다. 둘은 **사람 브라우저에서 상세까지 열어
 * mp4 주소를 뽑는** 방식이라(harvest/product-video.js) 검색 결과 href 를 긁는
 * 이 방식과 절차가 다르다. 없는 걸 있는 것처럼 Record 로 적어두면 타입은
 * 통과하고 실행이 undefined 로 터진다.
 */
const SITES: Partial<Record<LinkPlatform, SiteSpec>> = {
  xiaohongshu: {
    storageEnv: 'XIAOHONGSHU_STORAGE_STATE',
    sessionKey: 'xhs',
    label: '샤오홍슈',
    searchUrl: (k) =>
      `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(k)}&type=video`,
    // 토큰 없는 링크는 저장해봐야 404 다. 여기서 걸러 나중에 헛수고를 막는다.
    keep: (u) =>
      (u.includes('/explore/') || u.includes('/discovery/item/')) && u.includes('xsec_token='),
    blockedText: ['登录后查看', '登录发现更多', '扫码登录'],
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
  ali1688: {
    storageEnv: 'ALI1688_STORAGE_STATE',
    sessionKey: 'ali',
    label: '1688',
    searchUrl: (k) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(k)}`,
    keep: (u) => /detail\.1688\.com\/offer\/\d+/.test(u),
    blockedText: ['请登录', '滑动验证'],
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
};

/** 스크롤 횟수. 올리면 더 모이지만 그만큼 오래 머물러 차단 위험이 는다. */
const SCROLL_ROUNDS = Number(optionalEnv('HARVEST_SCROLL_ROUNDS', '10'));

/**
 * 검색 결과에서 링크를 긁어 `harvested_links` 에 쌓는다.
 *
 * 같은 키워드를 다시 수확해도 안전하다 — URL 전체로 unique 가 걸려 있어 겹치는 건
 * 그냥 무시된다. 새로 몇 건이 들어갔는지만 센다.
 */
/**
 * 로그인 세션을 찾는다.
 *
 * `npm run capture` 가 `.sessions/<key>.json` 에 파일로 떨군다. 그걸 다시 손으로
 * .env 에 복사하게 하면 단계가 하나 늘고, 그 단계에서 사람이 막힌다.
 * 그래서 **파일이 있으면 그냥 쓴다.** 환경변수는 파일이 없는 곳(Actions 러너)용이다.
 */
async function loadSession(site: SiteSpec): Promise<string> {
  const fromEnv = optionalEnv(site.storageEnv, '');
  if (fromEnv) return fromEnv;

  const path = `.sessions/${site.sessionKey}.json`;
  const fromFile = await readFile(path, 'utf8').catch(() => '');
  if (fromFile) {
    console.log(`${site.label} 세션을 ${path} 에서 읽었습니다.`);
    return fromFile;
  }

  throw new SessionExpiredError(
    site.label,
    `로그인 세션이 없습니다. \`npm run capture ${site.sessionKey}\` 로 한 번만 ` +
      `로그인하면 그 뒤로는 자동으로 돕니다. ` +
      `(${path} 파일이나 ${site.storageEnv} 환경변수 중 하나만 있으면 됩니다)`,
  );
}

export async function harvest(
  platform: LinkPlatform,
  keyword: string,
): Promise<HarvestResult> {
  const site = SITES[platform];
  if (!site) {
    throw new Error(
      `${platform} 는 자동 수확 대상이 아닙니다. ` +
        `상세를 열어 mp4 주소까지 뽑아야 하므로 브라우저 스니펫을 쓰세요:\n` +
        `     npm run links snippet video`,
    );
  }
  const profileDir = `.sessions/${site.sessionKey}-profile`;
  const hasProfile = existsSync(profileDir);

  // 프로필이 있으면 그쪽이 우선이다. 쿠키만으로는 샤오홍슈 로그인이 넘어가지 않는다
  // (쿠키 31개를 복원했는데도 검색이 로그인 벽으로 떴다). 프로필은 localStorage 까지
  // 통째로 들고 간다.
  const run = hasProfile
    ? <T,>(fn: Parameters<typeof withContext<T>>[1]) =>
        withPersistentContext(profileDir, { locale: site.locale, timezone: site.timezone }, fn)
    : async <T,>(fn: Parameters<typeof withContext<T>>[1]) => {
        const storageState = await loadSession(site);
        return withContext({ storageState, locale: site.locale, timezone: site.timezone }, fn);
      };

  console.log(
    hasProfile
      ? `${site.label} 프로필을 ${profileDir} 에서 씁니다.`
      : `${site.label} — 프로필이 없어 쿠키만 복원합니다. 로그인 벽이 뜨면 npm run capture ${site.sessionKey} 로 다시 받으세요.`,
  );

  const links = await run(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(site.searchUrl(keyword), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await pause(3_000, 5_000);

      // 앞 200KB 만 잘라서 보고 있었다. 로그인 벽 문구가 그 뒤에 있으면 못 잡고,
      // 그러면 "검색 결과가 비었다" 로 오진한다. 실제로 그렇게 틀렸다.
      // 본문 전체를 보고, 눈에 보이는 텍스트로도 한 번 더 확인한다.
      const body = await page.content();
      const visible = await page.locator('body').innerText().catch(() => '');
      const hit = site.blockedText.find((t) => body.includes(t) || visible.includes(t));
      if (hit) {
        throw new SessionExpiredError(
          site.label,
          `검색 페이지가 로그인 벽으로 떴습니다 ("${hit}"). ` +
            `npm run capture ${site.sessionKey} 로 다시 로그인하세요. ` +
            `그래도 막히면 harvest/*.js 콘솔 방식으로 우회할 수 있습니다.`,
        );
      }

      const collected = new Map<string, string>();

      const scrape = async () => {
        // a.href 는 절대 URL 로 해석되면서 쿼리스트링을 보존한다.
        // getAttribute('href') 를 쓰면 상대경로가 나와 토큰 조합이 깨진다.
        const rows = await page.$$eval('a[href]', (nodes) =>
          nodes.map((n) => ({
            url: (n as HTMLAnchorElement).href,
            title:
              n.getAttribute('title') ||
              n.querySelector('img')?.getAttribute('alt') ||
              n.textContent?.trim().slice(0, 120) ||
              '',
          })),
        );
        for (const row of rows) {
          if (!site.keep(row.url)) continue;
          if (!collected.has(row.url)) collected.set(row.url, row.title);
        }
      };

      await scrape();
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2_400);
        await pause(1_200, 2_200);
        await scrape();
      }

      return [...collected].map(([url, title]) => ({ url, title }));
  });

  if (links.length === 0) {
    // "로그인 벽은 아니었으므로" 라고 단정하던 문구를 뺐다. 실제로는 로그인 벽이었는데
    // 판정이 못 잡아서 엉뚱한 곳을 보게 만들었다. 아는 것만 말한다.
    throw new Error(
      `${site.label} / "${keyword}" 에서 링크를 한 건도 못 긁었습니다.\n` +
        `   알려진 문구의 로그인 벽은 아니었습니다. 가능한 원인:\n` +
        `   · 로그인 벽인데 문구가 바뀌어 판정이 못 잡음 (제일 흔함)\n` +
        `   · 검색 결과가 실제로 없음 (검색어를 바꿔보세요)\n` +
        `   · 페이지 구조가 바뀜\n` +
        `   HEADFUL=true npm run links harvest ${site.sessionKey} ${keyword} 로 띄워 눈으로 보세요.`,
    );
  }

  const rows = links.map((l) => ({
    platform,
    keyword,
    url: l.url,
    title: l.title || null,
  }));

  const inserted = await must(
    '수확 링크 저장',
    db()
      .from('harvested_links')
      .upsert(rows, { onConflict: 'url', ignoreDuplicates: true })
      .select('id'),
  );

  return {
    platform,
    keyword,
    found: links.length,
    inserted: (inserted as { id: string }[]).length,
  };
}
