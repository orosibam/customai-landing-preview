/**
 * 파이프라인 전역 설정.
 *
 * 여기 값들은 계획서에서 "설정 한 줄로 바꾼다"고 한 손잡이들이다.
 * 운영하면서 제일 자주 만질 곳이므로 한 파일에 모아둔다.
 */

export type Platform = 'youtube' | 'naverclip' | 'instagram' | 'tiktok';
export type ReferencePlatform = 'xiaohongshu' | 'tiktok' | 'instagram';

/** 필수 환경변수를 읽는다. 없으면 즉시 죽는다 — 파이프라인 중간에 터지는 것보다 낫다. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 없습니다. .env 또는 Actions secrets를 확인하세요.`);
  return v;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// ---------------------------------------------------------------------------
// 공정이용 제약 — 절대 완화하지 않는다
// ---------------------------------------------------------------------------

/**
 * 타오바오 클립 1개당 최대 사용 길이(초).
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
}

/**
 * 채널 5개 × 하루 2개 = 하루 10개.
 *
 * 플랫폼을 섞어두면 같은 상품을 다뤄도 중복 콘텐츠 판정이 구조적으로 불가능하다.
 * 전부 youtube 로 바꿔도 파이프라인은 그대로 돈다 (publisher 만 갈아끼운다).
 */
export const CHANNELS: ChannelConfig[] = [
  {
    key: 'yt-kitchen',
    platform: 'youtube',
    category: '주방·정리용품',
    seedKeywords: ['주방용품', '정리용품', '수납', '주방정리'],
    voicePreset: 'warm-female',
    dailyCount: 2,
  },
  {
    key: 'yt-car',
    platform: 'youtube',
    category: '차량·세차용품',
    seedKeywords: ['세차용품', '차량용품', '카샴푸', '차량정리'],
    voicePreset: 'bright-male',
    dailyCount: 2,
  },
  {
    key: 'naver-living',
    platform: 'naverclip',
    category: '생활·인테리어',
    seedKeywords: ['생활용품', '인테리어소품', '홈데코', '수납장'],
    voicePreset: 'calm-female',
    dailyCount: 2,
  },
  {
    key: 'ig-beauty',
    platform: 'instagram',
    category: '뷰티·헬스',
    seedKeywords: ['뷰티기기', '헬스용품', '홈트', '마사지기'],
    voicePreset: 'soft-female',
    dailyCount: 2,
  },
  {
    key: 'tt-gadget',
    platform: 'tiktok',
    category: '가전·가젯',
    seedKeywords: ['생활가전', '주방가전', '캠핑용품', '가젯'],
    voicePreset: 'energetic-male',
    dailyCount: 2,
  },
];

/**
 * true 면 하루 2개만 렌더해서 5개 채널에 복사한다 (렌더 비용 1/5).
 * false 면 채널마다 다른 영상을 만든다 (기본값 — 중복 판정 위험 없음).
 */
export const DUPLICATE_MODE = process.env.DUPLICATE_MODE === 'true';

export function dailySlotCount(): number {
  return CHANNELS.reduce((sum, c) => sum + c.dailyCount, 0);
}

// ---------------------------------------------------------------------------
// 레퍼런스 발굴
// ---------------------------------------------------------------------------

/**
 * 플랫폼별로 몇 개의 레퍼런스를 수집할지.
 *
 * 샤오홍슈가 안티봇이 제일 강해서 자주 깨진다. 깨지면 S2가 부족분을
 * 나머지 플랫폼으로 자동 재배분한다 (s2-find-references.ts 참고).
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

/** 유튜브 쇼핑 제휴 태그가 열리는 구독자 기준. 미만이면 인포크링크 모드. */
export const YT_SHOPPING_SUBSCRIBER_THRESHOLD = 500;

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
