/**
 * 완성본을 **로그인 없이 열리는 링크**로 만들어 준다.
 *
 * ## 왜 필요한가
 *
 * 렌더 결과는 두 군데에 있다: GitHub Actions 아티팩트(zip)와 Supabase 스토리지.
 * 둘 다 사람이 보기 어렵다.
 *   · 아티팩트는 **GitHub 로그인이 있어야** 받아진다. 로그인 없이 누르면 zip 이
 *     아니라 오류 페이지가 내려오고, 압축을 풀려 하면 "권한이 없다" 로 실패한다.
 *     실제로 그 일이 났다.
 *   · 스토리지 버킷은 비공개라 주소만으로는 안 열린다.
 *
 * 서명 링크는 둘 다 피해 간다. 시간 제한이 있고, 버킷을 공개로 바꾸지 않으며,
 * 브라우저에 붙여넣으면 바로 재생된다.
 *
 * 실행:  npm run stage share            (가장 최근 완성본)
 *        npm run stage share -- --run-id=<id>
 */
import { db } from './lib/supabase.js';
import { signedUrl } from './lib/storage.js';

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

export async function shareLatestRender(runId?: string): Promise<string | null> {
  let q = db()
    .from('renders')
    .select('id, run_id, storage_path, duration_sec, qc_passed, qc_notes, created_at')
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (runId) q = q.eq('run_id', runId);

  const { data, error } = await q;
  if (error) throw new Error(`완성본 조회 실패: ${error.message}`);

  const row = (data as
    | {
        id: string;
        run_id: string;
        storage_path: string;
        duration_sec: number | null;
        qc_passed: boolean;
        qc_notes: string[] | null;
        created_at: string;
      }[]
    | null)?.[0];

  if (!row) {
    console.log('완성본이 없습니다. 아직 렌더까지 간 실행이 없습니다.');
    return null;
  }

  const url = await signedUrl(row.storage_path, SEVEN_DAYS_SEC);

  console.log('');
  console.log(`완성본: ${row.duration_sec ?? '?'}초 · 검수 ${row.qc_passed ? '통과' : '미통과'}`);
  console.log(`만든 시각: ${row.created_at}`);
  console.log('');
  console.log('링크 (7일간 유효, 로그인 없이 열립니다):');
  console.log(url);
  console.log('');

  // 검수 지적을 같이 보여준다. 링크만 주면 "왜 이게 이상하지" 를 혼자 추측하게 된다.
  for (const note of row.qc_notes ?? []) console.log(`  · ${note}`);

  return url;
}
