import { chromium, type Page } from 'playwright';

/**
 * 알리익스프레스를 소재 공급처로 쓸 수 있는지 **검색부터 영상까지 한 번에** 재는 도구.
 *
 * ## 왜 1688 이 아니라 알리인가
 *
 * 러너에서 실측한 결과다 (2026-09-20):
 *   · 샤오홍슈 검색 → 登录后查看搜索结果 (로그인 벽), 링크 0
 *   · 1688 PC 검색 → 亲，请拖动下方滑块完成验证 (슬라이더 캡차), 링크 0
 *   · 1688 모바일  → 로그인 페이지, 링크 0
 *
 * 즉 **데이터센터 IP 에서 중국 내수 플랫폼 검색은 자동으로 못 뚫는다.** 사람이 자기
 * 브라우저로 로그인해 긁어주는 것 말고는 길이 없고, 그건 매일 도는 공장에 쓸 수 없다.
 *
 * 알리익스프레스는 해외向 이라 사정이 다르다. 공개 검색이 열려 있고 제휴 프로그램도
 * 공식이다. 그래서 여기가 뚫리면 소재 공급이 사람 손 없이 돈다.
 *
 * ## 세 가지를 순서대로 확인한다
 *
 * 1. 검색이 로그인·캡차 없이 열리는가, 상품 링크가 몇 개 나오는가
 * 2. 상품 상세가 열리는가
 * 3. **상세에 영상이 실제로 박혀 있는가** — 이게 핵심이다. 상품 페이지가 열려도
 *    영상이 없으면 소재로 못 쓴다. 이미지 슬라이드만으로는 쇼츠가 안 된다.
 *
 * 3번까지 통과해야 "쓸 수 있다" 다. 1번만 보고 결론 내면 또 며칠 뒤에 되돌아온다.
 *
 * 출력은 구조만 — URL 은 호스트와 경로 모양까지만 찍고 쿼리스트링은 길이만 센다.
 *
 * 실행:  npx tsx src/probe-ali.ts "car wash foam"
 */

const KEYWORD = process.argv[2] ?? 'car wash snow foam';

/** 상품 영상은 알리 CDN 에서 내려온다. 상세 HTML 에 JSON 으로 박혀 있다. */
const VIDEO_MARKERS: [string, RegExp][] = [
  ['mp4 주소', /https?:\\?\/\\?\/[^"'\s]*\.mp4/gi],
  ['videoId 키', /"videoId"\s*:\s*"?\d{6,}/gi],
  ['video.aliexpress', /video\.aliexpress\.com/gi],
  ['ali 비디오 CDN', /cloud\.video\.taobao\.com|video\.alicdn\.com/gi],
];

/**
 * 차단 표식.
 *
 * 처음엔 'captcha' · 'punish' · 'slider' 같은 일반 단어를 넣었는데 전부 거짓 경보였다.
 * 상품 페이지가 400KB 로 멀쩡히 렌더되고 제품명까지 보이는데도 셋 다 걸렸다 —
 * 이미지 슬라이더, 번들된 JS 에 그냥 들어 있는 단어들이다.
 *
 * 거짓 경보를 남겨두면 나중에 진짜 차단이 왔을 때 구분이 안 된다. 그래서 알리바바
 * 계열의 실제 검증 페이지에만 나오는 표식으로 좁힌다.
 */
const BLOCK_MARKERS = [
  'punish.aliexpress.com',
  '_____tmd_____',
  'nc_1_n1z',
  '滑动验证',
  '请拖动下方滑块',
  'Please slide to verify',
];

function shape(url: string): string {
  try {
    const u = new URL(url);
    const q = u.search ? ` ?(${u.search.length - 1}자)` : '';
    return `${u.host}${u.pathname}${q}`;
  } catch {
    return '(파싱 불가)';
  }
}

function countAll(html: string): string {
  return VIDEO_MARKERS.map(([name, re]) => `${name} ${(html.match(re) ?? []).length}`).join(' / ');
}

async function open(page: Page, url: string, label: string): Promise<string | null> {
  console.log(`\n── ${label} ─────────────────────────────`);
  console.log(`   ${shape(url)}`);

  const res = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 이동 실패: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return null;

  await page.waitForTimeout(6_000);
  const html = await page.content();
  const visible = await page.locator('body').innerText().catch(() => '');

  console.log(`   HTTP ${res.status()} / HTML ${html.length.toLocaleString()}자 / 보이는 텍스트 ${visible.length.toLocaleString()}자`);

  const blocked = BLOCK_MARKERS.filter((m) => html.toLowerCase().includes(m.toLowerCase()));
  if (blocked.length) {
    console.log(`   ⚠ 차단 표식: ${blocked.join(', ')}`);
    console.log(`   화면 앞부분: ${visible.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  return html;
}

async function main(): Promise<void> {
  console.log(`검색어: "${KEYWORD}"  — 로그인 세션 없이 엽니다.`);

  const browser = await chromium.launch({
    headless: process.env.HEADFUL !== 'true',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await ctx.newPage();

  try {
    // ── 1) 검색 ────────────────────────────────────────────
    const searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(
      KEYWORD.replace(/\s+/g, '-'),
    )}.html`;
    const searchHtml = await open(page, searchUrl, '알리 검색');
    if (!searchHtml) throw new Error('검색 페이지를 아예 못 열었습니다.');

    // 상품 링크. 알리는 /item/<id>.html 형태다.
    const itemUrls: string[] = await page.$$eval('a[href*="/item/"]', (ns) =>
      [...new Set(ns.map((n) => (n as HTMLAnchorElement).href))],
    );
    const items = itemUrls.filter((u) => /\/item\/\d+\.html/.test(u));
    console.log(`   상품 링크 ${items.length}개`);
    for (const u of items.slice(0, 3)) console.log(`     · ${shape(u)}`);

    if (items.length === 0) {
      console.log(`   → 판정: 검색에서 상품을 못 얻음. 여기서 막히면 알리도 쓸 수 없습니다.`);
      console.log(`   화면 앞부분: ${(await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
      return;
    }
    console.log(`   → 판정: 검색은 로그인 없이 열립니다.`);

    // ── 2·3) 상세 + 영상 유무 ───────────────────────────────
    // 상품마다 영상이 있는 건 아니다. 여러 건을 봐야 "비율" 을 알 수 있고,
    // 그 비율이 곧 "몇 개를 훑어야 소재 4개가 모이나" 가 된다.
    let withVideo = 0;
    const checked = items.slice(0, 5);

    for (const [i, url] of checked.entries()) {
      const html = await open(page, url, `상품 상세 ${i + 1}/${checked.length}`);
      if (!html) continue;

      const counts = countAll(html);
      const mp4 = (html.match(VIDEO_MARKERS[0]![1]) ?? []).length;
      const anyVideo = VIDEO_MARKERS.some(([, re]) => (html.match(re) ?? []).length > 0);
      if (anyVideo) withVideo++;

      console.log(`   영상 표식: ${counts}`);
      console.log(`   → ${anyVideo ? (mp4 > 0 ? '영상 있음 (mp4 주소 직접 노출)' : '영상 있음 (id 만 — 주소는 따로 받아야 함)') : '영상 없음'}`);

      await page.waitForTimeout(2_500);
    }

    console.log(`\n═══ 정리 ═══`);
    console.log(`검색 상품 링크: ${items.length}개`);
    console.log(`상세 ${checked.length}건 중 영상 있는 것: ${withVideo}건`);
    console.log(
      withVideo >= 2
        ? `→ 알리를 소재 공급처로 쓸 수 있습니다. 상품 4~5개를 모으려면 대략 ${Math.ceil((checked.length / Math.max(withVideo, 1)) * 5)}건을 훑으면 됩니다.`
        : `→ 영상이 너무 적습니다. 검색어를 바꿔 다시 재거나 다른 공급처가 필요합니다.`,
    );
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e: Error) => {
  console.error(`\n측정 실패: ${e.message}`);
  process.exit(1);
});
