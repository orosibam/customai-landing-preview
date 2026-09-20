import { chromium, type Page } from 'playwright';

/**
 * 쿠팡 상품 검색이 **러너에서 열리는지** 재는 도구.
 *
 * ## 왜 재는가
 *
 * 제휴사 매칭(②)의 첫 동작이 "이 제품이 쿠팡에 있나" 다. 그게 막히면 뒤따르는
 * 것(여러 몰 비교 → 수수료율 × 기여도로 선택 → 링크 생성)이 전부 무의미해진다.
 *
 * 1688 에서 똑같은 실수를 했다. 열릴 거라 가정하고 그 위에 파이프라인을 얹었다가
 * 뒤늦게 슬라이더 캡차인 걸 확인했다. 쿠팡은 데이터센터 IP 를 세게 막는 편이라
 * 가정하면 안 된다.
 *
 * ## 무엇을 보는가
 *
 * 1. 검색이 열리는가 — 상품 링크가 몇 개 나오는가
 * 2. 각 상품에서 **가격과 제목**을 읽을 수 있는가 (매칭 판정에 둘 다 필요하다)
 * 3. 로켓배송 표식이 보이는가 (전환율이 갈리므로 선택 기준에 넣을 값이다)
 *
 * 값을 그대로 찍는다 — 여기 나오는 건 전부 공개 상품 정보라 비밀값이 아니다.
 * 다만 URL 쿼리스트링은 추적 파라미터가 붙으므로 길이만 센다.
 *
 * 실행:  npx tsx src/probe-coupang.ts "차량용 팔걸이"
 */

const KEYWORD = process.argv[2] ?? '차량용 팔걸이';

/** 쿠팡이 사람 확인으로 돌렸을 때만 나오는 표식. 일반 단어는 넣지 않는다 —
 *  알리 계측에서 'captcha' 같은 일반 단어가 전부 거짓 경보였다. */
const BLOCK_MARKERS = [
  'ERR_ACCESS_DENIED',
  '접속이 차단',
  '비정상적인 접근',
  'Access Denied',
  'captcha.coupang',
  '/np/error',
];

function shape(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search ? ` ?(${u.search.length - 1}자)` : ''}`;
  } catch {
    return '(파싱 불가)';
  }
}

interface Hit {
  title: string;
  priceKrw: number | null;
  rocket: boolean;
  url: string;
}

async function search(page: Page, keyword: string): Promise<Hit[]> {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`;
  console.log(`\n── 쿠팡 검색: "${keyword}" ───────────────────────`);
  console.log(`   ${shape(url)}`);

  const res = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 이동 실패: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return [];

  await page.waitForTimeout(6_000);
  const html = await page.content();
  const visible = await page.locator('body').innerText().catch(() => '');

  console.log(
    `   HTTP ${res.status()} / HTML ${html.length.toLocaleString()}자 / 보이는 텍스트 ${visible.length.toLocaleString()}자`,
  );
  console.log(`   최종 URL: ${shape(page.url())}`);

  const blocked = BLOCK_MARKERS.filter((m) => html.includes(m));
  if (blocked.length) {
    console.log(`   ⚠ 차단 표식: ${blocked.join(', ')}`);
    console.log(`   화면 앞부분: ${visible.replace(/\s+/g, ' ').slice(0, 200)}`);
    return [];
  }

  // 쿠팡 검색 결과는 li.search-product 에 한 건씩 들어 있다. 클래스가 바뀔 수 있어
  // 대체 선택자도 같이 본다 — 하나가 비면 다른 쪽을 쓴다.
  const hits: Hit[] = await page.$$eval(
    'li.search-product, li[class*="ProductUnit"], ul#productList > li',
    (nodes) =>
      nodes.slice(0, 10).map((n) => {
        const text = (sel: string): string =>
          (n.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const title =
          text('.name') || text('[class*="productName"]') || text('img[alt]') ||
          (n.querySelector('img')?.getAttribute('alt') ?? '');
        const priceRaw = text('.price-value') || text('[class*="priceValue"]') || text('strong.price');
        const href = n.querySelector('a')?.getAttribute('href') ?? '';
        return {
          title: title.slice(0, 80),
          priceKrw: priceRaw ? Number(priceRaw.replace(/[^\d]/g, '')) || null : null,
          rocket: /로켓/.test(n.textContent ?? ''),
          url: href.startsWith('http') ? href : `https://www.coupang.com${href}`,
        };
      }),
  );

  return hits.filter((h) => h.title);
}

async function main(): Promise<void> {
  console.log(`쿠팡 검색을 로그인 없이 엽니다. 제휴사 매칭(②)의 첫 동작입니다.`);

  const browser = await chromium.launch({
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  // 검색어를 두 개 본다. 한 번의 0건은 검색어 탓일 수 있지만 둘 다 0이면 벽이다.
  const keywords = [KEYWORD, '반찬 뚜껑 정리대'];
  let total = 0;

  try {
    for (const k of keywords) {
      const hits = await search(page, k);
      total += hits.length;

      if (hits.length === 0) {
        console.log(`   → 0건`);
        continue;
      }

      console.log(`   상품 ${hits.length}건:`);
      for (const h of hits.slice(0, 5)) {
        const price = h.priceKrw ? `${h.priceKrw.toLocaleString()}원` : '가격 못 읽음';
        console.log(`     · ${price.padStart(12)} ${h.rocket ? '[로켓]' : '      '} ${h.title}`);
      }
      await page.waitForTimeout(3_000);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n═══ 판정 ═══`);
  if (total === 0) {
    // 조용히 넘어가지 않는다. 여기가 막히면 ② 를 다시 설계해야 한다.
    throw new Error(
      `검색어 ${keywords.length}개 모두 0건입니다. 쿠팡 검색을 러너에서 못 씁니다.\n` +
        `   ② 제휴사 매칭을 다른 경로로 다시 설계해야 합니다 —\n` +
        `   · 최종승인 후 파트너스 상품검색 API (지금은 키 발급 불가)\n` +
        `   · 네이버 쇼핑 검색으로 먼저 거르고 쿠팡은 링크 생성 때만 열기\n` +
        `   · 사람 PC 브라우저에서 돌리는 경로 (매일 도는 공장에는 부적합)`,
    );
  }
  console.log(`상품 ${total}건 확보. 쿠팡 검색은 러너에서 열립니다.`);
  console.log(`→ ② 제휴사 매칭의 "제품이 쿠팡에 있나" 판정을 자동으로 돌릴 수 있습니다.`);
}

main().catch((e: Error) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
