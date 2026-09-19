import {
  CHANNELS,
  COOKIE_DAYS_CAP,
  IMPULSE_PRICE_RANGE,
  PRODUCT_COOLDOWN_DAYS,
  type ChannelConfig,
} from '../config.js';
import { db, must } from '../lib/supabase.js';
import { askJson } from '../lib/llm.js';

/**
 * S1 — 상품 선정
 *
 * 채널 5개 × 하루 2개 = 10개 슬롯을 채운다. "될 만한 걸 아무거나" 가 아니라
 * 점수로 고른다. 원본 방법론이 "레퍼런스 선정에 주관을 배제하라" 고 한 원칙을
 * 상품 선정에도 그대로 적용한 것이다.
 *
 * 핵심 수식:
 *   점수 = 수수료율 × log(기여도기간) × 수요신호 × 충동구매 가격 적합도 × 쿨다운
 *
 * 기여도(쿠키) 기간이 곱으로 들어가는 게 이 단계의 전부다. 쿠팡 3%/1일 과
 * 30%/30일 짜리는 기대수익 자릿수가 다른데, 수수료율만 보면 그걸 놓친다.
 */

export interface MerchantRow {
  id: string;
  name: string;
  platform: string;
  commission_rate: number;
  cookie_days: number;
}

export interface ProductRow {
  id: string;
  merchant_id: string;
  title_ko: string;
  title_zh: string | null;
  title_en: string | null;
  price_krw: number | null;
  score: number | null;
  score_reason: string | null;
  picked_at: string | null;
}

export interface Slot {
  channel: ChannelConfig;
  product: ProductRow;
  merchant: MerchantRow;
}

/**
 * 기여도 기간 가중치.
 *
 * 선형으로 곱하면 "기여도만 길고 안 팔리는 상품" 이 1등이 된다.
 * 로그로 눌러서 30일이 1일의 약 4배가 되게 한다 — 크지만 압도적이지는 않게.
 */
export function cookieWeight(cookieDays: number): number {
  const capped = Math.min(Math.max(cookieDays, 1), COOKIE_DAYS_CAP);
  return 1 + Math.log2(capped);
}

/** 충동구매 가격대 적합도. 구간 안이면 1.0, 벗어나면 완만하게 감점. */
export function priceFit(priceKrw: number | null): number {
  if (priceKrw === null) return 0.7;
  const { min, max } = IMPULSE_PRICE_RANGE;
  if (priceKrw >= min && priceKrw <= max) return 1.0;
  if (priceKrw < min) return Math.max(0.3, priceKrw / min);
  return Math.max(0.3, max / priceKrw);
}

export interface ScoreInput {
  commissionRate: number;
  cookieDays: number;
  priceKrw: number | null;
  /** 네이버 데이터랩 등에서 온 수요 신호. 1.0 이 평균. */
  demandSignal: number;
  /** 최근에 쓴 상품이면 0에 가깝게. */
  cooldownFactor: number;
}

export function scoreProduct(input: ScoreInput): number {
  return (
    input.commissionRate *
    cookieWeight(input.cookieDays) *
    input.demandSignal *
    priceFit(input.priceKrw) *
    input.cooldownFactor
  );
}

/** 마지막 사용일로부터 며칠 지났는지에 따른 감점 계수. */
export function cooldownFactor(pickedAt: string | null): number {
  if (!pickedAt) return 1.0;
  const days = (Date.now() - new Date(pickedAt).getTime()) / 86_400_000;
  if (days >= PRODUCT_COOLDOWN_DAYS) return 1.0;
  return Math.max(0, days / PRODUCT_COOLDOWN_DAYS);
}

interface Candidate {
  product: ProductRow;
  merchant: MerchantRow;
  score: number;
}

/**
 * 채널 카테고리에 맞는 후보를 점수순으로 가져온다.
 *
 * 수요 신호는 지금은 1.0 고정이다. S10이 성과를 쌓으면 카테고리별 가중치로
 * 대체된다 — 그때까지는 수수료 × 기여도 × 가격대만으로도 충분히 유효하다.
 */
async function rankCandidates(channel: ChannelConfig): Promise<Candidate[]> {
  const rows = await must(
    '상품 후보 조회',
    db()
      .from('products')
      .select('*, merchants!inner(id,name,platform,commission_rate,cookie_days)')
      .or(channel.seedKeywords.map((k) => `title_ko.ilike.%${k}%`).join(','))
      .limit(200),
  );

  type Joined = ProductRow & { merchants: MerchantRow };

  return (rows as Joined[])
    .map((row) => {
      const { merchants, ...product } = row;
      return {
        product: product as ProductRow,
        merchant: merchants,
        score: scoreProduct({
          commissionRate: merchants.commission_rate,
          cookieDays: merchants.cookie_days,
          priceKrw: product.price_krw,
          demandSignal: 1.0,
          cooldownFactor: cooldownFactor(product.picked_at),
        }),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

interface PickResponse {
  picks: { product_id: string; reason: string; title_zh: string; title_en: string }[];
}

/**
 * 상위 후보 중에서 LLM이 최종 선정한다.
 *
 * 점수는 "팔릴 확률" 은 알려주지만 "영상으로 만들었을 때 볼만한가" 는 모른다.
 * 비슷한 점수대에서 시각적으로 보여줄 게 있는 상품을 고르는 게 LLM의 몫이다.
 * 선정 이유를 텍스트로 남겨야 나중에 왜 틀렸는지 복기할 수 있다.
 *
 * 중국어·영문 표기도 여기서 같이 만든다. 중국어는 S2(샤오홍슈 검색)와
 * S4(타오바오 검색)가, 영문은 S2(틱톡·인스타 검색)가 재사용한다.
 */
async function llmPick(channel: ChannelConfig, candidates: Candidate[]): Promise<PickResponse> {
  const shortlist = candidates.slice(0, 15).map((c) => ({
    product_id: c.product.id,
    title: c.product.title_ko,
    price_krw: c.product.price_krw,
    merchant: c.merchant.name,
    commission_rate: c.merchant.commission_rate,
    cookie_days: c.merchant.cookie_days,
    score: Number(c.score.toFixed(4)),
  }));

  return askJson<PickResponse>(
    `채널 "${channel.key}" (카테고리: ${channel.category}) 에 올릴 쇼핑 쇼츠 ${channel.dailyCount}개를 만들려고 한다.
아래는 점수순 후보다. score 는 수수료율 × 기여도기간 가중치 × 가격대 적합도로 계산된 값이다.

${JSON.stringify(shortlist, null, 2)}

이 중에서 ${channel.dailyCount}개를 골라라. 판단 기준:
1. score 가 높을수록 좋지만 절대 기준은 아니다.
2. 30초 세로 영상으로 "보여줄 게 있는" 상품이어야 한다. 변화가 눈에 보이는 것(before/after),
   동작이 있는 것, 크기·질감이 드러나는 것이 유리하다. 설명해야만 이해되는 상품은 불리하다.
3. 같은 채널에 올라가므로 서로 겹치지 않는 상품을 골라라.

각 상품에 대해:
- reason: 왜 골랐는지, 특히 "영상으로 뭘 보여줄 것인지" 를 한 문장으로.
- title_zh: 타오바오·샤오홍슈에서 검색할 중국어 상품명 (간체, 검색에 실제로 쓰이는 표현)
- title_en: 틱톡·인스타에서 검색할 영문 키워드

{"picks":[{"product_id":"...","reason":"...","title_zh":"...","title_en":"..."}]}`,
    { tier: 'reasoning' },
  );
}

export async function pickProducts(runId: string): Promise<Slot[]> {
  const slots: Slot[] = [];

  for (const channel of CHANNELS) {
    const candidates = await rankCandidates(channel);
    if (candidates.length === 0) {
      throw new Error(
        `채널 ${channel.key} (${channel.category}) 의 상품 후보가 없습니다. ` +
          `merchants/products 카탈로그가 비어 있거나 seedKeywords 가 맞지 않습니다.`,
      );
    }

    const picked = await llmPick(channel, candidates);
    const byId = new Map(candidates.map((c) => [c.product.id, c]));

    for (const pick of picked.picks.slice(0, channel.dailyCount)) {
      const candidate = byId.get(pick.product_id);
      if (!candidate) {
        console.warn(`LLM이 후보에 없는 상품을 골랐습니다: ${pick.product_id} — 건너뜁니다.`);
        continue;
      }

      await db()
        .from('products')
        .update({
          title_zh: pick.title_zh,
          title_en: pick.title_en,
          score: candidate.score,
          score_reason: pick.reason,
          picked_at: new Date().toISOString(),
        })
        .eq('id', candidate.product.id);

      slots.push({
        channel,
        merchant: candidate.merchant,
        product: {
          ...candidate.product,
          title_zh: pick.title_zh,
          title_en: pick.title_en,
          score: candidate.score,
          score_reason: pick.reason,
        },
      });
    }
  }

  console.log(`S1: ${slots.length}개 슬롯 확정 (run ${runId})`);
  for (const s of slots) {
    console.log(`  ${s.channel.key}: ${s.product.title_ko} — ${s.product.score_reason}`);
  }
  return slots;
}
