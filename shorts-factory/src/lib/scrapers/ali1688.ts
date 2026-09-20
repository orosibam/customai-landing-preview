import { MIN_SOURCE_COUNT, TARGET_SOURCE_COUNT } from '../../config.js';
import { aliOffer, downloadVideo } from './cn-bridge.js';
import { markFailed, markUsed, takeLinks } from './linkstore.js';

/**
 * 1688 상품 상세 영상 수집 — 소재 공급처.
 *
 * 타오바오를 쓰지 않는 이유는 실측이다. 타오바오에서는 영상을 한 건도 받지 못했고,
 * 실제로 받아진 건 샤오홍슈와 1688 둘뿐이었다.
 *
 * ## 검색은 HTTP 로 못 뚫는다
 *
 * 1688 검색 페이지는 받아지긴 한다(25KB). 그런데 그 안에 `detail.1688.com/offer` 링크도,
 * `offerId`·`data-offer-id` 키도 **0건**이다. 캡차도 로그인 벽도 아니고, 상품 목록을 JS 가
 * 나중에 받아온다 — HTML 은 껍데기다. 진입로를 바꿔도(GBK/UTF-8, 쿠키 워밍업, 모바일,
 * JSON 엔드포인트) 전부 같았다. 그러니 검색을 뚫으려는 시도는 여기서 접는다.
 *
 * **상세 페이지는 로그인 없이 열린다.** 그래서 필요한 건 상세 URL 목록뿐이고, 그건
 * `harvest/ali1688.js` 로 브라우저에서 한 번 긁어 `harvested_links` 에 넣어둔다.
 *
 * 수집한 클립은 그대로 쓰지 않는다 — 렌더 단계에서 소스당 MAX_CLIP_SEC(5초) 이내로만
 * 잘라 쓰며, 그 상한은 ffmpeg.trimToPortrait 이 강제한다. 여기서는 출처 URL 을 온전히
 * 보존해 나중에 어떤 판매자 소재를 썼는지 추적할 수 있게 한다.
 */

export interface AliClip {
  /** 실제 미디어 파일 주소 */
  videoUrl: string;
  /** 상품 상세 페이지 주소 — 출처 추적용 */
  productUrl: string;
  offerId: string;
  title: string;
}

export interface AliQuery {
  /** 중국어 상품명. 수확할 때 쓴 키워드와 같아야 링크가 잡힌다. */
  keywordZh: string;
  limit?: number;
}

/**
 * 상품 영상을 모은다.
 *
 * 원본 방법론은 "네 개에서 다섯 개 정도" 를 권한다. 소스가 적으면 같은 화면이 반복돼
 * 지루해지고, 무엇보다 소스당 사용 길이가 길어져 5초 상한에 걸린다.
 */
export async function collectClips(query: AliQuery): Promise<AliClip[]> {
  const limit = query.limit ?? TARGET_SOURCE_COUNT;

  // 상품마다 영상이 있는 건 아니라서 넉넉히 꺼내 훑는다.
  const links = await takeLinks('ali1688', query.keywordZh, limit * 4);

  const clips: AliClip[] = [];
  const failures: string[] = [];

  for (const link of links) {
    if (clips.length >= limit) break;
    try {
      // URL 통째로 넘긴다. 상품 id 로 재조립하지 않는다.
      const offer = await aliOffer(link.url);
      const videoUrl = offer.videoUrls[0];
      if (!videoUrl) {
        await markFailed(link.id, '상세에 영상 없음');
        continue;
      }
      await markUsed(link.id);
      clips.push({
        videoUrl,
        productUrl: offer.productUrl,
        offerId: offer.offerId,
        title: offer.title,
      });
    } catch (e) {
      const reason = (e as Error).message;
      failures.push(`${link.url.slice(0, 60)}: ${reason}`);
      await markFailed(link.id, reason);
    }
  }

  if (clips.length < MIN_SOURCE_COUNT) {
    throw new Error(
      `소재 부족: "${query.keywordZh}" 로 수확 링크 ${links.length}건을 훑어 ` +
        `영상 ${clips.length}개만 찾았습니다 (최소 ${MIN_SOURCE_COUNT}개 필요). ` +
        `소스가 적으면 소스당 사용 길이가 길어져 5초 상한에 걸립니다. ` +
        `링크를 더 수확하거나(npm run links snippet ali) 상품을 교체하세요.` +
        (failures.length > 0 ? ` 실패: ${failures.slice(0, 3).join(' / ')}` : ''),
    );
  }

  return clips;
}

/**
 * 영상 파일을 내려받는다.
 *
 * node 의 fetch 가 아니라 파이썬 쪽에서 받는다 — 수집할 때와 같은 TLS 지문을 써야
 * CDN 이 열어준다. 오류 페이지를 mp4 라고 저장하는 조용한 실패는 파이썬 쪽에서
 * 파일 크기로 걸러 던진다.
 */
export async function downloadClip(videoUrl: string, outPath: string): Promise<void> {
  await downloadVideo(videoUrl, outPath, 'https://detail.1688.com/');
}
