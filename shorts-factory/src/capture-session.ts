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
 *   npm run capture xhs      샤오홍슈 — 소재 링크 수확 (QR 로그인)
 *   npm run capture ali      1688
 *   npm run capture tiktok   틱톡 — 탐색·업로드
 *   npm run capture naver    네이버 클립 업로드
 *   npm run capture inpock   인포크링크
 *   npm run capture all      전부
 *
 * 대상 목록은 TARGETS 한 곳에만 둔다. 여기저기 적어두면 대상을 추가할 때
 * 안내가 먼저 거짓말을 하기 시작한다.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';
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
  /**
   * 셀렉터만 믿으면 안 되는 곳을 위한 2차 확인.
   *
   * 실측에서 이렇게 당했다: 샤오홍슈는 explore(둘러보기)는 비로그인도 열어주고
   * 검색만 따로 막는다. 그래서 아바타 셀렉터가 잡혀 "✓ 저장했습니다" 를 찍었는데
   * 정작 수확을 돌리면 검색이 로그인 벽이었다. 네이버도 같은 종류로 한 번 틀렸다.
   *
   * 그래서 "로그인했나" 가 아니라 "이 세션으로 실제 할 일이 되나" 를 묻는다.
   * url 을 열어 blocked 문구가 보이면 아직 로그인이 덜 된 것으로 본다.
   */
  capability?: { url: string; blocked: RegExp; what: string };
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
    // 위 셀렉터는 로그아웃 상태에서도 잡힌다(실측). 로그인해야만 열리는 곳으로 확인한다.
    capability: {
      url: 'https://brandconnect.naver.com',
      blocked: /브랜드 협업의 시작|크리에이터, 브랜드/,
      what: '브랜드 커넥트 접근',
    },
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
    // explore 는 비로그인도 열린다. 우리가 실제로 쓰는 건 검색이므로 검색으로 확인한다.
    capability: {
      url: 'https://www.xiaohongshu.com/search_result?keyword=%E6%B4%97%E8%BD%A6%E6%B6%B2',
      blocked: /登录后查看|扫码登录|手机号登录/,
      what: '키워드 검색',
    },
    secretName: 'XIAOHONGSHU_STORAGE_STATE',
    hint:
      '소재 링크 수확에 쓰입니다. 비로그인으로는 키워드 검색이 아예 안 돼서 ' +
      '이 세션이 있어야 "어떤 상품 영상을 쓸지" 를 자동으로 고를 수 있습니다. ' +
      'QR 로그인이면 휴대폰 앱으로 스캔하시면 됩니다.',
  },
  {
    key: 'instagram',
    label: '인스타그램',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    verifyUrl: 'https://www.instagram.com/',
    loggedInSelector: '[aria-label="홈"], [aria-label="Home"], svg[aria-label="새로운 소식"], a[href="/direct/inbox/"]',
    // 업로드가 아니라 **소재 발굴**용이다. 남의 공개 릴스를 읽는 데만 쓴다.
    // 업로드는 공식 Content Publishing API 로 간다(instagram-setup.md).
    // 해시태그 탐색은 비로그인이면 로그인 화면으로 막힌다. 그걸로 확인한다.
    capability: {
      url: 'https://www.instagram.com/explore/tags/carcleaning/',
      blocked: /accounts\/login|Log in to Instagram|Sign up to see|로그인하여 계속/,
      what: '해시태그 탐색',
    },
    secretName: 'INSTAGRAM_STORAGE_STATE',
    hint:
      '해외에서 터진 릴스를 찾는 소재 발굴에 쓰입니다. 업로드에는 쓰지 않습니다. ' +
      '⚠️ 스크래핑은 계정 제재 위험이 있으니 쇼핑 계정이 아니라 별도 부계정으로 로그인하세요.',
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

/** 로그인을 기다리는 최대 시간. QR 스캔·SMS 인증에 넉넉해야 한다. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 로그인될 때까지 기다린다.
 *
 * 예전엔 사람이 터미널로 돌아와 Enter 를 눌러야 저장했다. 실제로 그 단계에서
 * 사고가 났다 — 브라우저에서 로그인은 끝냈는데 Enter 를 안 눌러 창만 닫히고
 * 아무것도 저장되지 않았다. 나중에 수확을 돌릴 때가 되어서야 "세션이 없다" 로
 * 드러난다.
 *
 * 사람이 기억해야 할 단계를 없앤다. 로그인 흔적이 보이면 바로 저장한다.
 * Enter 는 남겨두되 "지금 바로 확인해라" 는 뜻으로만 쓴다.
 */
async function waitForLogin(
  page: Page,
  target: Target,
  context: BrowserContext,
): Promise<boolean> {
  const startedAt = Date.now();
  let lastNotice = 0;
  let capabilityNoticed = false;

  // 사람이 쓰는 탭을 건드리지 않으려고 확인은 별도 탭에서 한다.
  const probeRef: { page: Page | null } = { page: null };
  const closeProbe = async (): Promise<void> => {
    if (probeRef.page) {
      await probeRef.page.close().catch(() => {});
      probeRef.page = null;
    }
  };

  /** 이 세션으로 실제 할 일이 되는지 본다. capability 가 없으면 확인할 게 없으므로 통과. */
  const capabilityOk = async (): Promise<boolean> => {
    const cap = target.capability;
    if (!cap) return true;
    try {
      probeRef.page ??= await context.newPage();
      const probe = probeRef.page;
      await probe.goto(cap.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await probe.waitForTimeout(2_500);
      const text = await probe.evaluate(() => document.body.innerText || '');
      return !cap.blocked.test(text);
    } catch {
      return false;   // 확인을 못 했으면 통과시키지 않는다. 조용한 실패보다 낫다.
    }
  };

  // Enter 를 누르면 기다리지 않고 즉시 한 번 더 본다. 안 눌러도 상관없다.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let nudged = false;
  rl.question('  (로그인이 끝났는데 감지가 안 되면 Enter) ').then(() => { nudged = true; }).catch(() => {});

  try {
    while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
      const found = await page
        .locator(target.loggedInSelector)
        .first()
        .isVisible()
        .catch(() => false);
      if (found) {
        // 셀렉터만 믿으면 "저장했습니다" 를 찍고도 정작 쓸 때 로그인 벽을 만난다.
        if (await capabilityOk()) {
          await closeProbe();
          return true;
        }
        if (!capabilityNoticed) {
          capabilityNoticed = true;
          console.log(
            `\n  로그인 표시는 보이는데 ${target.capability?.what} 가 아직 안 열립니다.`,
          );
          console.log('  QR 을 스캔하셨다면 휴대폰에서 "확인/로그인" 까지 눌러주세요.');
          console.log('  계속 기다립니다.\n');
        }
      }

      // 창을 닫아버린 경우. 계속 기다려봐야 소용없다.
      if (page.isClosed()) {
        console.log('\n  창이 닫혔습니다. 저장하지 못했습니다.');
        return false;
      }

      const waited = Math.floor((Date.now() - startedAt) / 1000);
      if (waited - lastNotice >= 30) {
        lastNotice = waited;
        console.log(`  ... ${waited}초째 기다리는 중 (로그인되면 자동으로 넘어갑니다)`);
      }

      if (nudged) {
        nudged = false;
        // 확인 화면으로 한 번 보내본다. 로그인 직후 리디렉션이 안 된 경우가 있다.
        await page.goto(target.verifyUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      await new Promise((r) => setTimeout(r, 2_000));
    }
  } finally {
    rl.close();
    await closeProbe();
  }

  console.log('\n  10분 동안 로그인이 감지되지 않았습니다.');
  return false;
}

async function capture(target: Target): Promise<boolean> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${target.label} 로그인`);
  console.log(`  ${target.hint}`);
  console.log('─'.repeat(60));

  // headless 로 띄우면 사람이 로그인할 수가 없다. 이 스크립트는 항상 창을 띄운다.
  //
  // 프로필 폴더를 쓰는 이유: 쿠키(storageState)만 저장해서는 샤오홍슈 로그인이
  // 넘어가지 않는다. 실측에서 쿠키 31개를 복원했는데도 검색이 로그인 벽으로 떴다.
  // 프로필째로 두면 localStorage·IndexedDB 까지 남아 수확이 그대로 이어받는다.
  const profileDir = join(OUT_DIR, `${target.key}-profile`);
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--no-sandbox'],
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(target.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\n  창이 열렸습니다. 평소처럼 로그인하세요.');
  console.log('  (SMS 인증, QR 스캔, 캡차 전부 정상적으로 하시면 됩니다)');
  console.log('\n  로그인이 감지되면 자동으로 저장하고 창을 닫습니다.');
  console.log('  터미널로 돌아오실 필요 없습니다. 그냥 로그인만 끝내세요.\n');

  const ok = await waitForLogin(page, target, context);
  console.log('');

  if (!ok) {
    console.log(`\n  ✗ 로그인이 확인되지 않았습니다.`);
    if (target.capability) {
      console.log(`     ${target.capability.what} 가 열리는지까지 확인하는데, 열리지 않았습니다.`);
      console.log(`     확인 주소: ${target.capability.url}`);
    } else {
      console.log(`     ${target.verifyUrl} 에서 로그인 상태가 보이지 않습니다.`);
    }
    console.log(`     다시 시도하거나, 이미 로그인돼 있는데 확인만 실패한 것이라면`);
    console.log(`     capture-session.ts 의 loggedInSelector 를 조정하세요.`);
    await context.close();
    return false;
  }

  // 프로필은 이미 디스크에 있다. storageState 는 브라우저가 없는 곳(Actions)용으로
  // 같이 떠둔다 — 다만 샤오홍슈처럼 쿠키만으로는 안 되는 곳이 있다는 걸 알고 쓴다.
  const state = await context.storageState();
  const outPath = join(OUT_DIR, `${target.key}.json`);
  await writeFile(outPath, JSON.stringify(state));

  const cookieCount = state.cookies.length;
  await context.close();

  console.log(`\n  ✓ 저장했습니다`);
  console.log(`     프로필: ${profileDir}/   ← 이 컴퓨터에서 쓰는 것`);
  console.log(`     쿠키 ${cookieCount}개: ${outPath}`);
  // 이 컴퓨터에서는 코드가 이 파일을 직접 읽는다. 복사 단계를 만들지 않는다.
  console.log(`\n  이 컴퓨터에서는 바로 쓸 수 있습니다. 옮길 필요 없습니다.`);
  console.log(`\n  다음 단계:  npm run links harvest ${target.key === 'ali' ? 'ali' : target.key} <검색어>`);
  console.log(`\n  매일 자동 실행(GitHub Actions)에도 쓰려면 이 파일 내용을`);
  console.log(`  저장소 Settings → Secrets and variables → Actions 의`);
  console.log(`  ${target.secretName} 에 넣으세요. 복사 명령:`);
  console.log(`    macOS:   cat ${outPath} | pbcopy`);
  console.log(`    Windows: type ${outPath.replace(/\//g, '\\')} | clip`);

  return true;
}

async function main(): Promise<void> {
  const which = process.argv[2];

  if (!which) {
    console.log(
      `\n사용법: npm run capture <${TARGETS.map((t) => t.key).join('|')}|all>\n`,
    );
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
  console.log(`  대상: ${targets.map((t) => t.label).join(', ')}`);
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
