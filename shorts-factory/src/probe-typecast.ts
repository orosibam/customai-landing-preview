/**
 * 타입캐스트 API 형태 확인.
 *
 * 나레이션 어댑터(lib/typecast.ts)의 요청·응답 매핑은 **추측으로 쓰여 있다.**
 * 이 컨테이너에서 타입캐스트에 접속할 수 없어 한 번도 실물과 맞춰보지 못했다.
 *
 * 이 스크립트는 네트워크가 열린 곳에서 돌려 실제 응답의 **형태만** 출력한다.
 * 토큰 값, 오디오 URL, 사용자 정보 같은 실제 값은 찍지 않는다 — 출력을 그대로
 * 붙여넣어도 안전해야 하기 때문이다.
 *
 *   export TYPECAST_API_TOKEN='...'      (Windows: set TYPECAST_API_TOKEN=...)
 *   npx tsx src/probe-typecast.ts
 *
 * 출력을 통째로 복사해서 보내주면 어댑터를 실물에 맞춘다.
 */

import { requireEnv, optionalEnv } from './config.js';

/** 값은 감추고 구조만 남긴다. 붙여넣어도 안전하게. */
function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0], depth + 1), `…총 ${value.length}개`];
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shapeOf(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // URL 은 호스트와 경로 모양만. 토큰이 쿼리에 실려 있을 수 있다.
    if (/^https?:\/\//.test(value)) {
      try {
        const u = new URL(value);
        return `<url ${u.host}${u.pathname.replace(/\/[^/]{16,}/g, '/<id>')}>`;
      } catch {
        return '<url>';
      }
    }
    return `<string len=${value.length}>`;
  }
  return `<${typeof value}>`;
}

const BASES = [
  optionalEnv('TYPECAST_API_BASE', 'https://typecast.ai/api'),
  'https://api.typecast.ai/v1',
  'https://typecast.ai/api/v1',
];

/** 액터(성우) 목록. 여기서 액터 ID 형식을 알 수 있다. */
const ACTOR_PATHS = ['/actor', '/actors', '/voices'];

/**
 * 인증 헤더 방식 후보.
 *
 * 실측(2026-09-20): typecast.ai/api/actor 가 Bearer 로 403, api.typecast.ai/v1/voices 가
 * 401 을 줬다. 401 은 "그 엔드포인트는 있는데 이 인증은 아니다" 라는 뜻이라
 * 헤더 방식이 다른 쪽을 가리킨다. 어느 쪽인지는 추측할 게 아니라 다 때려보면 된다.
 */
const AUTH_STYLES: { name: string; header: (t: string) => Record<string, string> }[] = [
  { name: 'Bearer', header: (t) => ({ Authorization: `Bearer ${t}` }) },
  { name: 'X-API-KEY', header: (t) => ({ 'X-API-KEY': t }) },
  { name: 'Authorization(raw)', header: (t) => ({ Authorization: t }) },
];

async function probe(
  url: string,
  token: string,
  style: (typeof AUTH_STYLES)[number],
  init?: RequestInit,
): Promise<number | null> {
  const label = url.replace(/https?:\/\//, '');
  process.stdout.write(`  ${label.padEnd(40)} ${style.name.padEnd(19)} `);

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...style.header(token),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = `<비JSON len=${text.length}>`;
    }

    console.log(`${res.status}`);

    // 404·401·403 은 흔한 오답이라 한 줄로만 남긴다. 조합이 많아서 로그가 길어진다.
    if (res.status === 404 || res.status === 401 || res.status === 403) return res.status;

    console.log(`     ✅ 통했습니다. 응답 형태:`);
    console.log(`     ${JSON.stringify(shapeOf(body), null, 2).split('\n').join('\n     ')}`);
    return res.status;
  } catch (e) {
    console.log(`실패 — ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const token = requireEnv('TYPECAST_API_TOKEN');

  console.log('\n타입캐스트 API 형태 확인');
  console.log('값은 출력하지 않습니다. 구조만 봅니다.\n');
  console.log(`토큰: 길이 ${token.length}자, ${token.slice(0, 3)}… 로 시작\n`);

  console.log('1) 액터 목록 — 호스트 × 인증방식을 전부 때려봅니다');
  console.log('   (200 이 뜨는 조합 하나만 찾으면 된다. 나머지는 무시해도 된다)\n');

  const wins: string[] = [];
  for (const base of BASES) {
    for (const path of ACTOR_PATHS) {
      for (const style of AUTH_STYLES) {
        const status = await probe(`${base}${path}`, token, style);
        if (status && status >= 200 && status < 300) {
          wins.push(`${base}${path}  (${style.name})`);
        }
      }
    }
  }

  console.log('');
  if (wins.length > 0) {
    console.log(`통한 조합 ${wins.length}개:`);
    for (const w of wins) console.log(`  ✅ ${w}`);
  } else {
    console.log('❌ 통한 조합이 없습니다.');
    console.log('   401 만 나왔다면 토큰이 거부된 것이고(키를 다시 발급),');
    console.log('   403 만 나왔다면 요금제에서 API 가 안 열린 것일 수 있습니다.');
  }

  console.log('\n2) 합성 요청 — 응답에 오디오 URL과 길이가 오는지 확인합니다');
  const actorId = optionalEnv('TYPECAST_PROBE_ACTOR', '');
  if (!actorId) {
    console.log('  건너뜀 — 액터 ID가 필요합니다.');
    console.log('  위 1)에서 액터 ID를 하나 골라 다시 실행하세요:');
    console.log('    export TYPECAST_PROBE_ACTOR=<액터ID>');
  } else {
    // 1)에서 통한 인증 방식이 있으면 그걸 쓴다. 없으면 셋 다 시도한다.
    const styles = AUTH_STYLES;
    for (const base of BASES) {
      for (const style of styles) {
      await probe(`${base}/speak`, token, style, {
        method: 'POST',
        body: JSON.stringify({
          actor_id: actorId,
          text: '세차했는데도 광택이 금방 사라지죠?',
          lang: 'auto',
          tempo: 1.25,
          volume: 100,
          pitch: 1,
          xapi_hd: true,
          max_seconds: 30,
        }),
      });
      }
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('이 출력을 통째로 복사해서 보내주세요.');
  console.log('어댑터(lib/typecast.ts)를 실물 형식에 맞추겠습니다.');
  console.log('\n확인해야 할 것 두 가지:');
  console.log('  · 합성 응답에 오디오를 받을 URL이 있는가');
  console.log('  · 문장별 길이(초)를 응답에서 받을 수 있는가');
  console.log('    → 못 받으면 우리가 ffprobe 로 재면 되므로 치명적이진 않습니다.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
