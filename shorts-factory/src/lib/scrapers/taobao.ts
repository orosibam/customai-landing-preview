import { withContext, pause } from '../browser.js';
import { MIN_SOURCE_COUNT, TARGET_SOURCE_COUNT } from '../../config.js';

/**
 * 타오바오·1688 상품 상세 영상 수집.
 *
 * 원본 방법론의 소재 공급처. 판매자가 리셀러 확산을 전제로 올린 마케팅 소재라
 * 인스타/틱톡 리포스트와 달리 Content ID 그물에 걸리지 않는다.
 *
 * 수집한 클립은 그대로 쓰지 않는다. 렌더 단계에서 각 소스당 MAX_CLIP_SEC(5초)
 * 이내로만 잘라 쓰며, 그 상한은 ffmpeg.trimToPortrait 에서 강제된다.
 * 여기서는 원본과 출처 URL을 온전히 보존해 나중에 어떤 판매자 소재를 썼는지
 * 추적할 수 있게 한다.
 */

export interface TaobaoClip {
  sourceUrl: string;
  /** 상품 상세 페이지 주소 — 출처 추적용 */
  productUrl: string;
  videoUrl: string;
  title: string;
}

export interface TaobaoQuery {
  /** 중국어 상품명. S1이 만들어 S2(샤오홍슈 검색)와 공유하는 값. */
  keywordZh: string;
  limit?: number;
}

/**
 * 상품 영상을 모은다.
 *
 * 원본 방법론은 "네 개에서 다섯 개 정도" 를 권한다. 소스가 적으면 같은 화면이
 * 반복돼 영상이 지루해지고, 무엇보다 소스당 사용 길이가 길어져 5초 상한에 걸린다.
 */
export async function collectClips(query: TaobaoQuery): Promise<TaobaoClip[]> {
  const limit = query.limit ?? TARGET_SOURCE_COUNT;

  const clips = await withContext(
    { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    async (ctx) => {
      const page = await ctx.newPage();
      const found: TaobaoClip[] = [];

      // 상품 상세의 동영상은 대개 별도 미디어 요청으로 내려온다.
      // DOM 을 뒤지는 것보다 네트워크 응답을 보는 편이 안정적이다.
      const videoUrls = new Set<string>();
      page.on('response', (res) => {
        const url = res.url();
        if (/\.(mp4|m3u8)(\?|$)/i.test(url) && !url.includes('logo')) videoUrls.add(url);
      });

      await page.goto(
        `https://s.taobao.com/search?q=${encodeURIComponent(query.keywordZh)}`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await pause(3_000, 5_000);

      const productLinks = await page.$$eval('a[href*="item.taobao.com"], a[href*="detail.tmall"]', (nodes) =>
        [...new Set(nodes.map((n) => n.getAttribute('href') ?? ''))]
          .filter(Boolean)
          .slice(0, 20),
      );

      for (const href of productLinks) {
        if (found.length >= limit) break;
        const productUrl = href.startsWith('http') ? href : `https:${href}`;
        videoUrls.clear();
        try {
          await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await pause(2_500, 4_000);

          const title = await page.title();
          const [videoUrl] = [...videoUrls];
          if (videoUrl) {
            found.push({ sourceUrl: videoUrl, productUrl, videoUrl, title });
          }
        } catch (e) {
          console.warn(`상품 페이지 열기 실패 (${productUrl}): ${(e as Error).message}`);
        }
      }

      await page.close();
      return found;
    },
  );

  if (clips.length < MIN_SOURCE_COUNT) {
    throw new Error(
      `소재 부족: "${query.keywordZh}" 로 ${clips.length}개만 찾았습니다 (최소 ${MIN_SOURCE_COUNT}개 필요). ` +
        `소스가 적으면 소스당 사용 길이가 길어져 ${'5'}초 상한에 걸립니다. 검색어를 바꾸거나 상품을 교체하세요.`,
    );
  }

  return clips;
}

/** 원격 영상 파일을 내려받는다. */
export async function downloadClip(videoUrl: string, outPath: string): Promise<void> {
  const res = await fetch(videoUrl, {
    headers: { Referer: 'https://item.taobao.com/', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`클립 다운로드 실패 (${res.status}): ${videoUrl}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}
