import type { ReferencePlatform } from '../../config.js';

/**
 * 수집한 레퍼런스 한 건.
 *
 * 플랫폼마다 공개하는 지표가 달라서(샤오홍슈는 조회수를 감추는 경우가 많다)
 * 원시 지표를 그대로 들고 다니고, 아웃라이어 점수는 한 곳에서 계산한다.
 */
export interface RawReference {
  platform: ReferencePlatform;
  externalId: string;
  externalUrl: string;
  caption: string;
  views: number | null;
  likes: number | null;
  /** 샤오홍슈 수집(收藏) */
  collects: number | null;
  followerCount: number | null;
  postedAt: Date | null;
  /** 설계도 추출에 쓸 영상 파일 주소 (없으면 S3가 썸네일/캡션만으로 추론) */
  videoUrl?: string;
}

export interface ScrapeQuery {
  /** 검색어. 샤오홍슈는 중국어, 틱톡·인스타는 영문을 쓴다. */
  keyword: string;
  limit: number;
  maxAgeDays: number;
}

export interface Scraper {
  platform: ReferencePlatform;
  search(query: ScrapeQuery): Promise<RawReference[]>;
}

/**
 * 아웃라이어 점수 = 인게이지먼트 / 팔로워수.
 *
 * 팔로워가 많아서 나온 조회수는 우리가 복제할 수 없다. 팔로워 대비 몇 배가
 * 터졌는지를 봐야 "콘텐츠 자체의 힘" 을 고른 것이 된다.
 * 원본 방법론의 "레퍼런스 선정에 주관을 배제하라" 를 수식으로 옮긴 부분.
 */
export function outlierScore(ref: RawReference): number {
  const followers = ref.followerCount ?? 0;
  // 조회수가 있으면 그게 1순위. 없으면(샤오홍슈) 좋아요+수집으로 대체한다.
  const engagement = ref.views ?? (ref.likes ?? 0) + (ref.collects ?? 0);

  if (engagement <= 0) return 0;
  // 팔로워가 0이거나 못 읽은 경우: 나눌 수가 없으니 최소 기준을 적용한다.
  // 신생 계정에서 터진 것일 수 있으므로 버리지 않고 보수적인 값을 준다.
  if (followers <= 0) return engagement >= 100_000 ? 5 : 1;

  // 조회수가 아닌 좋아요 기반은 보통 조회수의 3~8% 수준이라 스케일을 맞춰준다.
  const scale = ref.views !== null ? 1 : 20;
  return (engagement * scale) / followers;
}

/** "1.2M", "34.5K", "1,234" 같은 표기를 숫자로. */
export function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.replace(/[,\s]/g, '').trim();
  const match = text.match(/^([\d.]+)\s*([KkMmBb万千])?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]?.toLowerCase()) {
    case 'k': return Math.round(value * 1_000);
    case 'm': return Math.round(value * 1_000_000);
    case 'b': return Math.round(value * 1_000_000_000);
    case '千': return Math.round(value * 1_000);
    case '万': return Math.round(value * 10_000);
    default: return Math.round(value);
  }
}
