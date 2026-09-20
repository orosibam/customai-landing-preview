import { writeFile } from 'node:fs/promises';
import { withContext, pause, SessionExpiredError } from '../browser.js';
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
  if (/차량|자동차/.test(category)) return ['carcleaning', 'cardetailing', 'caraccessories'];
  if (/가전|가젯/.test(category)) return ['homegadgets', 'gadgetsyouneed', 'coolgadgets'];
  return IG_SEED_TAGS;
}

function requireSession(): string {
  const state = optionalEnv('INSTAGRAM_STORAGE_STATE', '');
  if (!state) {
    throw new SessionExpiredError(
      '인스타그램',
      '해시태그 탐색은 로그인 세션이 있어야 결과가 보입니다. ' +
        'npm run capture instagram 으로 한 번 로그인한 뒤 ' +
        '.sessions/instagram.json 을 INSTAGRAM_STORAGE_STATE 에 넣으세요.',
    );
  }
  return state;
}

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
  const storageState = requireSession();

  return withContext({ storageState, locale: 'en-US', timezone: 'America/Los_Angeles' }, async (ctx) => {
    const page = await ctx.newPage();

    await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await pause(3_000, 5_000);

    if (page.url().includes('/accounts/login')) {
      throw new SessionExpiredError(
        '인스타그램',
        '저장된 세션으로 해시태그 페이지를 열었는데 로그인으로 튕겼습니다. ' +
          'npm run capture instagram 으로 세션을 다시 뜨세요.',
      );
    }

    // 릴스만 본다. 정지 이미지 게시물은 설계도 추출에 쓸 수 없다.
    const hrefs: string[] = [];
    for (let round = 0; round < 4 && hrefs.length < limit * 2; round++) {
      const found = await page.$$eval('a[href*="/reel/"]', (ns) =>
        ns.map((n) => n.getAttribute('href') ?? '').filter(Boolean),
      );
      for (const h of found) if (!hrefs.includes(h)) hrefs.push(h);
      await page.mouse.wheel(0, 2_000);
      await pause(1_500, 2_500);
    }

    if (hrefs.length === 0) {
      // 0건을 성공으로 넘기지 않는다. 발굴이 0이면 뒤가 전부 이유 없이 멈춘다.
      const visible = await page.locator('body').innerText().catch(() => '');
      throw new Error(
        `#${tag} 에서 릴스를 한 건도 못 찾았습니다. ` +
          `해시태그가 비었거나 인스타가 이 세션에 결과를 안 주고 있습니다. ` +
          `화면: ${visible.replace(/\s+/g, ' ').slice(0, 160)}`,
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
  });
}

async function readReel(
  page: import('playwright').Page,
  href: string,
  tag: string,
): Promise<HotVideo> {
  const url = `https://www.instagram.com${href}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await pause(1_500, 2_500);

  const data = await page.evaluate(() => {
    const text = (sel: string): string => document.querySelector(sel)?.textContent?.trim() ?? '';
    // 조회수는 "1.2M views" 처럼 별도 span 에 들어간다. 라벨로 찾는다.
    const spans = Array.from(document.querySelectorAll('span')).map((s) => s.textContent ?? '');
    const viewsText = spans.find((t) => /view/i.test(t)) ?? '';
    const likesText = spans.find((t) => /like/i.test(t)) ?? '';
    return {
      caption: text('h1'),
      viewsText,
      likesText,
      author: document.querySelector('header a[href^="/"]')?.getAttribute('href') ?? '',
      video: document.querySelector('video')?.getAttribute('src') ?? '',
    };
  });

  return {
    url,
    videoId: href.split('/reel/')[1]?.replace(/\//g, '') ?? href,
    authorHandle: data.author.replace(/\//g, '') || `#${tag}`,
    caption: data.caption.slice(0, 300),
    views: parseCount(data.viewsText),
    likes: parseCount(data.likesText),
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
