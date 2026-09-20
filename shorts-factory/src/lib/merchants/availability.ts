import { withContext, pause } from '../browser.js';

/**
 * "이 제품을 한국에서 살 수 있나 · 얼마인가" 를 확인한다.
 *
 * ## 제휴사 검색이 아니다
 *
 * 이름을 그렇게 지은 이유가 있다. 이건 **가용성 확인**이고, 제휴 링크를 만드는 것과
 * 별개의 일이다. 둘을 한 모듈에 섞었다가 쿠팡이 막히자 ② 전체가 멈췄다.
 *
 *   가용성 확인 → 한국에서 파는가, 얼마인가        ← 이 모듈
 *   제휴 링크   → 쿠팡 파트너스에서 생성 (지금은 수동)  ← 유통 담당
 *
 * ## 왜 다나와인가
 *
 * 러너 실측(2026-09-20), 검색어 "차량용 팔걸이":
 *
 *   쿠팡 PC      HTTP 403 Access Denied (Akamai)   카드  0 / 가격  0
 *   쿠팡 모바일   HTTP 403 Access Denied            카드  0 / 가격  0
 *   네이버쇼핑    HTTP 200 이지만 로그인 화면        카드  0 / 가격  0
 *   11번가       HTTP 200                          카드 10 / 가격  1
 *   다나와       HTTP 200                          카드 10 / 가격 10  ← 유일하게 온전
 *
 * 쿠팡은 데이터센터 IP 를 Akamai 에서 끊는다. 요청을 바꿔서 될 일이 아니다.
 * 11번가는 카드는 보이는데 첫 카드가 「온누리상품권」 광고였고 가격이 1/10 만 읽혔다.
 *
 * 다나와는 애초에 가격비교 사이트라 이 용도에 맞는다 — 한 번 검색하면 여러 몰의
 * 취급 여부와 가격대가 같이 나온다. 우리가 물어야 할 질문 그 자체다.
 */

export interface Availability {
  /** 다나와에 등록된 상품명 */
  title: string;
  priceKrw: number | null;
  /** 다나와 상품 페이지. 제휴 링크가 아니다 — 가용성 근거다. */
  referenceUrl: string;
  /** 어디서 확인했는지. 나중에 경로를 바꿔도 기록이 거짓이 되지 않게 남긴다. */
  source: string;
}

/** 다나와 차단 페이지에만 나오는 표식. 일반 단어는 넣지 않는다 —
 *  알리 계측에서 'captcha' 같은 일반 단어가 전부 거짓 경보였다. */
const BLOCK_MARKERS = ['비정상적인 접근', 'Access Denied', '접속이 차단'];

export class AvailabilityBlockedError extends Error {
  constructor(detail: string) {
    super(`가용성 확인이 막혔습니다: ${detail}`);
    this.name = 'AvailabilityBlockedError';
  }
}

export async function checkAvailability(keyword: string, limit = 10): Promise<Availability[]> {
  return withContext({ locale: 'ko-KR', timezone: 'Asia/Seoul' }, async (ctx) => {
    const page = await ctx.newPage();

    await page.goto(`https://search.danawa.com/dsearch.php?query=${encodeURIComponent(keyword)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await pause(5_000, 7_000);

    const html = await page.content();
    const wall = BLOCK_MARKERS.find((m) => html.includes(m));
    if (wall) {
      const visible = await page.locator('body').innerText().catch(() => '');
      throw new AvailabilityBlockedError(
        `다나와가 "${wall}" 로 막았습니다. 화면: ${visible.replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }

    const rows: Availability[] = await page.$$eval(
      'li.prod_item',
      (nodes, max) =>
        nodes.slice(0, max as number).map((n) => {
          const name = (n.querySelector('.prod_name a')?.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          const priceText = (n.querySelector('.price_sect strong')?.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          const href = n.querySelector('.prod_name a')?.getAttribute('href') ?? '';
          return {
            title: name.slice(0, 120),
            priceKrw: Number(priceText.replace(/[^\d]/g, '')) || null,
            referenceUrl: href.startsWith('http') ? href : `https://prod.danawa.com${href}`,
            source: '다나와',
          };
        }),
      limit,
    );

    const found = rows.filter((r) => r.title);

    if (found.length === 0) {
      // 0건이 "한국에 없다" 인지 "못 읽었다" 인지 구분한다. 대응이 다르다 —
      // 전자는 다음 제품으로 넘어가면 되고, 후자는 셀렉터를 고쳐야 한다.
      const visible = await page.locator('body').innerText().catch(() => '');
      const looksEmpty = /검색결과가 없|검색 결과가 없/.test(visible);
      if (looksEmpty) return [];
      throw new AvailabilityBlockedError(
        `"${keyword}" 결과를 못 읽었습니다 (${html.length.toLocaleString()}바이트, 차단 표식 없음). ` +
          `상품 목록 셀렉터가 바뀐 것으로 보입니다. ` +
          `화면: ${visible.replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }

    return found;
  });
}
