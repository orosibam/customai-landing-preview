import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLIP_SEC, MIN_SOURCE_COUNT, storagePath } from '../../config.js';
import { downloadTikTokVideo, findOverseasFootage } from '../../lib/scrapers/tiktok-discovery.js';
import { collectClips, downloadClip } from '../../lib/scrapers/ali1688.js';
import { probe } from '../../lib/ffmpeg.js';
import { uploadFile } from '../../lib/storage.js';
import { db, must } from '../../lib/supabase.js';
import { fail, HandoffError, withNote, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 소재 담당.
 *
 * 소싱 담당이 찾아온 한국 영상은 **소재로 쓸 수 없다.** 같은 시장의 같은 시청자에게
 * 같은 화면을 다시 보여주는 꼴이고, 원작자와 정면으로 부딪친다.
 * 그래서 상품명을 중국어로 옮겨 해외 원본을 따로 구해온다.
 *
 * 한 번에 안 걸리는 게 정상이다. 소싱 담당이 검색어 변형을 여러 개 준비해 넘기므로
 * 순서대로 시도하고, 그래도 없으면 1688 상품 상세 영상으로 내려간다.
 *
 * 2차 공급처가 타오바오가 아니라 1688 인 것은 실측 결과다 — 타오바오에서는 영상을
 * 한 건도 받지 못했고, 1688 은 상품 상세 HTML 에 영상 주소가 그대로 박혀 있어 오히려 쉽다.
 */

const CHARTER = `너는 해외 상품 영상 소재 담당이다.

한국 영상은 절대 소재로 쓰지 않는다. 중국 플랫폼의 판매자 상품 영상을 구해온다.

검색어를 만들 때: 같은 상품도 중국에서 부르는 이름이 여러 개다.
한 번에 안 걸리면 표현을 바꿔 다시 시도한다. 제품 범주를 넓혔다 좁혔다 해본다.`;

export const sourcer: TeamMember = {
  id: 'sourcer',
  role: '소재 담당',
  expertise: '중국어 검색으로 해외 원본 상품 영상을 확보한다',
  charter: CHARTER,

  async work(brief: Brief): Promise<Brief> {
    const product = brief.product;
    if (!product) throw new HandoffError('sourcer', '상품 정보가 넘어오지 않았습니다.');

    const dir = await mkdtemp(join(tmpdir(), 'footage-'));
    const localPaths: string[] = [];
    const sourceUrls: string[] = [];
    // 소재마다 출처가 다르다. 경로(route)는 전체 요약일 뿐이라 건별 기록에 쓰면
    // 섞인 실행에서 절반이 틀린 출처로 남는다.
    const sourceSites: string[] = [];
    const assetIds: string[] = [];
    let route = '틱톡 중국어 검색';

    // 1차: 틱톡에서 중국어로 검색
    const { videos, triedKeywords } = await findOverseasFootage(product.keywordsZh, 6);

    for (const [i, video] of videos.entries()) {
      const path = join(dir, `tt-${i}.mp4`);
      try {
        await downloadTikTokVideo(video.url, path);
        localPaths.push(path);
        sourceUrls.push(video.url);
        sourceSites.push('tiktok');
      } catch (e) {
        console.warn(`해외 영상 다운로드 실패 (${video.url}): ${(e as Error).message}`);
      }
    }

    // 2차: 부족하면 1688 상품 상세 영상으로 채운다.
    if (localPaths.length < MIN_SOURCE_COUNT) {
      route = localPaths.length > 0 ? '틱톡 + 1688 혼합' : '1688 상품 상세';
      try {
        const clips = await collectClips({ keywordZh: product.keywordsZh[0]! });
        for (const [i, clip] of clips.entries()) {
          if (localPaths.length >= MIN_SOURCE_COUNT + 1) break;
          const path = join(dir, `ali-${i}.mp4`);
          try {
            await downloadClip(clip.videoUrl, path);
            localPaths.push(path);
            sourceUrls.push(clip.productUrl);
            sourceSites.push('ali1688');
          } catch (e) {
            console.warn(`1688 클립 실패: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        console.warn(`1688 보강 실패: ${(e as Error).message}`);
      }
    }

    if (localPaths.length < MIN_SOURCE_COUNT) {
      throw new HandoffError(
        'sourcer',
        `"${product.titleKo}" 소재가 ${localPaths.length}개뿐입니다 (최소 ${MIN_SOURCE_COUNT}개). ` +
          `시도한 검색어: ${triedKeywords.join(', ')}. 소재가 적으면 소스당 사용 길이가 ` +
          `${MAX_CLIP_SEC}초 상한을 넘게 되어 편집이 불가능합니다.`,
        true,
      );
    }

    // 쓸 수 있는 것만 남기고 저장한다. 5초를 못 떼어낼 짧은 클립은 버린다.
    // 버린 것만큼 출처 목록도 같이 줄여야 아래 단계에서 인덱스가 어긋나지 않는다.
    const keptPaths: string[] = [];
    const keptUrls: string[] = [];
    for (const [i, path] of localPaths.entries()) {
      const info = await probe(path);
      if (info.durationSec < MAX_CLIP_SEC) {
        console.warn(`소재 ${i} 가 ${info.durationSec.toFixed(1)}초로 짧아 제외합니다.`);
        continue;
      }
      const remote = storagePath.asset(brief.runId, product.id, i);
      await uploadFile(path, remote);

      const row = await must(
        '소재 저장',
        db()
          .from('assets')
          .insert({
            product_id: product.id,
            source_url: sourceUrls[i] ?? '',
            source_site: sourceSites[i] ?? 'unknown',
            storage_path: remote,
            duration_sec: info.durationSec,
            width: info.width,
            height: info.height,
          })
          .select('id')
          .single(),
      );
      assetIds.push((row as { id: string }).id);
      keptPaths.push(path);
      keptUrls.push(sourceUrls[i] ?? '');
    }

    if (assetIds.length < MIN_SOURCE_COUNT) {
      throw new HandoffError(
        'sourcer',
        `길이 조건을 통과한 소재가 ${assetIds.length}개뿐입니다 (최소 ${MIN_SOURCE_COUNT}개).`,
        true,
      );
    }

    return withNote(
      {
        ...brief,
        footage: { assetIds, localPaths: keptPaths, sourceUrls: keptUrls, triedKeywords },
      },
      'sourcer',
      `소재 ${assetIds.length}개 확보 (${route}). 검색어 "${triedKeywords.join(' → ')}"`,
      route.includes('1688')
        ? '틱톡에서 충분히 못 구해 1688 로 보강했습니다. 화면 톤이 섞일 수 있습니다.'
        : undefined,
    );
  },

  async review(brief: Brief): Promise<ReviewResult> {
    const footage = brief.footage;
    if (!footage) return fail('소재가 비어 있습니다.');
    if (footage.assetIds.length < MIN_SOURCE_COUNT) {
      return fail(`소재 ${footage.assetIds.length}개는 최소 ${MIN_SOURCE_COUNT}개에 못 미칩니다.`);
    }

    const warnings: string[] = [];
    if (footage.assetIds.length === MIN_SOURCE_COUNT) {
      warnings.push('소재가 최소 개수라 컷 다양성이 부족할 수 있습니다.');
    }
    return { ok: true, problems: [], warnings };
  },
};
