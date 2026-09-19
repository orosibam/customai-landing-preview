import {
  MIN_OUTLIER_SCORE,
  REFERENCE_COOLDOWN_DAYS,
  REFERENCE_MAX_AGE_DAYS,
  REFERENCE_QUOTA,
  type ReferencePlatform,
} from '../config.js';
import { db, must } from '../lib/supabase.js';
import { outlierScore, type RawReference, type Scraper } from '../lib/scrapers/types.js';
import { tiktokScraper } from '../lib/scrapers/tiktok.js';
import { instagramScraper } from '../lib/scrapers/instagram.js';
import { xiaohongshuScraper } from '../lib/scrapers/xiaohongshu.js';
import type { Slot } from './s1-pick-products.js';

/**
 * S2 — 터진 릴스 발굴
 *
 * 샤오홍슈·틱톡·인스타에서 해당 상품으로 이미 터진 숏폼을 찾는다.
 * 여기서 고른 것의 '구조' 만 가져다 쓴다 — 픽셀은 S4의 타오바오 클립이 채운다.
 *
 * 세 플랫폼 중 샤오홍슈가 가장 자주 깨진다. 깨졌을 때 조용히 적게 가져오면
 * 파이프라인이 설계도 없이 진행되므로, 부족분을 살아있는 플랫폼으로 재배분한다.
 */

const SCRAPERS: Record<ReferencePlatform, Scraper> = {
  xiaohongshu: xiaohongshuScraper,
  tiktok: tiktokScraper,
  instagram: instagramScraper,
};

/** 플랫폼별 검색어. 샤오홍슈는 중국어, 나머지는 영문. */
function keywordFor(platform: ReferencePlatform, slot: Slot): string {
  if (platform === 'xiaohongshu') return slot.product.title_zh ?? slot.product.title_ko;
  return slot.product.title_en ?? slot.product.title_ko;
}

export interface StoredReference {
  id: string;
  platform: ReferencePlatform;
  external_url: string;
  caption: string;
  outlier_score: number;
  video_url?: string;
}

/** 최근에 이미 쓴 레퍼런스인지. 같은 설계도를 연달아 쓰면 채널이 단조로워진다. */
async function isOnCooldown(platform: string, externalId: string): Promise<boolean> {
  const { data } = await db()
    .from('references')
    .select('used_at')
    .eq('platform', platform)
    .eq('external_id', externalId)
    .maybeSingle();

  if (!data?.used_at) return false;
  const days = (Date.now() - new Date(data.used_at as string).getTime()) / 86_400_000;
  return days < REFERENCE_COOLDOWN_DAYS;
}

function isRecentEnough(ref: RawReference): boolean {
  if (!ref.postedAt) return true; // 날짜를 못 읽은 건 버리지 않는다 (샤오홍슈가 흔히 그렇다)
  const days = (Date.now() - ref.postedAt.getTime()) / 86_400_000;
  return days <= REFERENCE_MAX_AGE_DAYS;
}

/**
 * 한 슬롯에 대한 레퍼런스를 모은다.
 *
 * 쿼터대로 돌되, 실패한 플랫폼의 몫은 남은 플랫폼에 넘긴다.
 * 어느 플랫폼이 왜 실패했는지는 반드시 로그에 남긴다 — 조용한 실패가 제일 나쁘다.
 */
export async function findReferences(slot: Slot): Promise<StoredReference[]> {
  const platforms = Object.keys(REFERENCE_QUOTA) as ReferencePlatform[];
  const collected: RawReference[] = [];
  const failures: string[] = [];
  let carryOver = 0;

  for (const platform of platforms) {
    const want = REFERENCE_QUOTA[platform] + carryOver;
    if (want <= 0) continue;

    try {
      const found = await SCRAPERS[platform].search({
        keyword: keywordFor(platform, slot),
        // 필터링으로 떨어질 것을 감안해 넉넉히 가져온다.
        limit: want * 4,
        maxAgeDays: REFERENCE_MAX_AGE_DAYS,
      });

      const usable: RawReference[] = [];
      for (const ref of found) {
        if (usable.length >= want) break;
        if (!isRecentEnough(ref)) continue;
        if (outlierScore(ref) < MIN_OUTLIER_SCORE) continue;
        if (await isOnCooldown(ref.platform, ref.externalId)) continue;
        usable.push(ref);
      }

      collected.push(...usable);
      carryOver = want - usable.length;
      if (carryOver > 0) {
        console.warn(`${platform}: ${want}개 중 ${usable.length}개만 기준 통과 → ${carryOver}개 이월`);
      }
    } catch (e) {
      failures.push(`${platform}: ${(e as Error).message}`);
      carryOver = want;
      console.warn(`${platform} 수집 실패 → ${want}개를 다음 플랫폼으로 이월: ${(e as Error).message}`);
    }
  }

  if (collected.length === 0) {
    throw new Error(
      `"${slot.product.title_ko}" 의 레퍼런스를 하나도 못 찾았습니다.\n` +
        (failures.length > 0 ? `실패 내역:\n  ${failures.join('\n  ')}` : '기준(아웃라이어 점수)을 통과한 게 없습니다.'),
    );
  }

  // 점수 높은 순으로 저장. S3는 이 중 1등의 구조를 뜯는다.
  collected.sort((a, b) => outlierScore(b) - outlierScore(a));

  const stored: StoredReference[] = [];
  for (const ref of collected) {
    const row = await must(
      '레퍼런스 저장',
      db()
        .from('references')
        .upsert(
          {
            product_id: slot.product.id,
            platform: ref.platform,
            external_id: ref.externalId,
            external_url: ref.externalUrl,
            caption: ref.caption,
            views: ref.views,
            likes: ref.likes,
            collects: ref.collects,
            follower_count: ref.followerCount,
            outlier_score: outlierScore(ref),
            posted_at: ref.postedAt?.toISOString() ?? null,
          },
          { onConflict: 'platform,external_id' },
        )
        .select('id')
        .single(),
    );

    stored.push({
      id: (row as { id: string }).id,
      platform: ref.platform,
      external_url: ref.externalUrl,
      caption: ref.caption,
      outlier_score: outlierScore(ref),
      ...(ref.videoUrl ? { video_url: ref.videoUrl } : {}),
    });
  }

  console.log(
    `S2: "${slot.product.title_ko}" 레퍼런스 ${stored.length}건 ` +
      `(${stored.map((s) => `${s.platform} ${s.outlier_score.toFixed(1)}x`).join(', ')})`,
  );
  return stored;
}
