import { createClient } from '@supabase/supabase-js';

/**
 * 대시보드는 서버 컴포넌트/서버 액션에서만 DB에 접근한다.
 * 서비스 롤 키가 브라우저로 나가면 안 되므로 'server-only' 경계를 지킨다.
 */
export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const BUCKET = process.env.STORAGE_BUCKET ?? 'shorts';

export async function signedUrl(path: string): Promise<string | null> {
  const { data } = await db().storage.from(BUCKET).createSignedUrl(path, 43_200);
  return data?.signedUrl ?? null;
}
