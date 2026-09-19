import type { Locator, Page } from 'playwright';
import { optionalEnv } from '../../config.js';
import { isSessionAlive, pause, SessionExpiredError, withContext } from '../browser.js';
import type { LinkInput, PublishInput, PublishResult, Publisher } from './index.js';

/**
 * 네이버 클립 업로드.
 *
 * 공개 API가 없어 웹 업로드 화면을 Playwright 로 직접 몬다. 그럼에도 이 채널을
 * 가장 먼저 자동화하는 이유는 구독자·조회수 조건 없이 '구매 링크' 스티커가 붙는
 * 유일한 채널이기 때문이다. 스티커가 안 붙으면 이 채널을 돌릴 이유 자체가 없어서,
 * attachLink 는 어떤 실패든 예외로 올려 수동 작업 큐로 보낸다.
 */

/**
 * ⚠️ 전부 미검증 셀렉터다.
 *
 * 이 코드를 쓴 환경에서는 네이버에 접속할 수 없어 실제 DOM 으로 확인하지 못했다.
 * Phase 0 에서 `HEADFUL=true` 로 한 번 띄워 눈으로 맞추고 이 객체만 고치면 되도록
 * 화면 의존적인 문자열을 여기 한 곳에 모아둔다. 본문에는 셀렉터를 직접 쓰지 않는다.
 */
export const SELECTORS = {
  /** 로그인 상태 확인용 — GNB 프로필 영역 */
  loggedIn: '#gnb_my_namebox, .MyView-module__my_menu___dZxVo, [class*="MyView-module__my_menu"]',
  /** 영상 파일 input. 보통 화면에 숨어 있어 attached 상태로만 잡힌다. */
  fileInput: 'input[type="file"][accept*="video"], input[type="file"]',
  /** 파일 input 이 DOM 에 없을 때 파일 선택 창을 여는 버튼 */
  fileTrigger: 'button:has-text("동영상 추가"), button:has-text("영상 선택"), [class*="upload_btn"]',
  /** 업로드·인코딩 진행 표시. 사라지면 다음 단계로 넘어간다. */
  uploadProgress: '[class*="progress"], [role="progressbar"]',
  titleInput: 'input[name="title"], textarea[name="title"], [class*="title"] [contenteditable="true"]',
  descriptionInput:
    'textarea[name="description"], textarea[name="content"], [class*="desc"] [contenteditable="true"]',
  /** 최종 발행 버튼 */
  submitButton: 'button:has-text("발행"), button:has-text("등록"), button[type="submit"]',
  /** 발행 완료 표시 (완료 모달·토스트) */
  publishedIndicator: '[class*="complete"], [class*="success"], text=발행이 완료',
  /** 발행 완료 화면에 뜨는 클립 링크 — externalId 추출용 */
  publishedLink: 'a[href*="/clips/"], a[href*="clipNo="]',

  // --- 구매 링크 스티커 (이 채널의 존재 이유) ---
  /** 편집 화면의 스티커 도구 진입 버튼 */
  stickerButton: 'button:has-text("스티커"), [class*="sticker_btn"]',
  /** 스티커 목록에서 '구매 링크' 항목 */
  purchaseStickerOption: 'button:has-text("구매 링크"), li:has-text("구매 링크")',
  /** 상품 URL 입력란 */
  stickerUrlInput: 'input[placeholder*="링크"], input[placeholder*="URL"], input[name="url"]',
  /** URL 확인/적용 버튼 */
  stickerConfirm: 'button:has-text("확인"), button:has-text("적용"), button:has-text("등록")',
  /** 스티커가 실제로 붙었는지 확인하는 표식. 이게 없으면 성공으로 치지 않는다. */
  stickerAttached: '[class*="sticker"][class*="link"], [data-sticker-type="link"]',
  /** 스티커 부착 후 저장 */
  saveButton: 'button:has-text("저장"), button:has-text("완료")',
} as const;

/** ⚠️ 진입 URL 역시 미검증이다. PC 웹 경로가 없으면 모바일 웹 경로로 바꿔야 한다. */
export const URLS = {
  upload: optionalEnv('NAVER_CLIP_UPLOAD_URL', 'https://blog.naver.com/ClipUpload.naver'),
  /** 업로드된 클립의 편집 화면 (스티커 부착용) */
  edit: (clipId: string) =>
    `${optionalEnv('NAVER_CLIP_EDIT_URL', 'https://blog.naver.com/ClipEdit.naver')}?clipNo=${clipId}`,
  watch: (clipId: string) => `https://blog.naver.com/clips/${clipId}`,
  /** 로그인 페이지로 튕겼는지 판정하는 호스트 */
  loginHost: 'nid.naver.com',
} as const;

const PLATFORM_LABEL = '네이버 클립';

function session(): string {
  const storageState = optionalEnv('NAVER_STORAGE_STATE', '');
  if (!storageState) throw new SessionExpiredError(PLATFORM_LABEL);
  return storageState;
}

/**
 * 셀렉터가 안 맞으면 여기서 멈춘다.
 * 빈 값으로 흘려보내면 "올라갔는데 링크가 없는 영상" 이 되고, 그건 조회수만 쓰고
 * 수익은 0인 최악의 결과다. 무엇이 안 됐는지 사람이 바로 읽을 수 있게 남긴다.
 */
async function requireElement(
  page: Page,
  selector: string,
  label: string,
  opts: { state?: 'visible' | 'attached'; timeout?: number } = {},
): Promise<Locator> {
  const target = page.locator(selector).first();
  try {
    await target.waitFor({ state: opts.state ?? 'visible', timeout: opts.timeout ?? 20_000 });
  } catch {
    throw new Error(
      `${PLATFORM_LABEL}: ${label}을(를) 찾지 못했습니다 (셀렉터: ${selector}). ` +
        `publishers/naverclip.ts 의 SELECTORS 를 실제 화면에 맞게 고치거나 수동으로 업로드하세요.`,
    );
  }
  return target;
}

/** 네이버 에디터는 같은 자리가 <input> 일 수도 contenteditable 일 수도 있다. */
async function typeInto(target: Locator, text: string): Promise<void> {
  const contentEditable = await target.evaluate(
    (el) => el instanceof HTMLElement && el.isContentEditable,
  );
  if (contentEditable) {
    await target.click();
    await target.press('ControlOrMeta+a');
    await target.pressSequentially(text, { delay: 12 });
    return;
  }
  await target.fill(text);
}

async function assertSessionAlive(page: Page): Promise<void> {
  if (page.url().includes(URLS.loginHost)) throw new SessionExpiredError(PLATFORM_LABEL);
  if (!(await isSessionAlive(page, SELECTORS.loggedIn))) {
    throw new SessionExpiredError(PLATFORM_LABEL);
  }
}

/** 발행 후 URL 또는 완료 화면의 링크에서 클립 번호를 뽑는다. */
function extractClipId(url: string): string | null {
  const fromPath = url.match(/\/clips?\/(\d+)/);
  if (fromPath?.[1]) return fromPath[1];
  const fromQuery = url.match(/[?&]clipNo=(\d+)/);
  return fromQuery?.[1] ?? null;
}

export const naverclipPublisher: Publisher = {
  platform: 'naverclip',

  async publish(input: PublishInput): Promise<PublishResult> {
    const storageState = session();

    return withContext({ storageState }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(URLS.upload, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await pause(2_000, 3_500);
        await assertSessionAlive(page);

        // 파일 input 이 DOM 에 있으면 그대로 쓰고, 없으면 버튼을 눌러 파일 선택 창을 받는다.
        // 네이버 에디터는 화면마다 둘 중 하나라 양쪽을 다 열어둔다.
        const fileInput = page.locator(SELECTORS.fileInput).first();
        if (await fileInput.count()) {
          await fileInput.setInputFiles(input.videoPath);
        } else {
          const trigger = await requireElement(page, SELECTORS.fileTrigger, '영상 추가 버튼');
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null),
            trigger.click(),
          ]);
          if (!chooser) {
            throw new Error(
              `${PLATFORM_LABEL}: 영상 파일 입력란을 열지 못했습니다. ` +
                `SELECTORS.fileInput / fileTrigger 를 확인하세요.`,
            );
          }
          await chooser.setFiles(input.videoPath);
        }
        await pause(2_000, 3_000);

        // 인코딩이 끝나기 전에는 제목 입력란이 비활성인 화면이 있다. 진행 표시가
        // 사라질 때까지 기다리되, 표시 자체가 없는 화면도 있으므로 실패는 무시한다.
        await page
          .locator(SELECTORS.uploadProgress)
          .first()
          .waitFor({ state: 'hidden', timeout: 300_000 })
          .catch(() => undefined);

        const title = await requireElement(page, SELECTORS.titleInput, '제목 입력란');
        await typeInto(title, input.title.slice(0, 50));
        await pause(600, 1_200);

        const description = await requireElement(page, SELECTORS.descriptionInput, '설명 입력란');
        await typeInto(description, input.description);
        await pause(800, 1_500);

        // 예약 게시는 화면 구조를 확인하지 못해 자동화하지 않았다. 즉시 발행되므로
        // 시각 분산은 S9 가 publish 호출 자체를 늦추는 쪽으로 해결해야 한다.
        console.log(
          `${PLATFORM_LABEL}: 예약 게시 미지원 — 즉시 발행합니다 ` +
            `(요청된 예약 시각 ${input.scheduledAt.toLocaleString('ko-KR')}).`,
        );

        const submit = await requireElement(page, SELECTORS.submitButton, '발행 버튼');
        await submit.click();
        await pause(2_500, 4_000);

        await page
          .locator(SELECTORS.publishedIndicator)
          .first()
          .waitFor({ state: 'visible', timeout: 180_000 })
          .catch(() => undefined);

        // ID를 못 읽으면 후속 스티커 부착이 불가능하다. 업로드가 됐더라도
        // 성공으로 기록하면 링크 없는 영상이 남으므로 사람을 부른다.
        const href =
          (await page.locator(SELECTORS.publishedLink).first().getAttribute('href').catch(() => null)) ?? '';
        const clipId = extractClipId(page.url()) ?? extractClipId(href);
        if (!clipId) {
          throw new Error(
            `${PLATFORM_LABEL}: 발행 후 클립 ID를 읽지 못했습니다 (현재 URL: ${page.url()}). ` +
              `업로드 자체는 완료됐을 수 있으니 네이버에서 직접 확인하고, ` +
              `SELECTORS.publishedLink 를 실제 화면에 맞게 고치세요.`,
          );
        }

        return { externalId: clipId, externalUrl: URLS.watch(clipId) };
      } finally {
        await page.close();
      }
    });
  },

  async attachLink(input: LinkInput): Promise<void> {
    if (input.linkMode !== 'naver_sticker') {
      // 인포크링크 모드면 링크가 이미 설명란에 들어가 있다. 스티커는 건너뛰되
      // 이 채널의 강점을 못 쓰고 있다는 사실은 로그에 남긴다.
      if (input.linkMode === 'inpock') {
        console.warn(
          `${PLATFORM_LABEL}: linkMode=inpock 이라 구매 링크 스티커를 붙이지 않았습니다. ` +
            `이 채널은 조건 없이 스티커가 붙으므로 resolveLinkMode 설정을 확인하세요.`,
        );
        return;
      }
      throw new Error(
        `${PLATFORM_LABEL}: 지원하지 않는 링크 방식입니다 (${input.linkMode}). ` +
          `네이버 클립은 naver_sticker 만 사용합니다.`,
      );
    }

    if (!input.linkUrl) {
      throw new Error(`${PLATFORM_LABEL}: 붙일 구매 링크 URL이 비어 있습니다.`);
    }

    const storageState = session();

    await withContext({ storageState }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(URLS.edit(input.externalId), {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await pause(2_000, 3_500);
        await assertSessionAlive(page);

        const sticker = await requireElement(page, SELECTORS.stickerButton, '스티커 버튼');
        await sticker.click();
        await pause(1_000, 2_000);

        const purchase = await requireElement(
          page,
          SELECTORS.purchaseStickerOption,
          '구매 링크 스티커 항목',
        );
        await purchase.click();
        await pause(1_000, 2_000);

        const urlField = await requireElement(page, SELECTORS.stickerUrlInput, '상품 URL 입력란');
        await typeInto(urlField, input.linkUrl);
        await pause(600, 1_200);

        const confirm = await requireElement(page, SELECTORS.stickerConfirm, '스티커 확인 버튼');
        await confirm.click();
        await pause(1_200, 2_200);

        // 확인 버튼이 눌렸다고 스티커가 붙은 건 아니다 (URL 검증에서 조용히 막히는 경우가 있다).
        // 눈에 보이는 표식을 한 번 더 확인하고서야 성공으로 친다.
        await requireElement(page, SELECTORS.stickerAttached, '부착된 구매 링크 스티커', {
          timeout: 15_000,
        });

        const save = await requireElement(page, SELECTORS.saveButton, '저장 버튼');
        await save.click();
        await pause(2_000, 3_500);
      } finally {
        await page.close();
      }
    });
  },
};
