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

async function probe(url: string, token: string, init?: RequestInit): Promise<void> {
  const label = url.replace(/https?:\/\//, '');
  process.stdout.write(`  ${label.padEnd(46)} `);

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
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

    if (res.status === 401) {
      console.log(`     → 토큰이 거부됐습니다. Bearer 방식이 아닐 수 있습니다.`);
      return;
    }
    if (res.status === 403) {
      // 회사망·프록시가 막아도 403 이 온다. 단정하지 않고 둘 다 알려준다.
      console.log(`     → 거부됨. 토큰 권한 문제이거나, 네트워크가 이 호스트를 막고 있습니다.`);
      console.log(`        브라우저에서 같은 주소가 열리는지 확인해보세요.`);
      return;
    }
    if (res.status === 404) return;

    console.log(`     응답 형태: ${JSON.stringify(shapeOf(body), null, 2).split('\n').join('\n     ')}`);
  } catch (e) {
    console.log(`실패 — ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const token = requireEnv('TYPECAST_API_TOKEN');

  console.log('\n타입캐스트 API 형태 확인');
  console.log('값은 출력하지 않습니다. 구조만 봅니다.\n');
  console.log(`토큰: 길이 ${token.length}자, ${token.slice(0, 3)}… 로 시작\n`);

  console.log('1) 액터 목록 — 액터 ID 형식을 확인합니다');
  for (const base of BASES) {
    for (const path of ACTOR_PATHS) {
      await probe(`${base}${path}`, token);
    }
  }

  console.log('\n2) 합성 요청 — 응답에 오디오 URL과 길이가 오는지 확인합니다');
  const actorId = optionalEnv('TYPECAST_PROBE_ACTOR', '');
  if (!actorId) {
    console.log('  건너뜀 — 액터 ID가 필요합니다.');
    console.log('  위 1)에서 액터 ID를 하나 골라 다시 실행하세요:');
    console.log('    export TYPECAST_PROBE_ACTOR=<액터ID>');
  } else {
    for (const base of BASES) {
      await probe(`${base}/speak`, token, {
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
