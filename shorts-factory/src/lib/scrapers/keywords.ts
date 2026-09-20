/**
 * 검색어 넓히기.
 *
 * ## 왜 필요한가
 *
 * 5차 제작이 소재 단계에서 멈췄을 때 검색어는 "mini portable massage gun" 이었고
 * 검색 결과가 **7건**이었다. 소재 풀 12개를 채우려면 상품을 서른 건 넘게 훑어야
 * 하는데 7건이면 구조적으로 불가능하다. 검색어가 좁으면 그 뒤가 전부 헛돈다.
 *
 * ## 규칙을 단어 사전으로 만들지 않았다
 *
 * "mini · portable · wireless 같은 수식어를 지운다" 로 짜려다 그만뒀다. 그 목록은
 * 내가 아는 단어만 담고, 모르는 수식어는 조용히 남는다. 대신 **앞 단어부터 하나씩
 * 떼는** 방식을 쓴다 — 영어는 수식어가 앞에 붙고 핵심 명사가 뒤에 오기 때문에
 * 뒤를 남기면 범주어가 된다.
 *
 *   mini portable massage gun → portable massage gun → massage gun
 *
 * 마지막 두 단어는 남긴다. 한 단어까지 가면("gun") 전혀 다른 물건이 나온다.
 *
 * ## 넓힌 검색어를 먼저 쓰지는 않는다
 *
 * 좁은 검색어가 정확하다. 호출부는 원래 검색어로 먼저 시도하고, 모자랄 때만
 * 넓힌 쪽으로 내려간다. 순서를 뒤집으면 매번 엉뚱한 제품 영상을 받게 된다.
 */

/** 원래 검색어를 첫 번째로, 점점 넓힌 것을 뒤에 둔다. 중복은 없앤다. */
export function broadenKeyword(keyword: string, max = 3): string[] {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const out: string[] = [];
  for (let start = 0; start <= Math.max(0, words.length - 2); start++) {
    const variant = words.slice(start).join(' ');
    if (!out.includes(variant)) out.push(variant);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 여러 검색어를 받아 각각 넓히고, 순서를 유지하며 하나로 합친다.
 *
 * 소싱 담당이 중국어 표현을 여러 개 준비해 넘기는데(같은 상품도 중국에서 부르는
 * 이름이 여러 개다), 그 각각을 또 넓힐 수 있다. 다만 중국어는 띄어쓰기가 없어
 * 대개 한 덩어리로 들어오고, 그때는 넓히기가 원문 하나만 돌려준다.
 */
export function searchPlan(keywords: (string | undefined)[], maxPerKeyword = 2): string[] {
  const out: string[] = [];
  for (const kw of keywords) {
    if (!kw?.trim()) continue;
    for (const variant of broadenKeyword(kw, maxPerKeyword)) {
      if (!out.includes(variant)) out.push(variant);
    }
  }
  return out;
}
