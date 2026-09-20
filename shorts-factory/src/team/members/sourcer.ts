import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOOTAGE_POOL_SIZE, MAX_CLIP_SEC, MIN_SOURCE_COUNT, storagePath } from '../../config.js';
import { downloadTikTokVideo, findOverseasFootage } from '../../lib/scrapers/tiktok-discovery.js';
import { collectClips, downloadClip } from '../../lib/scrapers/aliexpress.js';
import { collect1688Clips, collectTaobaoClips, downloadCnClip } from '../../lib/scrapers/cn-footage.js';
import { searchPlan } from '../../lib/scrapers/keywords.js';
import { probe } from '../../lib/ffmpeg.js';
import { uploadFile } from '../../lib/storage.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 소재 담당.
 *
 * 소싱 담당이 찾아온 한국 영상은 **소재로 쓸 수 없다.** 같은 시장의 같은 시청자에게
 * 같은 화면을 다시 보여주는 꼴이고, 원작자와 정면으로 부딪친다.
 * 그래서 상품명을 중국어·영어로 옮겨 해외 원본을 따로 구해온다.
 *
 * ## 공급처를 넷으로 늘렸다
 *
 * 알리 하나로 돌다가 **두 번 막혔고 원인이 서로 달랐다** — 2차 제작은 속도 제한,
 * 5차 제작은 상품 7건 전부 영상 0개. 다른 단계는 전부 폴백이 있는데(인스타↔틱톡,
 * 쿠팡→다나와) 소재만 없어서 거기가 재채기하면 그날 공장이 섰다.
 *
 *   ① 알리익스프레스  영문 검색   — 해외向이라 데이터센터 IP 에서도 열린다(실측)
 *   ② 1688            중국어 검색 — 모바일 검색이 data-offer-id 로 상품 id 를 싣는다
 *   ③ 타오바오        중국어 검색 — 상세 로그인 벽 여부를 세어 기록한다
 *   ④ 틱톡            중국어 검색 — 판매자 영상이 아니라 실사용 영상이라 결이 다르다
 *
 * 순서는 실측 신뢰도 순이다. **앞이 실패해도 받아둔 건 버리지 않는다** — 공급처마다
 * 풀에 쌓고, 풀이 찼으면 멈춘다. 부족 판정은 넷을 다 돌아본 뒤 한 번만 한다.
 *
 * ## 검색어가 좁으면 먼저 넓힌다
 *
 * 5차 제작의 "mini portable massage gun" 은 검색 결과가 7건이었다. 풀 12개를
 * 채우려면 서른 건 넘게 훑어야 하는데 7건이면 구조적으로 불가능하다. 그래서
 * 공급처마다 원래 검색어 → 넓힌 검색어 순으로 시도한다(`searchPlan`).
 */

const CHARTER = `너는 해외 상품 영상 소재 담당이다.

한국 영상은 절대 소재로 쓰지 않는다. 중국 플랫폼의 판매자 상품 영상을 구해온다.

검색어를 만들 때: 같은 상품도 중국에서 부르는 이름이 여러 개다.
한 번에 안 걸리면 표현을 바꿔 다시 시도한다. 제품 범주를 넓혔다 좁혔다 해본다.`;

/** 풀에 쌓이는 소재 한 건. 어디서 왔는지를 건별로 들고 다닌다. */
interface PoolItem {
  videoUrl: string;
  productUrl: string;
  /** assets.source_site 에 그대로 들어간다. 요약이 아니라 건별 사실이어야 한다. */
  site: string;
  referer: string;
}

/** 공급처 하나. 검색어 목록과 수집·다운로드 방법을 함께 들고 있다. */
interface Supplier {
  label: string;
  site: string;
  keywords: string[];
  collect(keyword: string, want: number): Promise<{ items: PoolItem[]; note: string }>;
  download(item: PoolItem, outPath: string): Promise<void>;
}

export const sourcer: TeamMember = {
  id: 'sourcer',
  role: '소재 담당',
  expertise: '중국어·영문 검색으로 해외 원본 상품 영상을 확보한다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const product = brief.product;
    if (!product) throw new HandoffError('sourcer', '상품 정보가 넘어오지 않았습니다.');

    const dir = await mkdtemp(join(tmpdir(), 'footage-'));

    const pool: { path: string; item: PoolItem }[] = [];
    const seenVideos = new Set<string>();
    const triedKeywords: string[] = [];
    /** 공급처별로 무엇을 하다 무엇을 얻었는지. 성공도 실패도 여기에 남는다. */
    const journal: string[] = [];
    /** 실제로 소재를 준 공급처. 요약 문구는 여기서 만든다 — 추측하지 않는다. */
    const gaveFootage = new Set<string>();

    const suppliers: Supplier[] = [
      {
        label: '알리익스프레스',
        site: 'aliexpress',
        keywords: searchPlan([product.keywordEn]),
        async collect(keyword, want) {
          const res = await collectClips({ keyword, limit: want });
          return {
            items: res.clips.map((c) => ({
              videoUrl: c.videoUrl,
              productUrl: c.productUrl,
              site: 'aliexpress',
              referer: 'https://www.aliexpress.com/',
            })),
            note: res.note,
          };
        },
        download: (item, path) => downloadClip(item.videoUrl, path),
      },
      {
        label: '1688',
        site: 'ali1688',
        keywords: searchPlan(product.keywordsZh),
        async collect(keyword, want) {
          const res = await collect1688Clips(keyword, want);
          return {
            items: res.clips.map((c) => ({
              videoUrl: c.videoUrl,
              productUrl: c.productUrl,
              site: c.site,
              referer: c.referer,
            })),
            note: res.note,
          };
        },
        download: downloadCnClip,
      },
      {
        label: '타오바오',
        site: 'taobao',
        keywords: searchPlan(product.keywordsZh),
        async collect(keyword, want) {
          const res = await collectTaobaoClips(keyword, want);
          return {
            items: res.clips.map((c) => ({
              videoUrl: c.videoUrl,
              productUrl: c.productUrl,
              site: c.site,
              referer: c.referer,
            })),
            note: res.note,
          };
        },
        download: downloadCnClip,
      },
      {
        // 틱톡은 지금 러너에서 대개 0건이다(로그인 없이 목록을 안 내준다). 그래도
        // 남겨둔다 — 세션이 붙으면 그대로 살아나고, 여기서 걸리는 건 판매자
        // 상품영상이 아니라 실사용 영상이라 화면의 결이 다르다.
        label: '틱톡',
        site: 'tiktok',
        keywords: ['(중국어 검색어 묶음)'],
        async collect(_keyword, want) {
          const { videos, triedKeywords: zhTried } = await findOverseasFootage(
            product.keywordsZh,
            want,
          );
          triedKeywords.push(...zhTried);
          return {
            items: videos.map((v) => ({
              videoUrl: v.url,
              productUrl: v.url,
              site: 'tiktok',
              referer: 'https://www.tiktok.com/',
            })),
            note: `틱톡: 영상 ${videos.length}건`,
          };
        },
        download: (item, path) => downloadTikTokVideo(item.videoUrl, path),
      },
    ];

    for (const supplier of suppliers) {
      if (pool.length >= FOOTAGE_POOL_SIZE) break;
      if (supplier.keywords.length === 0) {
        journal.push(`${supplier.label}: 검색어가 없어 건너뜀`);
        continue;
      }

      for (const keyword of supplier.keywords) {
        if (pool.length >= FOOTAGE_POOL_SIZE) break;
        if (supplier.site !== 'tiktok') triedKeywords.push(keyword);

        try {
          const { items, note } = await supplier.collect(keyword, FOOTAGE_POOL_SIZE - pool.length);
          journal.push(note);

          for (const item of items) {
            if (pool.length >= FOOTAGE_POOL_SIZE) break;
            // 판매자가 달라도 같은 소재 영상을 쓰는 경우가 있다. 같은 파일을 두 번
            // 받으면 편집자에게는 선택지가 는 것처럼 보이는데 실제로는 같은 화면이다.
            if (seenVideos.has(item.videoUrl)) continue;
            seenVideos.add(item.videoUrl);

            const path = join(dir, `${supplier.site}-${pool.length}.mp4`);
            try {
              await supplier.download(item, path);
              pool.push({ path, item });
              gaveFootage.add(supplier.label);
            } catch (e) {
              console.warn(`${supplier.label} 클립 실패: ${(e as Error).message}`);
            }
          }
        } catch (e) {
          // 한 공급처가 막힌 건 치명적이지 않다 — 다음 공급처가 있다. 다만 조용히
          // 넘기지는 않는다. 넷이 전부 막혔을 때 아래 예외가 이 기록을 그대로 싣는다.
          const reason = (e as Error).message.split('\n')[0] ?? '';
          journal.push(`${supplier.label} "${keyword}" 실패: ${reason}`);
          console.warn(`${supplier.label} 수집 실패 (${keyword}): ${reason}`);
        }
      }
    }

    // 개수가 아니라 **서로 다른 상품 수**로 센다.
    //
    // 한 상품 페이지에서 뽑은 두 영상은 같은 판매자가 같은 날 찍은 촬영본이라 각도도
    // 동작도 비슷하다. 그걸 서로 다른 소스로 세면 "다양한 소재를 확보했다" 는 판정이
    // 거짓이 되고, 무엇보다 소스당 사용 길이가 길어져 MAX_CLIP_SEC 상한에 걸린다.
    // 알리 수집기 안에 있던 판정을 풀 전체로 옮기면서 이 기준도 같이 가져왔다.
    const distinctProducts = new Set(pool.map((e) => e.item.productUrl)).size;

    if (distinctProducts < MIN_SOURCE_COUNT) {
      throw new HandoffError(
        'sourcer',
        `"${product.titleKo}" 소재가 영상 ${pool.length}개 / 서로 다른 상품 ${distinctProducts}곳뿐입니다 ` +
          `(서로 다른 상품 최소 ${MIN_SOURCE_COUNT}곳 필요).\n` +
          `   공급처 ${suppliers.length}곳을 모두 돌았습니다:\n` +
          journal.map((j) => `     · ${j}`).join('\n') +
          `\n   소재가 적으면 소스당 사용 길이가 ${MAX_CLIP_SEC}초 상한을 넘게 되어 편집이 불가능합니다.`,
        true,
      );
    }

    // 쓸 수 있는 것만 남기고 저장한다. 5초를 못 떼어낼 짧은 클립은 버린다.
    const assetIds: string[] = [];
    const keptPaths: string[] = [];
    const keptUrls: string[] = [];

    for (const [i, entry] of pool.entries()) {
      const info = await probe(entry.path);
      if (info.durationSec < MAX_CLIP_SEC) {
        console.warn(`소재 ${i} 가 ${info.durationSec.toFixed(1)}초로 짧아 제외합니다.`);
        continue;
      }
      const remote = storagePath.asset(brief.runId, product.id, i);
      await uploadFile(entry.path, remote);

      const row = await must(
        '소재 저장',
        db()
          .from('assets')
          .insert({
            product_id: product.id,
            source_url: entry.item.productUrl,
            source_site: entry.item.site,
            storage_path: remote,
            duration_sec: info.durationSec,
            width: info.width,
            height: info.height,
          })
          .select('id')
          .single(),
      );
      assetIds.push((row as { id: string }).id);
      keptPaths.push(entry.path);
      keptUrls.push(entry.item.productUrl);
    }

    const keptProducts = new Set(keptUrls).size;
    if (keptProducts < MIN_SOURCE_COUNT) {
      throw new HandoffError(
        'sourcer',
        `길이 조건(${MAX_CLIP_SEC}초 이상)을 통과한 소재가 영상 ${assetIds.length}개 / ` +
          `서로 다른 상품 ${keptProducts}곳뿐입니다 (받은 건 ${pool.length}개, ` +
          `서로 다른 상품 최소 ${MIN_SOURCE_COUNT}곳 필요).`,
        true,
      );
    }

    // 경로 이름을 추측하지 않는다. 실제로 소재를 준 곳만 적는다 —
    // 예전엔 "알리 + 틱톡 혼합" 같은 문구를 조건문으로 지어냈고, 섞인 실행에서
    // 절반이 틀린 출처로 남았다.
    const route = [...gaveFootage].join(' + ');

    return withNote(
      {
        ...brief,
        footage: { assetIds, localPaths: keptPaths, sourceUrls: keptUrls, triedKeywords },
      },
      'sourcer',
      `소재 ${assetIds.length}개 확보 (${route}). 검색어 "${triedKeywords.join(' → ')}"`,
      gaveFootage.size > 1
        ? `공급처 ${gaveFootage.size}곳이 섞였습니다 (${route}). 화면 톤이 달라질 수 있습니다.`
        : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const footage = brief.footage;
    if (!footage) return fail('소재가 비어 있습니다.');

    // work() 와 같은 기준으로 센다. 여기서 개수만 보면 한 상품에서 뽑은 네 영상이
    // 통과하는데, 그건 같은 화면 네 번이라 컷을 짜깁기할 수가 없다.
    const distinctProducts = new Set(footage.sourceUrls).size;
    if (distinctProducts < MIN_SOURCE_COUNT) {
      return fail(
        `서로 다른 상품 ${distinctProducts}곳(영상 ${footage.assetIds.length}개)은 ` +
          `최소 ${MIN_SOURCE_COUNT}곳에 못 미칩니다.`,
      );
    }

    const warnings: string[] = [];
    if (distinctProducts === MIN_SOURCE_COUNT) {
      warnings.push('출처가 최소 개수라 컷 다양성이 부족할 수 있습니다.');
    }
    return { ok: true, problems: [], warnings };
  },
};
