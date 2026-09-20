/**
 * 파이프라인 전역 설정.
 *
 * 여기 값들은 계획서에서 "설정 한 줄로 바꾼다"고 한 손잡이들이다.
 * 운영하면서 제일 자주 만질 곳이므로 한 파일에 모아둔다.
 */

export type Platform = 'youtube' | 'naverclip' | 'instagram' | 'tiktok';
export type ReferencePlatform = 'xiaohongshu' | 'tiktok' | 'instagram';

/**
 * 로컬에서 돌릴 때 `.env` 파일을 읽어온다.
 *
 * Actions 에서는 secrets 가 환경변수로 들어오므로 파일이 없고, 그건 정상이다.
 * 없으면 조용히 넘어간다 — 여기서 죽으면 CI 가 이유 없이 빨개진다.
 *
 * Node 22 내장 기능이라 dotenv 의존성을 더하지 않는다. 의존성 하나를 아끼자는 게
 * 아니라, 처음 세팅하는 사람이 "왜 값이 안 읽히지" 로 막히는 걸 없애려는 것이다.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // .env 가 없는 환경(Actions 등). 정상이다.
}

/** 필수 환경변수를 읽는다. 없으면 즉시 죽는다 — 파이프라인 중간에 터지는 것보다 낫다. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `환경변수 ${name} 가 없습니다.\n` +
        `   로컬이라면 shorts-factory/.env 파일에 ${name}=값 을 넣으세요 (.env.example 참고).\n` +
        `   GitHub Actions 라면 저장소 Settings → Secrets and variables → Actions 를 확인하세요.`,
    );
  }
  return v;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// ---------------------------------------------------------------------------
// 공정이용 제약 — 절대 완화하지 않는다
// ---------------------------------------------------------------------------

/**
 * 소스 클립 1개당 최대 사용 길이(초).
 *
 * 원본 방법론이 공정이용 근거로 제시한 "각 영상에서 3~5초만" 을 코드로 강제한다.
 * 이 값을 올리면 근거가 무너지므로 상수로 박아두고, 렌더 단계에서 검증한다.
 */
export const MAX_CLIP_SEC = 5;

/** 클립 1개당 최소 길이(초). 너무 짧으면 뭘 보여주는지 알 수 없다. */
export const MIN_CLIP_SEC = 2.5;

/** 한 영상에 최소 몇 개의 서로 다른 소스에서 클립을 가져와야 하는가. */
export const MIN_SOURCE_COUNT = 4;

/** 한 영상에 사용할 목표 소스 개수 (원본 방법론: "다섯 개 정도가 제일 좋다"). */
export const TARGET_SOURCE_COUNT = 5;

// ---------------------------------------------------------------------------
// 산출물 규격
// ---------------------------------------------------------------------------

/**
 * 소스 클립 좌우 반전 여부.
 *
 * 표준 영상 변환이지만, 이걸 켜는 실무적 이유는 플랫폼의 중복 영상 판정을
 * 피하려는 것이다. 정책과 부딪힐 수 있는 선택이라 기본값을 끔으로 두고
 * 운영자가 환경변수로 명시적으로 켜게 한다.
 */
export const MIRROR_FOOTAGE = process.env.MIRROR_FOOTAGE === 'true';

/** 소스 확대 비율. 크롭 여백을 없애고 가장자리 워터마크를 프레임 밖으로 민다. */
export const ZOOM_FOOTAGE = Number(optionalEnv('ZOOM_FOOTAGE', '1.1'));

export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** 쇼츠 길이 하한/상한(초). 원본은 30초를 거의 넘지 않는다고 했다. */
  minDurationSec: 20,
  maxDurationSec: 55,
  /** 나레이션 목표 음량 (LUFS). 플랫폼 자동 정규화를 고려한 값. */
  targetLoudnessLufs: -14,
} as const;

// ---------------------------------------------------------------------------
// 채널 배치
// ---------------------------------------------------------------------------

export interface ChannelConfig {
  /** DB `channels.handle` 과 매칭되는 키 */
  key: string;
  platform: Platform;
  /** 이 채널이 다루는 카테고리. 원본 방법론의 "자기가 잘 아는 카테고리" 를 채널 아이덴티티로 고정 */
  category: string;
  /** 검색에 쓸 카테고리 시드 키워드 */
  seedKeywords: string[];
  /** 타입캐스트 보이스 프리셋 키 (lib/typecast.ts VOICE_PRESETS) */
  voicePreset: string;
  /** 하루에 이 채널에 올릴 개수 */
  dailyCount: number;
  /**
   * 타겟 시청층. 생략하면 플랫폼 기본값(PLATFORM_DEFAULT_AUDIENCE)을 쓴다.
   * 이 값 하나가 대본 화법, 나레이션 속도, 컷 개수, 자막 크기를 전부 바꾼다.
   */
  audience?: 'senior' | 'general';
}

/**
 * 채널 5개 × 하루 2개 = 하루 10개.
 *
 * 플랫폼을 섞어두면 같은 상품을 다뤄도 중복 콘텐츠 판정이 구조적으로 불가능하다.
 * 전부 youtube 로 바꿔도 파이프라인은 그대로 돈다 (publisher 만 갈아끼운다).
 */
export const CHANNELS: ChannelConfig[] = [
  // 틱톡을 앞에 둔다. 수익화까지 가장 빨리 닿는 채널이기 때문이다.
  // 사업자 인증만 하면 팔로워 0명부터 쇼핑 링크를 달 수 있고, 없어도 1,000명만
  // 채우면 조회수 조건이 없다. 유튜브의 "90일 내 쇼츠 300만뷰" 와 비교가 안 된다.
  // 게다가 시니어 유입이 많아 느리고 단순한 영상이 오히려 잘 먹혀 제작이 쉽다.
  {
    key: 'tt-living',
    platform: 'tiktok',
    category: '생활·수납용품',
    seedKeywords: ['생활꿀템', '살림템', '수납', '정리용품'],
    voicePreset: 'warm-female',
    dailyCount: 2,
    audience: 'senior',
  },
  {
    key: 'tt-kitchen',
    platform: 'tiktok',
    category: '주방용품',
    seedKeywords: ['주방꿀템', '주방용품', '요리도구', '주방가전'],
    voicePreset: 'calm-female',
    dailyCount: 2,
    audience: 'senior',
  },
  {
    key: 'naver-living',
    platform: 'naverclip',
    category: '생활·인테리어',
    seedKeywords: ['생활용품', '인테리어소품', '홈데코', '가성비템'],
    voicePreset: 'soft-female',
    dailyCount: 2,
    audience: 'senior',
  },
  {
    key: 'yt-gadget',
    platform: 'youtube',
    category: '가전·가젯',
    seedKeywords: ['생활가전', '캠핑용품', '차량용품', '가젯'],
    voicePreset: 'energetic-male',
    dailyCount: 2,
    audience: 'general',
  },
  {
    key: 'ig-beauty',
    platform: 'instagram',
    category: '뷰티·헬스',
    seedKeywords: ['뷰티기기', '헬스용품', '홈트', '마사지기'],
    voicePreset: 'bright-male',
    dailyCount: 2,
    audience: 'general',
  },
];

export function dailySlotCount(): number {
  return CHANNELS.reduce((sum, c) => sum + c.dailyCount, 0);
}

// ---------------------------------------------------------------------------
// 레퍼런스 발굴
// ---------------------------------------------------------------------------

/**
 * 플랫폼별로 몇 개의 레퍼런스를 수집할지.
 *
 * 샤오홍슈가 안티봇이 제일 강해서 자주 깨진다.
 *
 * 현재 제작 라인은 소싱 담당이 틱톡 인기순 하나로 상품과 레퍼런스를 동시에 물어오므로
 * 이 할당량은 쓰이지 않는다. 다중 플랫폼 발굴을 되살릴 때를 위한 값으로 남겨둔다
 * (`src/lib/scrapers/` 의 샤오홍슈·인스타 스크래퍼는 `src/probe.ts` 가 계속 점검한다).
 */
export const REFERENCE_QUOTA: Record<ReferencePlatform, number> = {
  xiaohongshu: 2,
  tiktok: 2,
  instagram: 1,
};

/** 레퍼런스 수집 시 최근 며칠 이내 게시물만 볼 것인가. */
export const REFERENCE_MAX_AGE_DAYS = 90;

/** 한 번 쓴 레퍼런스를 다시 쓰기까지의 쿨다운(일). */
export const REFERENCE_COOLDOWN_DAYS = 30;

/**
 * "터졌다" 고 인정할 최소 아웃라이어 점수 = 인게이지먼트 / 팔로워수.
 *
 * 1.0 이면 팔로워 수만큼 조회가 나왔다는 뜻. 3.0 이면 팔로워 기반이 아니라
 * 콘텐츠 자체의 힘으로 퍼졌다고 볼 수 있다.
 */
export const MIN_OUTLIER_SCORE = 3.0;

// ---------------------------------------------------------------------------
// 상품 선정
// ---------------------------------------------------------------------------

/**
 * 충동구매가 일어나는 가격대(원). 이 구간 밖은 점수에서 감점된다.
 * 너무 싸면 수수료가 안 되고, 너무 비싸면 쇼츠 한 편으로 안 팔린다.
 */
export const IMPULSE_PRICE_RANGE = { min: 10_000, max: 50_000 } as const;

/**
 * 기여도(쿠키) 기간 가중치 상한(일).
 *
 * 30일짜리가 1일짜리보다 압도적으로 유리하지만, 무한정 곱하면 기여도만
 * 긴 안 팔리는 상품이 1등이 된다. 로그 스케일로 눌러서 쓴다.
 */
export const COOKIE_DAYS_CAP = 30;

/** 같은 상품을 다시 쓰기까지의 쿨다운(일). */
export const PRODUCT_COOLDOWN_DAYS = 21;

// ---------------------------------------------------------------------------
// 배포
// ---------------------------------------------------------------------------

/**
 * 업로드 시각 랜덤 분산 창(분).
 *
 * 하루 10개를 같은 시각에 올리면 기계적 패턴이 그대로 드러난다.
 * 승인 시점부터 이 범위 안에서 흩뿌린다.
 */
export const UPLOAD_JITTER_MINUTES = { min: 15, max: 240 } as const;

// 유튜브 쇼핑 태그 승격 기준(YT_SHOPPING_SUBSCRIBER_THRESHOLD) 은 없앴다.
// 구독자 수만으로 판정하던 값인데, 실제 관문은 YPP 가입이고 쇼츠 채널엔 「90일 내
// 300만 조회」가 더 붙는다. 무엇보다 쇼핑 태그 부착에 공개 API 가 없어서, 승격되는
// 순간 링크가 안 붙는다 — 성장이 고장의 방아쇠가 되는 구조였다. 자세한 사정은
// lib/affiliate.ts 의 resolveLinkMode 주석에 있다.

// ---------------------------------------------------------------------------
// 모델
// ---------------------------------------------------------------------------

export const MODELS = {
  /** 설계도 추출·대본 — 품질이 결과물을 좌우하는 자리 */
  reasoning: optionalEnv('MODEL_REASONING', 'claude-opus-5'),
  /** 분류·클립 매칭·번역 — 양이 많고 저렴해야 하는 자리 */
  fast: optionalEnv('MODEL_FAST', 'claude-haiku-4-5-20251001'),
} as const;

// ---------------------------------------------------------------------------
// 스토리지 경로 규칙
// ---------------------------------------------------------------------------

export const STORAGE_BUCKET = optionalEnv('STORAGE_BUCKET', 'shorts');

export const storagePath = {
  asset: (runId: string, productId: string, idx: number) =>
    `${runId}/assets/${productId}/clip-${String(idx).padStart(2, '0')}.mp4`,
  narrationLine: (runId: string, scriptId: string, idx: number) =>
    `${runId}/narration/${scriptId}/line-${String(idx).padStart(2, '0')}.wav`,
  narrationFull: (runId: string, scriptId: string) => `${runId}/narration/${scriptId}/full.wav`,
  render: (runId: string, renderId: string) => `${runId}/renders/${renderId}.mp4`,
  thumb: (runId: string, renderId: string) => `${runId}/renders/${renderId}.jpg`,
};
