import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPLOAD_JITTER_MINUTES } from '../config.js';
import { buildDescription, buildPinnedComment, resolveLinkMode, trackedUrl } from '../lib/affiliate.js';
import { publisherFor } from '../lib/publishers/index.js';
import { downloadFile } from '../lib/storage.js';
import { db, must } from '../lib/supabase.js';

/**
 * S9 — 배포 + 링크
 *
 * 승인된 렌더만 처리한다. 승인 게이트를 통과하지 않은 건 절대 올라가지 않는다 —
 * 그게 "딸깍 자동 업로드" 와 선을 긋는 지점이다.
 *
 * 업로드 시각은 승인 시점부터 흩뿌린다. 하루 10개를 같은 분에 올리면
 * 기계적 패턴이 그대로 드러난다.
 */

interface ApprovedRender {
  id: string;
  storage_path: string;
  thumb_path: string;
  channel_id: string;
  channels: {
    key: string;
    platform: string;
    category: string;
    credentials_ref: string;
    subscriber_count: number;
  };
  narrations: {
    scripts: {
      cta: string;
      blueprint_id: string;
      products: {
        title_ko: string;
        product_url: string | null;
        merchants: { platform: string };
      };
    };
  };
}

/** 승인 시각 기준으로 흩뿌린 예약 시각. */
export function jitteredSchedule(base: Date = new Date()): Date {
  const { min, max } = UPLOAD_JITTER_MINUTES;
  const minutes = min + Math.random() * (max - min);
  return new Date(base.getTime() + minutes * 60_000);
}

export async function publish(runId: string): Promise<void> {
  const rows = await must(
    '승인된 렌더 조회',
    db()
      .from('renders')
      .select(
        `id, storage_path, thumb_path, channel_id,
         channels!inner(key, platform, category, credentials_ref, subscriber_count),
         narrations!inner(scripts!inner(cta, blueprint_id,
           products!inner(title_ko, product_url, merchants!inner(platform))))`,
      )
      .eq('run_id', runId)
      .eq('approval_status', 'approved'),
  );

  const approved = rows as unknown as ApprovedRender[];
  if (approved.length === 0) {
    console.log('S9: 승인된 렌더가 없습니다. 대시보드에서 승인이 필요합니다.');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  let succeeded = 0;

  for (const render of approved) {
    const channel = render.channels;
    const product = render.narrations.scripts.products;
    const publisher = publisherFor(channel.platform);

    const linkMode = resolveLinkMode(channel.platform, channel.subscriber_count);
    const destination = product.product_url ?? '';
    const linkUrl = trackedUrl(destination, {
      renderId: render.id,
      channelKey: channel.key,
      blueprintId: render.narrations.scripts.blueprint_id,
    });

    const hashtags = ['쇼츠', '쇼핑', channel.category.replace(/[·\s]/g, '')];
    const scheduledAt = jitteredSchedule();

    try {
      const videoPath = await downloadFile(render.storage_path, join(dir, `${render.id}.mp4`));
      const thumbPath = await downloadFile(render.thumb_path, join(dir, `${render.id}.jpg`));

      const result = await publisher.publish({
        videoPath,
        thumbPath,
        title: product.title_ko.slice(0, 80),
        description: buildDescription(
          { productTitle: product.title_ko, productUrl: destination, merchantPlatform: product.merchants.platform },
          linkUrl,
          hashtags,
        ),
        hashtags,
        scheduledAt,
        credentialsRef: channel.credentials_ref,
      });

      const upload = await must(
        '업로드 기록',
        db()
          .from('uploads')
          .upsert(
            {
              render_id: render.id,
              channel_id: render.channel_id,
              external_id: result.externalId,
              external_url: result.externalUrl,
              scheduled_at: scheduledAt.toISOString(),
              link_status: 'pending',
              link_url: linkUrl,
            },
            { onConflict: 'render_id,channel_id' },
          )
          .select('id')
          .single(),
      );

      // 링크 부착은 따로 실패할 수 있다. 업로드는 성공했으므로 기록은 남기고
      // 링크만 수동 작업으로 넘긴다.
      try {
        await publisher.attachLink({
          externalId: result.externalId,
          linkMode,
          linkUrl,
          pinnedComment: buildPinnedComment(linkUrl),
          productUrl: destination,
          credentialsRef: channel.credentials_ref,
        });
        await db().from('uploads').update({ link_status: 'attached' }).eq('id', (upload as { id: string }).id);
      } catch (e) {
        const message = (e as Error).message;
        console.warn(`${channel.key}: 링크 부착 실패 → 수동 작업으로 큐잉. ${message}`);
        await db()
          .from('uploads')
          .update({ link_status: 'manual_required', link_error: message })
          .eq('id', (upload as { id: string }).id);
      }

      succeeded++;
      console.log(`S9: ${channel.key} 업로드 완료 — ${result.externalUrl} (예약 ${scheduledAt.toLocaleString('ko-KR')})`);
    } catch (e) {
      const message = (e as Error).message;
      console.error(`S9: ${channel.key} 업로드 실패 — ${message}`);
      await db().from('channels').update({ blocked_reason: message }).eq('id', render.channel_id);
    }
  }

  await db()
    .from('runs')
    .update({ status: succeeded > 0 ? 'published' : 'failed', finished_at: new Date().toISOString() })
    .eq('id', runId);

  console.log(`S9: ${succeeded}/${approved.length}건 배포 완료`);
}
