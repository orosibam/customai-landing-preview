/**
 * 제휴사 명부.
 *
 * ## 왜 수수료율만 보면 안 되는가
 *
 * 원본 방법론이 가장 강조한 게 **기여도(쿠키) 기간**이다. 기여도 30일이면 내 링크를
 * 클릭한 사람이 한 달 동안 그 몰에서 사는 **모든 것**의 수수료가 들어온다.
 * 쿠팡 3% × 1일 과 어떤 몰 30% × 30일 은 300배 차이다.
 *
 * 그래서 선택 기준은 `수수료율 × 기여도기간` 이다. DB 에도 같은 식으로 인덱스가
 * 걸려 있다 (`merchants_score_idx`).
 *
 * ## 지금은 후보가 하나다
 *
 * 비교 로직은 있지만 **실제로 검색해서 상품을 찾아올 수 있는 제휴사가 쿠팡뿐**이다.
 * 텐핑·알리 제휴는 상품 검색 경로를 아직 안 붙였다. 붙이지 않은 제휴사를 명부에
 * 적어두면 "비교해서 골랐다" 는 기록이 거짓이 되므로, 검색이 되는 곳만 적는다.
 *
 * 텐핑이 붙는 순간 비교가 저절로 의미를 갖는다 — 명부에 한 줄 더하면 된다.
 *
 * ## 숫자의 출처
 *
 * 추정값을 적지 않는다. 확인 못 한 값은 null 로 두고, null 이면 점수 계산에서
 * 보수적으로(가장 불리하게) 잡는다. 모르는 값을 그럴듯한 숫자로 채우면 그 숫자를
 * 믿고 내린 선택이 전부 틀어진다.
 */

export interface Merchant {
  key: string;
  label: string;
  /** 수수료율 (0.03 = 3%). 카테고리별로 다르면 가장 낮은 구간을 적는다. */
  commissionRate: number | null;
  /** 기여도(쿠키) 기간, 일 단위 */
  cookieDays: number | null;
  /** 이 값을 어디서 확인했는지. 빈 문자열이면 확인 안 된 것이다. */
  source: string;
  /** 상품 검색이 구현돼 있는가. false 면 매칭 후보에서 빠진다. */
  searchable: boolean;
}

export const MERCHANTS: Merchant[] = [
  {
    key: 'coupang',
    label: '쿠팡',
    // 카테고리별로 다르고 공개 문서의 최저 구간이 3% 다. 더 높은 구간이 있어도
    // 낮게 잡아두는 편이 안전하다 — 높게 잡으면 실제보다 좋아 보여서 잘못 고른다.
    commissionRate: 0.03,
    cookieDays: 1,
    source: '쿠팡 파트너스 공개 수수료 안내 (최저 구간)',
    searchable: true,
  },
];

/**
 * 선택 점수 = 수수료율 × 기여도기간.
 *
 * 확인 안 된 값(null)은 최저로 잡는다. 모르는 걸 유리하게 가정하면 그 제휴사가
 * 부당하게 1등이 되고, 그게 왜 틀렸는지는 정산 때까지 모른다.
 */
export function merchantScore(m: Merchant): number {
  return (m.commissionRate ?? 0) * (m.cookieDays ?? 1);
}

/** 검색이 구현된 제휴사만, 점수 높은 순으로. */
export function searchableMerchants(): Merchant[] {
  return MERCHANTS.filter((m) => m.searchable).sort((a, b) => merchantScore(b) - merchantScore(a));
}
