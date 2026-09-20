import { db, must } from '../supabase.js';

/**
 * 수확한 링크를 꺼내 쓰는 창구.
 *
 * 샤오홍슈·1688 둘 다 비로그인으로는 키워드 검색이 안 된다. 검증된 유일한 경로는
 * 로그인된 브라우저에서 검색 결과 href 를 통째로 긁는 것이고, 그건 사람 손을 탄다.
 * 그 수확물이 `harvested_links` 에 쌓여 있고, 파이프라인은 여기서 꺼내 쓴다.
 *
 * ⚠️ url 은 저장된 그대로 넘긴다. 재조립하거나 파라미터를 정리하지 않는다 —
 * xsec_token 을 벗기면 링크가 404 가 된다 (실제로 55건을 그렇게 날린 적이 있다).
 */

export type LinkPlatform = 'xiaohongshu' | 'ali1688';

export interface HarvestedLink {
  id: string;
  url: string;
  title: string | null;
  keyword: string;
}

/** 수확물이 바닥났을 때. 고장이 아니라 사람 손이 필요하다는 신호라 따로 구분한다. */
export class LinkStoreEmptyError extends Error {
  constructor(
    readonly platform: LinkPlatform,
    readonly keyword: string,
  ) {
    const how =
      platform === 'xiaohongshu'
        ? 'npm run links snippet xhs'
        : 'npm run links snippet ali';
    super(
      `${platform} / "${keyword}" 로 쓸 수 있는 수확 링크가 없습니다.\n` +
        `   이건 코드 고장이 아니라 재고 소진입니다. 비로그인으로는 키워드 검색이 안 되므로 ` +
        `로그인된 브라우저에서 한 번 더 긁어야 합니다:\n` +
        `     ${how}\n` +
        `   그 뒤:  npm run links import <내려받은 파일>`,
    );
    this.name = 'LinkStoreEmptyError';
  }
}

/**
 * 아직 안 쓴 링크를 꺼낸다.
 *
 * 키워드가 정확히 안 맞으면 같은 플랫폼의 다른 키워드로는 내려가지 않는다 —
 * 세차용품 영상에 주방용품 소재를 붙이는 건 실패보다 나쁘다. 차라리 멈추고 알린다.
 */
export async function takeLinks(
  platform: LinkPlatform,
  keyword: string,
  limit: number,
): Promise<HarvestedLink[]> {
  const rows = await must(
    '수확 링크 조회',
    db()
      .from('harvested_links')
      .select('id, url, title, keyword')
      .eq('platform', platform)
      .eq('keyword', keyword)
      .is('used_at', null)
      .is('failed_reason', null)
      .order('harvested_at', { ascending: false })
      .limit(limit),
  );

  const links = rows as HarvestedLink[];
  if (links.length === 0) throw new LinkStoreEmptyError(platform, keyword);
  return links;
}

/** 실제로 쓴 링크에 표시한다. 같은 소재가 여러 영상에 반복되면 금방 들킨다. */
export async function markUsed(id: string): Promise<void> {
  await must(
    '링크 사용 표시',
    db().from('harvested_links').update({ used_at: new Date().toISOString() }).eq('id', id),
  );
}

/**
 * 열었지만 쓸 수 없던 링크에 사유를 남긴다.
 *
 * 지우지 않는 이유: 지우면 다음 수확 때 같은 링크가 다시 들어오고, 매일 같은 404 를
 * 때리게 된다. 왜 못 썼는지를 남겨야 그게 토큰 만료인지 영상 없음인지 나중에 구분된다.
 */
export async function markFailed(id: string, reason: string): Promise<void> {
  await must(
    '링크 실패 기록',
    db().from('harvested_links').update({ failed_reason: reason.slice(0, 500) }).eq('id', id),
  );
}
