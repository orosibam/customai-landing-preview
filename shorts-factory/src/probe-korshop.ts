import { chromium, type Page } from 'playwright';

/**
 * 한국 쇼핑몰 검색 중 **러너에서 열리는 곳**을 찾는다.
 *
 * ## 왜 필요한가
 *
 * 제휴사 매칭(②)의 첫 동작이 "이 제품을 한국에서 살 수 있나" 다. 쿠팡으로 하려 했는데
 * 러너에서 HTTP 403 Access Denied 가 떴다 (Akamai edge, errors.edgesuite.net).
 * 데이터센터 IP 차단이라 요청을 바꿔서 될 일이 아니다.
 *
 * 그렇다고 ② 를 없앨 수는 없다. 없애면 한국에서 못 사는 제품으로 영상을 만들고,
 * 소재·대본·렌더 비용을 다 쓴 뒤에 수익이 0인 걸 알게 된다.
 *
 * ## 무엇을 대신 쓸 수 있는가
 *
 * 가용성 확인과 제휴 링크 생성은 **다른 일이다.** 링크는 어차피 쿠팡 파트너스에서
 * 만들어야 하고 지금은 수동이다(API 키가 최종승인 전이라 안 나온다).
 * 그러니 ② 는 "한국에서 파나 · 얼마인가" 만 답하면 되고, 그건 열려 있는 아무 몰에서나
 * 확인할 수 있다.
 *
 * 그래서 후보를 여러 개 열어보고 **실제로 상품·가격을 읽을 수 있는 곳**을 찾는다.
 * 추측으로 하나 고르면 또 며칠 뒤에 403 을 발견한다.
 *
 * 실행:  npx tsx src/probe-korshop.ts "차량용 팔걸이"
 */

const KEYWORD = process.argv[2] ?? '차량용 팔걸이';

interface Site {
  label: string;
  url: (k: string) => string;
  /** 상품 카드 선택자 후보들. 하나라도 걸리면 된다. */
  cardSelectors: string[];
  /** 차단 페이지에만 나오는 표식 */
  blocked: string[];
}

const SITES: Site[] = [
  {
    label: '쿠팡 PC',
    url: (k) => `https://www.coupang.com/np/search?q=${encodeURIComponent(k)}`,
    cardSelectors: ['li.search-product', 'li[class*="ProductUnit"]'],
    blocked: ['Access Denied', 'ERR_ACCESS_DENIED', '비정상적인 접근'],
  },
  {
    label: '쿠팡 모바일',
    url: (k) => `https://m.coupang.com/nm/search?q=${encodeURIComponent(k)}`,
    cardSelectors: ['li.plp-default__item', 'li[class*="search-product"]', 'ul.search-product-list > li'],
    blocked: ['Access Denied', 'ERR_ACCESS_DENIED'],
  },
  {
    label: '네이버쇼핑',
    url: (k) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(k)}`,
    cardSelectors: ['div[class*="product_item"]', 'li[class*="basicList_item"]', 'div[class*="adProduct_item"]'],
    blocked: ['일시적으로 접속이 원활하지', '비정상적인 접근', '캡차'],
  },
  {
    label: '11번가',
    url: (k) => `https://search.11st.co.kr/Search.tmall?kwd=${encodeURIComponent(k)}`,
    cardSelectors: ['li.c_listing_item', 'div.c_card_item', 'li[class*="item"]'],
    blocked: ['비정상적인 접근', 'Access Denied'],
  },
  {
    label: '다나와',
    url: (k) => `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(k)}`,
    cardSelectors: ['li.prod_item', 'div.prod_main_info'],
    blocked: ['비정상적인 접근', 'Access Denied'],
  },
];

interface Result {
  label: string;
  status: number | null;
  cards: number;
  withPrice: number;
  blocked: string | null;
  sample: string;
}

async function probe(page: Page, site: Site): Promise<Result> {
  console.log(`\n── ${site.label} ─────────────────────────────`);

  const res = await page
    .goto(site.url(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 이동 실패: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return { label: site.label, status: null, cards: 0, withPrice: 0, blocked: '이동 실패', sample: '' };

  await page.waitForTimeout(6_000);
  const html = await page.content();
  const visible = await page.locator('body').innerText().catch(() => '');

  console.log(`   HTTP ${res.status()} / HTML ${html.length.toLocaleString()}자 / 보이는 텍스트 ${visible.length.toLocaleString()}자`);

  const wall = site.blocked.find((b) => html.includes(b)) ?? null;
  if (wall) {
    console.log(`   ⚠ 차단: "${wall}"`);
    console.log(`   화면: ${visible.replace(/\s+/g, ' ').slice(0, 140)}`);
    return { label: site.label, status: res.status(), cards: 0, withPrice: 0, blocked: wall, sample: '' };
  }

  // 선택자 후보를 하나씩 대본다. 한 곳이 개편돼도 다른 후보가 받쳐준다.
  let cards = 0;
  let withPrice = 0;
  let sample = '';
  for (const sel of site.cardSelectors) {
    const rows: { text: string; price: number | null }[] = await page
      .$$eval(sel, (ns) =>
        ns.slice(0, 10).map((n) => {
          const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
          const m = t.match(/([\d,]{3,})\s*원/);
          return { text: t.slice(0, 90), price: m ? Number(m[1]!.replace(/,/g, '')) || null : null };
        }),
      )
      .catch(() => [] as { text: string; price: number | null }[]);
    if (rows.length > cards) {
      cards = rows.length;
      withPrice = rows.filter((r) => r.price !== null).length;
      sample = rows[0]?.text ?? '';
    }
  }

  console.log(`   상품 카드 ${cards}개 / 가격 읽힌 것 ${withPrice}개`);
  if (sample) console.log(`   예시: ${sample}`);
  else console.log(`   화면: ${visible.replace(/\s+/g, ' ').slice(0, 140)}`);

  return { label: site.label, status: res.status(), cards, withPrice, blocked: null, sample };
}

async function main(): Promise<void> {
  console.log(`검색어: "${KEYWORD}" — 로그인 없이, 러너에서.`);
  console.log(`② 제휴사 매칭이 쓸 "한국에서 파나 · 얼마인가" 확인 경로를 찾습니다.`);

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

  const results: Result[] = [];
  try {
    for (const site of SITES) {
      results.push(await probe(page, site));
      await page.waitForTimeout(2_500);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n═══ 정리 ═══`);
  for (const r of results) {
    const verdict = r.blocked ? `차단 (${r.blocked})` : r.withPrice > 0 ? '쓸 수 있음' : r.cards > 0 ? '카드는 보이나 가격 못 읽음' : '0건';
    console.log(`  ${r.label.padEnd(12)} ${String(r.status ?? '-').padStart(4)}  카드 ${String(r.cards).padStart(3)} / 가격 ${String(r.withPrice).padStart(3)}  ${verdict}`);
  }

  const usable = results.filter((r) => r.withPrice > 0);
  if (usable.length === 0) {
    throw new Error(
      `가격까지 읽을 수 있는 몰이 하나도 없습니다.\n` +
        `   ② 를 이 경로로는 못 만듭니다. 남은 선택지:\n` +
        `   · 네이버 쇼핑 검색 API (developers.naver.com 에서 앱 등록 → 클라이언트 키)\n` +
        `   · 쿠팡 파트너스 상품검색 API (최종승인 후에나 키가 나온다)\n` +
        `   · ② 를 가용성 확인 없이 통과시키고 승인 화면에서 사람이 확인 (권장하지 않음)`,
    );
  }
  console.log(`\n→ 쓸 수 있는 곳: ${usable.map((u) => u.label).join(', ')}`);
  console.log(`   가장 많이 읽힌 곳을 ② 의 기본 경로로 쓰면 됩니다.`);
}

main().catch((e: Error) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
