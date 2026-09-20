import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, must } from './lib/supabase.js';
import { harvest } from './lib/scrapers/harvester.js';
import type { LinkPlatform } from './lib/scrapers/linkstore.js';

/**
 * 수확한 링크 보관소 CLI.
 *
 *   npm run links harvest xhs 洗车液   ← 기본. 저장된 세션으로 알아서 긁어온다
 *   npm run links status              플랫폼·키워드별 잔량
 *
 *   npm run links snippet xhs         (폴백) 브라우저 콘솔에 붙여넣을 코드
 *   npm run links import <파일>        (폴백) 그렇게 내려받은 JSON 을 DB에 넣는다
 *
 * 왜 이 단계가 있는가: 샤오홍슈·1688 둘 다 비로그인으로는 키워드 검색이 안 된다.
 * 로그인된 브라우저에서 검색 결과 href 를 통째로 긁는 것만이 검증된 경로다.
 *
 * 그렇다고 사람이 매번 긁을 이유는 없다. `npm run capture xhs` 로 **한 번만** 로그인해
 * 세션을 저장해두면 harvest 가 그 세션으로 알아서 검색·스크롤·수집한다.
 * snippet/import 는 샤오홍슈가 자동화를 감지해 막을 때를 위한 폴백으로만 남겨둔다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPPETS: Record<string, { file: string; site: string }> = {
  xhs: { file: 'xiaohongshu.js', site: 'https://www.xiaohongshu.com (로그인 후 키워드 검색)' },
  ali: { file: 'ali1688.js', site: 'https://s.1688.com (로그인 후 중국어 키워드 검색)' },
  // 지금 실제로 써야 하는 건 이쪽이다. 러너가 상품 상세를 못 열게 되면서
  // (실측: 알리 26번 중 0번) 상세 URL 만 모아서는 아무 쓸모가 없어졌다.
  video: {
    file: 'product-video.js',
    site: '1688 · 알리익스프레스 · 타오바오 **상품 상세 페이지** (검색 결과 아님)',
  },
};

interface HarvestFile {
  platform: string;
  keyword: string;
  links: { url: string; title?: string; videoUrl?: string; platform?: string; keyword?: string }[];
}

async function printSnippet(which: string): Promise<void> {
  const entry = SNIPPETS[which];
  if (!entry) {
    throw new Error(`알 수 없는 대상: ${which}. 가능한 값: ${Object.keys(SNIPPETS).join(', ')}`);
  }
  const code = await readFile(join(HERE, '..', 'harvest', entry.file), 'utf8');
  console.log(`\n1. 크롬에서 ${entry.site}\n2. F12 → Console 탭\n3. 아래를 통째로 붙여넣고 Enter\n`);
  console.log('─'.repeat(72));
  console.log(code);
  console.log('─'.repeat(72));
  console.log('\n4. 내려받아진 파일을 넘기세요:  npm run links import <파일>\n');
}

async function importFile(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as HarvestFile;

  if (!parsed.platform || !Array.isArray(parsed.links)) {
    throw new Error(
      `수확 파일 형식이 아닙니다: ${path}\n` +
        `  harvest/*.js 가 만든 JSON 을 그대로 넘기세요.`,
    );
  }
  if (parsed.links.length === 0) {
    throw new Error(`링크가 0건인 파일입니다: ${path}. 수확이 실패한 것이니 다시 긁으세요.`);
  }

  // 토큰 없는 샤오홍슈 링크는 열리지 않는다. 넣어두면 매일 404 를 때리게 되므로
  // 여기서 걸러내고, 몇 건을 왜 버렸는지 반드시 말한다.
  const usable: HarvestFile['links'] = [];
  const tokenless: string[] = [];
  for (const link of parsed.links) {
    if (parsed.platform === 'xiaohongshu' && !link.url.includes('xsec_token=')) {
      tokenless.push(link.url);
      continue;
    }
    usable.push(link);
  }

  if (tokenless.length > 0) {
    console.warn(
      `\n⚠️  토큰이 없는 링크 ${tokenless.length}건을 제외했습니다.\n` +
        `   explore/<id> 만 남은 링크는 전부 404 라 복구할 수 없습니다.\n` +
        `   수확 단계에서 href 가 잘렸을 수 있으니 harvest/xiaohongshu.js 를 그대로 썼는지 확인하세요.\n`,
    );
  }
  if (usable.length === 0) {
    throw new Error('쓸 수 있는 링크가 한 건도 없습니다. 전부 토큰이 없습니다.');
  }

  // 상품영상 수확물은 파일 하나에 여러 사이트가 섞인다(platform: 'mixed').
  // 그때는 건별 platform 을 쓴다 — 전부 'mixed' 로 박으면 나중에 어디서 온
  // 소재인지 알 수 없고, 출처 추적이 이 파이프라인의 법적 방어선이다.
  const rows = usable.map((link) => ({
    platform: link.platform ?? parsed.platform,
    keyword: link.keyword ?? parsed.keyword ?? 'unknown',
    url: link.url,
    title: link.title ?? null,
    video_url: link.videoUrl ?? null,
  }));

  const withVideo = rows.filter((r) => r.video_url).length;

  // 같은 키워드를 다시 긁으면 겹친다. 겹치는 건 조용히 넘기되 몇 건이 새로 들어갔는지는 센다.
  const inserted = await must(
    '수확 링크 저장',
    db().from('harvested_links').upsert(rows, { onConflict: 'url', ignoreDuplicates: true }).select('id'),
  );

  const newCount = (inserted as { id: string }[]).length;
  console.log(
    `\n✅ "${parsed.keyword}" — 파일 ${parsed.links.length}건 중 ` +
      `${newCount}건 신규 저장 (${usable.length - newCount}건은 이미 있음)\n`,
  );

  // 영상 주소가 없는 행은 러너가 상세를 열어야 쓸 수 있는데 지금 그게 막혀 있다.
  // 조용히 넣어두면 "수확했는데 왜 소재가 없지" 가 된다.
  if (withVideo === 0) {
    console.warn(
      `⚠️  영상 주소가 붙은 행이 0건입니다.\n` +
        `   상세 URL 만 모은 파일은 지금 쓸 수 없습니다 — 러너가 상품 상세를\n` +
        `   못 엽니다(실측: 알리 26번 열어 0번). harvest/product-video.js 로\n` +
        `   상세 페이지에서 mp4 주소까지 뽑으세요:  npm run links snippet video\n`,
    );
  } else {
    const products = new Set(rows.filter((r) => r.video_url).map((r) => r.url)).size;
    console.log(`   영상 주소가 붙은 것 ${withVideo}건 / 서로 다른 상품 ${products}곳`);
    if (products < 4) {
      console.warn(
        `   ⚠️  서로 다른 상품이 4곳은 돼야 영상을 만들 수 있습니다 (${4 - products}곳 부족).\n` +
          `      같은 판매자 영상만 모으면 각도와 동작이 겹쳐 짜깁기할 게 없습니다.\n`,
      );
    }
  }
}

async function status(): Promise<void> {
  const rows = await must(
    '잔량 조회',
    db()
      .from('harvested_links')
      .select('platform, keyword, used_at, failed_reason')
      .order('harvested_at', { ascending: false })
      .limit(5_000),
  );

  const tally = new Map<string, { total: number; left: number }>();
  for (const r of rows as { platform: string; keyword: string; used_at: string | null; failed_reason: string | null }[]) {
    const key = `${r.platform} / ${r.keyword}`;
    const cur = tally.get(key) ?? { total: 0, left: 0 };
    cur.total++;
    if (!r.used_at && !r.failed_reason) cur.left++;
    tally.set(key, cur);
  }

  if (tally.size === 0) {
    console.log('\n수확된 링크가 없습니다. npm run capture xhs 로 로그인 후 npm run links harvest xhs <검색어> 로 시작하세요.\n');
    return;
  }

  console.log('\n수확 링크 잔량\n');
  for (const [key, { total, left }] of [...tally].sort((a, b) => a[1].left - b[1].left)) {
    const mark = left === 0 ? '✗' : left < 10 ? '!' : '✓';
    console.log(`  ${mark}  ${key.padEnd(40)} 남음 ${String(left).padStart(4)} / 전체 ${total}`);
  }
  console.log('\n  ! 는 곧 떨어집니다. ✗ 는 그 키워드로 더 못 만듭니다 — 다시 수확하세요.\n');
}

/** 별칭을 실제 플랫폼 이름으로. CLI 에서 매번 xiaohongshu 를 치게 하지 않는다. */
function toPlatform(alias: string): LinkPlatform {
  if (alias === 'xhs' || alias === 'xiaohongshu') return 'xiaohongshu';
  if (alias === 'ali' || alias === 'ali1688' || alias === '1688') return 'ali1688';
  throw new Error(
    `알 수 없는 대상: ${alias}. 자동 수확 가능한 값: xhs, ali\n` +
      `   알리익스프레스·타오바오는 자동 수확이 아니라 브라우저 스니펫입니다: ` +
      `npm run links snippet video`,
  );
}

async function runHarvest(alias: string, keyword: string): Promise<void> {
  const platform = toPlatform(alias);
  console.log(`\n${platform} / "${keyword}" 수확 중... (브라우저를 띄웁니다)\n`);

  const r = await harvest(platform, keyword);
  console.log(
    `✅ ${r.found}건 긁어서 ${r.inserted}건 신규 저장 ` +
      `(${r.found - r.inserted}건은 이미 있던 것)\n`,
  );
  if (r.inserted === 0) {
    console.log(
      '   새로 들어간 게 없습니다. 같은 검색 결과를 다시 긁었을 가능성이 큽니다 —\n' +
        '   검색어를 바꾸거나 HARVEST_SCROLL_ROUNDS 를 올려보세요.\n',
    );
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case 'harvest': {
      const keyword = process.argv.slice(4).join(' ');
      if (!arg || !keyword) {
        throw new Error('사용법: npm run links harvest <xhs|ali> <검색어>');
      }
      await runHarvest(arg, keyword);
      break;
    }
    case 'snippet':
      await printSnippet(arg ?? 'xhs');
      break;
    case 'import':
      if (!arg) throw new Error('파일 경로가 필요합니다: npm run links import <파일>');
      await importFile(arg);
      break;
    case 'status':
      await status();
      break;
    default:
      console.error(
        '사용법:\n' +
          '  npm run links harvest <xhs|ali> <검색어>   저장된 세션으로 알아서 긁어온다\n' +
          '  npm run links status                      플랫폼·키워드별 잔량\n' +
          '\n' +
          '  소재(상품영상) 수확 — 지금은 이 경로만 작동합니다:\n' +
          '  npm run links snippet video               브라우저 콘솔용 코드 출력\n' +
          '  npm run links import <파일>                내려받은 JSON 을 DB에 저장\n' +
          '\n' +
          '  폴백 (샤오홍슈가 자동화를 막을 때만):\n' +
          '  npm run links snippet <xhs|ali>           검색 결과 href 만 긁는 예전 방식',
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
});
