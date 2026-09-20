import { chromium, type Page } from 'playwright';

/**
 * 알리에서 **검색어에 따라 상품 수와 영상 보유율이 얼마나 달라지는지** 잰다.
 *
 * ## 왜 이걸 재야 하는가
 *
 * 소재 단계가 두 번 막혔는데 원인이 서로 달랐다.
 *
 *   2차: 상세가 "_____tmd_____" 검증으로 떴다        → 속도 문제. 백오프로 해결됐다.
 *   5차: 백오프는 통과했는데 **상품 7건 전부 영상 0개**  → 속도가 아니다.
 *
 * 계측 때는 "car wash snow foam" 으로 상세 5건 중 3건에 mp4 가 있었다. 그걸 보고
 * "알리는 영상 보유율 60%" 라고 일반화했는데, 5차의 "mini portable massage gun" 은
 * 7건 중 0건이었다. **한 검색어로 잰 값을 전부에 적용한 게 틀렸다.**
 *
 * 짐작 가는 이유는 제품 성격이다 — 세차 거품은 뿌리는 걸 보여줘야 팔리고,
 * 마사지건은 사진으로도 팔린다. 하지만 그건 가설이고, 고치기 전에 재야 한다.
 *
 * 검색 결과 수도 문제다. 5차는 7건뿐이었는데 소재 풀 12개를 채우려면 36건을
 * 훑어야 한다. 구조적으로 불가능했다.
 *
 * ## 무엇을 내는가
 *
 * 검색어마다: 상품 링크 수 / 상세를 연 수 / 영상이 있던 수 / 영상 총 개수.
 * 이 표가 있어야 "검색어를 어떻게 만들어야 소재가 모이나" 를 근거 있게 정할 수 있다.
 *
 * 실행:  npx tsx src/probe-ali-yield.ts
 */

/** 성격이 다른 제품군을 섞는다. 한 종류만 재면 또 같은 실수를 한다. */
const KEYWORDS = [
  'car wash snow foam',        // 계측에서 3/5 였던 것 — 기준점
  'mini portable massage gun', // 5차에서 0/7 이었던 것
  'massage gun',               // 위를 넓힌 것. 수식어를 빼면 늘어나는가?
  'ultrasonic cleaner',        // 4차에서 고른 제품 계열
  'kitchen gadget',            // 범주어. 넓히면 상품 수가 느는지
];

const BLOCK_MARKERS = ['punish.aliexpress.com', '_____tmd_____', 'nc_1_n1z', '请拖动下方滑块'];
const VIDEO_RE = /https?:\\?\/\\?\/[^"'\s\\]*(?:alicdn\.com|aliexpress\.com|cloud\.video\.taobao\.com)[^"'\s]*?\.mp4[^"'\s]*/gi;
const ITEM_RE = /\/item\/(\d+)\.html/;

interface Row {
  keyword: string;
  items: number;
  opened: number;
  withVideo: number;
  videos: number;
  blocked: number;
}

async function measure(page: Page, keyword: string, detailLimit: number): Promise<Row> {
  const row: Row = { keyword, items: 0, opened: 0, withVideo: 0, videos: 0, blocked: 0 };

  const url = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(
    keyword.trim().replace(/\s+/g, '-'),
  )}.html`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(6_000);

  const hrefs: string[] = await page
    .$$eval('a[href*="/item/"]', (ns) => [...new Set(ns.map((n) => (n as HTMLAnchorElement).href))])
    .catch(() => [] as string[]);
  const items = hrefs.filter((u) => ITEM_RE.test(u));
  row.items = items.length;

  console.log(`\n── "${keyword}" ──`);
  console.log(`   검색 상품 링크 ${items.length}개`);

  for (const item of items.slice(0, detailLimit)) {
    await page.goto(item, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4_500);
    const html = await page.content();

    if (BLOCK_MARKERS.some((m) => html.includes(m))) {
      row.blocked++;
      // 검증이 뜨면 잠깐 쉰다. 여기서 안 쉬면 뒤 상품이 줄줄이 막혀 측정이 오염된다.
      await page.waitForTimeout(8_000);
      continue;
    }

    row.opened++;
    const found = new Set((html.match(VIDEO_RE) ?? []).map((u) => u.replace(/\\\//g, '/')));
    if (found.size > 0) {
      row.withVideo++;
      row.videos += found.size;
    }
    await page.waitForTimeout(2_500);
  }

  console.log(
    `   상세 ${row.opened}건 열림 (검증 ${row.blocked}건) / 영상 있는 것 ${row.withVideo}건 / 영상 총 ${row.videos}개`,
  );
  return row;
}

async function main(): Promise<void> {
  console.log('알리 검색어별 상품 수와 영상 보유율을 잽니다.');
  console.log('한 검색어로 잰 값을 전부에 적용했던 게 틀렸다는 걸 확인하려는 겁니다.');

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

  const rows: Row[] = [];
  try {
    for (const k of KEYWORDS) {
      rows.push(await measure(page, k, 6));
      await page.waitForTimeout(4_000);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n═══ 정리 ═══`);
  console.log(`검색어                         상품  열림  영상있음  영상수  보유율`);
  for (const r of rows) {
    const rate = r.opened > 0 ? `${Math.round((r.withVideo / r.opened) * 100)}%` : '—';
    console.log(
      `${r.keyword.padEnd(30)} ${String(r.items).padStart(4)} ${String(r.opened).padStart(5)}` +
        ` ${String(r.withVideo).padStart(9)} ${String(r.videos).padStart(7)} ${rate.padStart(7)}`,
    );
  }

  console.log(`\n읽을 것:`);
  console.log(`  · 수식어를 빼면(mini portable massage gun → massage gun) 상품 수가 느는가`);
  console.log(`  · 제품군에 따라 보유율이 갈리는가 — 갈린다면 소싱 단계에서 걸러야 한다`);
  console.log(`  · 상품 수가 적은 검색어는 애초에 소재 풀을 못 채운다`);
}

main().catch((e: Error) => {
  console.error(`\n측정 실패: ${e.message}`);
  process.exit(1);
});
