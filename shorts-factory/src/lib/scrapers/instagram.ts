import { withContext, pause, SessionExpiredError } from '../browser.js';
import { optionalEnv } from '../../config.js';
import { parseCount, type RawReference, type ScrapeQuery, type Scraper } from './types.js';

/**
 * 인스타그램 릴스 레퍼런스 수집.
 *
 * 해시태그 탐색 페이지는 로그인 세션이 있어야 대부분의 결과가 보인다.
 * 세션이 없거나 만료되면 SessionExpiredError 를 던져서 대시보드가 재로그인을
 * 요청하게 한다 — 빈 배열을 돌려주고 조용히 넘어가면 S2가 "레퍼런스가 없네"
 * 하고 잘못된 결론을 내린다.
 */

export const instagramScraper: Scraper = {
  platform: 'instagram',

  async search(query: ScrapeQuery): Promise<RawReference[]> {
    const storageState = optionalEnv('INSTAGRAM_STORAGE_STATE', '');
    if (!storageState) throw new SessionExpiredError('인스타그램');

    return withContext({ storageState, locale: 'en-US' }, async (ctx) => {
      const page = await ctx.newPage();
      const tag = query.keyword.replace(/\s+/g, '');

      await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await pause(2_500, 4_000);

      if (page.url().includes('/accounts/login')) {
        await page.close();
        throw new SessionExpiredError('인스타그램');
      }

      // 릴스 링크만 추린다. 정지 이미지 게시물은 설계도 추출에 쓸 수 없다.
      const links = await page.$$eval('a[href*="/reel/"]', (nodes) =>
        [...new Set(nodes.map((n) => n.getAttribute('href') ?? ''))].filter(Boolean).slice(0, 40),
      );

      const results: RawReference[] = [];
      for (const href of links.slice(0, query.limit)) {
        try {
          results.push(await readReel(page, href));
          await pause(1_200, 2_400);
        } catch (e) {
          console.warn(`인스타 릴스 읽기 실패 (${href}): ${(e as Error).message}`);
        }
      }

      await page.close();
      return results;
    });
  },
};

async function readReel(
  page: import('playwright').Page,
  href: string,
): Promise<RawReference> {
  const url = `https://www.instagram.com${href}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await pause(1_500, 2_500);

  const data = await page.evaluate(() => {
    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? '';
    return {
      caption: text('h1') || text('[data-testid="post-comment-root"] span'),
      views: text('span:has-text("views")'),
      likes: text('section span'),
      video: document.querySelector('video')?.getAttribute('src') ?? '',
      time: document.querySelector('time')?.getAttribute('datetime') ?? '',
    };
  });

  const videoUrl = data.video;
  return {
    platform: 'instagram',
    externalId: href.split('/reel/')[1]?.replace(/\//g, '') ?? href,
    externalUrl: url,
    caption: data.caption,
    views: parseCount(data.views),
    likes: parseCount(data.likes),
    collects: null,
    followerCount: null,
    postedAt: data.time ? new Date(data.time) : null,
    ...(videoUrl ? { videoUrl } : {}),
  };
}
