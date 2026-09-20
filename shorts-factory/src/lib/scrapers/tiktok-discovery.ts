import { withContext, pause } from '../browser.js';
import { parseCount } from './types.js';

/**
 * 틱톡 발굴 — 상품과 설계도를 동시에 얻는다.
 *
 * 앞선 파이프라인은 상품을 먼저 정하고(S1) 레퍼런스를 나중에 찾았다(S2).
 * 틱톡 쇼핑은 순서가 반대다. "꿀템" 같은 시드 키워드로 제품 리뷰 채널을 찾고
 * **인기순으로 정렬**하면, 이미 터진 영상 목록이 곧 잘 팔리는 상품 목록이다.
 * 조회수가 상품 검증과 크리에이티브 검증을 동시에 해준다.
 *
 * 소재는 여기서 가져오지 않는다. 한국 영상은 그대로 쓸 수 없으므로,
 * 상품명을 중국어로 옮겨 다시 검색해 해외 원본 영상을 따로 구한다.
 */

export interface HotVideo {
  /** 틱톡 영상 URL */
  url: string;
  videoId: string;
  authorHandle: string;
  caption: string;
  views: number | null;
  likes: number | null;
}

/** 제품 리뷰 채널을 찾을 때 쓰는 시드 키워드. */
export const SEED_KEYWORDS = ['꿀템', '생활꿀템', '주방꿀템', '살림템', '가성비템'];

/**
 * 시드 키워드로 제품 리뷰 채널을 찾고, 각 채널의 인기 영상을 모은다.
 *
 * 이미 틱톡에서 검증된 영상만 본다는 게 요점이다. 내가 좋아 보이는 상품이 아니라
 * 시장이 이미 반응한 상품을 고른다.
 */
export async function discoverHotVideos(
  seedKeyword: string,
  opts: { channelLimit?: number; perChannel?: number; minViews?: number } = {},
): Promise<HotVideo[]> {
  const channelLimit = opts.channelLimit ?? 4;
  const perChannel = opts.perChannel ?? 6;
  const minViews = opts.minViews ?? 300_000;

  return withContext({ locale: 'ko-KR', timezone: 'Asia/Seoul' }, async (ctx) => {
    const page = await ctx.newPage();

    await page.goto(
      `https://www.tiktok.com/search/user?q=${encodeURIComponent(seedKeyword)}`,
      { waitUntil: 'domcontentloaded', timeout: 45_000 },
    );
    await pause(3_000, 5_000);

    const handles = await page.$$eval('a[href^="/@"]', (nodes) =>
      [...new Set(nodes.map((n) => n.getAttribute('href') ?? ''))]
        .filter((h) => /^\/@[^/]+$/.test(h))
        .slice(0, 12),
    );

    const collected: HotVideo[] = [];

    for (const handle of handles.slice(0, channelLimit)) {
      try {
        const videos = await readChannelPopular(page, handle, perChannel);
        collected.push(...videos.filter((v) => (v.views ?? 0) >= minViews));
        await pause(1_500, 3_000);
      } catch (e) {
        console.warn(`채널 ${handle} 읽기 실패: ${(e as Error).message}`);
      }
    }

    await page.close();

    collected.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    return collected;
  });
}

/** 채널 페이지에서 인기순 탭을 눌러 상위 영상을 읽는다. */
async function readChannelPopular(
  page: import('playwright').Page,
  handle: string,
  limit: number,
): Promise<HotVideo[]> {
  await page.goto(`https://www.tiktok.com${handle}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await pause(2_000, 3_500);

  // 인기순 탭. 최신순으로 두면 아직 검증 안 된 영상이 섞인다.
  const popularTab = page.locator('text=/인기|Popular/').first();
  if (await popularTab.isVisible().catch(() => false)) {
    await popularTab.click();
    await pause(1_500, 2_500);
  }

  const items = await page.$$eval('[data-e2e="user-post-item"]', (nodes) =>
    nodes.slice(0, 20).map((n) => ({
      href: n.querySelector('a')?.getAttribute('href') ?? '',
      views: n.querySelector('[data-e2e="video-views"]')?.textContent ?? '',
      caption: n.querySelector('img')?.getAttribute('alt') ?? '',
    })),
  );

  return items
    .filter((i) => i.href.includes('/video/'))
    .slice(0, limit)
    .map((i) => ({
      url: i.href.startsWith('http') ? i.href : `https://www.tiktok.com${i.href}`,
      videoId: i.href.split('/video/')[1]?.split('?')[0] ?? '',
      authorHandle: handle,
      caption: i.caption.trim(),
      views: parseCount(i.views),
      likes: null,
    }));
}

/**
 * 중국어 키워드로 해외 원본 영상을 찾는다.
 *
 * 한국 영상은 소재로 쓸 수 없다 — 같은 시장의 같은 시청자에게 같은 화면을 다시
 * 보여주는 꼴이라 의미가 없고, 원작자와 직접 충돌한다. 그래서 상품명을 중국어로
 * 옮겨 원본 상품 영상을 따로 구한다.
 *
 * 한 번에 안 나오는 경우가 흔하다. 호출부가 키워드를 변형해 재시도하도록
 * 빈 배열을 돌려주고 끝내지 않고 시도한 검색어를 함께 반환한다.
 */
export async function findOverseasFootage(
  keywordsZh: string[],
  limit = 5,
): Promise<{ videos: HotVideo[]; triedKeywords: string[] }> {
  const tried: string[] = [];

  for (const keyword of keywordsZh) {
    tried.push(keyword);

    const videos = await withContext(
      { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(
          `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}`,
          { waitUntil: 'domcontentloaded', timeout: 45_000 },
        );
        await pause(3_000, 5_000);

        const items = await page.$$eval('[data-e2e="search_video-item"]', (nodes) =>
          nodes.slice(0, 20).map((n) => ({
            href: n.querySelector('a')?.getAttribute('href') ?? '',
            caption: n.querySelector('[data-e2e="search-card-video-caption"]')?.textContent ?? '',
            views: n.querySelector('[data-e2e="video-views"]')?.textContent ?? '',
          })),
        );
        await page.close();

        return items
          .filter((i) => i.href.includes('/video/'))
          .slice(0, limit)
          .map((i) => ({
            url: i.href.startsWith('http') ? i.href : `https://www.tiktok.com${i.href}`,
            videoId: i.href.split('/video/')[1]?.split('?')[0] ?? '',
            authorHandle: i.href.split('/@')[1]?.split('/')[0] ?? '',
            caption: i.caption.trim(),
            views: parseCount(i.views),
            likes: null,
          }));
      },
    );

    if (videos.length > 0) return { videos, triedKeywords: tried };
    console.warn(`중국어 검색 "${keyword}" 결과 없음 — 다음 변형으로 시도합니다.`);
  }

  return { videos: [], triedKeywords: tried };
}

/**
 * 틱톡 영상 파일을 내려받는다.
 *
 * 외부 다운로드 사이트에 의존하면 그 사이트가 바뀔 때마다 파이프라인이 죽는다.
 * 재생 페이지를 열어 미디어 응답을 직접 받아내는 쪽이 오래 간다.
 */
export async function downloadTikTokVideo(videoUrl: string, outPath: string): Promise<void> {
  const mediaUrl = await withContext({ locale: 'en-US' }, async (ctx) => {
    const page = await ctx.newPage();
    const found: string[] = [];

    page.on('response', (res) => {
      const url = res.url();
      if (/\.mp4/i.test(url) && res.status() === 200) found.push(url);
    });

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await pause(3_000, 5_000);

    // 자동재생이 안 걸리면 재생 요소를 직접 건드려 미디어 요청을 유발한다.
    if (found.length === 0) {
      await page.locator('video').first().click({ timeout: 5_000 }).catch(() => {});
      await pause(2_500, 4_000);
    }

    const src = await page
      .locator('video')
      .first()
      .getAttribute('src')
      .catch(() => null);

    await page.close();
    return found[0] ?? src ?? null;
  });

  if (!mediaUrl) {
    throw new Error(`영상 주소를 찾지 못했습니다: ${videoUrl}`);
  }

  // Referer 를 **열었던 페이지 기준으로** 만든다.
  //
  // 여기 틱톡 주소가 박혀 있었다. 이 함수는 구조 분석가가 **인스타 릴스**를 받을
  // 때도 쓰는데(analyst.sampleFrames), 그때 인스타 CDN 에 틱톡 Referer 를 보내면
  // 거절당한다. 1688 CDN 에서 같은 성질을 이미 확인했다 — 꼬리표가 안 맞으면
  // 非法访问 로 돌려준다.
  let referer = 'https://www.tiktok.com/';
  try {
    referer = new URL(videoUrl).origin + '/';
  } catch {
    // 주소를 못 읽으면 기본값으로 둔다. 여기서 던질 일은 아니다.
  }

  const res = await fetch(mediaUrl, {
    headers: {
      Referer: referer,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`영상 다운로드 실패 (${res.status}): ${videoUrl}`);

  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}
