import type { Locator, Page } from 'playwright';
import { optionalEnv } from '../../config.js';
import { isSessionAlive, pause, SessionExpiredError, withContext } from '../browser.js';
import type { LinkInput, PublishInput, PublishResult, Publisher } from './index.js';

/**
 * 틱톡 업로드.
 *
 * Content Posting API 는 심사를 받아야 하고 심사 전에는 비공개 업로드만 되므로,
 * 승인 전까지는 TikTok Studio 웹 업로드 화면을 Playwright 로 모는 쪽이 유일한 경로다.
 *
 * 업로드 화면은 iframe 안에 들어있던 시기가 길어서, 본문에서는 프레임을 먼저
 * 고르고 시작한다. 프레임이 사라지면 페이지 자체를 쓴다.
 */

/**
 * ⚠️ 전부 미검증 셀렉터다.
 *
 * 이 환경에서는 틱톡에 접속할 수 없어 실제 DOM 으로 확인하지 못했다.
 * Phase 0 에서 `HEADFUL=true` 로 띄워 맞춘 뒤 이 객체만 고치면 되도록 모아둔다.
 * data-e2e 속성은 틱톡이 자주 바꾸므로 클래스 기반 대안을 함께 적어둔다.
 */
export const SELECTORS = {
  /** 로그인 상태 확인용 — 스튜디오 사이드바 */
  loggedIn: '[data-e2e="profile-icon"], [class*="sidebar"], [class*="upload-title"]',
  /** 업로드 UI 가 들어있는 iframe (없는 버전도 있다) */
  uploadIframe: 'iframe[src*="upload"], iframe[data-tt="Upload_index_iframe"]',
  fileInput: 'input[type="file"][accept*="video"], input[type="file"]',
  /** 업로드·인코딩 진행 표시 */
  uploadProgress: '[class*="info-progress"], [role="progressbar"], text=업로드 중',
  /** 캡션 입력란. contenteditable DraftJS 에디터다. */
  captionEditor:
    '[data-e2e="caption-editor"] div[contenteditable="true"], div[contenteditable="true"][class*="public-DraftEditor"]',
  /** 해시태그 자동완성 드롭다운. 떠 있으면 Enter 가 게시로 안 가고 태그 선택으로 먹힌다. */
  hashtagSuggestion: '[class*="mention-list"], [class*="hashtag-list"]',
  postButton: '[data-e2e="post_video_button"], button:has-text("게시"), button:has-text("Post")',
  /** 게시 완료 모달 */
  postedIndicator: '[class*="modal"]:has-text("게시"), text=Your video is being uploaded',
  /** 게시 후 콘텐츠 관리 화면의 최신 영상 링크 — externalId 추출용 */
  contentVideoLink: 'a[href*="/video/"]',
} as const;

/** ⚠️ 진입 URL 도 미검증이다. 스튜디오 경로가 바뀌면 여기만 고친다. */
export const URLS = {
  upload: optionalEnv('TIKTOK_UPLOAD_URL', 'https://www.tiktok.com/tiktokstudio/upload?from=webapp'),
  /** 게시 후 영상 ID를 확인하는 콘텐츠 관리 화면 */
  content: optionalEnv('TIKTOK_CONTENT_URL', 'https://www.tiktok.com/tiktokstudio/content'),
  video: (videoId: string) => `https://www.tiktok.com/@me/video/${videoId}`,
  /** 로그인 페이지로 튕겼는지 판정하는 경로 조각 */
  loginPath: '/login',
} as const;

const PLATFORM_LABEL = '틱톡';
/** 캡션 길이 상한. 넘기면 앞이 잘려 링크 안내 문구가 사라진다. */
const CAPTION_LIMIT = 2_200;

function session(): string {
  const storageState = optionalEnv('TIKTOK_STORAGE_STATE', '');
  if (!storageState) throw new SessionExpiredError(PLATFORM_LABEL);
  return storageState;
}

/** 업로드 폼이 iframe 안에 있으면 그 프레임을, 아니면 페이지를 돌려준다. */
type Scope = Page | import('playwright').FrameLocator;

async function uploadScope(page: Page): Promise<Scope> {
  const iframe = page.locator(SELECTORS.uploadIframe).first();
  if (await iframe.count()) return page.frameLocator(SELECTORS.uploadIframe);
  return page;
}

/**
 * 셀렉터가 안 맞으면 여기서 멈춘다. 조용히 넘어가면 "올라갔는데 캡션도 링크도
 * 없는 영상" 이 남고, 그건 조회수만 쓰고 수익은 0인 결과다.
 */
async function requireElement(
  scope: Scope,
  selector: string,
  label: string,
  opts: { state?: 'visible' | 'attached'; timeout?: number } = {},
): Promise<Locator> {
  const target = scope.locator(selector).first();
  try {
    await target.waitFor({ state: opts.state ?? 'visible', timeout: opts.timeout ?? 20_000 });
  } catch {
    throw new Error(
      `${PLATFORM_LABEL}: ${label}을(를) 찾지 못했습니다 (셀렉터: ${selector}). ` +
        `publishers/tiktok.ts 의 SELECTORS 를 실제 화면에 맞게 고치거나 수동으로 업로드하세요.`,
    );
  }
  return target;
}

async function assertSessionAlive(page: Page): Promise<void> {
  if (page.url().includes(URLS.loginPath)) throw new SessionExpiredError(PLATFORM_LABEL);
  if (!(await isSessionAlive(page, SELECTORS.loggedIn))) {
    throw new SessionExpiredError(PLATFORM_LABEL);
  }
}

export function buildCaption(title: string, hashtags: string[]): string {
  const tags = hashtags.map((t) => `#${t.replace(/^#/, '')}`).join(' ');
  return `${title}\n${tags}`.slice(0, CAPTION_LIMIT);
}

function extractVideoId(url: string): string | null {
  return url.match(/\/video\/(\d+)/)?.[1] ?? null;
}

export const tiktokPublisher: Publisher = {
  platform: 'tiktok',

  async publish(input: PublishInput): Promise<PublishResult> {
    const storageState = session();

    return withContext({ storageState }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(URLS.upload, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await pause(2_500, 4_000);
        await assertSessionAlive(page);

        const scope = await uploadScope(page);

        // 파일 input 은 화면에 안 보이게 감춰져 있어 attached 로 잡는다.
        const fileInput = await requireElement(scope, SELECTORS.fileInput, '영상 파일 입력란', {
          state: 'attached',
        });
        await fileInput.setInputFiles(input.videoPath);
        await pause(3_000, 5_000);

        // 인코딩이 끝나야 게시 버튼이 살아난다. 쇼츠 길이라도 수 분 걸릴 수 있다.
        await scope
          .locator(SELECTORS.uploadProgress)
          .first()
          .waitFor({ state: 'hidden', timeout: 300_000 })
          .catch(() => undefined);

        const caption = await requireElement(scope, SELECTORS.captionEditor, '캡션 입력란');
        await caption.click();
        // DraftJS 에디터라 fill() 이 먹지 않는다. 기존 파일명 캡션을 지우고 직접 친다.
        await caption.press('ControlOrMeta+a');
        await caption.press('Backspace');
        await caption.pressSequentially(buildCaption(input.title, input.hashtags), { delay: 18 });
        await pause(800, 1_500);

        // 해시태그 자동완성이 떠 있으면 다음 클릭을 가로챈다. Escape 로 닫고 간다.
        if (await scope.locator(SELECTORS.hashtagSuggestion).first().count()) {
          await page.keyboard.press('Escape');
          await pause(400, 800);
        }

        // 예약 게시 토글은 화면 구조를 확인하지 못해 자동화하지 않았다. 즉시 게시되므로
        // 시각 분산은 S9 가 publish 호출 자체를 늦추는 쪽으로 해결해야 한다.
        console.log(
          `${PLATFORM_LABEL}: 예약 게시 미지원 — 즉시 게시합니다 ` +
            `(요청된 예약 시각 ${input.scheduledAt.toLocaleString('ko-KR')}).`,
        );

        const post = await requireElement(scope, SELECTORS.postButton, '게시 버튼');
        if (await post.isDisabled().catch(() => false)) {
          throw new Error(
            `${PLATFORM_LABEL}: 게시 버튼이 비활성 상태입니다. 업로드·인코딩이 끝나지 않았거나 ` +
              `캡션 입력이 반영되지 않았습니다. 틱톡에서 직접 확인하세요.`,
          );
        }
        await post.click();
        await pause(3_000, 5_000);

        await page
          .locator(SELECTORS.postedIndicator)
          .first()
          .waitFor({ state: 'visible', timeout: 120_000 })
          .catch(() => undefined);

        const videoId = await resolveVideoId(page);
        if (!videoId) {
          throw new Error(
            `${PLATFORM_LABEL}: 게시 후 영상 ID를 읽지 못했습니다. 게시 자체는 완료됐을 수 있으니 ` +
              `틱톡 스튜디오에서 직접 확인하고, SELECTORS.contentVideoLink 를 실제 화면에 맞게 고치세요.`,
          );
        }

        return { externalId: videoId, externalUrl: URLS.video(videoId) };
      } finally {
        await page.close();
      }
    });
  },

  async attachLink(input: LinkInput): Promise<void> {
    if (input.linkMode === 'tiktok_shop') {
      throw new Error(
        `${PLATFORM_LABEL}: 틱톡샵 상품 링크는 자동 부착이 아직 불가능합니다. ` +
          `상품 링크는 일반 크리에이터 업로드 화면이 아니라 셀러(TikTok Shop) 계정의 ` +
          `제휴 상품 선택 흐름에서만 붙고, 해당 화면은 사업자 인증이 끝난 계정에서만 열립니다. ` +
          `인증을 마친 뒤 실제 화면을 보고 자동화하거나, 그때까지는 틱톡 스튜디오에서 ` +
          `수동으로 상품을 연결하세요. (Phase 2)`,
      );
    }

    if (input.linkMode === 'inpock') {
      // 인포크링크는 프로필 바이오에 한 번 박아두는 구조라 영상마다 할 일이 없다.
      // 다만 "바이오에 링크가 있다" 는 전제가 깨지면 전 영상이 수익 0이 되므로,
      // 운영자가 무엇을 해뒀어야 하는지 로그로 남긴다.
      console.log(
        `${PLATFORM_LABEL}: 영상 ${input.externalId} — 링크는 프로필 바이오와 캡션에 있습니다. ` +
          `프로필 바이오가 ${input.linkUrl} (또는 인포크링크 페이지) 로 설정돼 있어야 합니다.`,
      );
      return;
    }

    throw new Error(
      `${PLATFORM_LABEL}: 지원하지 않는 링크 방식입니다 (${input.linkMode}).`,
    );
  },
};

/**
 * 게시 직후 URL 에 영상 ID가 없으면 콘텐츠 관리 화면의 최신 영상에서 가져온다.
 * 여기서도 못 읽으면 호출부가 수동 확인으로 돌린다.
 */
async function resolveVideoId(page: Page): Promise<string | null> {
  const fromUrl = extractVideoId(page.url());
  if (fromUrl) return fromUrl;

  await page.goto(URLS.content, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await pause(2_500, 4_000);

  const href = await page
    .locator(SELECTORS.contentVideoLink)
    .first()
    .getAttribute('href')
    .catch(() => null);
  return href ? extractVideoId(href) : null;
}
