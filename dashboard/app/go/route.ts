import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/supabase';

/**
 * 제휴 링크 리다이렉터.
 *
 * 인포크링크/텐핑으로 바로 보내면 어떤 훅이 클릭을 만들었는지 우리가 알 수 없다.
 * 우리 도메인을 한 번 거치면 클릭 데이터를 우리가 소유하게 되고,
 * S10이 "어떤 설계도가 돈이 됐는가" 를 계산할 수 있다.
 *
 * 클릭 기록이 실패해도 리다이렉트는 반드시 나간다 — 로깅 때문에 구매를 놓칠 수는 없다.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const destination = params.get('u');

  if (!destination) {
    return NextResponse.json({ error: 'missing destination' }, { status: 400 });
  }

  // 오픈 리다이렉트 방지. 허용된 제휴사 도메인으로만 보낸다.
  let target: URL;
  try {
    target = new URL(destination);
  } catch {
    return NextResponse.json({ error: 'invalid destination' }, { status: 400 });
  }
  if (!isAllowedHost(target.hostname)) {
    return NextResponse.json({ error: 'destination not allowed' }, { status: 400 });
  }

  const renderId = params.get('r');
  if (renderId) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: upload } = await db()
        .from('uploads')
        .select('id')
        .eq('render_id', renderId)
        .maybeSingle();

      if (upload?.id) {
        await db().rpc('increment_click', { p_upload_id: upload.id, p_date: today });
      }
    } catch {
      // 기록 실패는 삼킨다. 리다이렉트가 우선이다.
    }
  }

  return NextResponse.redirect(target.toString(), 302);
}

const ALLOWED_SUFFIXES = [
  'coupang.com',
  'link.coupang.com',
  'inpock.co.kr',
  'linkinpock.co.kr',
  'tenping.kr',
  'aliexpress.com',
  'ohou.se',
  'ssg.com',
  'kyobobook.co.kr',
];

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}
