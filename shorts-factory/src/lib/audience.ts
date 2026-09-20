/**
 * 타겟 시청층 프로파일.
 *
 * 같은 쇼핑 쇼츠라도 누가 보느냐에 따라 최적 파라미터가 정반대로 간다.
 *
 * 유튜브(10~40대)는 빠르고 화려한 편집에 대본까지 잘 써야 조회수가 나온다.
 * 반면 틱톡 시니어 시장은 적당히 느린 속도에 화면 전환이 적은 쪽이 오히려 잘 먹힌다.
 * 틱톡 라이트 친구초대 이벤트로 시니어가 대거 유입되면서 생긴 시장 특성이다.
 *
 * 이게 실무적으로 중요한 이유: 시니어 타겟이면 제작 난이도 자체가 내려간다.
 * 컷을 적게 쓰고 전환을 줄여도 되니 소재도 덜 필요하고 렌더도 단순해진다.
 */

export type AudienceKey = 'senior' | 'general';

export interface AudienceProfile {
  key: AudienceKey;
  label: string;
  /** 나레이션 속도 배율. 타입캐스트 기본값은 느려서 이탈이 난다. */
  speechRate: number;
  /** 소스 영상 재생 속도 배율 */
  footageRate: number;
  /** 설계도가 잡을 컷 개수 범위. 시니어는 적을수록 좋다. */
  cutCount: { min: number; max: number };
  /** 컷 하나의 최소 체류 시간(초). 짧으면 시니어는 못 따라온다. */
  minCutSec: number;
  /** 자막 글자 크기(1080x1920 기준) */
  subtitleFontSize: number;
  /** 자막 테두리 두께 */
  subtitleOutline: number;
  /** 한 줄 최대 글자수. 크게 쓰면 줄이 짧아야 한다. */
  subtitleMaxCharsPerLine: number;
  /** 대본 한 문장 길이 범위 */
  sentenceChars: { min: number; max: number };
  /** 카피라이터에게 주는 화법 지침 */
  toneGuidance: string;
}

export const AUDIENCE_PROFILES: Record<AudienceKey, AudienceProfile> = {
  /**
   * 50~70대. 틱톡 쇼핑의 주력 구매층.
   * 느리고 단순하게. 자막은 크고 대비가 확실하게.
   */
  senior: {
    key: 'senior',
    label: '시니어 (50~70대)',
    speechRate: 1.25,
    footageRate: 1.3,
    cutCount: { min: 3, max: 5 },
    minCutSec: 3.5,
    subtitleFontSize: 96,
    subtitleOutline: 7,
    subtitleMaxCharsPerLine: 12,
    sentenceChars: { min: 10, max: 16 },
    toneGuidance: [
      '말을 거는 듯한 구어체로 쓴다. 혼잣말처럼 시작하면 좋다.',
      '자기 경험을 섞은 스토리텔링이 잘 먹힌다. ("제가 워낙 ~를 좋아해서" 같은 도입)',
      '한 문장에 정보를 하나만 담는다. 두 개를 겹치면 못 따라온다.',
      '외래어와 줄임말을 쓰지 않는다. 가격은 반드시 숫자로 말해준다.',
      '지시문은 단순하게. "프로필 링크에서 보세요" 정도까지만.',
    ].join('\n'),
  },

  /**
   * 10~40대. 유튜브 쇼츠·인스타 릴스 주력.
   * 빠르고 촘촘하게. 훅이 약하면 1초 만에 넘어간다.
   */
  general: {
    key: 'general',
    label: '일반 (10~40대)',
    speechRate: 1.1,
    footageRate: 1.0,
    cutCount: { min: 5, max: 9 },
    minCutSec: 2.5,
    subtitleFontSize: 72,
    subtitleOutline: 5,
    subtitleMaxCharsPerLine: 16,
    sentenceChars: { min: 12, max: 18 },
    toneGuidance: [
      '첫 1.5초에 승부를 건다. 결론이나 충격을 먼저 던진다.',
      '군더더기 없이 짧게. 접속사로 늘어지지 않는다.',
      '정보 밀도를 높게 유지한다. 한 문장이 한 가지 이득을 말한다.',
    ].join('\n'),
  },
};

export function audienceFor(key: AudienceKey): AudienceProfile {
  const profile = AUDIENCE_PROFILES[key];
  if (!profile) throw new Error(`알 수 없는 타겟 프로파일: ${key}`);
  return profile;
}

/**
 * 플랫폼별 기본 타겟.
 *
 * 틱톡은 시니어 비중이 높아 senior 가 기본이다. 채널 설정에서 개별로 덮어쓸 수 있다.
 */
export const PLATFORM_DEFAULT_AUDIENCE: Record<string, AudienceKey> = {
  tiktok: 'senior',
  naverclip: 'senior',
  youtube: 'general',
  instagram: 'general',
};
