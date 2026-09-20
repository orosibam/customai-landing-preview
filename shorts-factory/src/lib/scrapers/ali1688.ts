import { MIN_SOURCE_COUNT, TARGET_SOURCE_COUNT } from '../../config.js';
import { aliOffer, aliSearch, downloadVideo } from './cn-bridge.js';

/**
 * 1688 상품 상세 영상 수집 — 소재 공급처.
 *
 * 타오바오를 쓰지 않는 이유는 실측 결과다. 타오바오에서는 영상을 한 건도 받지 못했고,
 * 실제로 받아진 건 샤오홍슈와 1688 둘뿐이었다. 1688 쪽은 오히려 단순하다 —
 * 상품 상세 HTML 에 영상 주소가 그대로 박혀 있어서 재생 페이지를 열어 미디어 응답을
 * 가로챌 필요가 없다 (그 방식은 샤오홍슈에서 막힌 바로 그 방식이다).
 *
 * 판매자가 리셀러 확산을 전제로 올린 마케팅 소재라 Content ID 그물에 걸리지 않는다.
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
  /** 중국어 상품명. 소싱 담당이 만들어 샤오홍슈 필터와 공유하는 값. */
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

  // 상품마다 영상이 있는 건 아니라서 검색 결과를 넉넉히 받아 훑는다.
  const offerIds = await aliSearch(query.keywordZh, Math.max(limit * 4, 20));

  const clips: AliClip[] = [];
  const failures: string[] = [];

  for (const offerId of offerIds) {
    if (clips.length >= limit) break;
    try {
      const offer = await aliOffer(offerId);
      const videoUrl = offer.videoUrls[0];
      if (!videoUrl) continue;
      clips.push({ videoUrl, productUrl: offer.productUrl, offerId, title: offer.title });
    } catch (e) {
      failures.push(`${offerId}: ${(e as Error).message}`);
    }
  }

  if (clips.length < MIN_SOURCE_COUNT) {
    throw new Error(
      `소재 부족: "${query.keywordZh}" 로 상품 ${offerIds.length}개를 훑어 ` +
        `영상 ${clips.length}개만 찾았습니다 (최소 ${MIN_SOURCE_COUNT}개 필요). ` +
        `소스가 적으면 소스당 사용 길이가 길어져 5초 상한에 걸립니다. ` +
        `검색어를 바꾸거나 상품을 교체하세요.` +
        (failures.length > 0 ? ` 실패한 상품: ${failures.slice(0, 3).join(' / ')}` : ''),
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
