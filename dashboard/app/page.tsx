import { db, signedUrl } from '@/lib/supabase';
import { approveAll, decide } from './actions';

export const dynamic = 'force-dynamic';

interface RenderRow {
  id: string;
  run_id: string;
  storage_path: string;
  thumb_path: string | null;
  duration_sec: number;
  qc_passed: boolean;
  qc_notes: string[];
  approval_status: string;
  channels: { key: string; platform: string; category: string; subscriber_count: number };
  narrations: {
    total_duration_sec: number;
    source_mode: string;
    scripts: {
      cta: string;
      lines: { text: string }[];
      products: { title_ko: string; price_krw: number | null; score_reason: string | null };
      blueprints: { hook_type: string; appeal_order: string[]; references: { platform: string; outlier_score: number } };
    };
  };
}

async function loadQueue(): Promise<{ runId: string | null; runDate: string | null; rows: RenderRow[] }> {
  const { data: run } = await db()
    .from('runs')
    .select('id, run_date')
    .in('status', ['awaiting_approval', 'running'])
    .order('run_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) return { runId: null, runDate: null, rows: [] };

  const { data } = await db()
    .from('renders')
    .select(
      `id, run_id, storage_path, thumb_path, duration_sec, qc_passed, qc_notes, approval_status,
       channels!inner(key, platform, category, subscriber_count),
       narrations!inner(total_duration_sec, source_mode,
         scripts!inner(cta, lines,
           products!inner(title_ko, price_krw, score_reason),
           blueprints!inner(hook_type, appeal_order, references!inner(platform, outlier_score))))`,
    )
    .eq('run_id', run.id)
    .order('created_at', { ascending: true });

  return {
    runId: run.id as string,
    runDate: run.run_date as string,
    rows: (data ?? []) as unknown as RenderRow[],
  };
}

export default async function Page() {
  const { runId, runDate, rows } = await loadQueue();
  const pending = rows.filter((r) => r.approval_status === 'pending');
  const cleanPending = pending.filter((r) => r.qc_passed);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '32px 16px 96px' }}>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>쇼핑쇼츠 승인</h1>
        <p style={{ color: '#9aa0ab', margin: '8px 0 0', fontSize: 14 }}>
          {runDate ? `${runDate} · 전체 ${rows.length}개 · 대기 ${pending.length}개` : '대기 중인 실행이 없습니다.'}
        </p>
      </header>

      {runId && cleanPending.length > 0 && (
        <form action={approveAll.bind(null, runId)} style={{ marginBottom: 24 }}>
          <button type="submit" style={btn('#3b82f6')}>
            QC 통과 {cleanPending.length}개 전체 승인
          </button>
          <span style={{ marginLeft: 12, color: '#9aa0ab', fontSize: 13 }}>
            QC 미통과 건은 제외됩니다. 개별로 확인하세요.
          </span>
        </form>
      )}

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {rows.map((row) => (
          <RenderCard key={row.id} row={row} />
        ))}
      </div>

      {rows.length === 0 && (
        <p style={{ color: '#6b7280' }}>
          오늘 생성된 영상이 없습니다. Actions 에서 <code>쇼핑쇼츠 일일 생성</code> 워크플로를 확인하세요.
        </p>
      )}
    </main>
  );
}

async function RenderCard({ row }: { row: RenderRow }) {
  const videoUrl = await signedUrl(row.storage_path);
  const script = row.narrations.scripts;
  const blueprint = script.blueprints;
  const decided = row.approval_status !== 'pending';

  return (
    <article
      style={{
        border: `1px solid ${row.qc_passed ? '#242833' : '#7f3d3d'}`,
        borderRadius: 12,
        background: '#15171d',
        overflow: 'hidden',
        opacity: decided ? 0.55 : 1,
      }}
    >
      {videoUrl && (
        <video src={videoUrl} controls preload="metadata" style={{ width: '100%', display: 'block', background: '#000' }} />
      )}

      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>{script.products.title_ko}</strong>
          <span style={{ color: '#9aa0ab', fontSize: 13, whiteSpace: 'nowrap' }}>
            {row.duration_sec.toFixed(0)}초
          </span>
        </div>

        <dl style={{ margin: '0 0 12px', fontSize: 13, color: '#9aa0ab', display: 'grid', gap: 4 }}>
          <Row label="채널" value={`${row.channels.key} · ${row.channels.category}`} />
          <Row
            label="설계도"
            value={`${blueprint.references.platform} ${blueprint.references.outlier_score.toFixed(1)}배 · ${blueprint.hook_type}`}
          />
          <Row label="소구 순서" value={blueprint.appeal_order.join(' → ')} />
          <Row
            label="가격"
            value={script.products.price_krw ? `${script.products.price_krw.toLocaleString()}원` : '-'}
          />
          <Row label="나레이션" value={`타입캐스트 (${row.narrations.source_mode})`} />
        </dl>

        {script.products.score_reason && (
          <p style={{ fontSize: 12, color: '#7b818c', margin: '0 0 12px', lineHeight: 1.5 }}>
            선정 이유: {script.products.score_reason}
          </p>
        )}

        {!row.qc_passed && row.qc_notes.length > 0 && (
          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, color: '#f0a0a0', lineHeight: 1.6 }}>
            {row.qc_notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}

        <details style={{ marginBottom: 14, fontSize: 12, color: '#9aa0ab' }}>
          <summary style={{ cursor: 'pointer' }}>대본 {script.lines.length}문장</summary>
          <ol style={{ paddingLeft: 18, lineHeight: 1.7, marginTop: 8 }}>
            {script.lines.map((l, i) => (
              <li key={i}>{l.text}</li>
            ))}
          </ol>
        </details>

        {decided ? (
          <span style={{ fontSize: 13, color: row.approval_status === 'approved' ? '#4ade80' : '#9aa0ab' }}>
            {statusLabel(row.approval_status)}
          </span>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <form action={decide.bind(null, row.id, 'approved')}>
              <button type="submit" style={btn('#16a34a')}>승인</button>
            </form>
            <form action={decide.bind(null, row.id, 'regenerate')}>
              <button type="submit" style={btn('#b45309')}>재생성</button>
            </form>
            <form action={decide.bind(null, row.id, 'rejected')}>
              <button type="submit" style={btn('#374151')}>반려</button>
            </form>
          </div>
        )}
      </div>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <dt style={{ minWidth: 64, color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

function statusLabel(status: string): string {
  if (status === 'approved') return '승인됨 — 다음 배포 주기에 나갑니다';
  if (status === 'regenerate') return '재생성 대기';
  return '반려됨';
}

function btn(background: string): React.CSSProperties {
  return {
    background,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '9px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
}
