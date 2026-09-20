import { readFile } from 'node:fs/promises';
import { requireEnv } from '../../config.js';
import type { LinkInput, PublishInput, PublishResult, Publisher } from './index.js';

/**
 * 유튜브 업로드.
 *
 * ⚠️ 감사(audit)를 통과하지 않은 GCP 프로젝트에서 API로 올린 영상은 강제로
 * 비공개(private)로 고정되고 공개 전환이 불가능하다. Phase 0에서 테스트 채널에
 * 1건 올려 공개 전환이 되는지 반드시 눈으로 확인해야 한다.
 *
 * quota: videos.insert 는 호출당 1600 units, 프로젝트당 일 10,000 units.
 * 유튜브 채널 2개 × 2개 = 4업로드 = 6,400 units 로 한 프로젝트에 들어간다.
 */

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/** 자격증명은 환경변수(Actions secrets)에서 읽는다. DB에는 키 이름만 둔다. */
function loadCredentials(credentialsRef: string): OAuthCredentials {
  const raw = requireEnv(credentialsRef);
  return JSON.parse(raw) as OAuthCredentials;
}

async function accessToken(creds: OAuthCredentials): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`유튜브 토큰 갱신 실패 (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export const youtubePublisher: Publisher = {
  platform: 'youtube',

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = await accessToken(loadCredentials(input.credentialsRef));
    const video = await readFile(input.videoPath);

    const metadata = {
      snippet: {
        title: input.title.slice(0, 100),
        description: input.description.slice(0, 5000),
        tags: input.hashtags.slice(0, 15),
        categoryId: '26', // Howto & Style
      },
      status: {
        // 예약 게시. 업로드 시각을 흩뿌려 기계적 패턴을 없앤다.
        privacyStatus: 'private',
        publishAt: input.scheduledAt.toISOString(),
        selfDeclaredMadeForKids: false,
      },
    };

    // resumable 업로드 세션을 연다.
    const init = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(video.byteLength),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!init.ok) {
      throw new Error(`유튜브 업로드 세션 실패 (${init.status}): ${await init.text()}`);
    }

    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('유튜브 업로드 URL을 받지 못했습니다.');

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.byteLength) },
      body: video,
    });
    if (!upload.ok) {
      throw new Error(`유튜브 업로드 실패 (${upload.status}): ${await upload.text()}`);
    }

    const result = (await upload.json()) as { id: string; status?: { uploadStatus?: string } };

    // 감사 미통과 프로젝트의 전형적 증상. 조용히 넘어가면 나중에
    // "왜 조회수가 0이지?" 로 돌아온다.
    if (result.status?.uploadStatus === 'rejected') {
      throw new Error(
        `유튜브가 업로드를 거부했습니다. GCP 프로젝트 감사가 통과됐는지 확인하세요. ` +
          `(감사 전에는 API 업로드 영상이 비공개로 고정됩니다)`,
      );
    }

    return {
      externalId: result.id,
      externalUrl: `https://www.youtube.com/shorts/${result.id}`,
    };
  },

  async attachLink(input: LinkInput): Promise<void> {
    if (input.linkMode === 'yt_shopping_tag') {
      throw new Error(
        '유튜브 쇼핑 상품 태그는 공개 API가 없습니다. YouTube Studio 브라우저 자동화가 필요합니다. ' +
          '자동화 실패 시 대시보드에 "수동 태그 필요" 로 남습니다. (Phase 2)',
      );
    }

    // 인포크링크 모드: 고정 댓글을 단다. 설명란은 업로드 시 이미 들어갔다.
    const token = await accessToken(loadCredentials(input.credentialsRef));

    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: {
            videoId: input.externalId,
            topLevelComment: { snippet: { textOriginal: input.pinnedComment } },
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`고정 댓글 작성 실패 (${res.status}): ${await res.text()}`);
    }
  },
};
