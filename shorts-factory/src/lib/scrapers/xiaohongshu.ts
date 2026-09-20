import { xhsNote } from './cn-bridge.js';
import { markFailed, markUsed, takeLinks } from './linkstore.js';
import type { RawReference, ScrapeQuery, Scraper } from './types.js';

/**
 * 샤오홍슈(小红书) 레퍼런스·소재 수집.
 *
 * 가치가 큰 출처다 — 소재를 중국 커머스에서 가져오는데 설계도까지 중국 커머스 숏폼에서
 * 가져오면 같은 상품·같은 화면·같은 구성이 통째로 맞물린다. 실제로 받아진 영상도
 * 여기가 제일 많았다.
 *
 * ## 왜 검색하지 않고 수확한 링크를 쓰는가
 *
 * 세 가지를 다 해보고 남은 결론이다.
 *
 *   · Playwright + 로그인 세션으로 `/search_result` → 「로그인 후 검색결과 보기」만 렌더되고
 *     검색 API 호출 자체가 일어나지 않는다. 게스트 쿠키로 서명 호출을 해도 code -104.
 *   · 비로그인 SSR 은 열린다(실측 183KB). 하지만 입구가 `/explore` 홈피드뿐이고 무작위라
 *     조준이 안 된다 — 반복 호출로 980건을 뽑아 적중 0건이었다. 모수를 늘리는 걸로는
 *     해결되지 않는 구조적 한계다.
 *   · 유일하게 통한 것: **로그인된 브라우저에서 검색 결과의 href 를 통째로 수확**하고,
 *     그 링크를 비로그인 curl_cffi 로 여는 것. 토큰이 쿼리스트링에 들어 있어서 가능하다.
 *
 * 그래서 사람 손은 「1회성 수확」에만 들어가고(`harvest/xiaohongshu.js`), 그 뒤 파싱·
 * 다운로드는 전부 자동이다. 수확물이 떨어지면 `LinkStoreEmptyError` 로 멈추고 알린다 —
 * 재고 소진과 코드 고장은 다른 문제라 섞지 않는다.
 *
 * ## href 를 자르지 않는다
 *
 * note id 만 남기고 xsec_token 을 버리면 그 링크는 전부 404 다. 그렇게 55건을 통째로
 * 날린 적이 있다. 그래서 이 파일은 저장된 URL 을 한 글자도 건드리지 않고 그대로 넘긴다.
 */

export const xiaohongshuScraper: Scraper = {
  platform: 'xiaohongshu',

  async search(query: ScrapeQuery): Promise<RawReference[]> {
    // 열어보면 영상이 없는 노트(사진 노트)도 섞여 있어서 넉넉히 꺼낸다.
    const links = await takeLinks('xiaohongshu', query.keyword, query.limit * 3);

    const cutoff = Date.now() - query.maxAgeDays * 24 * 60 * 60 * 1000;
    const refs: RawReference[] = [];
    const problems: string[] = [];

    for (const link of links) {
      if (refs.length >= query.limit) break;

      // URL 통째로 넘긴다. 재조립하지 않는다.
      const detail = await xhsNote(link.url).catch((e: Error) => {
        problems.push(e.message);
        return null;
      });

      if (!detail) {
        await markFailed(link.id, '상세 열기 실패');
        continue;
      }

      const postedAt = detail.postedAtMs ? new Date(detail.postedAtMs) : null;
      if (postedAt && postedAt.getTime() < cutoff) {
        // 오래된 건 실패가 아니라 조건 미달이다. 다시 볼 일이 없으니 사유를 남겨둔다.
        await markFailed(link.id, `${query.maxAgeDays}일보다 오래됨`);
        continue;
      }

      await markUsed(link.id);

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
        `"${query.keyword}" 로 수확 링크 ${links.length}건을 열었지만 쓸 수 있는 게 없습니다.\n` +
          `   사유: ${problems.slice(0, 3).join(' / ') || '전부 조건 미달'}\n` +
          `   토큰 만료라면 다시 수확해야 합니다 (npm run links snippet xhs).`,
      );
    }
    return refs;
  },
};
