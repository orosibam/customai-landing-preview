import { optionalEnv, requireEnv } from '../../config.js';
import { pause, SessionExpiredError, withContext } from '../browser.js';

/**
 * 인포크링크 상품 진열.
 *
 * 영상만 올리면 수익이 0이다. 원본 방법론이 가장 강조한 지점이 이것 —
 * "업로드만 하는 게 아니라 링크를 연결시켜야 됩니다".
 *
 * 흐름은 이렇다: 쿠팡파트너스 링크를 인포크링크 페이지에 **번호가 붙은 항목**으로
 * 등록하고, 영상 제목에서 그 번호를 지칭한다("프로필 링크 29번"). 시청자는
 * 프로필 → 인포크링크 → 해당 번호 → 쿠팡 순으로 이동한다.
 *
 * 한 페이지에 수백 개를 쌓아두는 구조라, 과거 영상들도 계속 살아서 클릭을 만든다.
 * 그래서 등록이 실패하면 조용히 넘어가면 안 된다.
 */

/**
 * 셀렉터는 **실물로 검증되지 않았다.** 이 컨테이너에서 인포크링크에 접속할 수 없다.
 * Phase 0에서 `HEADFUL=true` 로 띄워 한 번에 맞춘다. 본문에는 셀렉터 문자열을
 * 쓰지 않으므로 여기만 고치면 된다.
 */
export const SELECTORS = {
  /** 로그인 상태에서만 보이는 요소 */
  loggedIn: '[class*="dashboard"], [href*="/admin"], button:has-text("디자인")',
  /** 항목 추가 버튼 (+) */
  addButton: 'button:has-text("추가"), button[aria-label*="추가"], [class*="add-block"]',
  /** 추가 유형 중 "링크" */
  linkOption: 'button:has-text("링크"), [data-type="link"]',
  /** 링크 주소 입력 */
  urlInput: 'input[name="url"], input[placeholder*="주소"], input[placeholder*="URL"]',
  /** 항목 제목 입력 */
  titleInput: 'input[name="title"], input[placeholder*="제목"]',
  /** 저장/추가 완료 */
  saveButton: 'button:has-text("완료"), button:has-text("저장"), button[type="submit"]',
  /** 등록된 항목 목록 — 개수를 세어 번호를 매긴다 */
  itemList: '[class*="link-item"], [class*="block-item"], li[data-id]',
} as const;

export const URLS = {
  admin: optionalEnv('INPOCK_ADMIN_URL', 'https://link.inpock.co.kr/admin'),
  loginPath: 'login',
} as const;

export interface RegisteredItem {
  /** 영상 제목에서 지칭할 번호. 1부터 시작한다. */
  itemNumber: number;
  /** 시청자가 프로필에서 들어올 페이지 */
  pageUrl: string;
}

/**
 * 제휴 링크를 인포크링크에 등록하고 항목 번호를 돌려준다.
 *
 * 번호는 등록 후 목록의 길이로 센다. 인포크링크가 번호를 직접 노출하지 않기
 * 때문인데, 이 방식은 **항목 순서를 사람이 바꾸면 어긋난다.** 등록 직후에
 * 번호를 읽어 그 영상에 박아두므로 이후 재정렬은 과거 영상의 지칭을 깨뜨린다.
 * 운영 중에는 목록 순서를 건드리지 않는 게 전제다.
 */
export async function registerProduct(params: {
  affiliateUrl: string;
  productTitle: string;
}): Promise<RegisteredItem> {
  const storageState = optionalEnv('INPOCK_STORAGE_STATE', '');
  if (!storageState) throw new SessionExpiredError('인포크링크');

  const handle = requireEnv('INPOCK_HANDLE');

  return withContext({ storageState, locale: 'ko-KR' }, async (ctx) => {
    const page = await ctx.newPage();

    await page.goto(URLS.admin, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await pause(1_500, 2_500);

    if (page.url().includes(URLS.loginPath)) {
      await page.close();
      throw new SessionExpiredError('인포크링크');
    }

    await requireElement(page, SELECTORS.loggedIn, '로그인 확인');

    // 등록 전 개수를 세어둔다. 등록 후 개수가 늘지 않으면 실패한 것이다.
    const before = await page.locator(SELECTORS.itemList).count();

    await (await requireElement(page, SELECTORS.addButton, '항목 추가 버튼')).click();
    await pause(600, 1_200);

    await (await requireElement(page, SELECTORS.linkOption, '링크 유형 선택')).click();
    await pause(600, 1_200);

    await (await requireElement(page, SELECTORS.urlInput, '링크 주소 입력')).fill(params.affiliateUrl);

    const titleField = page.locator(SELECTORS.titleInput).first();
    if (await titleField.isVisible().catch(() => false)) {
      await titleField.fill(params.productTitle.slice(0, 40));
    }

    await (await requireElement(page, SELECTORS.saveButton, '저장 버튼')).click();
    await pause(1_500, 2_500);

    const after = await page.locator(SELECTORS.itemList).count();
    await page.close();

    if (after <= before) {
      throw new Error(
        `인포크링크 등록이 반영되지 않았습니다 (등록 전 ${before}개, 등록 후 ${after}개). ` +
          `저장이 거부됐거나 셀렉터가 맞지 않습니다. 영상 제목의 번호 지칭이 엉뚱한 상품을 ` +
          `가리키게 되므로 업로드를 중단합니다.`,
      );
    }

    return { itemNumber: after, pageUrl: `https://link.inpock.co.kr/${handle}` };
  });
}

/** 없으면 무엇을 하다 실패했는지 말하고 던진다. 조용한 실패는 수익 0으로 돌아온다. */
async function requireElement(
  page: import('playwright').Page,
  selector: string,
  step: string,
) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    throw new Error(
      `인포크링크 "${step}" 단계에서 요소를 찾지 못했습니다.\n` +
        `  셀렉터: ${selector}\n` +
        `  HEADFUL=true 로 띄워 SELECTORS 를 맞추세요 (lib/affiliate/inpock.ts).`,
    );
  }
  return locator;
}
