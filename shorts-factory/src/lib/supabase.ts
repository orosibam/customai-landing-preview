import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '../config.js';

let client: SupabaseClient | null = null;

/**
 * 서비스 롤 키로 접속한다. 이 파이프라인은 전부 서버사이드(Actions)에서만 돌고
 * 브라우저에 노출되지 않는다.
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });
  }
  return client;
}

/**
 * 실패를 삼키지 않는다. 쿼리가 실패하면 그 자리에서 죽는 편이 디버깅이 쉽다.
 *
 * DB 타입을 생성해 쓰지 않으므로 `unknown` 을 돌려주고 호출부가 형태를 단언한다.
 * 스키마가 커지면 `supabase gen types` 로 생성한 타입을 붙이는 게 낫다.
 */
export async function must(
  label: string,
  q: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<unknown> {
  const { data, error } = await q;
  if (error) throw new Error(`${label} 실패: ${error.message}`);
  if (data === null || data === undefined) throw new Error(`${label}: 결과가 비어 있습니다`);
  return data;
}

/** 오늘 실행(run) 행을 만들거나 가져온다. 하루에 하나만 존재한다. */
export async function openRun(runDate: string): Promise<string> {
  const existing = await db().from('runs').select('id').eq('run_date', runDate).maybeSingle();
  if (existing.data) return existing.data.id as string;

  const created = await must(
    'run 생성',
    db().from('runs').insert({ run_date: runDate, status: 'running' }).select('id').single(),
  );
  return (created as { id: string }).id;
}

/** 스테이지 결과를 run.stage_log 에 누적한다. 실패 원인을 여기서 먼저 본다. */
export async function logStage(
  runId: string,
  entry: { stage: string; ok: boolean; ms: number; note?: string },
): Promise<void> {
  const run = await must('run 조회', db().from('runs').select('stage_log').eq('id', runId).single());
  const log = ((run as { stage_log: unknown[] }).stage_log ?? []) as unknown[];
  log.push({ ...entry, at: new Date().toISOString() });
  await db().from('runs').update({ stage_log: log }).eq('id', runId);
}
