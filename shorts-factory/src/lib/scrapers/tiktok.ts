import { withContext, pause } from '../browser.js';
import { parseCount, type RawReference, type ScrapeQuery, type Scraper } from './types.js';

/**
 * 틱톡 레퍼런스 수집.
 *
 * 1순위는 Creative Center 의 Top Ads 다. 지역·카테고리·기간 필터로 이미 성과순
 * 정렬된 '상업' 숏폼만 모아놓은 곳이라, 쇼핑쇼츠 레퍼런스로는 일반 검색보다 훨씬 낫다.
 * 광고 소재는 애초에 전환을 목적으로 만들어졌기 때문에 훅 구조가 선명하다.
 *
 * Creative Center 가 막히면 일반 검색으로 내려간다.
 */

const CREATIVE_CENTER =
  'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en';

export const tiktokScraper: Scraper = {
  platform: 'tiktok',

  async search(query: ScrapeQuery): Promise<RawReference[]> {
    try {
      const fromAds = await searchCreativeCenter(query);
      if (fromAds.length > 0) return fromAds;
    } catch (e) {
      console.warn(`틱톡 Creative Center 실패, 일반 검색으로 전환: ${(e as Error).message}`);
    }
    return searchPublic(query);
  },
};

async function searchCreativeCenter(query: ScrapeQuery): Promise<RawReference[]> {
  return withContext({ locale: 'en-US', timezone: 'America/Los_Angeles' }, async (ctx) => {
    const page = await ctx.newPage();
    const collected: RawReference[] = [];

    // 프론트엔드가 호출하는 JSON 응답을 가로채는 편이 DOM 파싱보다 안정적이다.
    page.on('response', async (res) => {
      if (!res.url().includes('/creative_radar_api/') || !res.url().includes('top_ads')) return;
      try {
        const body = (await res.json()) as {
          data?: { materials?: TopAdMaterial[] };
        };
        for (const m of body.data?.materials ?? []) {
          collected.push(fromTopAd(m));
        }
      } catch {
        // 관심 없는 응답이거나 JSON이 아님 — 무시한다.
      }
    });

    const url = `${CREATIVE_CENTER}?period=30&keyword=${encodeURIComponent(query.keyword)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await pause(2_500, 4_000);

    // 결과가 더 필요하면 스크롤로 다음 페이지를 부른다.
    for (let i = 0; collected.length < query.limit && i < 3; i++) {
      await page.mouse.wheel(0, 2_000);
      await pause(1_500, 2_500);
    }

    await page.close();
    return collected.slice(0, query.limit);
  });
}

interface TopAdMaterial {
  id?: string;
  ad_title?: string;
  brand_name?: string;
  video_info?: { video_url?: Record<string, string>; duration?: number };
  like?: number;
  cost?: number;
  ctr?: number;
}

function fromTopAd(m: TopAdMaterial): RawReference {
  const videoUrl = m.video_info?.video_url ? Object.values(m.video_info.video_url)[0] : undefined;
  return {
    platform: 'tiktok',
    externalId: m.id ?? crypto.randomUUID(),
    externalUrl: `${CREATIVE_CENTER}/detail/${m.id ?? ''}`,
    caption: [m.brand_name, m.ad_title].filter(Boolean).join(' · '),
    // Top Ads 는 조회수를 주지 않는다. 좋아요를 인게이지먼트로 쓴다.
    views: null,
    likes: m.like ?? null,
    collects: null,
    // 광고 소재에는 계정 팔로워 개념이 없다. null 이면 outlierScore 가
    // 절대 인게이지먼트 기준으로 보수적으로 평가한다.
    followerCount: null,
    postedAt: null,
    ...(videoUrl ? { videoUrl } : {}),
  };
}

async function searchPublic(query: ScrapeQuery): Promise<RawReference[]> {
  return withContext({ locale: 'en-US' }, async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`https://www.tiktok.com/search/video?q=${encodeURIComponent(query.keyword)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await pause(3_000, 5_000);

    const items = await page.$$eval('[data-e2e="search_video-item"]', (nodes) =>
      nodes.slice(0, 30).map((n) => ({
        href: n.querySelector('a')?.getAttribute('href') ?? '',
        caption: n.querySelector('[data-e2e="search-card-video-caption"]')?.textContent ?? '',
        views: n.querySelector('[data-e2e="video-views"]')?.textContent ?? '',
      })),
    );
    await page.close();

    return items
      .filter((i) => i.href)
      .slice(0, query.limit)
      .map((i) => ({
        platform: 'tiktok' as const,
        externalId: i.href.split('/video/')[1]?.split('?')[0] ?? i.href,
        externalUrl: i.href.startsWith('http') ? i.href : `https://www.tiktok.com${i.href}`,
        caption: i.caption.trim(),
        views: parseCount(i.views),
        likes: null,
        collects: null,
        followerCount: null,
        postedAt: null,
      }));
  });
}
