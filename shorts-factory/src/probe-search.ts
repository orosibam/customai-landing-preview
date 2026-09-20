import { chromium, type Page } from 'playwright';

/**
 * 검색 페이지를 **로그인 없이 진짜 브라우저로** 열면 무엇이 보이는지 재는 도구.
 *
 * ## 왜 다시 재는가
 *
 * 앞선 실측은 전부 생 HTTP(curl_cffi)였다. 1688 검색은 25KB 를 주는데 그 안에
 * `detail.1688.com/offer` 링크가 0건이었고, 거기서 "상품 목록을 JS 가 나중에 받아온다"
 * 는 결론을 냈다. 그 결론이 맞다면 **JS 를 실행하는 브라우저로 열면 보여야 한다.**
 * 그걸 한 번도 확인하지 않고 곧장 "로그인이 필요하다" 로 건너뛰었다.
 *
 * 이게 중요한 이유: 로그인 없이 된다면 수확이 Actions 안에서 혼자 돈다. 사람이
 * `npm run capture` 를 돌릴 일 자체가 없어진다.
 *
 * ## 무엇을 출력하는가
 *
 * 값이 아니라 **구조만** 찍는다. 쿠키·토큰은 찍지 않는다 — 이 출력은 그대로 공유해도
 * 안전해야 한다. 링크는 호스트와 경로 모양까지만 보여주고 쿼리스트링은 길이만 센다.
 *
 * 실행:  npx tsx src/probe-search.ts [검색어]
 */

const KEYWORD = process.argv[2] ?? '洗车液';

interface SiteProbe {
  label: string;
  url: string;
  /** 이 패턴에 맞는 href 를 "상품/노트 링크" 로 센다 */
  keep: (u: string) => boolean;
  /** 로그인 벽 문구 */
  blocked: string[];
}

const SITES: SiteProbe[] = [
  {
    label: '샤오홍슈 검색',
    url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(KEYWORD)}&type=video`,
    keep: (u) => u.includes('/explore/') || u.includes('/discovery/item/'),
    blocked: ['登录后查看', '登录发现更多', '扫码登录'],
  },
  {
    label: '1688 검색',
    url: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(KEYWORD)}`,
    keep: (u) => /detail\.1688\.com\/offer\/\d+/.test(u),
    blocked: ['请登录', '滑动验证', '验证码'],
  },
  {
    label: '1688 모바일 검색',
    url: `https://m.1688.com/offer_search/-6D7launcher.html?keywords=${encodeURIComponent(KEYWORD)}`,
    keep: (u) => /(detail|m)\.1688\.com\/(offer|page)\/\d+/.test(u),
    blocked: ['请登录', '滑动验证', '验证码'],
  },
];

/** 쿼리스트링은 토큰이 들어있을 수 있으니 길이만 센다. */
function shape(url: string): string {
  try {
    const u = new URL(url);
    const q = u.search ? ` ?(${u.search.length - 1}자, 키 ${[...u.searchParams.keys()].join(',')})` : '';
    return `${u.host}${u.pathname}${q}`;
  } catch {
    return '(파싱 불가)';
  }
}

async function probe(page: Page, site: SiteProbe): Promise<void> {
  console.log(`\n── ${site.label} ─────────────────────────────`);
  console.log(`   ${site.url}`);

  const res = await page
    .goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 이동 실패: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return;

  console.log(`   HTTP ${res.status()}`);

  // JS 렌더를 기다린다. 이 대기가 앞선 생 HTTP 측정에는 없던 부분이다.
  await page.waitForTimeout(6_000);

  const html = await page.content();
  const visible = await page.locator('body').innerText().catch(() => '');
  console.log(`   HTML ${html.length.toLocaleString()}자 / 보이는 텍스트 ${visible.length.toLocaleString()}자`);

  const wall = site.blocked.filter((t) => html.includes(t) || visible.includes(t));
  console.log(`   로그인 벽 문구: ${wall.length ? wall.join(', ') : '없음'}`);

  const hrefs: string[] = await page.$$eval('a[href]', (ns) =>
    ns.map((n) => (n as HTMLAnchorElement).href),
  );
  const hits = [...new Set(hrefs.filter(site.keep))];
  console.log(`   전체 a[href] ${hrefs.length}개 / 상품·노트 링크 ${hits.length}개`);

  if (hits.length) {
    console.log(`   예시 (쿼리스트링은 길이만):`);
    for (const h of hits.slice(0, 3)) console.log(`     · ${shape(h)}`);
  } else {
    // 왜 0인지 좁힐 수 있게, 화면에 뭐가 떠 있는지 앞부분만 보여준다.
    const head = visible.replace(/\s+/g, ' ').slice(0, 200);
    console.log(`   화면 앞부분: ${head || '(비어 있음)'}`);
  }

  console.log(`   → 판정: ${
    wall.length ? '로그인 필요' : hits.length ? '로그인 없이 수확 가능' : '벽은 없는데 링크가 안 나옴'
  }`);
}

async function main(): Promise<void> {
  console.log(`검색어: ${KEYWORD}`);
  console.log(`로그인 세션 없이, 진짜 브라우저로 엽니다.`);

  const browser = await chromium.launch({
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    for (const site of SITES) {
      await probe(page, site).catch((e: Error) => {
        // 한 사이트가 터져도 나머지는 재야 한다. 무엇을 하다 실패했는지는 남긴다.
        console.log(`   ✗ ${site.label} 측정 중 실패: ${e.message.split('\n')[0]}`);
      });
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n끝. "로그인 없이 수확 가능" 이 하나라도 있으면 사람이 로그인할 일이 없습니다.`);
}

main().catch((e: Error) => {
  console.error(`측정 자체가 실패했습니다: ${e.message}`);
  process.exit(1);
});
