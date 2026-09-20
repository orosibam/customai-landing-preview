import { askJson } from '../../lib/llm.js';
import { discoverHotVideos, SEED_KEYWORDS, type HotVideo } from '../../lib/scrapers/tiktok-discovery.js';
import {
  discoverHotVideos as discoverReels,
  tagsForCategory,
} from '../../lib/scrapers/instagram-discovery.js';
import { db, must } from '../../lib/supabase.js';
import { PRODUCT_COOLDOWN_DAYS } from '../../config.js';
import { fail, HandoffError, PASS, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 소싱 담당.
 *
 * 앞선 설계는 상품을 먼저 정하고 레퍼런스를 나중에 찾았다. 틱톡 쇼핑은 순서가 반대다.
 * "꿀템" 같은 시드로 제품 리뷰 채널을 찾아 **인기순**으로 보면, 터진 영상 목록이
 * 곧 잘 팔리는 상품 목록이다. 조회수 하나가 상품 검증과 크리에이티브 검증을
 * 동시에 해주기 때문에 이 순서가 훨씬 빠르고 정확하다.
 *
 * 그래서 이 담당자는 상품과 설계도 원본을 한 번에 물어온다.
 */

const CHARTER = `너는 쇼핑 숏폼의 상품 소싱 담당이다.

너의 유일한 판단 기준은 **이미 터진 영상인가** 이다. 네 취향이나 상품에 대한
감상은 개입시키지 않는다. 시장의 반응이 답이고, 너는 그 답을 읽을 뿐이다.

상품을 고를 때 보는 것:
1. 반응 — 조회수가 있으면 조회수, 없으면 좋아요를 본다. 둘 다 없으면 그 자리는
   비어 있는 것이니 아래 2~4번으로만 판단해라. 없는 숫자를 있다고 가정하지 마라.
2. 영상으로 보여줄 게 있는가 — 변화가 눈에 보이거나(before/after), 동작이 있거나,
   크기·질감이 드러나는 상품이 유리하다. 말로 설명해야만 이해되는 상품은 불리하다.
3. 해외에 같은 상품 영상이 있을 법한가 — 중국 제조 생활용품이면 거의 있다.
   국내 브랜드 전용 상품이나 식품은 원본을 못 구한다.
4. 가격대 — 충동구매가 일어나는 구간이어야 한다. 너무 싸면 수수료가 안 되고,
   너무 비싸면 30초 영상 하나로는 안 팔린다.

고르지 않는 것: 의약품, 건강기능식품, 의료기기. 효능을 단언해야 팔리는데
그 단언이 광고 심의에 걸린다.`;

interface PickResponse {
  picks: {
    video_url: string;
    product_name_ko: string;
    keywords_zh: string[];
    keyword_en: string;
    estimated_price_krw: number | null;
    rationale: string;
  }[];
}

async function recentlyUsed(): Promise<Set<string>> {
  const since = new Date(Date.now() - PRODUCT_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data } = await db().from('products').select('title_ko').gte('picked_at', since);
  return new Set(((data ?? []) as { title_ko: string }[]).map((r) => r.title_ko));
}

export const scout: TeamMember = {
  id: 'scout',
  role: '소싱 담당',
  expertise: '해외 인스타 릴스에서 이미 터진 상품과 그 영상을 찾아낸다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const used = await recentlyUsed();

    let hot: HotVideo[] = [];
    const tried: string[] = [];
    let discoverySource: 'instagram' | 'tiktok' = 'instagram';

    // 1차: 인스타 릴스.
    //
    // 틱톡이 두 겹으로 막혔다 — 러너에서 로그인 없이 게시물 목록을 안 내주고
    // (실측: 스크롤 12회에 0건), 사용자 쪽 로그인도 횟수 제한에 걸려 있다.
    //
    // 시드는 **영문 해시태그**다. 「꿀템」 같은 한국어로 찾으면 이미 한국에 들어온
    // 것만 나오고, 그러면 "해외에서 터졌지만 아직 안 들어온 포맷" 이라는 전제가
    // 성립하지 않는다.
    for (const tag of tagsForCategory(brief.channel.category)) {
      tried.push(`#${tag}`);
      try {
        hot.push(...(await discoverReels(tag, { limit: 10 })));
        if (hot.length >= 12) break;
      } catch (e) {
        console.warn(`#${tag} 탐색 실패: ${(e as Error).message}`);
      }
    }

    // 2차: 인스타가 안 되면 틱톡으로 내려간다. 지금은 대개 0건이지만,
    // 세션이 붙으면 살아나므로 경로를 지우지는 않는다.
    if (hot.length === 0) {
      discoverySource = 'tiktok';
      for (const seed of [...brief.channel.seedKeywords, ...SEED_KEYWORDS]) {
        tried.push(seed);
        try {
          hot.push(...(await discoverHotVideos(seed, { channelLimit: 3, perChannel: 6 })));
          if (hot.length >= 12) break;
        } catch (e) {
          console.warn(`시드 "${seed}" 탐색 실패: ${(e as Error).message}`);
        }
      }
    }

    if (hot.length === 0) {
      throw new HandoffError(
        'scout',
        `인스타·틱톡 양쪽에서 아무것도 못 찾았습니다. 시도: ${tried.join(', ')}.\n` +
          `   인스타 해시태그는 **비로그인**이 더 잘 됩니다(실측). 세션은 폴백일 뿐입니다.\n` +
          `   위 로그에 경로별로 무엇이 보였는지 찍혀 있으니 거기부터 보세요.`,
        true,
      );
    }

    console.log(`${discoverySource === 'instagram' ? '인스타 릴스' : '틱톡'} 에서 후보 ${hot.length}건 확보 (시도: ${tried.join(', ')})`);

    // 중복 제거 + 반응순.
    //
    // 조회수로 정렬하고 싶지만 **비로그인 인스타는 조회수를 안 싣는다**(실측:
    // 릴스 페이지의 숫자 키가 전부 oz_www_playback_speed_* 같은 플레이어 설정값이고
    // 조회수 계열이 하나도 없다). 전부 null 인 값으로 정렬하면 순서가 사실상
    // 무작위인데 "인기순으로 골랐다" 는 착각만 남는다.
    //
    // 그래서 조회수가 있으면 그걸로, 없으면 좋아요로 정렬한다. 좋아요는 조회수보다
    // 약한 신호지만 "이 릴스가 반응을 얻었나" 는 답한다.
    const seen = new Set<string>();
    hot = hot
      .filter((v) => v.videoId && !seen.has(v.videoId) && seen.add(v.videoId))
      .sort((a, b) => (b.views ?? b.likes ?? 0) - (a.views ?? a.likes ?? 0))
      .slice(0, 20);

    const withMetric = hot.filter((v) => (v.views ?? v.likes ?? 0) > 0).length;
    if (withMetric === 0) {
      // 지표가 하나도 없으면 "이미 터진 것만 고른다" 가 성립하지 않는다.
      // 그 사실을 숨기지 않는다 — 경고 없이 돌면 매일 무작위로 고르게 된다.
      console.warn(
        `후보 ${hot.length}건 전부 조회수·좋아요를 못 읽었습니다. ` +
          `이번 선정은 "터진 것" 이 아니라 해시태그 노출 순서에 가깝습니다.`,
      );
    }

    const picked = await askJson<PickResponse>(
      `채널 "${brief.channel.key}" (카테고리: ${brief.channel.category}, 타겟: ${brief.audience.label})에
올릴 상품 1개를 고른다.

아래는 ${discoverySource === 'instagram' ? '인스타그램 해시태그' : '틱톡 인기순'} 에서 긁어온 해외 영상들이다.
${
  withMetric === 0
    ? '⚠️ 이번엔 조회수·좋아요를 하나도 못 읽었다. "터진 것" 이라는 근거가 없으니\n캡션과 제품 자체의 영상화 적합도로만 판단해라.'
    : '조회수가 없으면 좋아요를 봐라. 둘 다 0 이거나 없는 건 지표를 못 읽은 것이지\n반응이 없었다는 뜻이 아니다.'
}

${JSON.stringify(
  hot.map((v) => ({ url: v.url, caption: v.caption, views: v.views, likes: v.likes })),
  null,
  2,
)}

최근 ${PRODUCT_COOLDOWN_DAYS}일 안에 이미 쓴 상품(다시 고르지 말 것):
${[...used].join(', ') || '(없음)'}

고른 영상에서 상품을 특정하고 다음을 채워라:
- product_name_ko: 상품을 부르는 한국어 이름 (예: "무타공 전동커튼", "수세미 거치대")
- keywords_zh: 이 상품을 중국 플랫폼에서 검색할 **중국어 간체 키워드 3~4개**.
  한 번에 안 걸리는 경우가 많으므로 표현을 달리한 변형을 준비한다.
  (예: 떡 만드는 기계 → ["打糕机","家用年糕机","糯米打糕机"])
- keyword_en: 영문 검색어 1개
- estimated_price_krw: 추정 가격. 모르면 null.
- rationale: 왜 이 상품인지 + 영상으로 뭘 보여줄 것인지 한 문장

{"picks":[{"video_url":"...","product_name_ko":"...","keywords_zh":[],"keyword_en":"...","estimated_price_krw":0,"rationale":"..."}]}`,
      { tier: 'reasoning', system: CHARTER, maxTokens: 2000 },
    );

    const pick = picked.picks[0];
    if (!pick) throw new HandoffError('scout', '상품을 고르지 못했습니다.', true);

    const source = hot.find((v) => v.url === pick.video_url) ?? hot[0]!;

    const productRow = await must(
      '상품 저장',
      db()
        .from('products')
        .insert({
          merchant_id: await defaultMerchantId(),
          title_ko: pick.product_name_ko,
          title_zh: pick.keywords_zh[0] ?? null,
          title_en: pick.keyword_en,
          price_krw: pick.estimated_price_krw,
          score_reason: pick.rationale,
          picked_at: new Date().toISOString(),
        })
        .select('id')
        .single(),
    );

    const refRow = await must(
      '레퍼런스 저장',
      db()
        .from('references')
        .upsert(
          {
            product_id: (productRow as { id: string }).id,
            // 실제로 어디서 찾았는지 그대로 적는다. 예전엔 'tiktok' 으로 박혀 있어서
            // 인스타에서 온 레퍼런스도 틱톡으로 기록됐다 — 나중에 "어느 플랫폼의
            // 설계도가 잘 먹혔나" 를 집계할 때 그 숫자가 통째로 틀린다.
            platform: discoverySource,
            external_id: source.videoId,
            external_url: source.url,
            caption: source.caption,
            views: source.views,
            // 조회수가 있으면 조회수, 없으면 좋아요. 팔로워를 못 읽는 경우가 많아
            // 절대값을 백만 단위로 환산해 쓴다. 둘 다 없으면 0 이고, 그건
            // "지표 없이 골랐다" 는 기록으로 남는다 — 나중에 성과를 볼 때 구분된다.
            outlier_score: (source.views ?? source.likes ?? 0) / 1_000_000,
          },
          { onConflict: 'platform,external_id' },
        )
        .select('id')
        .single(),
    );

    return withNote(
      {
        ...brief,
        product: {
          id: (productRow as { id: string }).id,
          titleKo: pick.product_name_ko,
          keywordsZh: pick.keywords_zh,
          keywordEn: pick.keyword_en,
          priceKrw: pick.estimated_price_krw,
          rationale: pick.rationale,
        },
        reference: {
          id: (refRow as { id: string }).id,
          url: source.url,
          platform: discoverySource,
          views: source.views,
          caption: source.caption,
          outlierScore: (source.views ?? source.likes ?? 0) / 1_000_000,
        },
      },
      'scout',
      `"${pick.product_name_ko}" 선정. 원본 ` +
        `${source.views ? `${source.views.toLocaleString()}회` : source.likes ? `좋아요 ${source.likes.toLocaleString()}` : '지표 없음'}` +
        `. ${pick.rationale}`,
      pick.keywords_zh.length < 2
        ? '중국어 검색어 변형이 하나뿐이라 소재 담당이 못 찾을 수 있습니다.'
        : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    if (!brief.product) return fail('상품이 비어 있습니다.');
    if (!brief.reference) return fail('레퍼런스가 비어 있습니다.');
    if (brief.product.keywordsZh.length === 0) {
      return fail('중국어 검색어가 없습니다. 소재를 구할 방법이 없어집니다.');
    }

    const warnings: string[] = [];
    if (brief.reference.outlierScore === 0) {
      warnings.push(
        '원본의 조회수·좋아요를 둘 다 못 읽었습니다. "이미 터진 것" 이라는 근거가 없는 선정입니다.',
      );
    } else if ((brief.reference.views ?? 0) === 0) {
      warnings.push('조회수를 못 읽어 좋아요로 대체했습니다. 검증 강도가 조회수보다 약합니다.');
    }
    return { ok: true, problems: [], warnings };
  },
};

/** 기본 제휴사(쿠팡파트너스) 행을 찾거나 만든다. */
async function defaultMerchantId(): Promise<string> {
  const existing = await db()
    .from('merchants')
    .select('id')
    .eq('platform', 'coupang')
    .eq('name', '쿠팡파트너스')
    .maybeSingle();
  if (existing.data) return existing.data.id as string;

  const created = await must(
    '제휴사 생성',
    db()
      .from('merchants')
      .insert({
        name: '쿠팡파트너스',
        platform: 'coupang',
        commission_rate: 0.03,
        // 쿠팡은 기여도 1일. 클릭 후 24시간 안에 산 것만 수수료가 잡힌다.
        cookie_days: 1,
      })
      .select('id')
      .single(),
  );
  return (created as { id: string }).id;
}
