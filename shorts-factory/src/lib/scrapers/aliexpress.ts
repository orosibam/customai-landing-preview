import { writeFile } from 'node:fs/promises';
import { withContext, pause } from '../browser.js';
import { FOOTAGE_POOL_SIZE } from '../../config.js';

/**
 * 알리익스프레스 상품 영상 수집 — 소재 공급처.
 *
 * ## 왜 1688 이 아니라 여기가 1차인가
 *
 * 러너 실측(2026-09-20)이 브라우저로 연 1688·샤오홍슈 경로를 닫았다:
 *   · 샤오홍슈 검색   256KB → 登录后查看搜索结果          링크 0
 *   · 1688 PC 검색   236KB → 亲，请拖动下方滑块完成验证   링크 0  (슬라이더 캡차)
 *   · 1688 모바일     220KB → 密码登录 / 扫码登录         링크 0
 *
 * 데이터센터 IP 에서 **브라우저로 열면** 이렇다. 나중에 생 HTTP + 크롬 TLS 지문으로
 * 받으면 1688 모바일 검색은 상품 id 를 내준다는 게 확인됐고(cn-footage.ts), 그래서
 * 1688 은 2차 공급처로 살아 있다. 다만 여기가 먼저인 건 같은 날 같은 러너에서
 * 알리가 검색·상세·영상까지 끝까지 간 유일한 곳이었기 때문이다.
 *
 * 같은 날 같은 러너에서 알리는 달랐다:
 *   · 검색      로그인·캡차 없이 열림, 상품 링크 6개
 *   · 상세 5건  HTML 약 400KB 정상 렌더, 그중 3건에 mp4 주소가 직접 박혀 있음
 *
 * ## 1688 판과 무엇이 다른가
 *
 * **harvested_links 가 필요 없다.** 1688 은 검색이 막혀서 사람이 브라우저로 상세
 * URL 을 미리 긁어 DB 에 채워둬야 했다. 알리는 검색이 열리므로 키워드만 있으면
 * 검색부터 영상까지 한 번에 간다 — 사람 손이 빠진다.
 *
 * ## 조용히 넘어가지 않는다
 *
 * 상품마다 영상이 있는 건 아니다(실측 5건 중 3건). 그래서 넉넉히 훑되, 최소 개수를
 * 못 채우면 던진다. 소스가 적으면 소스당 사용 길이가 길어져 MAX_CLIP_SEC 상한에
 * 걸리고, 무엇보다 같은 화면이 반복돼 지루해진다.
 */

export interface AliClip {
  /** 실제 미디어 파일 주소 */
  videoUrl: string;
  /** 상품 상세 주소 — 어떤 판매자 소재를 썼는지 추적용 */
  productUrl: string;
  productId: string;
  title: string;
}

export interface AliCollectResult {
  clips: AliClip[];
  /** 서로 다른 판매자 수. 같은 페이지의 두 영상은 같은 촬영본이라 1로 센다. */
  sellersWithVideo: number;
  /** 왜 이만큼인지. 부족해도 여기서 던지지 않고 호출부가 공급처를 갈아타며 읽는다. */
  note: string;
}

export interface AliQuery {
  /** 영문 검색어. 알리는 해외向 이라 영어가 기본이다. */
  keyword: string;
  limit?: number;
}

/** 알리바바 검증 페이지에만 나오는 표식. 일반 단어는 넣지 않는다 —
 *  'captcha' · 'slider' 같은 건 멀쩡한 상품 페이지에서도 걸려 거짓 경보가 됐다. */
const BLOCK_MARKERS = [
  'punish.aliexpress.com',
  '_____tmd_____',
  'nc_1_n1z',
  '滑动验证',
  '请拖动下方滑块',
];

/** 상세 HTML 안의 mp4 주소. JSON 문자열 안에 이스케이프된 채로 박혀 있다. */
const VIDEO_RE = /https?:\\?\/\\?\/[^"'\s\\]*(?:alicdn\.com|aliexpress\.com|cloud\.video\.taobao\.com)[^"'\s]*?\.mp4[^"'\s]*/gi;

const ITEM_RE = /\/item\/(\d+)\.html/;

function unescapeUrl(url: string): string {
  return url.replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\+$/, '');
}

export class AliBlockedError extends Error {
  constructor(detail: string) {
    super(`알리익스프레스 접근이 막혔습니다: ${detail}`);
    this.name = 'AliBlockedError';
  }
}

/**
 * 검색어로 **같은 제품의 영상을 여러 개** 모은다.
 *
 * 완성 영상에 쓰는 건 5개쯤이지만, 여기서는 그보다 훨씬 많이 받는다. 편집자가
 * 설계도의 컷마다 "그 동작이 실제로 찍힌 소재" 를 골라야 하는데, 후보가 쓸 개수와
 * 같으면 고르는 게 아니라 채우는 게 되기 때문이다.
 *
 * 두 방향으로 늘린다:
 *   · 판매자를 여러 명 본다 — 같은 제품이라도 찍은 각도와 동작이 다르다
 *   · 한 상품 페이지의 mp4 를 전부 받는다 — 실측에서 페이지당 2개씩 있었다
 *
 * 예전엔 페이지당 첫 번째 하나만 받고 나머지를 버렸다. 절반을 버리고 있었던 셈이다.
 */
export async function collectClips(query: AliQuery): Promise<AliCollectResult> {
  const limit = query.limit ?? FOOTAGE_POOL_SIZE;

  return withContext<AliCollectResult>({ locale: 'en-US', timezone: 'America/Los_Angeles' }, async (ctx) => {
    const page = await ctx.newPage();

    const searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(
      query.keyword.trim().replace(/\s+/g, '-'),
    )}.html`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(5_000, 7_000);

    const searchHtml = await page.content();
    const wall = BLOCK_MARKERS.find((m) => searchHtml.includes(m));
    if (wall) {
      throw new AliBlockedError(`검색 페이지가 검증으로 떴습니다 ("${wall}"). 잠시 뒤 다시 시도하세요.`);
    }

    // a.href 프로퍼티를 읽는다 — 절대 URL 로 해석되면서 쿼리스트링이 보존된다.
    const hrefs: string[] = await page.$$eval('a[href*="/item/"]', (ns) =>
      [...new Set(ns.map((n) => (n as HTMLAnchorElement).href))],
    );
    const items = hrefs.filter((u) => ITEM_RE.test(u));

    if (items.length === 0) {
      throw new AliBlockedError(
        `검색 "${query.keyword}" 에서 상품 링크를 한 건도 못 찾았습니다 ` +
          `(${searchHtml.length.toLocaleString()}바이트 수신, 검증 표식 없음). ` +
          `검색어가 너무 좁거나 페이지 구조가 바뀐 쪽입니다.`,
      );
    }

    /**
     * 검증 페이지가 뜨면 잠깐 쉬었다 다시 연다.
     *
     * 계측(상세 5건)은 통과했는데 실제 수집(최대 36건)에서 막혔다. 차이는 요청량이다 —
     * 연달아 열면 알리바바가 `_____tmd_____` 검증으로 돌린다. 영구 차단이 아니라
     * 속도 제한이라, 쉬었다 다시 열면 열린다. 1688 쪽(cn_media.py)에서 이미 같은
     * 방식으로 푼 적이 있다.
     *
     * 계속 막히면 던진다. 조용히 0건으로 넘기면 "소재가 없다" 로 오진하게 되고,
     * 그러면 검색어를 바꾸며 헛수고하게 된다 — 원인은 검색어가 아니라 속도다.
     */
    const openDetail = async (url: string, attempts = 3): Promise<string> => {
      let lastWall = '';
      for (let i = 0; i < attempts; i++) {
        if (i > 0) {
          const waitMs = 4_000 * 2 ** i + Math.random() * 2_000;
          console.log(`알리 검증("${lastWall}") — ${Math.round(waitMs / 1000)}초 쉬고 다시 엽니다`);
          await page.waitForTimeout(waitMs);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pause(4_000, 6_000);
        const html = await page.content();
        const wall = BLOCK_MARKERS.find((m) => html.includes(m));
        if (!wall) return html;
        lastWall = wall;
      }
      throw new AliBlockedError(
        `상세가 ${attempts}번 연속 검증으로 떴습니다 ("${lastWall}"). ` +
          `요청이 너무 잦습니다 — 잠시 뒤 다시 시도하거나 소재 풀 크기를 줄이세요.`,
      );
    };

    const clips: AliClip[] = [];
    const noVideo: string[] = [];
    // 판매자가 달라도 같은 소재 영상을 쓰는 경우가 있다. 같은 파일을 두 번 받으면
    // 편집자에게는 선택지가 늘어난 것처럼 보이는데 실제로는 같은 화면이다.
    const seenVideos = new Set<string>();
    let sellersWithVideo = 0;

    // 영상 보유율이 60% 남짓이라(실측) 넉넉히 훑는다.
    for (const url of items.slice(0, limit * 3)) {
      if (clips.length >= limit) break;

      try {
        const html = await openDetail(url);

        const found = [...new Set((html.match(VIDEO_RE) ?? []).map(unescapeUrl))].filter((u) =>
          u.startsWith('http'),
        );
        if (found.length === 0) {
          noVideo.push(url);
          continue;
        }

        const title =
          (await page.title().catch(() => '')).replace(/\s*[-|]\s*AliExpress.*$/i, '').trim() ||
          '(제목 없음)';
        const productId = url.match(ITEM_RE)?.[1] ?? '';

        // 페이지의 mp4 를 전부 받는다. 예전엔 첫 번째 하나만 쓰고 나머지를 버렸는데,
        // 실측에서 페이지당 2개씩 있었으므로 절반을 버리고 있었던 셈이다.
        let addedHere = 0;
        for (const videoUrl of found) {
          if (clips.length >= limit) break;
          if (seenVideos.has(videoUrl)) continue;
          seenVideos.add(videoUrl);
          clips.push({ videoUrl, productUrl: url, productId, title: title.slice(0, 120) });
          addedHere++;
        }
        if (addedHere > 0) sellersWithVideo++;

        // 다음 상품까지 간격을 둔다. 앞에서 검증에 걸린 게 속도 때문이었다.
        await pause(2_500, 4_500);
      } catch (e) {
        if (e instanceof AliBlockedError) throw e;
        // 상품 한 건이 안 열리는 건 흔하다. 다만 세지 않고 넘기지는 않는다.
        const first = (e as Error).message.split('\n')[0] ?? '';
        noVideo.push(`${url} (${first.slice(0, 60)})`);
      }
    }

    // 모자라도 여기서 던지지 않는다.
    //
    // 예전에는 MIN_SOURCE_COUNT 에 못 미치면 여기서 예외를 냈다. 공급처가 알리
    // 하나였을 때는 그게 맞았지만 — 지금은 1688·타오바오가 뒤에 있다. 여기서
    // 던지면 3개를 이미 받아놓고도 그걸 버리고 다음 공급처가 0에서 다시 시작한다.
    // 부족 판정은 **풀 전체를 본 뒤** 소재 담당이 한다.
    //
    // 판매자 수를 따로 세어 넘긴다. 같은 페이지에서 뽑은 두 영상은 같은 촬영본이라
    // 화면이 비슷하고, 그걸 서로 다른 소스로 세면 "다양한 소재를 확보했다" 가 거짓이 된다.
    const note =
      `알리 "${query.keyword}": 상품 ${items.length}건 중 ` +
      `${Math.min(items.length, limit * 3)}건을 훑어 판매자 ${sellersWithVideo}곳에서 ` +
      `영상 ${clips.length}개` +
      (noVideo.length > 0 ? ` (영상 없던 상품 ${noVideo.length}건)` : '');
    console.log(note);

    return { clips, sellersWithVideo, note };
  });
}

/**
 * 영상 파일을 내려받는다.
 *
 * 오류 페이지를 mp4 라고 저장하는 조용한 실패를 막으려고 content-type 과 크기를
 * 둘 다 본다. 여기서 빈 파일이 넘어가면 렌더가 이유 없이 깨진다.
 */
export async function downloadClip(videoUrl: string, outPath: string): Promise<void> {
  const res = await fetch(videoUrl, {
    headers: {
      Referer: 'https://www.aliexpress.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`영상 내려받기 실패 (HTTP ${res.status}): ${videoUrl.slice(0, 120)}`);
  }

  const ctype = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());

  if (bytes.byteLength < 10_240) {
    throw new Error(
      `영상이 너무 작습니다 (${bytes.byteLength}바이트, content-type: ${ctype || '없음'}). ` +
        `mp4 가 아니라 오류 페이지를 받은 것으로 보입니다: ${videoUrl.slice(0, 120)}`,
    );
  }
  if (ctype && !ctype.includes('video') && !ctype.includes('octet-stream')) {
    throw new Error(
      `영상이 아닌 응답입니다 (content-type: ${ctype}, ${bytes.byteLength}바이트): ` +
        videoUrl.slice(0, 120),
    );
  }

  await writeFile(outPath, bytes);
}
