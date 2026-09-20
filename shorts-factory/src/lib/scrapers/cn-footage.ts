import { aliOffer, aliSearch, downloadVideo, taobaoItem, taobaoSearch } from './cn-bridge.js';

/**
 * 중국 내수 플랫폼(1688 · 타오바오) 상품 영상 수집 — 소재 2·3차 공급처.
 *
 * ## 왜 공급처를 늘리는가
 *
 * 소재가 알리 하나뿐이었고 거기가 **두 번 막혔다**. 원인도 서로 달랐다 —
 * 2차 제작은 속도 제한(검증 페이지), 5차 제작은 상품 7건 전부 영상 0개.
 * 다른 단계는 전부 폴백이 있는데(인스타↔틱톡, 쿠팡→다나와) 소재만 없어서,
 * 알리가 재채기하면 그날 공장이 선다.
 *
 * ## 1688 은 살아 있다 — 내가 잘못 판정했던 것이다
 *
 * "1688 검색은 HTTP 로 못 뚫는다" 고 주석에까지 박아뒀는데, 근거로 삼은 계측은
 * 이렇게 찍혀 있었다:
 *
 *   m.1688   200   67,517 bytes   offerIds 0   ← 추출 결과
 *                                 offerIdAttr 20  ← 그런데 속성은 20개 있었다
 *
 * 모바일 검색이 detail 링크 대신 `data-offer-id` 속성으로 싣는데 추출이 링크만
 * 찾았다. 계측은 답을 줬고 읽는 쪽이 못 받았다. 파이썬 쪽을 고쳤고 여기가 그걸 쓴다.
 *
 * ## URL 을 재조립하는 것에 대해
 *
 * 샤오홍슈에서는 "수확한 URL 을 통째로 넘긴다" 가 철칙이다 — 토큰을 벗겼다가
 * 55건을 날린 적이 있다. 여기서는 사정이 다르다. 검색이 돌려주는 건 **id 뿐이고
 * 토큰이라는 게 애초에 없다.** 잃을 파라미터가 없으니 표준 상세 주소를 만든다.
 * 수확 링크(harvested_links)를 쓸 때는 지금도 통째로 넘긴다(ali1688.ts).
 */

export interface CnClip {
  /** 실제 미디어 파일 주소 */
  videoUrl: string;
  /** 상품 상세 주소 — 어떤 판매자 소재를 썼는지 추적용 */
  productUrl: string;
  productId: string;
  site: 'ali1688' | 'taobao';
  /** CDN 이 이 헤더를 본다. 사이트마다 달라서 클립에 붙여 다닌다. */
  referer: string;
}

/** 상세를 몇 건 열어볼지 — 상품마다 영상이 있는 건 아니라 넉넉히 훑는다. */
const DETAIL_FACTOR = 3;

/** 상세 사이 간격. 알리에서 한 번 속도 제한에 걸린 뒤로 중국 쪽은 전부 쉬어 간다. */
async function breathe(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1_200 + Math.random() * 1_300));
}

export interface CnCollectResult {
  clips: CnClip[];
  /** 왜 이만큼밖에 못 모았는지. 0건일 때 호출부가 그대로 로그에 남긴다. */
  note: string;
}

/**
 * 1688 상품 상세 영상.
 *
 * 한 상품에 영상이 여러 개면 **전부** 가져온다. 예전에 첫 번째만 쓰다가 풀이
 * 안 차서 소스당 사용 길이가 길어졌고, 그러면 MAX_CLIP_SEC 상한에 걸린다.
 */
export async function collect1688Clips(keywordZh: string, want: number): Promise<CnCollectResult> {
  const ids = await aliSearch(keywordZh, want * DETAIL_FACTOR);

  const clips: CnClip[] = [];
  let opened = 0;
  const errors: string[] = [];

  for (const id of ids) {
    if (clips.length >= want) break;
    try {
      const offer = await aliOffer(`https://detail.1688.com/offer/${id}.html`);
      opened++;
      for (const videoUrl of offer.videoUrls) {
        if (clips.some((c) => c.videoUrl === videoUrl)) continue;
        clips.push({
          videoUrl,
          productUrl: offer.productUrl,
          productId: offer.offerId,
          site: 'ali1688',
          referer: 'https://detail.1688.com/',
        });
      }
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message.slice(0, 80)}`);
    }
    await breathe();
  }

  return {
    clips,
    note:
      `1688 "${keywordZh}": 상품 ${ids.length}건 중 ${opened}건을 열어 영상 ${clips.length}개` +
      (errors.length > 0 ? ` (상세 실패 ${errors.length}건: ${errors.slice(0, 2).join(' / ')})` : ''),
  };
}

/**
 * 타오바오 상품 상세 영상.
 *
 * 이전 기록은 "타오바오에서는 영상을 한 건도 받지 못했다" 였는데, 그게 검색이
 * 막혀서인지 상세에 영상이 없어서인지 구분돼 있지 않았다. 둘은 대응이 완전히
 * 다르다 — 앞이면 진입로를 바꾸고, 뒤면 이 공급처를 접어야 한다. 그래서
 * 로그인 벽 개수를 따로 세어 돌려준다.
 */
export async function collectTaobaoClips(keywordZh: string, want: number): Promise<CnCollectResult> {
  const ids = await taobaoSearch(keywordZh, want * DETAIL_FACTOR);

  const clips: CnClip[] = [];
  let opened = 0;
  let loginWalls = 0;
  const errors: string[] = [];

  for (const id of ids) {
    if (clips.length >= want) break;
    try {
      const item = await taobaoItem(id);
      opened++;
      if (item.loginWall) loginWalls++;
      for (const videoUrl of item.videoUrls) {
        if (clips.some((c) => c.videoUrl === videoUrl)) continue;
        clips.push({
          videoUrl,
          productUrl: item.productUrl,
          productId: item.itemId,
          site: 'taobao',
          referer: 'https://item.taobao.com/',
        });
      }
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message.slice(0, 80)}`);
    }
    await breathe();
  }

  return {
    clips,
    note:
      `타오바오 "${keywordZh}": 상품 ${ids.length}건 중 ${opened}건을 열어 영상 ${clips.length}개` +
      (loginWalls > 0 ? ` — 그중 ${loginWalls}건은 로그인 벽이라 영상 유무를 못 봤습니다` : '') +
      (errors.length > 0 ? ` (상세 실패 ${errors.length}건: ${errors.slice(0, 2).join(' / ')})` : ''),
  };
}

/**
 * 영상 파일을 내려받는다.
 *
 * node 의 fetch 가 아니라 파이썬 쪽에서 받는다 — 수집할 때와 같은 TLS 지문을 써야
 * CDN 이 열어준다. 오류 페이지를 mp4 라고 저장하는 조용한 실패는 파이썬이 파일
 * 크기로 걸러 던진다.
 */
export async function downloadCnClip(
  clip: { videoUrl: string; referer: string },
  outPath: string,
): Promise<void> {
  await downloadVideo(clip.videoUrl, outPath, clip.referer);
}
