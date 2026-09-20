import { askJson } from '../../lib/llm.js';
import { discoverHotVideos, SEED_KEYWORDS, type HotVideo } from '../../lib/scrapers/tiktok-discovery.js';
import {
  discoverHotVideos as discoverReels,
  tagsForCategory,
} from '../../lib/scrapers/instagram-discovery.js';
import { db, must } from '../../lib/supabase.js';
import { PRODUCT_COOLDOWN_DAYS } from '../../config.js';
import {
  fail,
  HandoffError,
  PASS,
  withNote,
  type Brief,
  type ProductCandidate,
  type ReviewResult,
  type TeamMember,
} from '../types.js';

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


/**
 * 고른 후보를 DB 에 박고 브리프에 싣는다.
 *
 * 새로 발굴했든 남겨둔 후보를 꺼냈든 이 아래는 똑같다. 남은 후보는 `shortlist` 로
 * 넘겨서, 아래에서 퇴짜가 나면 발굴 없이 다음 걸 쓸 수 있게 한다.
 */
async function commitCandidate(
  brief: Brief,
  candidate: ProductCandidate,
  rest: ProductCandidate[],
): Promise<Brief> {
  const { source } = candidate;

  const productRow = await must(
    '상품 저장',
    db()
      .from('products')
      .insert({
        merchant_id: await defaultMerchantId(),
        title_ko: candidate.productNameKo,
        title_zh: candidate.keywordsZh[0] ?? null,
        title_en: candidate.keywordEn,
        price_krw: candidate.priceKrw,
        score_reason: candidate.rationale,
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
          platform: source.platform,
          external_id: source.videoId,
          external_url: source.url,
          caption: source.caption,
          views: source.views,
          // 조회수가 있으면 조회수, 없으면 좋아요. 팔로워를 못 읽는 경우가 많아
          // 절대값을 백만 단위로 환산해 쓴다. 둘 다 없으면 0 이고, 그건
          // "지표 없이 골랐다" 는 기록으로 남는다 — 나중에 성과를 볼 때 구분된다.
          outlier_score: (source.views ?? source.likes ?? 0) / 1_000_000,
        },
        // 상품마다 자기 원본을 들고 있는다. 예전엔 (platform, external_id) 였는데,
        // 같은 해시태그를 매번 긁으니 같은 릴스가 계속 다시 나오고 그때마다
        // 앞 상품의 원본을 빼앗았다 — 소재를 12개 수확해온 뒤에 "베낄 원본이
        // 없습니다" 로 멈추는 상품이 그렇게 생겼다 (0005 참고).
        { onConflict: 'product_id,platform,external_id' },
      )
      .select('id')
      .single(),
  );

  return withNote(
    {
      ...brief,
      shortlist: rest,
      product: {
        id: (productRow as { id: string }).id,
        titleKo: candidate.productNameKo,
        keywordsZh: candidate.keywordsZh,
        keywordEn: candidate.keywordEn,
        priceKrw: candidate.priceKrw,
        rationale: candidate.rationale,
      },
      reference: {
        id: (refRow as { id: string }).id,
        url: source.url,
        platform: source.platform,
        views: source.views,
        caption: source.caption,
        outlierScore: (source.views ?? source.likes ?? 0) / 1_000_000,
      },
    },
    'scout',
    `"${candidate.productNameKo}" 선정. 원본 ` +
      `${source.views ? `${source.views.toLocaleString()}회` : source.likes ? `좋아요 ${source.likes.toLocaleString()}` : '지표 없음'}` +
      `. ${candidate.rationale}` +
      (rest.length > 0 ? ` (다음 후보 ${rest.length}건 대기)` : ''),
    candidate.keywordsZh.length < 2
      ? '중국어 검색어 변형이 하나뿐이라 소재 담당이 못 찾을 수 있습니다.'
      : undefined,
  );
}

/**
 * DB 에 이미 있는 상품으로 브리프를 채운다.
 *
 * 레퍼런스(설계도 원본)도 같이 꺼낸다 — 없으면 설계도 담당이 무엇을 베낄지 모른다.
 * 상품은 있는데 레퍼런스가 없으면 그 사실을 적어 던진다. 조용히 빈 값으로 넘기면
 * 뒤에서 이유 없이 이상한 구조가 나온다.
 */
async function usePinnedProduct(brief: Brief, needle: string): Promise<Brief> {
  const rows = await must(
    '지정 상품 조회',
    db()
      .from('products')
      .select('id, title_ko, title_zh, title_en, price_krw, score_reason')
      .or(`title_ko.ilike.%${needle}%,title_zh.ilike.%${needle}%`)
      .order('picked_at', { ascending: false })
      .limit(5),
  );

  const found = rows as {
    id: string;
    title_ko: string;
    title_zh: string | null;
    title_en: string | null;
    price_krw: number | null;
    score_reason: string | null;
  }[];

  if (found.length === 0) {
    throw new HandoffError('scout', `"${needle}" 로 찾히는 상품이 DB 에 없습니다.`);
  }

  // 여러 개가 맞으면 추측하지 않는다. 엉뚱한 상품으로 영상을 만드는 것보다
  // 멈추고 어느 것인지 묻는 게 낫다.
  const exact = found.filter(
    (r) => r.title_ko === needle || r.title_zh === needle,
  );
  const picked = exact[0] ?? (found.length === 1 ? found[0] : undefined);
  if (!picked) {
    throw new HandoffError(
      'scout',
      `"${needle}" 에 맞는 상품이 ${found.length}건입니다. 더 정확히 적어주세요:\n` +
        found.map((r) => `     · ${r.title_ko} (${r.title_zh ?? '-'})`).join('\n'),
    );
  }

  const refRows = await must(
    '지정 상품의 레퍼런스 조회',
    db()
      .from('references')
      .select('id, external_url, platform, views, caption, outlier_score')
      .eq('product_id', picked.id)
      .order('created_at', { ascending: false })
      .limit(1),
  );
  const ref = (refRows as {
    id: string;
    external_url: string;
    platform: string;
    views: number | null;
    caption: string | null;
    outlier_score: number | null;
  }[])[0];

  if (!ref) {
    throw new HandoffError(
      'scout',
      `"${picked.title_ko}" 에 붙은 레퍼런스 영상이 없습니다. ` +
        `설계도를 뽑을 원본이 없으면 구조를 베낄 수가 없습니다.`,
    );
  }

  console.log(`지정 상품으로 갑니다: "${picked.title_ko}" (발굴 건너뜀)`);

  return withNote(
    {
      ...brief,
      shortlist: [],
      product: {
        id: picked.id,
        titleKo: picked.title_ko,
        // 수확 매칭은 **정확한 문자열**이라, DB 에 저장된 값을 그대로 쓴다.
        keywordsZh: picked.title_zh ? [picked.title_zh] : [],
        ...(picked.title_en ? { keywordEn: picked.title_en } : {}),
        priceKrw: picked.price_krw,
        rationale: picked.score_reason ?? '(지정 상품)',
      },
      reference: {
        id: ref.id,
        url: ref.external_url,
        platform: ref.platform,
        views: ref.views,
        caption: ref.caption ?? '',
        outlierScore: ref.outlier_score ?? 0,
      },
    },
    'scout',
    `지정 상품 "${picked.title_ko}" 로 진행합니다 (발굴 건너뜀).`,
  );
}

export const scout: TeamMember = {
  id: 'scout',
  role: '소싱 담당',
  expertise: '해외 인스타 릴스에서 이미 터진 상품과 그 영상을 찾아낸다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    // "이 제품으로 만들어라" — 발굴을 통째로 건너뛴다.
    //
    // 소재를 사람이 수확하게 되면서 필요해졌다. 수확물은 특정 상품의 검색어에
    // 묶여 있는데 발굴은 매번 새 상품을 고르므로, 그대로 두면 모아둔 소재가
    // 영영 안 쓰인다.
    if (brief.pinnedProduct) {
      return usePinnedProduct(brief, brief.pinnedProduct);
    }

    // 아래에서 퇴짜가 나 다시 온 경우. 발굴을 처음부터 하지 않는다 —
    // 인스타 탐색이 한 번에 2분 반이라, 후보 하나 떨어질 때마다 다시 긁으면
    // 재시도라는 게 사실상 불가능해진다. 지난번에 남겨둔 후보를 꺼낸다.
    const queued = brief.shortlist?.[0];
    if (queued) {
      console.log(`남겨둔 후보에서 "${queued.productNameKo}" 로 갑니다 (재발굴 없음).`);
      return commitCandidate(brief, queued, brief.shortlist!.slice(1));
    }

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
올릴 상품 후보를 **좋은 순서대로 3개** 고른다.

여러 개를 고르는 이유: 다음 담당자가 "이 물건이 한국에서 팔리는가" 를 확인하는데,
거기서 떨어지면 1순위를 버리고 2순위로 간다. 후보가 하나뿐이면 그 자리에서 제작이
통째로 멈춘다. 1순위만 성의껏 쓰고 나머지를 대충 채우지 마라 — 2·3순위가 실제로
쓰이는 날이 온다.

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
${
  (brief.rejected?.length ?? 0) > 0
    ? `\n이번 실행에서 아래 담당자가 이미 퇴짜 놓은 것(같은 이유로 떨어질 것들도 피해라):\n` +
      brief.rejected!.map((r) => `- ${r.titleKo}: ${r.reason}`).join('\n') +
      '\n'
    : ''
}
고른 영상에서 상품을 특정하고 다음을 채워라:
- product_name_ko: 상품을 부르는 한국어 이름 (예: "무타공 전동커튼", "수세미 거치대")
- keywords_zh: 이 상품을 중국 플랫폼에서 검색할 **중국어 간체 키워드 3~4개**.
  한 번에 안 걸리는 경우가 많으므로 표현을 달리한 변형을 준비한다.
  (예: 떡 만드는 기계 → ["打糕机","家用年糕机","糯米打糕机"])
- keyword_en: 영문 검색어 1개
- estimated_price_krw: 추정 가격. 모르면 null.
- rationale: 왜 이 상품인지 + 영상으로 뭘 보여줄 것인지 한 문장

picks 는 **3개**, 좋은 순서대로.
{"picks":[{"video_url":"...","product_name_ko":"...","keywords_zh":[],"keyword_en":"...","estimated_price_krw":0,"rationale":"..."}]}`,
      { tier: 'reasoning', system: CHARTER, maxTokens: 2000 },
    );

    if (picked.picks.length === 0) {
      throw new HandoffError('scout', '상품을 고르지 못했습니다.', true);
    }

    // 후보를 전부 들고 간다. 1순위가 아래에서 떨어지면 2순위로 다시 돈다.
    const candidates: ProductCandidate[] = picked.picks.map((pick) => {
      const source = hot.find((v) => v.url === pick.video_url) ?? hot[0]!;
      return {
        productNameKo: pick.product_name_ko,
        keywordsZh: pick.keywords_zh,
        keywordEn: pick.keyword_en,
        priceKrw: pick.estimated_price_krw,
        rationale: pick.rationale,
        source: {
          url: source.url,
          videoId: source.videoId,
          caption: source.caption,
          views: source.views,
          likes: source.likes,
          platform: discoverySource,
        },
      };
    });

    if (candidates.length === 1) {
      console.warn(
        '후보가 하나뿐입니다. 아래에서 퇴짜가 나면 이 건은 재발굴 없이 멈춥니다.',
      );
    }

    return commitCandidate(brief, candidates[0]!, candidates.slice(1));
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
