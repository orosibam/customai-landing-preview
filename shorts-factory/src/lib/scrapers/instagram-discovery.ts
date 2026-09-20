import { writeFile } from 'node:fs/promises';
import { withContext, pause } from '../browser.js';
import type { Page } from 'playwright';
import { optionalEnv } from '../../config.js';
import { parseCount } from './types.js';
import type { HotVideo } from './tiktok-discovery.js';

/**
 * 인스타 릴스 발굴 — 해외에서 이미 터진 영상을 찾는다.
 *
 * ## 왜 틱톡이 아니라 여기인가
 *
 * 발굴은 파이프라인의 첫 단계라 여기가 막히면 나머지가 전부 안 돈다. 그런데
 * 틱톡이 두 겹으로 막혔다 — 러너에서 로그인 없이 게시물 목록을 안 내주고
 * (실측: 프로필 머리말은 보이는데 스크롤 12회에 0건), 사용자 쪽 틱톡 로그인도
 * 로그인 횟수 제한에 걸려 있다.
 *
 * ## 한국 시드를 쓰지 않는다
 *
 * 틱톡판은 「꿀템」 「살림템」 같은 한국어 시드를 썼다. 그건 한국 크리에이터를
 * 찾는 검색어다. 우리가 원하는 건 **해외에서 터졌지만 한국에 아직 안 들어온**
 * 포맷이라 시드도 영어여야 한다. 한국어로 찾으면 이미 한국에 들어온 것만 나오고,
 * 그건 타임머신 아비트라지가 성립하지 않는다.
 *
 * ## 조회수가 아니라 팔로워 대비로 본다
 *
 * 팔로워가 많아서 나온 조회수는 우리가 복제할 수 없다. 다만 인스타는 릴스 상세에
 * 계정 팔로워 수가 안 실리는 경우가 많아, 여기서는 원시 지표만 들고 나가고
 * 아웃라이어 판정은 호출부에 맡긴다.
 */

/**
 * 해외 생활용품·청소·주방 릴스가 도는 해시태그.
 *
 * 브랜드 태그가 아니라 **행위·범주** 태그만 쓴다. 브랜드 태그는 그 브랜드 홍보물만
 * 나와서 구조를 베낄 만한 게 없다.
 */
export const IG_SEED_TAGS = [
  'cleaninghacks',
  'kitchengadgets',
  'homegadgets',
  'organizationhacks',
  'carcleaning',
  'cleantok',
  'homehacks',
  'gadgetsyouneed',
];

/**
 * 채널 카테고리(한국어)를 영문 해시태그로 옮긴다.
 *
 * 매핑에 없으면 전체 시드를 쓴다 — 빈 목록을 돌려주면 발굴이 조용히 0건이 된다.
 */
export function tagsForCategory(category: string): string[] {
  if (/주방/.test(category)) return ['kitchengadgets', 'kitchenhacks', 'cookinggadgets'];
  if (/수납|정리|생활/.test(category)) return ['organizationhacks', 'homehacks', 'cleaninghacks'];
  // 「세차」 는 「차량」 에 안 걸린다 — 정규식이 놓치면 조용히 전체 시드로 떨어지고,
  // 세차 제품에 주방 해시태그가 붙는다. 실제로 세차 워터건에서 걸렸다.
  if (/차량|자동차|세차|워터건|물총/.test(category)) {
    return ['carcleaning', 'cardetailing', 'caraccessories'];
  }
  if (/가전|가젯/.test(category)) return ['homegadgets', 'gadgetsyouneed', 'coolgadgets'];
  return IG_SEED_TAGS;
}

/**
 * 해시태그 경로 후보. 순서가 곧 우선순위다.
 *
 * 실측(2026-09-20, 러너)에서 **비로그인이 더 잘 된다.**
 *   · 비로그인 → /explore/tags/<tag>/ 가 /popular/<tag>/ 로 넘어가며 릴스 12개
 *   · 세션 있음 → /explore/search/keyword/ 로 넘어가며 릴스 0개
 *
 * 세션을 넣으면 인스타가 개인화된 검색 화면을 주는데 거기엔 릴스 그리드가 없다.
 * 그래서 세션을 필수로 요구하던 걸 뒤집었다 — 그대로 뒀으면 0건이 나왔다.
 */
const TAG_ROUTES = [
  (t: string) => `https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`,
  (t: string) => `https://www.instagram.com/popular/${encodeURIComponent(t)}/`,
];

/**
 * 해시태그 하나에서 릴스를 모은다.
 *
 * 틱톡판과 시그니처를 맞춰뒀다(`discoverHotVideos`). 소싱 담당이 공급처를 바꿀 때
 * import 한 줄만 바뀌도록 하기 위해서다.
 */
export async function discoverHotVideos(
  tag: string,
  opts: { limit?: number; minViews?: number } = {},
): Promise<HotVideo[]> {
  const limit = opts.limit ?? 12;
  const minViews = opts.minViews ?? 0;

  // 비로그인을 먼저 쓴다(실측에서 이쪽이 된다). 0건일 때만 세션으로 한 번 더 본다 —
  // 인스타가 경로를 또 바꿀 수 있으니 붙어 있는 세션을 버리지는 않는다.
  const state = optionalEnv('INSTAGRAM_STORAGE_STATE', '');
  const attempts: { label: string; storageState?: string }[] = [{ label: '비로그인' }];
  if (state) attempts.push({ label: '세션', storageState: state });

  const problems: string[] = [];

  for (const attempt of attempts) {
    const found = await withContext(
      {
        ...(attempt.storageState ? { storageState: attempt.storageState } : {}),
        locale: 'en-US',
        timezone: 'America/Los_Angeles',
      },
      async (ctx) => collectFromTag(await ctx.newPage(), tag, limit, minViews, problems, attempt.label),
    );
    if (found.length > 0) {
      console.log(`#${tag}: ${attempt.label} 으로 릴스 ${found.length}건`);
      return found;
    }
  }

  // 0건을 성공으로 넘기지 않는다. 발굴이 0이면 뒤가 전부 이유 없이 멈춘다.
  throw new Error(
    `#${tag} 에서 릴스를 한 건도 못 찾았습니다 (${attempts.map((a) => a.label).join(', ')} 모두).\n` +
      problems.map((p) => `   ${p}`).join('\n'),
  );
}

/** 경로 후보를 순서대로 열어 릴스를 모은다. */
async function collectFromTag(
  page: Page,
  tag: string,
  limit: number,
  minViews: number,
  problems: string[],
  label: string,
): Promise<HotVideo[]> {
  const hrefs: string[] = [];

  for (const route of TAG_ROUTES) {
    await page.goto(route(tag), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await pause(3_000, 5_000);

    if (page.url().includes('/accounts/login')) {
      problems.push(`${label}: 로그인 화면으로 튕겼습니다 (${route(tag)})`);
      continue;
    }

    // 릴스만 본다. 정지 이미지 게시물은 설계도 추출에 쓸 수 없다.
    for (let round = 0; round < 4 && hrefs.length < limit * 2; round++) {
      const found = await page.$$eval('a[href*="/reel/"]', (ns) =>
        ns.map((n) => n.getAttribute('href') ?? '').filter(Boolean),
      );
      for (const h of found) if (!hrefs.includes(h)) hrefs.push(h);
      await page.mouse.wheel(0, 2_000);
      await pause(1_500, 2_500);
    }

    if (hrefs.length > 0) break;

    const visible = await page.locator('body').innerText().catch(() => '');
    problems.push(
      `${label}: ${page.url()} 에서 릴스 0개 — ${visible.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }

  const out: HotVideo[] = [];
  for (const href of hrefs.slice(0, limit)) {
    try {
      const v = await readReel(page, href, tag);
      if ((v.views ?? 0) >= minViews) out.push(v);
      await pause(1_200, 2_400);
    } catch (e) {
      console.warn(`릴스 읽기 실패 (${href}): ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * 페이지에 박힌 JSON 에서 숫자를 줍는다.
 *
 * ## 조회수는 비로그인으로 못 읽는다 (실측)
 *
 * DOM 스팬도 JSON 키도 다 틀려서 조회수가 계속 null 이었다. 키 이름을 더 추측하는
 * 대신 페이지에 **실제로 있는** 숫자 키를 찍어봤더니 답이 나왔다:
 *
 *   oz_www_playback_speed_*, oz_www_in_play_buffer_*, oz_www_max_bandwidth_sample_count ...
 *
 * 전부 비디오 플레이어 설정값이고 **조회수 계열 키가 하나도 없다.** 인스타가
 * 비로그인 릴스 페이지에는 조회수를 안 싣는다. 파싱 문제가 아니라 데이터가 없는 것이다.
 *
 * 그래서 좋아요를 대체 지표로 쓴다. 조회수보다 약하지만 "이 릴스가 반응을 얻었나" 는
 * 답한다. 조회수가 필요하면 로그인 세션이 있어야 하는데, 세션을 붙이면 해시태그
 * 탐색 자체가 0건이 된다(실측) — 지금은 둘을 동시에 가질 수 없다.
 */
function numFromJson(html: string, keys: string[]): number | null {
  for (const key of keys) {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

async function readReel(page: Page, href: string, tag: string): Promise<HotVideo> {
  const url = `https://www.instagram.com${href}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await pause(1_500, 2_500);

  const html = await page.content();

  const data = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span')).map((s) => s.textContent ?? '');
    return {
      caption: document.querySelector('h1')?.textContent?.trim() ?? '',
      viewsText: spans.find((t) => /view|조회/i.test(t)) ?? '',
      likesText: spans.find((t) => /like|좋아요/i.test(t)) ?? '',
      author: document.querySelector('header a[href^="/"]')?.getAttribute('href') ?? '',
    };
  });

  // 조회수는 비로그인으로 안 실린다(위 주석의 실측). 있으면 쓰고, 없으면 null 로 둔다.
  const views =
    numFromJson(html, ['video_view_count', 'play_count', 'video_play_count', 'view_count']) ??
    parseCount(data.viewsText);
  const likes = numFromJson(html, ['edge_liked_by', 'like_count']) ?? parseCount(data.likesText);

  return {
    url,
    videoId: href.split('/reel/')[1]?.replace(/\//g, '') ?? href,
    authorHandle: data.author.replace(/\//g, '') || `#${tag}`,
    caption: data.caption.slice(0, 300),
    views,
    likes,
  };
}

/**
 * 릴스 영상 파일을 내려받는다.
 *
 * 인스타의 video src 는 서명된 임시 주소라 오래 못 간다. 발굴 직후에 받아야 한다.
 * 오류 페이지를 mp4 로 저장하는 조용한 실패를 막으려고 크기를 확인한다.
 */
export async function downloadReel(videoUrl: string, outPath: string): Promise<void> {
  const res = await fetch(videoUrl, {
    headers: { Referer: 'https://www.instagram.com/' },
  });
  if (!res.ok) throw new Error(`릴스 내려받기 실패 (HTTP ${res.status})`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength < 10_240) {
    throw new Error(
      `릴스가 너무 작습니다 (${bytes.byteLength}바이트). 서명이 만료됐거나 오류 페이지입니다.`,
    );
  }
  await writeFile(outPath, bytes);
}

/**
 * 릴스에서 **화면을 찍어** 프레임을 얻는다.
 *
 * ## 왜 내려받지 않고 찍는가
 *
 * 영상을 파일로 받으려다 계속 실패했다. 실측:
 *
 *   /tmp/analyst-*\/ref.mp4: Invalid data found when processing input
 *   [mpegts] Format mpegts detected only with low score of 2
 *   Output file does not contain any stream
 *
 * 인스타는 영상을 통째로 주지 않고 **조각(segment)으로 쪼개** 보낸다. 페이지에서
 * 가로챈 mp4 요청 하나는 그 조각이고, 컨테이너가 없는 바이트 덩어리라 ffmpeg 이
 * 스트림을 못 찾는다. Referer 를 고쳐도 마찬가지였다 — 주소 문제가 아니라
 * **받아온 것이 영상 파일이 아닌** 문제다.
 *
 * 그런데 우리는 원본의 픽셀을 **한 프레임도 쓰지 않는다.** 화면은 수확한 판매자
 * 영상으로 채우고, 릴스에서 가져오는 건 구조뿐이다. 그러면 파일이 필요 없다 —
 * 재생되는 화면을 찍으면 된다. 조각이든 통짜든 브라우저는 어차피 그려낸다.
 *
 * ## 구조 분석에 이게 왜 필수인가
 *
 * 프레임이 0장이면 LLM 은 상품명만 보고 설계도를 지어낸다. 그러면 "해외에서 터진
 * 구조를 베낀다" 는 이 시스템의 전제가 통째로 사라지고, 매일 창작 대본을 뽑는
 * 평범한 생성기가 된다. 그 차이가 이 프로젝트의 존재 이유다.
 */
export async function captureReelFrames(
  reelUrl: string,
  count = 8,
): Promise<{ frames: Buffer[]; caption: string }> {
  return withContext(
    { locale: 'en-US', timezone: 'America/Los_Angeles' },
    async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(reelUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await pause(2_500, 4_000);

      const video = page.locator('video').first();
      await video.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});

      const has = await page.locator('video').count();
      if (has === 0) {
        throw new Error(
          `릴스 페이지에 video 요소가 없습니다: ${reelUrl}\n` +
            `   로그인 화면으로 튕겼거나 게시물이 내려갔을 수 있습니다.`,
        );
      }

      // 재생시킨다. 정지 상태로 찍으면 같은 첫 프레임이 8장 나오고,
      // 그건 "컷이 어떻게 넘어가는가" 를 하나도 안 알려준다.
      await page.evaluate(() => {
        for (const v of Array.from(document.querySelectorAll('video'))) {
          v.muted = true;
          v.loop = true;
          void v.play().catch(() => {});
        }
      });

      const caption =
        (await page.locator('h1').first().textContent().catch(() => ''))?.trim() ?? '';

      const frames: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        await page.waitForTimeout(1_200);
        try {
          frames.push(await video.screenshot({ type: 'jpeg', quality: 70 }));
        } catch (e) {
          console.warn(`프레임 ${i} 캡처 실패: ${(e as Error).message}`);
        }
      }

      await page.close();

      if (frames.length === 0) {
        throw new Error(`릴스에서 프레임을 한 장도 못 찍었습니다: ${reelUrl}`);
      }
      console.log(`릴스 프레임 ${frames.length}장 캡처 (${reelUrl})`);
      return { frames, caption };
    },
  );
}
