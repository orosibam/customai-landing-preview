/**
 * 로그인 세션 캡처.
 *
 * 파이프라인 준비 과정에서 사람이 혼자 하기 제일 까다로운 단계다.
 * 틱톡·네이버·인포크링크는 공식 API가 없어 브라우저 자동화로 움직이는데,
 * 그러려면 로그인된 상태를 JSON(Playwright storageState)으로 떠서
 * GitHub Secrets 에 넣어줘야 한다.
 *
 * 개발자 도구로 쿠키를 일일이 긁는 건 실수하기 쉽고 위험하다.
 * 이 스크립트는 브라우저를 띄우고, 사람이 평소처럼 로그인하면,
 * 나머지를 알아서 처리한다.
 *
 *   npx tsx src/capture-session.ts tiktok
 *   npx tsx src/capture-session.ts naver
 *   npx tsx src/capture-session.ts inpock
 *   npx tsx src/capture-session.ts all
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';

interface Target {
  key: string;
  label: string;
  /** 로그인 화면으로 바로 보낸다. 사람이 주소를 찾아다니지 않게. */
  loginUrl: string;
  /** 로그인이 끝났는지 확인할 주소 */
  verifyUrl: string;
  /** 로그인 상태에서만 나타나는 것 */
  loggedInSelector: string;
  /** GitHub Secrets 에 넣을 이름 */
  secretName: string;
  hint: string;
}

const TARGETS: Target[] = [
  {
    key: 'tiktok',
    label: '틱톡',
    loginUrl: 'https://www.tiktok.com/login',
    verifyUrl: 'https://www.tiktok.com/tiktokstudio/upload',
    loggedInSelector: '[data-e2e="profile-icon"], input[type="file"], [class*="upload"]',
    secretName: 'TIKTOK_STORAGE_STATE',
    hint: '소싱·소재 수집과 업로드에 함께 쓰입니다. PC 계정으로 로그인하세요.',
  },
  {
    key: 'naver',
    label: '네이버',
    loginUrl: 'https://nid.naver.com/nidlogin.login',
    verifyUrl: 'https://www.naver.com',
    loggedInSelector: '.MyView-module__my_info___GNmHz, .link_login_area, [class*="MyView"]',
    secretName: 'NAVER_STORAGE_STATE',
    hint: '네이버 클립 업로드에 쓰입니다. 구독자 조건 없이 구매 링크가 붙는 채널입니다.',
  },
  {
    key: 'inpock',
    label: '인포크링크',
    loginUrl: 'https://link.inpock.co.kr/login',
    verifyUrl: 'https://link.inpock.co.kr/admin',
    loggedInSelector: '[class*="dashboard"], [href*="/admin"]',
    secretName: 'INPOCK_STORAGE_STATE',
    hint: '상품을 번호로 진열하는 곳입니다. 이게 없으면 영상은 나가도 수익이 0입니다.',
  },
  {
    key: 'xhs',
    label: '샤오홍슈(小红书)',
    loginUrl: 'https://www.xiaohongshu.com/explore',
    verifyUrl: 'https://www.xiaohongshu.com/explore',
    // 로그인하면 우상단에 내 아바타/계정 메뉴가 생긴다. 비로그인이면 로그인 버튼만 있다.
    loggedInSelector: '.user .link-wrapper, .avatar, [class*="user-avatar"], .reds-avatar',
    secretName: 'XIAOHONGSHU_STORAGE_STATE',
    hint:
      '소재 링크 수확에 쓰입니다. 비로그인으로는 키워드 검색이 아예 안 돼서 ' +
      '이 세션이 있어야 "어떤 상품 영상을 쓸지" 를 자동으로 고를 수 있습니다. ' +
      'QR 로그인이면 휴대폰 앱으로 스캔하시면 됩니다.',
  },
  {
    key: 'ali',
    label: '1688',
    loginUrl: 'https://login.1688.com/member/signin.htm',
    verifyUrl: 'https://www.1688.com',
    loggedInSelector: '[class*="member"], [class*="user-name"], .login-info',
    secretName: 'ALI1688_STORAGE_STATE',
    hint:
      '1688 검색 결과에서 상품 상세 링크를 긁어오는 데 쓰입니다. ' +
      '검색 페이지가 JS 로 그려져서 로그인 세션 없이는 목록을 읽을 수 없습니다.',
  },
];

const OUT_DIR = '.sessions';

async function capture(target: Target): Promise<boolean> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${target.label} 로그인`);
  console.log(`  ${target.hint}`);
  console.log('─'.repeat(60));

  // headless 로 띄우면 사람이 로그인할 수가 없다. 이 스크립트는 항상 창을 띄운다.
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await context.newPage();

  await page.goto(target.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\n  창이 열렸습니다. 평소처럼 로그인하세요.');
  console.log('  (SMS 인증, 캡차 전부 정상적으로 하시면 됩니다)');
  console.log('\n  로그인이 끝나면 여기로 돌아와 Enter 를 누르세요.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('  > ');
  rl.close();

  // 사람이 "됐다" 고 해도 실제로 됐는지는 확인해야 한다.
  // 여기서 잘못 저장하면 나중에 파이프라인이 한밤중에 조용히 실패한다.
  console.log('\n  로그인 상태 확인 중...');
  await page.goto(target.verifyUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  let ok = false;
  try {
    await page.waitForSelector(target.loggedInSelector, { timeout: 10_000 });
    ok = true;
  } catch {
    ok = false;
  }

  if (!ok) {
    console.log(`\n  ✗ 로그인이 확인되지 않았습니다.`);
    console.log(`     ${target.verifyUrl} 에서 로그인 상태가 보이지 않습니다.`);
    console.log(`     다시 시도하거나, 이미 로그인돼 있는데 확인만 실패한 것이라면`);
    console.log(`     capture-session.ts 의 loggedInSelector 를 조정하세요.`);
    await browser.close();
    return false;
  }

  const state = await context.storageState();
  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${target.key}.json`);
  await writeFile(outPath, JSON.stringify(state));

  const cookieCount = state.cookies.length;
  await browser.close();

  console.log(`\n  ✓ 저장했습니다 (쿠키 ${cookieCount}개) → ${outPath}`);
  console.log(`\n  GitHub Secrets 에 넣을 이름: ${target.secretName}`);
  console.log(`  값은 아래 명령으로 클립보드에 복사하세요:`);
  console.log(`\n    macOS:   cat ${outPath} | pbcopy`);
  console.log(`    Windows: type ${outPath.replace(/\//g, '\\')} | clip`);
  console.log(`    Linux:   cat ${outPath} | xclip -selection clipboard`);

  return true;
}

async function main(): Promise<void> {
  const which = process.argv[2];

  if (!which) {
    console.log('\n사용법: npx tsx src/capture-session.ts <tiktok|naver|inpock|all>\n');
    console.log('대상:');
    for (const t of TARGETS) console.log(`  ${t.key.padEnd(8)} ${t.label} — ${t.hint}`);
    console.log();
    process.exit(1);
  }

  const targets = which === 'all' ? TARGETS : TARGETS.filter((t) => t.key === which);

  if (targets.length === 0) {
    console.error(`알 수 없는 대상: ${which}`);
    process.exit(1);
  }

  console.log('\n로그인 세션 캡처');
  console.log('\n⚠ 저장되는 파일은 로그인 자격증명과 같습니다.');
  console.log('  .sessions/ 는 .gitignore 에 있어 커밋되지 않지만,');
  console.log('  이 파일을 누구에게도 보내지 마세요. GitHub Secrets 에만 넣습니다.');

  const results: { label: string; ok: boolean; secret: string }[] = [];
  for (const target of targets) {
    const ok = await capture(target);
    results.push({ label: target.label, ok, secret: target.secretName });
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  결과');
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'}  ${r.label.padEnd(10)} ${r.ok ? r.secret : '실패 — 다시 시도하세요'}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    failed === 0
      ? '\n전부 캡처했습니다. GitHub Secrets 에 넣으면 됩니다.\n'
      : `\n${failed}건 실패했습니다.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
