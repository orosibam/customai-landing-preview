import { withContext, pause, SessionExpiredError } from '../browser.js';
import { optionalEnv } from '../../config.js';
import { parseCount, type RawReference, type ScrapeQuery, type Scraper } from './types.js';

/**
 * 샤오홍슈(小红书) 레퍼런스 수집.
 *
 * 셋 중 가장 까다롭다. 로그인 세션이 필수이고 UI도 자주 바뀐다. 대신 가치가 크다 —
 * 소재를 타오바오에서 가져오는데 설계도까지 중국 커머스 숏폼에서 가져오면
 * 같은 상품·같은 화면·같은 구성이 통째로 맞물리기 때문이다.
 *
 * 조회수를 공개하지 않는 노트가 많아서 좋아요 + 수집(收藏) 을 인게이지먼트로 쓴다.
 * 깨질 것을 전제로 설계했다 — 실패하면 S2가 다른 플랫폼으로 쿼터를 재배분한다.
 */

export const xiaohongshuScraper: Scraper = {
  platform: 'xiaohongshu',

  async search(query: ScrapeQuery): Promise<RawReference[]> {
    const storageState = optionalEnv('XIAOHONGSHU_STORAGE_STATE', '');
    if (!storageState) throw new SessionExpiredError('샤오홍슈');

    return withContext({ storageState, locale: 'zh-CN', timezone: 'Asia/Shanghai' }, async (ctx) => {
      const page = await ctx.newPage();

      await page.goto(
        `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query.keyword)}&type=video`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await pause(3_000, 5_000);

      if (await page.locator('text=登录').first().isVisible().catch(() => false)) {
        await page.close();
        throw new SessionExpiredError('샤오홍슈');
      }

      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 2_000);
        await pause(1_500, 2_500);
      }

      const cards = await page.$$eval('section.note-item, div.note-item', (nodes) =>
        nodes.slice(0, 40).map((n) => ({
          href: n.querySelector('a')?.getAttribute('href') ?? '',
          title: n.querySelector('.title, span')?.textContent?.trim() ?? '',
          likes: n.querySelector('.like-wrapper .count, .count')?.textContent?.trim() ?? '',
        })),
      );
      await page.close();

      return cards
        .filter((c) => c.href)
        .slice(0, query.limit)
        .map((c) => ({
          platform: 'xiaohongshu' as const,
          externalId: c.href.split('/').filter(Boolean).pop() ?? c.href,
          externalUrl: c.href.startsWith('http')
            ? c.href
            : `https://www.xiaohongshu.com${c.href}`,
          caption: c.title,
          // 검색 목록에서는 조회수를 주지 않는다. 좋아요만 읽고,
          // outlierScore 가 좋아요 기반임을 알아서 스케일을 보정한다.
          views: null,
          likes: parseCount(c.likes),
          collects: null,
          followerCount: null,
          postedAt: null,
        }));
    });
  },
};
