import { db, must } from '../lib/supabase.js';

/**
 * S10 — 성과 수집
 *
 * 이 루프가 닫혀야 "알아서 잘 되는" 공장이 된다. 없으면 매일 10개를 뱉는
 * 랜덤 생성기일 뿐이다.
 *
 * 수집한 값이 답하는 질문 두 가지:
 *   1) 어떤 플랫폼의 설계도가 실제로 돈이 됐는가 → REFERENCE_QUOTA 조정 근거
 *   2) 기여도 기간이 긴 제휴사가 정말 더 벌었는가 → COOKIE_DAYS_CAP 조정 근거
 *
 * 두 질문의 답은 blueprint_performance / cookie_window_performance 뷰가 낸다.
 */

interface UploadRow {
  id: string;
  external_id: string;
  published_at: string | null;
  channels: { platform: string; credentials_ref: string };
}

export interface DailyMetric {
  uploadId: string;
  views: number;
  impressions: number;
  /** 첫 3초 이탈률. 훅 품질의 직접 지표. */
  retention3s: number | null;
  clicks: number;
  conversions: number;
  revenueKrw: number;
}

/** 최근 N일간 올라간 것들의 지표를 갱신한다. */
export async function collectMetrics(lookbackDays = 14): Promise<void> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const rows = await must(
    '업로드 조회',
    db()
      .from('uploads')
      .select('id, external_id, published_at, channels!inner(platform, credentials_ref)')
      .not('external_id', 'is', null)
      .gte('created_at', since),
  );

  const uploads = rows as unknown as UploadRow[];
  const today = new Date().toISOString().slice(0, 10);
  let collected = 0;

  for (const upload of uploads) {
    try {
      const metric = await fetchPlatformMetric(upload);
      const affiliate = await fetchAffiliateMetric(upload.id);

      await db().from('metrics').upsert(
        {
          upload_id: upload.id,
          metric_date: today,
          views: metric.views,
          impressions: metric.impressions,
          retention_3s: metric.retention3s,
          clicks: affiliate.clicks,
          conversions: affiliate.conversions,
          revenue_krw: affiliate.revenueKrw,
        },
        { onConflict: 'upload_id,metric_date' },
      );
      collected++;
    } catch (e) {
      console.warn(`지표 수집 실패 (${upload.external_id}): ${(e as Error).message}`);
    }
  }

  console.log(`S10: ${collected}/${uploads.length}건 지표 갱신`);
  await reportFeedback();
}

/**
 * 플랫폼 조회 지표.
 *
 * 유튜브만 Analytics API 로 첫 3초 이탈률까지 받을 수 있다. 나머지 플랫폼은
 * 조회수 정도만 긁어와야 하므로 retention3s 가 null 이 된다.
 */
async function fetchPlatformMetric(upload: UploadRow): Promise<{
  views: number;
  impressions: number;
  retention3s: number | null;
}> {
  if (upload.channels.platform !== 'youtube') {
    // Phase 3에서 플랫폼별 수집을 붙인다. 지금은 0으로 두고 제휴 수익만 본다.
    return { views: 0, impressions: 0, retention3s: null };
  }
  // Phase 3: YouTube Analytics API (reports.query) 로 교체.
  // audienceWatchRatio 로 첫 3초 유지율을 계산한다.
  return { views: 0, impressions: 0, retention3s: null };
}

/** 제휴 리포트(인포크링크/텐핑/쿠팡파트너스) 또는 자체 리다이렉터 로그. */
async function fetchAffiliateMetric(_uploadId: string): Promise<{
  clicks: number;
  conversions: number;
  revenueKrw: number;
}> {
  // Phase 3: 자체 리다이렉터 로그가 클릭을, 제휴사 리포트 API가 전환·수익을 준다.
  return { clicks: 0, conversions: 0, revenueKrw: 0 };
}

/** 피드백 뷰를 읽어 콘솔에 요약한다. 쿼터 조정의 근거가 되는 숫자들. */
async function reportFeedback(): Promise<void> {
  const { data: byPlatform } = await db()
    .from('blueprint_performance')
    .select('*')
    .order('revenue_per_video', { ascending: false })
    .limit(10);

  if (byPlatform && byPlatform.length > 0) {
    console.log('\n설계도 출처별 성과 (영상당 수익 순):');
    for (const r of byPlatform as Record<string, unknown>[]) {
      console.log(
        `  ${r.reference_platform} / ${r.hook_type}: ` +
          `${r.render_count}편, 영상당 ${Number(r.revenue_per_video ?? 0).toLocaleString()}원`,
      );
    }
  }

  const { data: byCookie } = await db()
    .from('cookie_window_performance')
    .select('*')
    .order('revenue_per_upload', { ascending: false });

  if (byCookie && byCookie.length > 0) {
    console.log('\n기여도 기간별 성과:');
    for (const r of byCookie as Record<string, unknown>[]) {
      console.log(
        `  ${r.cookie_bucket}: ${r.upload_count}건, ` +
          `건당 ${Number(r.revenue_per_upload ?? 0).toLocaleString()}원`,
      );
    }
  }
}
