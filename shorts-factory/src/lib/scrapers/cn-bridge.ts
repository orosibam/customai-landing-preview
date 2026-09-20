import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { optionalEnv } from '../../config.js';

/**
 * 파이썬 헬퍼(`scrapers-py/cn_media.py`) 호출 다리.
 *
 * 왜 프로세스를 하나 더 띄우는가: 샤오홍슈는 크롬의 TLS 지문을 흉내 내야 SSR HTML 을
 * 내준다. Playwright 로 페이지를 열어 미디어를 가로채는 방식은 실측에서 막혔고
 * (검색 페이지가 로그인 벽으로만 렌더되고, 게스트 쿠키로 서명 호출을 해도 code -104),
 * 통한 방법은 curl_cffi 로 브라우저를 아예 안 쓰는 쪽이었다. node 에는 같은 일을 하는
 * 검증된 수단이 없어서 그 한 조각만 파이썬으로 둔다.
 *
 * 실패는 그대로 올린다. 파이썬 쪽 stderr 에 무엇을 하다 막혔는지 한국어로 적혀 있으므로
 * 삼키지 않고 메시지에 붙여서 던진다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/lib/scrapers → shorts-factory/scrapers-py */
const SCRIPT = join(HERE, '..', '..', '..', 'scrapers-py', 'cn_media.py');

export class CnBridgeError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`중국 플랫폼 접근 실패 (${command}): ${detail}`);
    this.name = 'CnBridgeError';
  }
}

async function run<T>(args: string[], timeoutMs = 180_000): Promise<T> {
  const python = optionalEnv('PYTHON_BIN', 'python3');

  return new Promise<T>((resolve, reject) => {
    const child = spawn(python, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CnBridgeError(args[0]!, `${timeoutMs / 1000}초 안에 끝나지 않아 중단했습니다.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        new CnBridgeError(
          args[0]!,
          `${python} 를 실행하지 못했습니다 (${e.message}). ` +
            `파이썬 3.11+ 와 scrapers-py/requirements.txt 설치가 필요합니다.`,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CnBridgeError(args[0]!, stderr.trim() || `종료코드 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new CnBridgeError(args[0]!, `JSON 이 아닌 출력: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

/** 피드에서 읽은 노트 한 건. xsecToken 은 이 노트에만 쓸 수 있다. */
export interface XhsFeedNote {
  noteId: string;
  xsecToken: string;
  title: string;
  type: string | null;
  likes: number | null;
  authorId: string | null;
  authorName: string | null;
}

export interface XhsNoteDetail {
  noteId: string;
  url: string;
  title: string;
  desc: string;
  type: string | null;
  videoUrl: string | null;
  likes: number | null;
  collects: number | null;
  comments: number | null;
  shares: number | null;
  authorId: string | null;
  authorName: string | null;
  followerCount: number | null;
  postedAtMs: number | null;
}

export interface AliOffer {
  offerId: string;
  productUrl: string;
  title: string;
  videoUrls: string[];
}

/**
 * /explore 피드의 노트 목록.
 *
 * **검색이 아니다.** 샤오홍슈 키워드 검색은 로그인 벽에 막혀 있어서, 그날 피드에 뜬 것
 * 중에서 고르는 수밖에 없다. 키워드 필터링은 호출부가 캡션으로 한다.
 */
export function xhsFeed(limit: number, channel?: string, rounds = 1): Promise<XhsFeedNote[]> {
  const args = ['xhs-feed', '--limit', String(limit), '--rounds', String(rounds)];
  if (channel) args.push('--channel', channel);
  return run<XhsFeedNote[]>(args);
}

/**
 * 노트 상세. **수확한 URL 을 통째로** 넘긴다.
 *
 * id 와 토큰을 따로 받아 URL 을 재조립하지 않는 이유: 예전에 토큰을 벗겼다가 55건을
 * 통째로 날렸다. 재조립은 내가 아는 파라미터만 다시 붙이게 되고, 모르는 건 조용히
 * 사라진다. 받은 문자열을 그대로 쓰는 게 유일하게 안전하다.
 */
export function xhsNote(url: string): Promise<XhsNoteDetail> {
  return run<XhsNoteDetail>(['xhs-note', '--url', url]);
}

/** 1688 상품 상세 → 영상 주소. 수확한 URL 을 통째로 넘긴다. */
export function aliOffer(url: string): Promise<AliOffer> {
  return run<AliOffer>(['ali-offer', '--url', url]);
}

/** 영상 파일 내려받기. 같은 TLS 지문을 써야 CDN 이 열어주므로 여기서 받는다. */
export function downloadVideo(url: string, outPath: string, referer?: string): Promise<{ path: string; bytes: number }> {
  const args = ['download', '--url', url, '--out', outPath];
  if (referer) args.push('--referer', referer);
  return run<{ path: string; bytes: number }>(args, 300_000);
}

/** 설치·연결 점검. 값은 찍지 않으므로 출력을 그대로 공유해도 안전하다. */
export function selfcheck(): Promise<{
  curl_cffi: boolean;
  impersonate: string;
  xhsStatus: number;
  xhsBytes: number;
  hasInitialState: boolean;
}> {
  return run(['selfcheck'], 60_000);
}
