import { askJson } from '../../lib/llm.js';
import { searchCoupang, CoupangBlockedError, type CoupangHit } from '../../lib/merchants/coupang.js';
import { searchableMerchants, merchantScore, type Merchant } from '../../lib/merchants/registry.js';
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
 * 지금은 검색이 붙은 제휴사가 쿠팡뿐이라 비교가 1:0 이다. 텐핑이 붙으면
 * 코드를 바꾸지 않아도 비교가 저절로 의미를 갖는다.
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

/** 제휴사 한 곳에서 이 제품을 찾아본다. */
async function findAt(
  merchant: Merchant,
  terms: string[],
): Promise<{ hits: CoupangHit[]; usedTerm: string } | null> {
  for (const term of terms) {
    if (!term?.trim()) continue;
    try {
      const hits = await searchCoupang(term, 10);
      if (hits.length > 0) return { hits, usedTerm: term };
      console.log(`${merchant.label}: "${term}" 검색 결과 없음`);
    } catch (e) {
      if (e instanceof CoupangBlockedError) throw e; // 차단은 다음 검색어로 덮을 일이 아니다
      console.warn(`${merchant.label} "${term}" 검색 실패: ${(e as Error).message}`);
    }
  }
  return null;
}

export const merchandiser: TeamMember = {
  id: 'merchandiser',
  role: '제휴 담당',
  expertise: '터진 영상의 제품을 한국 제휴사에서 찾고, 수수료율 × 기여도로 고른다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const product = brief.product;
    if (!product) throw new HandoffError('merchandiser', '상품 정보가 넘어오지 않았습니다.');

    const merchants = searchableMerchants();
    if (merchants.length === 0) {
      throw new HandoffError(
        'merchandiser',
        '검색이 구현된 제휴사가 하나도 없습니다. lib/merchants/registry.ts 를 확인하세요.',
      );
    }

    // 검색어 후보. 상품명이 길면 앞 두 단어만으로도 한 번 본다 —
    // 한국 쇼핑몰은 수식어가 붙은 긴 이름을 잘 못 찾는다.
    const short = product.titleKo.split(/\s+/).slice(0, 2).join(' ');
    const terms = [...new Set([product.titleKo, short])];

    const candidates: {
      merchant: Merchant;
      hit: CoupangHit;
      score: number;
      reason: string;
    }[] = [];

    for (const merchant of merchants) {
      const found = await findAt(merchant, terms);
      if (!found) continue;

      const judged = await askJson<MatchResponse>(
        `해외에서 터진 영상 속 제품과 ${merchant.label} 검색 결과를 비교해라.

영상 속 제품: ${product.titleKo}
영상 캡션: ${brief.reference?.caption ?? '(없음)'}
왜 골랐나: ${product.rationale}

${merchant.label} 검색 결과 ("${found.usedTerm}" 으로 검색):
${JSON.stringify(
  found.hits.map((h, i) => ({
    index: i,
    title: h.title,
    price_krw: h.priceKrw,
    rocket: h.rocket,
  })),
  null,
  2,
)}

같은 물건이 있으면 그 index 를, 없으면 null 을 내라.
korean_search_term 에는 한국에서 이 제품을 부르는 이름을 적어라 (다음에 더 잘 찾게).

{"index":0,"korean_search_term":"...","reason":"..."}`,
        { tier: 'reasoning', system: CHARTER, maxTokens: 800 },
      );

      if (judged.index === null || judged.index === undefined) {
        console.log(`${merchant.label}: 같은 물건 없음 — ${judged.reason}`);
        continue;
      }

      const hit = found.hits[judged.index];
      if (!hit) {
        console.warn(`${merchant.label}: 판정이 가리킨 ${judged.index}번이 목록에 없습니다.`);
        continue;
      }

      candidates.push({ merchant, hit, score: merchantScore(merchant), reason: judged.reason });
    }

    if (candidates.length === 0) {
      // 여기서 버리는 게 목적이다. 소재·대본·렌더를 다 하고 나서 "살 데가 없다" 를
      // 알면 그 비용이 전부 날아간다. retry=true 라서 소싱 담당이 다른 제품을 고른다.
      throw new HandoffError(
        'merchandiser',
        `"${product.titleKo}" 를 제휴사 ${merchants.length}곳에서 못 찾았습니다 ` +
          `(검색어: ${terms.join(', ')}).\n` +
          `   한국에 안 들어온 제품이거나, 들어왔어도 부르는 이름이 달라 검색이 안 걸립니다.\n` +
          `   살 데가 없는 제품으로 영상을 만들면 수익이 0입니다. 다른 제품으로 갑니다.`,
        true,
      );
    }

    // 수수료율 × 기여도기간 이 큰 쪽. 같으면 로켓배송이 있는 쪽 (전환이 갈린다).
    candidates.sort((a, b) => b.score - a.score || Number(b.hit.rocket) - Number(a.hit.rocket));
    const best = candidates[0]!;

    const scoreLine = candidates
      .map(
        (c) =>
          `${c.merchant.label} ${((c.merchant.commissionRate ?? 0) * 100).toFixed(1)}%` +
          ` × ${c.merchant.cookieDays ?? 1}일 = ${(c.score * 100).toFixed(2)}`,
      )
      .join(' / ');

    await must(
      '제휴 매칭 저장',
      db()
        .from('products')
        // 새 컬럼을 만들지 않는다. product_url 이 이미 "이 제품을 어디서 사나" 이고,
        // 제휴사는 merchant_id 가 이미 가리킨다 — merchant_key 를 따로 두면
        // 둘이 어긋났을 때 어느 쪽이 맞는지 알 수 없게 된다.
        .update({
          product_url: best.hit.productUrl,
          price_krw: best.hit.priceKrw ?? product.priceKrw,
        })
        .eq('id', product.id)
        .select('id'),
    );

    return withNote(
      {
        ...brief,
        product: { ...product, priceKrw: best.hit.priceKrw ?? product.priceKrw },
        offer: {
          merchantKey: best.merchant.key,
          merchantLabel: best.merchant.label,
          productUrl: best.hit.productUrl,
          productTitle: best.hit.title,
          priceKrw: best.hit.priceKrw,
          rocket: best.hit.rocket,
          commissionRate: best.merchant.commissionRate,
          cookieDays: best.merchant.cookieDays,
          score: best.score,
          // 파트너스 API 키가 없으면 제휴 링크를 못 만든다. 그 사실을 들고 다닌다.
          needsManualLink: true,
        },
      },
      'merchandiser',
      `${best.merchant.label} 에서 "${best.hit.title.slice(0, 40)}" 매칭` +
        `${best.hit.priceKrw ? ` (${best.hit.priceKrw.toLocaleString()}원)` : ''}` +
        `${best.hit.rocket ? ' [로켓]' : ''}. ${best.reason}`,
      candidates.length === 1
        ? `후보가 ${best.merchant.label} 한 곳뿐이라 비교 없이 결정됐습니다 (${scoreLine}). ` +
          `텐핑 등 기여도 긴 제휴사를 붙이면 여기서 선택이 생깁니다.`
        : `후보 ${candidates.length}곳 비교: ${scoreLine}`,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    if (!brief.offer) return fail('제휴 매칭 결과가 비어 있습니다.');
    if (!brief.offer.productUrl.includes('/vp/products/')) {
      return fail(`상품 URL 이 상품 페이지가 아닙니다: ${brief.offer.productUrl.slice(0, 80)}`);
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
