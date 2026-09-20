import { withContext, pause } from '../browser.js';

/**
 * 쿠팡 상품 검색 — 제휴사 매칭(②)의 첫 동작.
 *
 * ## 왜 브라우저인가
 *
 * 쿠팡 파트너스 상품검색 API 가 있지만 **최종승인된 회원만 키를 받는다.** 실측으로
 * 확인했다 — 파트너스 `추가 기능 → 파트너스 API` 페이지의 생성 버튼이
 * `disabled: true` 이고 "API키는 최종 승인된 회원만 발급이 가능합니다" 라고 적혀 있다.
 * 최종승인은 채널에 파트너스 링크를 게시하고 스크린샷을 등록해야 난다.
 *
 * 즉 **첫 영상을 만들기 전에는 API 를 못 쓴다.** 그래서 공개 검색을 읽는다.
 * 키가 나오면 이 모듈만 API 판으로 바꾸면 되고, 호출부는 그대로다.
 *
 * ## 링크 생성은 여기서 안 한다
 *
 * 제휴 링크(link.coupang.com/a/...)는 파트너스에서 만들어야 하고 그것도 API 가 필요하다.
 * 여기서는 **상품이 존재하는지와 그 상품 URL** 까지만 낸다. 링크 부착은 유통 담당이
 * 맡고, 지금은 수동 작업으로 큐잉된다 — 링크가 안 붙은 걸 붙었다고 기록하면
 * "영상은 나갔는데 수익이 0" 으로 며칠 뒤에 돌아온다.
 */

export interface CoupangHit {
  title: string;
  priceKrw: number | null;
  rocket: boolean;
  /** 쿠팡 상품 페이지 주소 (제휴 링크가 아니다) */
  productUrl: string;
}

/** 쿠팡 차단 페이지에만 나오는 표식. 일반 단어는 넣지 않는다. */
const BLOCK_MARKERS = [
  'ERR_ACCESS_DENIED',
  '접속이 차단',
  '비정상적인 접근',
  'captcha.coupang',
];

export class CoupangBlockedError extends Error {
  constructor(detail: string) {
    super(`쿠팡 검색이 막혔습니다: ${detail}`);
    this.name = 'CoupangBlockedError';
  }
}

export async function searchCoupang(keyword: string, limit = 10): Promise<CoupangHit[]> {
  return withContext({ locale: 'ko-KR', timezone: 'Asia/Seoul' }, async (ctx) => {
    const page = await ctx.newPage();

    await page.goto(`https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await pause(4_000, 6_000);

    const html = await page.content();
    const hit = BLOCK_MARKERS.find((m) => html.includes(m));
    if (hit) {
      const visible = await page.locator('body').innerText().catch(() => '');
      throw new CoupangBlockedError(
        `"${hit}" 표식. 화면: ${visible.replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }

    // 클래스명이 개편으로 바뀌는 곳이라 후보를 여러 개 둔다.
    const rows: CoupangHit[] = await page.$$eval(
      'li.search-product, li[class*="ProductUnit"], ul#productList > li',
      (nodes, max) =>
        nodes.slice(0, max as number).map((n) => {
          const text = (sel: string): string =>
            (n.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const title =
            text('.name') ||
            text('[class*="productName"]') ||
            (n.querySelector('img')?.getAttribute('alt') ?? '');
          const priceRaw =
            text('.price-value') || text('[class*="priceValue"]') || text('strong.price');
          const href = n.querySelector('a')?.getAttribute('href') ?? '';
          return {
            title: title.slice(0, 120),
            priceKrw: priceRaw ? Number(priceRaw.replace(/[^\d]/g, '')) || null : null,
            rocket: /로켓/.test(n.textContent ?? ''),
            productUrl: href.startsWith('http') ? href : `https://www.coupang.com${href}`,
          };
        }),
      limit,
    );

    const found = rows.filter((r) => r.title && r.productUrl.includes('/vp/products/'));

    if (found.length === 0) {
      // 0건이 "없다" 인지 "못 읽었다" 인지 구분해서 올린다. 둘은 대응이 다르다 —
      // 전자는 다음 상품으로 넘어가면 되고, 후자는 셀렉터를 고쳐야 한다.
      const visible = await page.locator('body').innerText().catch(() => '');
      const looksEmpty = /검색결과가 없습니다|에 대한 검색결과가 없습니다/.test(visible);
      if (looksEmpty) return [];
      throw new CoupangBlockedError(
        `"${keyword}" 결과를 못 읽었습니다 (${html.length.toLocaleString()}바이트, 차단 표식 없음). ` +
          `상품 목록 셀렉터가 바뀐 것으로 보입니다. ` +
          `화면: ${visible.replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }

    return found;
  });
}
