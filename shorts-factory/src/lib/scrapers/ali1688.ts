import { MIN_SOURCE_COUNT, TARGET_SOURCE_COUNT } from '../../config.js';
import { aliOffer, downloadVideo } from './cn-bridge.js';
import { markFailed, markUsed, takeLinks } from './linkstore.js';

/**
 * 1688 상품 상세 영상 수집 — 소재 공급처.
 *
 * 예전 주석은 "타오바오에서는 영상을 한 건도 받지 못했다" 였다. 그 기록에는 **검색이
 * 막혀서인지 상세에 영상이 없어서인지가 빠져 있었다** — 둘은 대응이 완전히 다르다.
 * 지금은 타오바오도 검색 → 상세 → 영상까지 끝까지 재고 있고(sources-probe),
 * 결과에 따라 공급처로 쓴다.
 *
 * ## 이 파일은 "사람이 긁어둔 링크" 를 쓰는 쪽이다
 *
 * 한동안 여기에 "1688 검색은 HTTP 로 못 뚫는다" 고 적어뒀는데 **그건 틀린 판정이었다.**
 * 계측은 m.1688 에서 `data-offer-id` 를 20개 세어 보여줬고, 추출이 detail 링크만
 * 찾느라 0건을 냈다. 읽는 쪽이 못 받은 걸 사이트가 막은 걸로 읽었다.
 * 검색으로 상품 id 를 받아 상세까지 가는 길은 `cn-footage.ts` 에 있고, 소재 담당은
 * 그쪽을 쓴다.
 *
 * 그래도 이 경로를 남겨둔다. **상세 페이지는 로그인 없이 열리므로**, 검색이 다시
 * 막히는 날에도 `harvest/ali1688.js` 로 브라우저에서 한 번 긁어 `harvested_links` 에
 * 넣어두면 영상은 계속 받아진다. 자동 검색이 1차, 이쪽이 사람 손 폴백이다.
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
