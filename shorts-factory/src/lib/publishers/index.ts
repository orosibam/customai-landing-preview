import type { LinkMode } from '../affiliate.js';

/**
 * 플랫폼별 업로드 어댑터.
 *
 * 유튜브만 공개 API가 있고 나머지는 브라우저 자동화다. 구현되지 않은 경로는
 * 조용히 성공한 척하지 않고 명시적으로 던진다 — 대시보드가 그걸 받아
 * "수동 업로드 필요" 작업으로 띄운다.
 */

export interface PublishInput {
  videoPath: string;
  thumbPath: string;
  title: string;
  description: string;
  hashtags: string[];
  /** 승인 시각 기준으로 흩뿌린 예약 시각. 기계적 패턴을 피하려는 장치. */
  scheduledAt: Date;
  credentialsRef: string;
}

export interface PublishResult {
  externalId: string;
  externalUrl: string;
}

export interface LinkInput {
  externalId: string;
  linkMode: LinkMode;
  linkUrl: string;
  pinnedComment: string;
  productUrl: string;
  credentialsRef: string;
}

export interface Publisher {
  platform: string;
  publish(input: PublishInput): Promise<PublishResult>;
  attachLink(input: LinkInput): Promise<void>;
}

export class NotImplementedPublisher implements Publisher {
  constructor(
    public readonly platform: string,
    private readonly hint: string,
  ) {}

  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error(`${this.platform} 업로드가 아직 구현되지 않았습니다. ${this.hint}`);
  }

  async attachLink(_input: LinkInput): Promise<void> {
    throw new Error(`${this.platform} 링크 부착이 아직 구현되지 않았습니다. ${this.hint}`);
  }
}

import { youtubePublisher } from './youtube.js';

export const PUBLISHERS: Record<string, Publisher> = {
  youtube: youtubePublisher,
  naverclip: new NotImplementedPublisher(
    '네이버 클립',
    '공식 API가 없어 Playwright 자동화가 유일한 경로입니다. ' +
      '구독자 조건 없이 구매 링크 스티커가 붙는 유일한 채널이라 가장 먼저 구현할 가치가 있습니다. (Phase 0 ⑦)',
  ),
  instagram: new NotImplementedPublisher(
    '인스타그램',
    'Content Publishing API(비즈니스 계정) 또는 Playwright. (Phase 2)',
  ),
  tiktok: new NotImplementedPublisher(
    '틱톡',
    'Content Posting API 심사 또는 Playwright. (Phase 2)',
  ),
};

export function publisherFor(platform: string): Publisher {
  const p = PUBLISHERS[platform];
  if (!p) throw new Error(`알 수 없는 플랫폼: ${platform}`);
  return p;
}
