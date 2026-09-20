import { writeFile, mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

/**
 * 벤치마킹 대상 계정을 **실제로 재는** 도구.
 *
 * ## 왜 만들었나
 *
 * 홈스토리를 벤치마킹하기로 했는데, 개발 컨테이너에서는 틱톡·인스타·유튜브가 전부
 * egress 프록시에 막힌다(실측 2026-09-20). 유튜브 API 는 쿼터가 소진됐다. 그 상태에서
 * "홈스토리는 이런 구조입니다" 를 쓰면 그건 측정이 아니라 창작이다. 그러면 그 위에
 * 세운 대본 규칙이 전부 근거 없는 게 된다.
 *
 * Actions 러너는 막혀 있지 않다. 그래서 러너에서 돌려 **숫자를 갖고 온다.**
 *
 * ## 무엇을 재는가
 *
 * 틱톡 프로필은 로그인 없이 열리고, 게시물 목록은 프론트엔드가 `/api/post/item_list/`
 * 로 받아온다. 그 응답을 가로채면 게시물마다 조회·좋아요·댓글·공유·길이와 캡션이 통째로
 * 들어 있다. DOM 을 긁는 것보다 안정적이고, 스크롤한 만큼 쌓인다.
 *
 * 이 숫자가 있어야 답할 수 있는 것들:
 *   · 터진 것과 안 터진 것의 캡션이 어떻게 다른가 (훅 문구)
 *   · 길이가 몇 초에 몰려 있는가
 *   · 저장·공유가 높은 건 어떤 종류인가 (= 구매 직전 신호)
 *   · 조회 대비 댓글이 튀는 건 무엇인가 (= 논쟁·질문 유발형)
 *
 * ## 출력
 *
 * 요약은 콘솔에, 원본은 JSON 파일로 떨군다(Actions 아티팩트로 받아 분석에 쓴다).
 * 캡션은 공개 게시물의 공개 문구라 그대로 담는다 — 비밀값이 섞일 여지가 없다.
 *
 * 실행:  npx tsx src/probe-benchmark.ts homestory.official
 */

const HANDLE = (process.argv[2] ?? 'homestory.official').replace(/^@/, '');
const OUT_DIR = '.probe';
const SCROLL_ROUNDS = Number(process.env.BENCHMARK_SCROLL_ROUNDS ?? '12');

interface Post {
  id: string;
  caption: string;
  createdAt: string;
  durationSec: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  url: string;
}

/** 틱톡 item_list 응답의 한 건. 필요한 필드만 좁게 받는다. */
interface RawItem {
  id?: string;
  desc?: string;
  createTime?: number;
  video?: { duration?: number };
  stats?: {
    playCount?: number;
    diggCount?: number;
    commentCount?: number;
    shareCount?: number;
    collectCount?: number;
  };
  statsV2?: Record<string, string>;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function toPost(item: RawItem): Post | null {
  if (!item.id) return null;
  // statsV2 는 문자열이고 더 정확한 편이다. 없으면 stats 로 떨어진다.
  const s = item.stats ?? {};
  const v2 = item.statsV2 ?? {};
  return {
    id: item.id,
    caption: item.desc ?? '',
    createdAt: item.createTime
      ? new Date(item.createTime * 1_000).toISOString().slice(0, 10)
      : '',
    durationSec: item.video?.duration ?? null,
    views: num(v2.playCount) || num(s.playCount),
    likes: num(v2.diggCount) || num(s.diggCount),
    comments: num(v2.commentCount) || num(s.commentCount),
    shares: num(v2.shareCount) || num(s.shareCount),
    saves: num(v2.collectCount) || num(s.collectCount),
    url: `https://www.tiktok.com/@${HANDLE}/video/${item.id}`,
  };
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : '—';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function report(posts: Post[]): void {
  const views = posts.map((p) => p.views);
  const med = median(views);

  console.log(`\n═══ @${HANDLE} — 게시물 ${posts.length}건 ═══`);
  console.log(`조회수 중앙값 ${med.toLocaleString()} / 최대 ${Math.max(...views).toLocaleString()}`);

  const durs = posts.map((p) => p.durationSec).filter((d): d is number => d !== null);
  if (durs.length) {
    console.log(`길이 중앙값 ${median(durs)}초 (최소 ${Math.min(...durs)} / 최대 ${Math.max(...durs)})`);
  }

  // 터진 것 = 중앙값 대비 배수. 팔로워 기반이 아니라 콘텐츠 힘으로 본다.
  const sorted = [...posts].sort((a, b) => b.views - a.views);

  console.log(`\n── 상위 15건 (조회수순) ─────────────────────────`);
  console.log(`배수   조회수      저장률   공유율   댓글률  길이  캡션`);
  for (const p of sorted.slice(0, 15)) {
    const mult = med > 0 ? (p.views / med).toFixed(1) : '—';
    console.log(
      `${mult.padStart(5)}x ${p.views.toLocaleString().padStart(11)}` +
        ` ${pct(p.saves, p.views).padStart(8)}` +
        ` ${pct(p.shares, p.views).padStart(8)}` +
        ` ${pct(p.comments, p.views).padStart(7)}` +
        ` ${String(p.durationSec ?? '?').padStart(4)}초` +
        `  ${p.caption.replace(/\s+/g, ' ').slice(0, 70)}`,
    );
  }

  console.log(`\n── 하위 10건 (같은 계정, 같은 팔로워 — 차이는 콘텐츠뿐) ──`);
  for (const p of sorted.slice(-10)) {
    console.log(
      `      ${p.views.toLocaleString().padStart(11)}` +
        ` ${String(p.durationSec ?? '?').padStart(4)}초` +
        `  ${p.caption.replace(/\s+/g, ' ').slice(0, 70)}`,
    );
  }

  // 저장률은 "나중에 살 것" 의 직접 신호다. 조회수와 따로 본다.
  const bySave = [...posts].filter((p) => p.views > 1_000).sort((a, b) => b.saves / b.views - a.saves / a.views);
  console.log(`\n── 저장률 상위 10건 (= 구매 직전 신호) ───────────`);
  for (const p of bySave.slice(0, 10)) {
    console.log(
      `${pct(p.saves, p.views).padStart(8)}  ${p.views.toLocaleString().padStart(11)}` +
        `  ${p.caption.replace(/\s+/g, ' ').slice(0, 70)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`@${HANDLE} 을 잽니다. 로그인 세션 없이 프로필만 엽니다.`);

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

  const byId = new Map<string, Post>();

  page.on('response', (res) => {
    if (!res.url().includes('/api/post/item_list/')) return;
    void res
      .json()
      .then((body: { itemList?: RawItem[] }) => {
        for (const item of body.itemList ?? []) {
          const p = toPost(item);
          if (p) byId.set(p.id, p);
        }
      })
      .catch(() => {
        // 본문이 없거나 JSON 이 아닌 응답이 섞인다. 그건 이 목록이 아니다.
      });
  });

  let bioLink: string | null = null;
  let products: BioProduct[] = [];

  try {
    await page.goto(`https://www.tiktok.com/@${HANDLE}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(5_000);

    // 프로필 머리말은 로그인 없이 보인다. 여기서 링크인바이오 주소를 줍는다 —
    // 게시물 목록이 막혀도 이건 남는다.
    const header = await page.locator('body').innerText().catch(() => '');
    bioLink = findBioLink(header);
    console.log(`  링크인바이오: ${bioLink ?? '(프로필에서 못 찾음)'}`);

    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      await page.mouse.wheel(0, 2_000);
      await page.waitForTimeout(1_800);
      process.stdout.write(`\r  스크롤 ${i + 1}/${SCROLL_ROUNDS} — 모은 게시물 ${byId.size}건`);
    }
    console.log('');

    if (byId.size === 0) {
      // 0건을 성공으로 위장하지 않는다. 다만 여기서 끝내지도 않는다 —
      // 링크 페이지는 아직 안 봤고, 거기가 오히려 더 직접적인 자료다.
      console.log(
        `\n  ⚠ 게시물 0건. 틱톡이 로그인 없이는 목록(item_list)을 안 내줍니다.\n` +
          `    화면에 보인 것(앞 240자): ${header.replace(/\s+/g, ' ').slice(0, 240)}`,
      );
    }

    // ── 링크인바이오 = 이 계정이 실제로 파는 제품 목록 ──────────────
    // 영상보다 이쪽이 직접적이다. 무엇을 밀어서 돈이 되는지가 그대로 나열돼 있다.
    if (bioLink) {
      products = await readBioPage(page, bioLink);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  const posts = [...byId.values()];
  if (posts.length) report(posts);
  if (products.length) reportProducts(products);

  await mkdir(OUT_DIR, { recursive: true });
  const out = `${OUT_DIR}/benchmark-${HANDLE}.json`;
  await writeFile(
    out,
    JSON.stringify({ handle: HANDLE, capturedAt: new Date().toISOString(), bioLink, posts, products }, null, 2),
  );
  console.log(`\n게시물 ${posts.length}건 / 제품 ${products.length}건 → ${out}`);

  if (posts.length === 0 && products.length === 0) {
    throw new Error(
      `@${HANDLE} 에서 게시물도 제품도 한 건도 못 얻었습니다. ` +
        `틱톡이 로그인을 요구하고, 링크 페이지도 못 읽었습니다.`,
    );
  }
}

/** 링크인바이오 한 줄. */
interface BioProduct {
  label: string;
  url: string;
  /** 링크가 최종적으로 가리키는 쇼핑몰 (호스트로 판정) */
  mall: string;
}

/** 프로필 본문에서 링크인바이오 주소를 줍는다. 한국 계정은 대개 이 셋 중 하나다. */
function findBioLink(text: string): string | null {
  const m = text.match(
    /\b((?:moneying\.biz|inpock\.co\.kr|link\.inpock\.co\.kr|litt\.ly|linktr\.ee|lnk\.bio|bio\.link|[\w-]+\.(?:im|me))\/[^\s"')]+)/i,
  );
  return m ? `https://${m[1]!.replace(/^https?:\/\//, '')}` : null;
}

/** 호스트만 보고 어느 몰인지 붙인다. 모르는 곳은 호스트 그대로 남긴다. */
function mallOf(url: string): string {
  try {
    const h = new URL(url).host.replace(/^www\./, '');
    if (h.includes('coupang')) return '쿠팡';
    if (h.includes('aliexpress')) return '알리';
    if (h.includes('naver') || h.includes('smartstore')) return '네이버';
    if (h.includes('tenping')) return '텐핑';
    if (h.includes('11st')) return '11번가';
    if (h.includes('gmarket')) return 'G마켓';
    if (h.includes('ohou')) return '오늘의집';
    return h;
  } catch {
    return '(파싱 불가)';
  }
}

async function readBioPage(page: Page, url: string): Promise<BioProduct[]> {
  console.log(`\n── 링크인바이오 ─────────────────────────────`);
  console.log(`   ${url}`);

  const res = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: Error) => {
      console.log(`   ✗ 못 열었습니다: ${e.message.split('\n')[0]}`);
      return null;
    });
  if (!res) return [];

  await page.waitForTimeout(5_000);
  console.log(`   HTTP ${res.status()}`);

  // 링크 페이지는 대체로 <a> 목록이다. 버튼 라벨이 곧 제품명이다.
  const rows: { url: string; label: string }[] = await page.$$eval('a[href]', (ns) =>
    ns.map((n) => ({
      url: (n as HTMLAnchorElement).href,
      label: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );

  const seen = new Set<string>();
  const out: BioProduct[] = [];
  for (const r of rows) {
    if (!r.url.startsWith('http')) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ label: r.label.slice(0, 120), url: r.url, mall: mallOf(r.url) });
  }
  return out;
}

function reportProducts(products: BioProduct[]): void {
  console.log(`\n═══ 링크인바이오 제품 ${products.length}건 ═══`);

  // 어느 몰로 보내는지가 곧 이 계정의 수익 구조다.
  const byMall = new Map<string, number>();
  for (const p of products) byMall.set(p.mall, (byMall.get(p.mall) ?? 0) + 1);
  console.log(`\n몰별 분포:`);
  for (const [mall, n] of [...byMall].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mall.padEnd(24)} ${n}건`);
  }

  console.log(`\n제품 목록 (라벨 = 이 계정이 붙인 제품명):`);
  for (const p of products) {
    if (!p.label) continue;
    console.log(`  [${p.mall}] ${p.label}`);
  }
}

main().catch((e: Error) => {
  console.error(`\n측정 실패: ${e.message}`);
  process.exit(1);
});
