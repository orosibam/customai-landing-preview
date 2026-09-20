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
};

interface HarvestFile {
  platform: string;
  keyword: string;
  links: { url: string; title?: string }[];
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

  const rows = usable.map((link) => ({
    platform: parsed.platform,
    keyword: parsed.keyword ?? 'unknown',
    url: link.url,
    title: link.title ?? null,
  }));

  // 같은 키워드를 다시 긁으면 겹친다. 겹치는 건 조용히 넘기되 몇 건이 새로 들어갔는지는 센다.
  const inserted = await must(
    '수확 링크 저장',
    db().from('harvested_links').upsert(rows, { onConflict: 'url', ignoreDuplicates: true }).select('id'),
  );

  const newCount = (inserted as { id: string }[]).length;
  console.log(
    `\n✅ ${parsed.platform} / "${parsed.keyword}" — 파일 ${parsed.links.length}건 중 ` +
      `${newCount}건 신규 저장 (${usable.length - newCount}건은 이미 있음)\n`,
  );
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
  throw new Error(`알 수 없는 대상: ${alias}. 가능한 값: xhs, ali`);
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
          '  폴백 (샤오홍슈가 자동화를 막을 때만):\n' +
          '  npm run links snippet <xhs|ali>           브라우저 콘솔용 코드 출력\n' +
          '  npm run links import <파일>                내려받은 JSON 을 DB에 저장',
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
});
