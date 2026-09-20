import { db } from '../../lib/supabase.js';
import type { Brief, ReviewResult, TeamMember } from '../types.js';

/**
 * 성장 분석.
 *
 * 나머지 담당자들이 오늘 것을 만든다면, 이 담당자는 **내일 것을 더 잘 만들게** 한다.
 * 이 자리가 비면 공장은 매일 10개를 뱉는 난수 발생기일 뿐이다.
 *
 * 답해야 할 질문 두 가지:
 *   1. 어떤 훅 유형이 실제로 돈이 됐는가 → 분석가가 어떤 설계도를 고를지
 *   2. 기여도 기간이 긴 제휴사가 정말 더 벌었는가 → 소싱 담당이 어떤 상품을 고를지
 */

export interface GrowthReport {
  byHook: { hookType: string; renders: number; revenuePerVideo: number }[];
  byCookieWindow: { bucket: string; uploads: number; revenuePerUpload: number }[];
  linkFailures: number;
  blockedChannels: { key: string; reason: string }[];
}

export async function collectMetrics(lookbackDays = 14): Promise<void> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const { data } = await db()
    .from('uploads')
    .select('id, external_id, channels!inner(platform)')
    .not('external_id', 'is', null)
    .gte('created_at', since);

  const uploads = (data ?? []) as unknown as { id: string; external_id: string }[];
  const today = new Date().toISOString().slice(0, 10);

  // 플랫폼별 지표 수집은 Phase 3에서 붙인다. 지금은 리다이렉터가 기록한 클릭만
  // 이미 metrics 에 들어와 있으므로, 행이 없는 업로드만 0으로 만들어 둔다.
  for (const upload of uploads) {
    await db()
      .from('metrics')
      .upsert({ upload_id: upload.id, metric_date: today }, { onConflict: 'upload_id,metric_date' });
  }

  console.log(`성장 분석: ${uploads.length}건 지표 행 확인`);
}

export async function buildReport(): Promise<GrowthReport> {
  const { data: hooks } = await db()
    .from('blueprint_performance')
    .select('*')
    .order('revenue_per_video', { ascending: false })
    .limit(10);

  const { data: cookies } = await db()
    .from('cookie_window_performance')
    .select('*')
    .order('revenue_per_upload', { ascending: false });

  const { count: linkFailures } = await db()
    .from('uploads')
    .select('id', { count: 'exact', head: true })
    .eq('link_status', 'manual_required');

  const { data: blocked } = await db()
    .from('channels')
    .select('key, blocked_reason')
    .not('blocked_reason', 'is', null);

  return {
    byHook: ((hooks ?? []) as Record<string, unknown>[]).map((r) => ({
      hookType: String(r.hook_type ?? '-'),
      renders: Number(r.render_count ?? 0),
      revenuePerVideo: Number(r.revenue_per_video ?? 0),
    })),
    byCookieWindow: ((cookies ?? []) as Record<string, unknown>[]).map((r) => ({
      bucket: String(r.cookie_bucket ?? '-'),
      uploads: Number(r.upload_count ?? 0),
      revenuePerUpload: Number(r.revenue_per_upload ?? 0),
    })),
    linkFailures: linkFailures ?? 0,
    blockedChannels: ((blocked ?? []) as { key: string; blocked_reason: string }[]).map((c) => ({
      key: c.key,
      reason: c.blocked_reason,
    })),
  };
}

/** 사람이 아침에 읽을 한 덩어리 요약. */
export function formatReport(report: GrowthReport): string {
  const lines: string[] = [];

  if (report.byHook.length > 0) {
    lines.push('훅 유형별 성과 (영상당 수익 순)');
    for (const h of report.byHook) {
      lines.push(`  ${h.hookType}: ${h.renders}편, 영상당 ${Math.round(h.revenuePerVideo).toLocaleString()}원`);
    }
  }

  if (report.byCookieWindow.length > 0) {
    lines.push('', '기여도 기간별 성과');
    for (const c of report.byCookieWindow) {
      lines.push(`  ${c.bucket}: ${c.uploads}건, 건당 ${Math.round(c.revenuePerUpload).toLocaleString()}원`);
    }
  }

  if (report.linkFailures > 0) {
    lines.push('', `⚠ 링크가 안 붙은 영상 ${report.linkFailures}건 — 수익이 0입니다. 대시보드에서 처리하세요.`);
  }

  for (const c of report.blockedChannels) {
    lines.push(`⚠ ${c.key} 중단됨: ${c.reason}`);
  }

  return lines.join('\n') || '아직 집계할 데이터가 없습니다.';
}

export const growth: TeamMember = {
  id: 'growth',
  role: '성장 분석',
  expertise: '성과를 집계해 내일의 상품·설계도 선택을 조정한다',
  charter:
    '너는 성장 분석 담당이다. 조회수가 아니라 수익으로 판단한다. ' +
    '조회수는 많은데 수익이 없는 포맷은 성공이 아니라 실패다.',

  // 성과 수집은 배포 이후 며칠에 걸쳐 일어난다. 지시서 단계에서는 관여하지 않는다.
  async work(brief: Brief): Promise<Brief> {
    return brief;
  },

  async review(): Promise<ReviewResult> {
    return { ok: true, problems: [], warnings: [] };
  },
};
