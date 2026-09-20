import { chromium, type Page } from 'playwright';

/**
 * 벤치마킹 대상의 **나레이션 전문**을 받는다.
 *
 * ## 왜 다시 만드나
 *
 * yt-dlp 판(scrapers-py/voice_probe.py)은 러너에서 막혔다. 영상 6건 전부
 * 「로그인하여 봇이 아님을 확인하세요」였다. 제목과 채널 정보는 받아졌지만
 * 자막은 한 건도 못 받았다.
 *
 * 같은 러너에서 **진짜 브라우저는 통한다** — 인스타·알리가 Playwright 로 열렸다.
 * 그래서 브라우저로 시청 페이지를 열고, 페이지가 자기 자막을 받아올 때 쓰는
 * timedtext 주소를 ytInitialPlayerResponse 에서 읽어 그대로 받는다.
 *
 * ## 무엇을 읽어야 하는가
 *
 * 제목만으로는 절반이다. 제목은 썸네일 옆 문구고, 영상이 실제로 여는 첫 문장은
 * 따로다. 이 넷을 보려고 받는다:
 *   · 0~2초 문장   훅 문형 ("여러분 이거 아세요" 류인가, 문제 선언인가, 서사인가)
 *   · 어미와 길이  말투
 *   · 소구 시점    몇 초에 이득을 꺼내는가
 *   · 마지막 문장  CTA 문형과 위치
 *
 * 영상은 내려받지 않는다. 자막 텍스트만 쓴다.
 *
 * 실행:  npx tsx src/probe-narration.ts @Homestory_official
 */

const HANDLE = (process.argv[2] ?? '@Homestory_official').replace(/^@?/, '@');
const LIMIT = Number(process.argv[3] ?? '5');

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

/** 시청 페이지 HTML 안의 플레이어 응답에서 자막 트랙 목록을 꺼낸다. */
function captionTracks(html: string): CaptionTrack[] {
  const m = html.match(/"captionTracks":(\[.*?\])(?=,"audioTracks"|,"translationLanguages"|\})/s);
  if (!m?.[1]) return [];
  try {
    return JSON.parse(m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"')) as CaptionTrack[];
  } catch {
    // 이스케이프가 다른 형태로 올 수 있다. 통째로 실패시키지 않고 baseUrl 만 줍는다.
    const urls = [...m[1].matchAll(/"baseUrl":"(.*?)"/g)].map((x) =>
      x[1]!.replace(/\\u0026/g, '&').replace(/\\\//g, '/'),
    );
    return urls.map((u) => ({ baseUrl: u }));
  }
}

function pickKorean(tracks: CaptionTrack[]): string | null {
  const ko = tracks.find((t) => t.languageCode === 'ko');
  return (ko ?? tracks[0])?.baseUrl ?? null;
}

/** timedtext XML → [초, 문장] */
function parseTimedText(xml: string): [number, string][] {
  const out: [number, string][] = [];
  for (const m of xml.matchAll(/<text start="([\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
    const text = m[2]!
      .replace(/&amp;#39;/g, "'")
      .replace(/&amp;quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push([Number(m[1]), text]);
  }
  return out;
}

async function videoIds(page: Page): Promise<{ id: string; title: string }[]> {
  await page.goto(`https://www.youtube.com/${HANDLE}/shorts`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(5_000);

  // HTML 정규식으로 videoId 를 긁으려다 0건이었다. 렌더된 DOM 에서 링크를 읽는 게
  // 훨씬 단순하고 튼튼하다 — 유튜브가 내부 JSON 모양을 바꿔도 a[href] 는 남는다.
  const rows: { id: string; title: string }[] = await page.$$eval(
    'a[href*="/shorts/"]',
    (ns) =>
      ns.map((n) => {
        const href = (n as HTMLAnchorElement).getAttribute('href') ?? '';
        const id = href.split('/shorts/')[1]?.split(/[?&/]/)[0] ?? '';
        // 제목은 링크 자신이거나 카드 안의 제목 요소에 있다.
        const title =
          (n.getAttribute('title') || n.textContent || '').replace(/\s+/g, ' ').trim();
        return { id, title };
      }),
  );

  const seen = new Set<string>();
  const out: { id: string; title: string }[] = [];
  for (const r of rows) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, title: r.title || '(제목 없음)' });
    if (out.length >= LIMIT) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`${HANDLE} 의 쇼츠 ${LIMIT}건에서 나레이션을 받습니다 (브라우저).`);

  const browser = await chromium.launch({
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });
  const page = await ctx.newPage();

  let got = 0;
  try {
    const vids = await videoIds(page);
    if (vids.length === 0) {
      const visible = await page.locator('body').innerText().catch(() => '');
      throw new Error(
        `쇼츠 목록을 못 읽었습니다. 화면: ${visible.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
    }
    console.log(`목록 ${vids.length}건 확보.\n`);

    for (const [i, v] of vids.entries()) {
      console.log('═'.repeat(66));
      console.log(`${i + 1}. ${v.title}`);
      console.log(`   https://www.youtube.com/shorts/${v.id}`);

      await page.goto(`https://www.youtube.com/watch?v=${v.id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForTimeout(4_000);

      const html = await page.content();
      const url = pickKorean(captionTracks(html));
      if (!url) {
        // 0건을 성공으로 위장하지 않는다. 무엇이 없었는지 적는다.
        const wall = /로그인하여|not a bot|sign in to confirm/i.test(html);
        console.log(`   ✗ 자막 트랙이 없습니다${wall ? ' (봇 확인 화면)' : ''}.`);
        continue;
      }

      const xml = await page.evaluate(async (u) => {
        const r = await fetch(u);
        return r.ok ? await r.text() : '';
      }, url);

      const lines = parseTimedText(xml);
      if (lines.length === 0) {
        console.log(`   ✗ 자막을 받았지만 문장이 없습니다 (${xml.length}바이트).`);
        continue;
      }

      got++;
      console.log(`   ── 나레이션 ${lines.length}줄 ──`);
      for (const [t, text] of lines) console.log(`   ${t.toFixed(1).padStart(6)}  ${text}`);
      console.log('');
      await page.waitForTimeout(2_000);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log('═'.repeat(66));
  if (got === 0) {
    throw new Error('나레이션을 한 건도 못 받았습니다. 유튜브가 이 IP 를 막고 있습니다.');
  }
  console.log(`나레이션 확보: ${got}건`);
  console.log(`읽을 것: 0~2초 문형(훅) / 어미·문장길이(말투) / 소구 시점 / 마지막 문장(CTA)`);
}

main().catch((e: Error) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
