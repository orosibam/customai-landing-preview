import { optionalEnv } from '../../config.js';
import { xhsFeed, xhsNote, type XhsFeedNote } from './cn-bridge.js';
import type { RawReference, ScrapeQuery, Scraper } from './types.js';

/**
 * 샤오홍슈(小红书) 레퍼런스 수집.
 *
 * 가치가 큰 출처다 — 소재를 중국 커머스에서 가져오는데 설계도까지 중국 커머스 숏폼에서
 * 가져오면 같은 상품·같은 화면·같은 구성이 통째로 맞물린다.
 *
 * ## 이 파일이 브라우저를 쓰지 않는 이유
 *
 * 이전 구현은 로그인 세션을 담은 Playwright 로 `/search_result` 를 열었다. 실측에서 막혔다:
 *
 *   · 검색 페이지가 「로그인 후 검색결과 보기」로만 렌더되고 검색 API 호출 자체가 일어나지 않는다
 *   · 게스트 쿠키를 받아 페이지 컨텍스트의 서명 함수로 직접 호출해도 code -104 (권한 없음)
 *
 * 통한 방법은 브라우저를 아예 안 쓰는 것이다. curl_cffi 로 크롬 TLS 지문을 흉내 내
 * SSR HTML 을 받고 `__INITIAL_STATE__` 를 파싱한다 (`scrapers-py/cn_media.py`).
 * 로그인도 쿠키도 필요 없어서 `XIAOHONGSHU_STORAGE_STATE` 는 더 이상 쓰지 않는다.
 *
 * ## 대신 포기한 것 — 정직하게
 *
 * **키워드 검색을 할 수 없다.** 입구는 `/explore` 피드뿐이고, 키워드는 피드에 뜬 노트의
 * 캡션을 보고 거르는 데만 쓴다. 그래서 니치한 상품일수록 0건이 나온다. 그때 빈 배열을
 * 돌려주면 위에서는 "그런 레퍼런스가 없다"로 읽지만 실제로는 "검색을 못 했다"이다 —
 * 둘은 다른 문제라 구분해서 던진다. 계정별 노트 목록도 막혀 있다
 * (2026-09-18 재측정에서 noteId 가 전부 빈 문자열).
 */

export class FeedMissError extends Error {
  constructor(keyword: string, scanned: number) {
    super(
      `샤오홍슈 피드 ${scanned}건 중 "${keyword}" 와 맞는 노트가 없습니다. ` +
        `샤오홍슈는 키워드 검색이 막혀 있어 그날 피드에 뜬 것 중에서만 고를 수 있습니다 — ` +
        `"레퍼런스가 없다"가 아니라 "이번 피드에 안 떴다"는 뜻이므로, ` +
        `다른 플랫폼으로 할당량을 돌리거나 다음 실행에서 다시 시도하세요.`,
    );
    this.name = 'FeedMissError';
  }
}

/**
 * 피드를 한 번에 몇 건까지 훑을 것인가.
 * 키워드 필터를 캡션으로만 걸 수 있어서 모수가 작으면 매번 0건이 난다.
 */
const FEED_SCAN_LIMIT = Number(optionalEnv('XHS_FEED_SCAN_LIMIT', '60'));

/**
 * 훑을 채널(카테고리) 목록. 비워두면 기본 피드만 본다.
 *
 * 채널 id 는 샤오홍슈가 공개하지 않아 브라우저 주소창에서 직접 확인해야 하는 값이라
 * 코드에 박지 않는다 — 확인되지 않은 id 를 기본값으로 두면 조용히 기본 피드만 보면서
 * 카테고리를 좁힌 줄 알게 된다.
 */
const CHANNELS = optionalEnv('XHS_EXPLORE_CHANNELS', '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

/** 키워드가 캡션에 걸리는지. 중국어는 띄어쓰기가 없어 부분 일치로 본다. */
function matches(note: XhsFeedNote, keyword: string): boolean {
  const haystack = note.title.toLowerCase();
  const needle = keyword.toLowerCase().trim();
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  // 두 글자 이상의 조각이 걸리면 같은 제품군으로 본다 ("洗车液" → "洗车").
  return needle.length >= 3 && haystack.includes(needle.slice(0, 2));
}

export const xiaohongshuScraper: Scraper = {
  platform: 'xiaohongshu',

  async search(query: ScrapeQuery): Promise<RawReference[]> {
    const feeds: XhsFeedNote[] = [];
    const sources = CHANNELS.length > 0 ? CHANNELS : [undefined];

    for (const channel of sources) {
      const batch = await xhsFeed(FEED_SCAN_LIMIT, channel);
      feeds.push(...batch);
    }

    const hits = feeds.filter((n) => matches(n, query.keyword)).slice(0, query.limit);
    if (hits.length === 0) throw new FeedMissError(query.keyword, feeds.length);

    const cutoff = Date.now() - query.maxAgeDays * 24 * 60 * 60 * 1000;
    const refs: RawReference[] = [];

    for (const hit of hits) {
      // 상세를 열어야 수집(收藏) 수와 영상 주소가 나온다. 토큰은 이 노트 전용이라
      // 피드에서 받은 것을 그대로 넘긴다.
      const detail = await xhsNote(hit.noteId, hit.xsecToken).catch((e: Error) => {
        console.warn(`노트 ${hit.noteId} 상세 실패: ${e.message}`);
        return null;
      });
      if (!detail) continue;

      const postedAt = detail.postedAtMs ? new Date(detail.postedAtMs) : null;
      if (postedAt && postedAt.getTime() < cutoff) continue;

      refs.push({
        platform: 'xiaohongshu',
        externalId: detail.noteId,
        externalUrl: detail.url,
        caption: [detail.title, detail.desc].filter(Boolean).join(' — '),
        // 샤오홍슈는 조회수를 공개하지 않는다. outlierScore 가 좋아요+수집 기반임을
        // 알고 스케일을 보정한다.
        views: null,
        likes: detail.likes,
        collects: detail.collects,
        followerCount: detail.followerCount,
        postedAt,
        videoUrl: detail.videoUrl ?? undefined,
      });
    }

    if (refs.length === 0) {
      throw new Error(
        `"${query.keyword}" 로 피드에서 ${hits.length}건을 골랐지만 상세를 하나도 열지 못했습니다. ` +
          `xsec_token 이 만료됐거나 SSR 구조가 바뀐 쪽이 유력합니다.`,
      );
    }
    return refs;
  },
};
