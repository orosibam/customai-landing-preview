import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPLOAD_JITTER_MINUTES } from '../../config.js';
import { buildDescription, buildPinnedComment, resolveLinkMode, trackedUrl } from '../../lib/affiliate.js';
import { publisherFor } from '../../lib/publishers/index.js';
import { downloadFile } from '../../lib/storage.js';
import { db, must } from '../../lib/supabase.js';
import { fail, type Brief, type ReviewResult, type TeamMember } from '../types.js';

/**
 * 유통 담당.
 *
 * 승인된 것만 내보낸다. 승인 게이트를 통과하지 않은 건 이 담당자에게 넘어오지도 않는다.
 *
 * 업로드 시각은 승인 시점부터 흩뿌린다. 하루 10개를 같은 분에 올리면
 * 기계가 돌리고 있다는 게 그대로 드러난다.
 */

export interface PublishTarget {
  renderId: string;
  channelId: string;
  channelKey: string;
  platform: string;
  category: string;
  credentialsRef: string;
  subscriberCount: number;
  storagePath: string;
  thumbPath: string;
  productTitle: string;
  productUrl: string;
  blueprintId: string;
}

export function jitteredSchedule(base: Date = new Date()): Date {
  const { min, max } = UPLOAD_JITTER_MINUTES;
  return new Date(base.getTime() + (min + Math.random() * (max - min)) * 60_000);
}

/**
 * 승인된 렌더를 모아 배포한다.
 *
 * 이 담당자만 예외적으로 Brief 단위가 아니라 실행(run) 단위로 일한다.
 * 승인은 사람이 나중에 한꺼번에 누르기 때문이다.
 */
export async function publishApproved(runId: string): Promise<{ ok: number; failed: number }> {
  const rows = await must(
    '승인된 렌더 조회',
    db()
      .from('renders')
      .select(
        `id, storage_path, thumb_path, channel_id,
         channels!inner(key, platform, category, credentials_ref, subscriber_count),
         narrations!inner(scripts!inner(blueprint_id,
           products!inner(title_ko, product_url)))`,
      )
      .eq('run_id', runId)
      .eq('approval_status', 'approved'),
  );

  type Row = {
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
    narrations: { scripts: { blueprint_id: string; products: { title_ko: string; product_url: string | null } } };
  };

  const approved = rows as unknown as Row[];
  if (approved.length === 0) {
    console.log('유통 담당: 승인된 건이 없습니다.');
    return { ok: 0, failed: 0 };
  }

  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  let ok = 0;
  let failed = 0;

  for (const row of approved) {
    const channel = row.channels;
    const product = row.narrations.scripts.products;
    const publisher = publisherFor(channel.platform);

    const linkMode = resolveLinkMode(channel.platform, channel.subscriber_count);
    const destination = product.product_url ?? '';
    const linkUrl = trackedUrl(destination, {
      renderId: row.id,
      channelKey: channel.key,
      blueprintId: row.narrations.scripts.blueprint_id,
    });

    const hashtags = ['꿀템', '쇼핑', channel.category.replace(/[·\s]/g, '')];
    const scheduledAt = jitteredSchedule();

    try {
      const videoPath = await downloadFile(row.storage_path, join(dir, `${row.id}.mp4`));
      const thumbPath = await downloadFile(row.thumb_path, join(dir, `${row.id}.jpg`));

      const result = await publisher.publish({
        videoPath,
        thumbPath,
        title: product.title_ko.slice(0, 80),
        description: buildDescription(
          { productTitle: product.title_ko, productUrl: destination, merchantPlatform: channel.platform },
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
              render_id: row.id,
              channel_id: row.channel_id,
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

      // 링크 부착은 따로 실패할 수 있다. 업로드는 성공했으니 기록은 남기고
      // 링크만 수동 작업으로 넘긴다. 조용히 넘어가면 수익이 0인 영상이 쌓인다.
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

      ok++;
      console.log(`유통 담당: ${channel.key} 완료 — ${result.externalUrl} (예약 ${scheduledAt.toLocaleString('ko-KR')})`);
    } catch (e) {
      failed++;
      const message = (e as Error).message;
      console.error(`유통 담당: ${channel.key} 실패 — ${message}`);
      await db().from('channels').update({ blocked_reason: message }).eq('id', row.channel_id);
    }
  }

  return { ok, failed };
}

export const publisher: TeamMember = {
  id: 'publisher',
  role: '유통 담당',
  expertise: '승인된 영상을 플랫폼에 올리고 제휴 링크를 붙인다',
  charter:
    '너는 유통 담당이다. 승인되지 않은 것은 절대 내보내지 않는다. ' +
    '링크가 안 붙은 영상은 수익이 0이므로, 링크 실패는 반드시 사람에게 알린다.',

  // 배포는 승인 이후에 별도로 돌기 때문에 지시서 단계에서는 아무것도 하지 않는다.
  async work(brief: Brief): Promise<Brief> {
    return brief;
  },

  async review(brief: Brief): Promise<ReviewResult> {
    if (!brief.render) return fail('배포할 렌더가 없습니다.');
    return { ok: true, problems: [], warnings: [] };
  },
};
