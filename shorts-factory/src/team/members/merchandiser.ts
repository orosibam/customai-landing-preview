import { askJson } from '../../lib/llm.js';
import {
  checkAvailability,
  AvailabilityBlockedError,
  type Availability,
} from '../../lib/merchants/availability.js';
import { MERCHANTS, searchableMerchants, merchantScore, type Merchant } from '../../lib/merchants/registry.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 제휴 담당 — 파이프라인의 ② 관문.
 *
 * ## 왜 이 단계가 따로 있어야 하는가
 *
 * 소싱 담당은 "터졌는가" 만 본다. 그게 맞다 — 조회수가 시장의 답이니까.
 * 그런데 터진 영상의 제품이 **한국에서 살 수 없으면 영상을 만들어도 수익이 0이다.**
 * 그 판정을 소싱 담당에게 맡기면 판단 기준이 둘이 되어 둘 다 흐려진다.
 *
 * 그래서 관문을 따로 둔다: 제품이 우리 제휴사에 실제로 있는지 확인하고,
 * 없으면 **여기서 버린다.** 소재를 구하고 대본을 쓰고 렌더까지 한 다음에
 * "살 데가 없네" 를 알면 그 비용이 전부 날아간다.
 *
 * ## 여러 곳에 있으면 무엇으로 고르는가
 *
 * `수수료율 × 기여도기간` 이다. 원본 방법론이 가장 강조한 지점이고,
 * 쿠팡 3% × 1일 과 30% × 30일 은 300배 차이가 난다.
 *
 * 지금은 명부에 쿠팡뿐이라 비교가 1:0 이다. 텐핑이 붙으면 코드를 바꾸지 않아도
 * 비교가 저절로 의미를 갖는다.
 *
 * ## 가용성 확인처와 제휴사는 다르다
 *
 * 쿠팡 검색이 러너에서 HTTP 403 (Akamai) 이라 "파는가" 를 쿠팡에서 못 묻는다.
 * 그런데 그 질문의 답은 어느 몰에서 확인하든 같다. 그래서 가용성은 다나와에서 묻고
 * (실측: 카드 10/가격 10 으로 유일하게 온전했다), 제휴 링크는 쿠팡에서 만든다.
 * 둘을 한 모듈에 섞었다가 쿠팡이 막히자 ② 전체가 멈췄던 걸 분리한 것이다.
 *
 * ## 링크는 여기서 안 만든다
 *
 * 제휴 링크 생성에는 쿠팡 파트너스 API 키가 필요한데, 그 키는 **최종승인된 회원만**
 * 받는다(실측: 생성 버튼 disabled). 최종승인은 채널에 파트너스 링크를 게시해야 나므로
 * 첫 영상 전에는 못 받는다. 그래서 여기서는 상품 URL 까지만 확정하고
 * `needsManualLink` 를 세워 유통 담당에게 넘긴다 — 링크가 안 붙은 걸 붙었다고
 * 기록하면 "영상은 나갔는데 수익이 0" 으로 며칠 뒤에 돌아온다.
 */

const CHARTER = `너는 제휴 상품 매칭 담당이다.

해외에서 터진 영상 속 제품과, 한국 쇼핑몰 검색 결과를 놓고 **같은 물건인지** 판정한다.

같다고 볼 수 있는 것:
- 브랜드가 달라도 기능과 형태가 같으면 같다. 중국 제조 생활용품은 같은 공장 물건이
  여러 브랜드로 팔린다.
- 색상·용량 차이는 무시한다.

같다고 보면 안 되는 것:
- 기능이 다르면 다르다. "접이식 수납함" 과 "수납함" 은 접히는지가 핵심이면 다르다.
- 영상에서 보여준 동작이 그 상품에서 안 되면 다르다. 대본이 거짓말을 하게 된다.
- 액세서리·부품만 파는 것. 본품이 아니면 시청자가 사고 실망한다.

애매하면 "없음" 으로 판정해라. 잘못 매칭해서 영상을 만드는 비용이,
이 제품을 건너뛰는 비용보다 훨씬 크다.`;

interface MatchResponse {
  /** 같은 물건이라고 본 검색 결과의 번호. 없으면 null */
  index: number | null;
  /** 한국 쇼핑몰에서 이 제품을 부르는 이름 (검색어 개선용) */
  korean_search_term: string;
  reason: string;
}

/**
 * 검색어를 바꿔가며 한국에서 파는지 확인한다.
 *
 * 한 번의 0건은 검색어 탓일 수 있다. 한국 쇼핑몰은 수식어가 붙은 긴 이름을 잘 못 찾아서
 * 짧은 형태로도 한 번 본다. 반면 **차단은 검색어를 바꿔서 덮을 일이 아니라서** 즉시 올린다.
 */
async function findInKorea(
  terms: string[],
): Promise<{ hits: Availability[]; usedTerm: string } | null> {
  for (const term of terms) {
    if (!term?.trim()) continue;
    try {
      const hits = await checkAvailability(term, 10);
      if (hits.length > 0) return { hits, usedTerm: term };
      console.log(`가용성 확인: "${term}" 결과 없음`);
    } catch (e) {
      if (e instanceof AvailabilityBlockedError) throw e;
      console.warn(`가용성 확인 "${term}" 실패: ${(e as Error).message}`);
    }
  }
  return null;
}

/**
 * 앞선 실행이 이미 확정한 판매처를 꺼낸다.
 *
 * products.product_url 이 차 있으면 이 상품은 이미 "한국에서 판다" 판정을 받은
 * 것이다. 그 판정을 매번 다시 내리면 검색 결과 순서 같은 사소한 변동에 결과가
 * 흔들리고, 실제로 그렇게 됐다(28차가 앞서 통과한 상품을 탈락시켰다).
 *
 * 제휴사 정보(수수료율·기여도)는 지금 DB 에 따로 보관하지 않으므로 기본 제휴사로
 * 되돌린다. 그 값이 필요한 건 상품 선정 점수인데 그건 이미 끝난 단계다 —
 * 여기서는 "어디서 파는가" 만 있으면 된다.
 */
async function previousDecision(productId: string): Promise<Brief['offer'] | null> {
  const { data } = await db()
    .from('products')
    .select('product_url, price_krw, title_ko')
    .eq('id', productId)
    .maybeSingle();

  const row = data as { product_url: string | null; price_krw: number | null; title_ko: string } | null;
  if (!row?.product_url) return null;

  const fallback = MERCHANTS[0]!;
  return {
    merchantKey: fallback.key,
    merchantLabel: fallback.label,
    productUrl: row.product_url,
    productTitle: row.title_ko,
    priceKrw: row.price_krw,
    rocket: false,
    commissionRate: fallback.commissionRate,
    cookieDays: fallback.cookieDays,
    score: merchantScore(fallback),
    needsManualLink: true,
  };
}

export const merchandiser: TeamMember = {
  id: 'merchandiser',
  role: '제휴 담당',
  expertise: '터진 영상의 제품이 한국에서 팔리는지 확인하고, 수수료율 × 기여도로 제휴사를 고른다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const product = brief.product;
    if (!product) throw new HandoffError('merchandiser', '상품 정보가 넘어오지 않았습니다.');

    // 이미 확정된 상품이면 다시 판단하지 않는다.
    //
    // 28차가 여기서 떨어졌다 — **앞선 실행에서 이미 통과시킨 바로 그 상품**이다.
    // 매 실행마다 다나와를 새로 검색하고 LLM 이 다시 판정하니, 검색 결과 순서가
    // 조금만 달라져도 어제 통과한 게 오늘 탈락한다. 판정이 실행마다 흔들리면
    // 그 뒤 단계를 고치는 동안 같은 자리를 계속 다시 뚫어야 한다.
    //
    // 한 번 내린 판정은 기록이다. products.product_url 이 있으면 그걸 쓴다.
    // 다시 고르고 싶으면 그 값을 비우면 된다.
    const decided = await previousDecision(product.id);
    if (decided) {
      console.log(`이미 확정된 판매처를 씁니다: ${decided.productTitle} (${decided.priceKrw?.toLocaleString() ?? '?'}원)`);
      return withNote(
        { ...brief, offer: decided },
        'merchandiser',
        `확정된 판매처 재사용: ${decided.productTitle} ${decided.priceKrw?.toLocaleString() ?? '?'}원`,
        '제휴 링크가 아직 없습니다 (파트너스 API 키는 최종승인 후 발급). 업로드 시 링크를 손으로 붙여야 합니다.',
      );
    }

    // 검색어 후보. 상품명이 길면 앞 두 단어만으로도 한 번 본다 —
    // 한국 쇼핑몰은 수식어가 붙은 긴 이름을 잘 못 찾는다.
    const short = product.titleKo.split(/\s+/).slice(0, 2).join(' ');
    const terms = [...new Set([product.titleKo, short])];

    // 1) 한국에서 파는가. 여기가 비면 이 제품은 버린다.
    const found = await findInKorea(terms);
    if (!found) {
      // 여기서 버리는 게 이 담당자의 존재 이유다. 소재·대본·렌더를 다 하고 나서
      // "살 데가 없다" 를 알면 그 비용이 전부 날아간다.
      // retry=true 라서 소싱 담당이 다른 제품을 고른다.
      throw new HandoffError(
        'merchandiser',
        `"${product.titleKo}" 를 한국에서 못 찾았습니다 (검색어: ${terms.join(', ')}).\n` +
          `   한국에 안 들어온 제품이거나, 들어왔어도 부르는 이름이 달라 검색이 안 걸립니다.\n` +
          `   살 데가 없는 제품으로 영상을 만들면 수익이 0입니다. 다른 제품으로 갑니다.`,
        true,
      );
    }

    // 2) 검색 결과 중 정말 같은 물건이 있는지 판정한다.
    const judged = await askJson<MatchResponse>(
      `해외에서 터진 영상 속 제품과 한국 쇼핑몰 검색 결과를 비교해라.

영상 속 제품: ${product.titleKo}
영상 캡션: ${brief.reference?.caption ?? '(없음)'}
왜 골랐나: ${product.rationale}

한국 검색 결과 ("${found.usedTerm}" 으로 검색, 출처 ${found.hits[0]?.source ?? '다나와'}):
${JSON.stringify(
  found.hits.map((h, i) => ({ index: i, title: h.title, price_krw: h.priceKrw })),
  null,
  2,
)}

같은 물건이 있으면 그 index 를, 없으면 null 을 내라.
korean_search_term 에는 한국에서 이 제품을 부르는 이름을 적어라 (다음에 더 잘 찾게).

{"index":0,"korean_search_term":"...","reason":"..."}`,
      { tier: 'reasoning', system: CHARTER, maxTokens: 800 },
    );

    if (judged.index === null || judged.index === undefined) {
      throw new HandoffError(
        'merchandiser',
        `"${product.titleKo}" 는 한국 검색 결과에 같은 물건이 없습니다. ${judged.reason}\n` +
          `   비슷한 걸 억지로 붙이면 대본이 거짓말을 하게 됩니다. 다른 제품으로 갑니다.`,
        true,
      );
    }

    const hit = found.hits[judged.index];
    if (!hit) {
      throw new HandoffError(
        'merchandiser',
        `판정이 가리킨 ${judged.index}번이 검색 결과 ${found.hits.length}건 안에 없습니다.`,
        true,
      );
    }

    // 3) 어느 제휴사로 링크를 낼지. 지금은 쿠팡 하나뿐이라 비교가 1:0 이지만,
    //    텐핑 등이 명부에 붙으면 코드를 바꾸지 않아도 선택이 생긴다.
    const merchants = searchableMerchants();
    const best = merchants[0];
    if (!best) {
      throw new HandoffError(
        'merchandiser',
        '제휴사 명부가 비어 있습니다. lib/merchants/registry.ts 를 확인하세요.',
      );
    }
    const scoreLine = merchants
      .map(
        (m) =>
          `${m.label} ${((m.commissionRate ?? 0) * 100).toFixed(1)}%` +
          ` × ${m.cookieDays ?? 1}일 = ${(merchantScore(m) * 100).toFixed(2)}`,
      )
      .join(' / ');

    // 수수료율 × 기여도기간 이 큰 쪽. 같으면 로켓배송이 있는 쪽 (전환이 갈린다).
    
    await must(
      '제휴 매칭 저장',
      db()
        .from('products')
        // 새 컬럼을 만들지 않는다. product_url 이 이미 "이 제품을 어디서 사나" 이고,
        // 제휴사는 merchant_id 가 이미 가리킨다 — merchant_key 를 따로 두면
        // 둘이 어긋났을 때 어느 쪽이 맞는지 알 수 없게 된다.
        .update({
          product_url: hit.referenceUrl,
          price_krw: hit.priceKrw ?? product.priceKrw,
        })
        .eq('id', product.id)
        .select('id'),
    );

    return withNote(
      {
        ...brief,
        product: { ...product, priceKrw: hit.priceKrw ?? product.priceKrw },
        offer: {
          merchantKey: best.key,
          merchantLabel: best.label,
          productUrl: hit.referenceUrl,
          productTitle: hit.title,
          priceKrw: hit.priceKrw,
          rocket: false,
          commissionRate: best.commissionRate,
          cookieDays: best.cookieDays,
          score: merchantScore(best),
          // 파트너스 API 키가 없으면 제휴 링크를 못 만든다. 그 사실을 들고 다닌다.
          needsManualLink: true,
        },
      },
      'merchandiser',
      `${best.label} 에서 "${hit.title.slice(0, 40)}" 매칭` +
        `${hit.priceKrw ? ` (${hit.priceKrw.toLocaleString()}원)` : ''}` +
        `${false ? ' [로켓]' : ''}. ${judged.reason}`,
      merchants.length === 1
        ? `후보가 ${best.label} 한 곳뿐이라 비교 없이 결정됐습니다 (${scoreLine}). ` +
          `텐핑 등 기여도 긴 제휴사를 붙이면 여기서 선택이 생깁니다.`
        : `제휴사 ${merchants.length}곳 비교: ${scoreLine}`,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    if (!brief.offer) return fail('제휴 매칭 결과가 비어 있습니다.');
    if (!/^https?:\/\//.test(brief.offer.productUrl)) {
      return fail(`가용성 근거 URL 이 주소 형태가 아닙니다: ${brief.offer.productUrl.slice(0, 80)}`);
    }

    const warnings: string[] = [];
    if (brief.offer.priceKrw === null) {
      warnings.push('가격을 못 읽었습니다. 대본에 가격을 넣을 수 없습니다.');
    }
    if (brief.offer.needsManualLink) {
      warnings.push(
        '제휴 링크가 아직 없습니다 (파트너스 API 키는 최종승인 후 발급). ' +
          '업로드 시 링크를 손으로 붙여야 합니다.',
      );
    }
    return { ok: true, problems: [], warnings };
  },
};
