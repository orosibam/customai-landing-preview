import { optionalEnv, YT_SHOPPING_SUBSCRIBER_THRESHOLD } from '../config.js';

/**
 * 제휴 링크 생성.
 *
 * 원본 방법론의 "구독자 0명 비기" 를 코드로 옮긴 것. 유튜브 쇼핑 태그는 조건이
 * 필요하지만, 인포크링크는 조건이 없어서 첫날부터 수익이 난다.
 * 실측 차이가 10% 남짓이라(유튜브 438만 vs 쿠팡파트너스 395만) 조건을 기다릴 이유가 없다.
 *
 * 채널이 조건을 넘기면 자동으로 쇼핑 태그로 승격한다.
 */

export type LinkMode = 'inpock' | 'yt_shopping_tag' | 'naver_sticker';

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
 * - 유튜브: 구독자가 기준을 넘으면 쇼핑 태그, 아니면 인포크링크.
 * - 인스타·틱톡: 프로필 링크 구조라 인포크링크.
 */
export function resolveLinkMode(platform: string, subscriberCount: number): LinkMode {
  if (platform === 'naverclip') return 'naver_sticker';
  if (platform === 'youtube' && subscriberCount >= YT_SHOPPING_SUBSCRIBER_THRESHOLD) {
    return 'yt_shopping_tag';
  }
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

/** 영상 설명란에 붙일 문구. 제휴 고지를 반드시 포함한다. */
export function buildDescription(target: LinkTarget, linkUrl: string, hashtags: string[]): string {
  return [
    `${target.productTitle}`,
    '',
    `구매하기 ▶ ${linkUrl}`,
    '',
    // 공정거래위원회 추천·보증 심사지침상 경제적 대가를 받는 경우 명시해야 한다.
    '※ 이 영상은 제휴 마케팅 링크를 포함하며, 구매 시 일정액의 수수료를 받습니다.',
    '',
    hashtags.map((t) => `#${t}`).join(' '),
  ].join('\n');
}

/** 고정 댓글 문구. 설명란을 안 펴는 시청자를 위한 두 번째 경로. */
export function buildPinnedComment(linkUrl: string): string {
  return `구매 링크 ▶ ${linkUrl}\n(제휴 링크이며 구매 시 수수료를 받습니다)`;
}
