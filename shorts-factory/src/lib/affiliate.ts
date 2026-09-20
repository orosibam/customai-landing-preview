import { optionalEnv } from '../config.js';

/**
 * 제휴 링크 생성.
 *
 * 원본 방법론의 "구독자 0명 비기" 를 코드로 옮긴 것. 플랫폼 자체 쇼핑 태그는 조건이
 * 필요하지만, 인포크링크는 조건이 없어서 첫날부터 수익이 난다.
 * 실측 차이가 10% 남짓이라(유튜브 438만 vs 쿠팡파트너스 395만) 조건을 기다릴 이유가 없다.
 *
 * **자동 승격은 하지 않는다.** 조건을 넘겼다고 올려봐야 부착 경로가 없으면 링크가
 * 안 붙고, 그건 잘 돌던 것이 성장을 계기로 깨지는 최악의 형태다. 승격은 그 플랫폼의
 * 부착 자동화가 실제로 붙은 뒤에 되살린다.
 */

export type LinkMode = 'inpock' | 'yt_shopping_tag' | 'naver_sticker' | 'tiktok_shop';

/**
 * `tiktok_shop` 은 지금 도달할 수 없는 모드다.
 *
 * 여기 「사업자 인증을 마치면 팔로워 0명부터 쇼핑 링크가 열린다」고 적혀 있었는데,
 * 조사 결과 **두 제도를 섞은 것**이었다:
 *
 *   · 셀러(TikTok Shop) — 내 재고를 내가 파는 내 샵. 사업자 인증이 여기 걸린다.
 *     재고와 해외 3PL 이 필요해서 이 프로젝트 모델과 맞지 않는다.
 *   · 어필리에이트(크리에이터) — 남의 상품을 홍보하고 수수료를 받는 것. **우리가 원하는 쪽.**
 *     조건은 팔로워 1,000명이고, 사업자 인증으로 면제되지 않는다.
 *
 * 게다가 2026-09 현재 **한국 틱톡샵 자체가 열려 있지 않다.** 어필리에이트는 틱톡샵이
 * 운영되는 국가의 거주자만 가입할 수 있어서 한국 거주자는 해당이 없다.
 * (근거·출처는 `docs/tiktok-shop-setup.md`. 다만 이 환경에서 tiktok.com 이 막혀
 *  원문을 직접 열지 못했고, 전부 2차 출처다.)
 *
 * 그래서 `TIKTOK_BUSINESS_VERIFIED` 설정을 없앴다. 켜면 `tiktok_shop` 으로 가는데
 * 그 경로는 부착 단계에서 던지고, 결국 링크가 안 붙은 영상 = 수익 0 이 된다.
 * 틀린 전제를 믿고 켤 수 있는 스위치를 남겨두는 것보다 없는 게 낫다.
 *
 * 한국 오픈이 확인되면 그때 실제 화면을 보고 되살린다. `LinkMode` 의 `tiktok_shop` 과
 * DB enum 은 그대로 둔다 — 지우면 되살릴 때 마이그레이션이 한 번 더 필요하다.
 */
export const TIKTOK_FOLLOWER_THRESHOLD = 1_000;

export interface LinkTarget {
  productTitle: string;
  /** 제휴사 상품 URL */
  productUrl: string;
  merchantPlatform: string;
}

/**
 * 채널 상태에 따라 어떤 링크 방식을 쓸지 정한다.
 *
 * - 네이버 클립: 조건 없이 구매 링크 스티커가 붙는다. 가장 유리해서 무조건 스티커.
 * - 나머지 전부: 인포크링크. 유튜브 쇼핑 태그도 틱톡샵도 지금은 부착할 수단이 없다.
 *   각 분기의 사정은 아래 주석에 적어뒀다.
 */
export function resolveLinkMode(platform: string, subscriberCount: number): LinkMode {
  // 네이버 클립: 조건 없이 구매 링크 스티커가 붙는다. 가장 유리하므로 무조건 스티커.
  if (platform === 'naverclip') return 'naver_sticker';

  // 틱톡: 한국 틱톡샵이 열려 있지 않아 어필리에이트 가입 자체가 안 된다.
  // 팔로워가 1,000명을 넘어도 마찬가지라 조건 분기를 두지 않는다 —
  // 열리지도 않는 모드로 보내면 링크가 안 붙어 수익이 0이 된다. 프로필 링크로 간다.
  if (platform === 'tiktok') return 'inpock';

  // 유튜브도 인포크링크로 간다. 쇼핑 태그로 자동 승격하지 않는다 — 이유는 아래.
  //
  // 예전엔 구독자가 500명을 넘으면 'yt_shopping_tag' 로 올렸는데, 그게 시한폭탄이었다:
  //   1. 쇼핑 태그 부착에는 공개 API 가 없어서 publishers/youtube.ts 의 attachLink 가
  //      그 모드를 받으면 그대로 던진다. 즉 승격되는 순간 링크가 안 붙는다.
  //   2. 잘 돌던 인포크링크 모드가 「구독자 500명 도달」을 계기로 깨진다.
  //      성장한 게 고장의 방아쇠가 되는 구조라 원인을 찾기도 어렵다.
  //   3. 조건도 틀렸다. 500명은 YPP 가입 조건의 일부일 뿐이고, 쇼츠 채널은
  //      여기에 「90일 내 300만 조회」가 더 붙는다. 구독자 수만 보고 승격할 수 없다.
  //
  // 쇼핑 태그는 Studio 브라우저 자동화가 실제로 붙은 뒤에 되살린다. 그때는 조건도
  // 구독자 수가 아니라 「YPP 가입 여부」로 판정해야 한다 — 그게 진짜 관문이다.
  return 'inpock';
}

/**
 * 자체 도메인 리다이렉터를 경유하는 링크.
 *
 * 인포크링크/텐핑을 그대로 쓰면 어떤 훅이 클릭을 만들었는지 우리가 알 수 없다.
 * 우리 도메인을 한 번 거치면 클릭 데이터를 우리가 소유하게 되고,
 * S10이 "어떤 설계도가 돈이 됐는가" 를 계산할 수 있다.
 */
export function trackedUrl(destination: string, params: {
  renderId: string;
  channelKey: string;
  blueprintId: string;
}): string {
  const base = optionalEnv('REDIRECTOR_BASE_URL', '');
  if (!base) return destination;

  const url = new URL('/go', base);
  url.searchParams.set('u', destination);
  url.searchParams.set('r', params.renderId);
  url.searchParams.set('c', params.channelKey);
  url.searchParams.set('b', params.blueprintId);
  return url.toString();
}

/**
 * 인포크링크 항목 번호.
 *
 * 틱톡·인스타는 설명란 링크가 클릭되지 않는다. 그래서 프로필에 인포크링크를 걸어두고
 * 영상에서는 **번호로 지칭**한다 — "프로필 링크 29번". 이 번호가 빠지면 시청자가
 * 수백 개 목록에서 상품을 못 찾아 그대로 이탈한다.
 */
export interface ItemRef {
  itemNumber: number;
  pageUrl: string;
}

/**
 * 영상 제목.
 *
 * 번호 지칭을 제목에 넣는 이유는 시청자가 설명란을 펴지 않기 때문이다.
 * 제목은 피드에서 바로 보인다.
 */
export function buildTitle(productTitle: string, item?: ItemRef): string {
  const base = productTitle.trim();
  if (!item) return base.slice(0, 80);
  const suffix = ` · 프로필 링크 ${item.itemNumber}번`;
  return base.slice(0, 80 - suffix.length) + suffix;
}

/** 영상 설명란에 붙일 문구. 제휴 고지를 반드시 포함한다. */
export function buildDescription(
  target: LinkTarget,
  linkUrl: string,
  hashtags: string[],
  item?: ItemRef,
): string {
  const route = item
    ? [`프로필 링크 ${item.itemNumber}번에서 확인하세요`, item.pageUrl]
    : [`구매하기 ▶ ${linkUrl}`];

  return [
    target.productTitle,
    '',
    ...route,
    '',
    // 공정거래위원회 추천·보증 심사지침상 경제적 대가를 받는 경우 명시해야 한다.
    '※ 이 영상은 제휴 마케팅 링크를 포함하며, 구매 시 일정액의 수수료를 받습니다.',
    '',
    hashtags.map((t) => `#${t}`).join(' '),
  ].join('\n');
}

/** 고정 댓글 문구. 설명란을 안 펴는 시청자를 위한 두 번째 경로. */
export function buildPinnedComment(linkUrl: string, item?: ItemRef): string {
  const target = item ? `프로필 링크 ${item.itemNumber}번 ▶ ${item.pageUrl}` : `구매 링크 ▶ ${linkUrl}`;
  return `${target}\n(제휴 링크이며 구매 시 수수료를 받습니다)`;
}
