/**
 * 업로드 시각 분산 검증.
 *
 * 예약 게시를 지원하는 건 유튜브뿐이라, 나머지 플랫폼에서 시각을 흩뿌리려면
 * 배포 시작 자체를 늦춰야 한다. 그 지연값이 **결정적**이어야 한다는 게 핵심이다 —
 * 30분마다 도는 워크플로가 돌 때마다 값이 바뀌면 예정 시각에 영영 도달하지 못한다.
 *
 *   npx tsx src/team/members/publisher.test.ts
 */
import { UPLOAD_JITTER_MINUTES } from '../../config.js';
import { jitterMinutesFor, jitteredSchedule } from './publisher.js';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 렌더 id 표본.
 *
 * 예전엔 crypto.randomUUID() 로 만들었는데, 그러면 테스트가 실행할 때마다 다른 걸
 * 검사하게 된다. 아래 「표본이 2시간 이상에 걸쳐 분산」 은 무작위 10개를 뽑아 보는
 * 것이라 가끔 몰려서 7번에 한 번꼴로 빨개졌다. 그런 테스트는 고장을 알리는 게 아니라
 * 고장 신호를 못 믿게 만든다.
 *
 * 그래서 표본을 고정한다. 실제 UUID 와 같은 모양으로 만들되 값은 결정적이라,
 * 실패하면 항상 실패하고 통과하면 항상 통과한다.
 */
const ids = Array.from({ length: 500 }, (_, i) => {
  const hex = (i * 2_654_435_761 >>> 0).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${String(i).padStart(12, '0')}`;
});
const mins = ids.map(jitterMinutesFor);

console.log('\n지연 계산');

check(
  '같은 입력은 항상 같은 값',
  ids.every((id) => jitterMinutesFor(id) === jitterMinutesFor(id)),
);

check(
  `범위 ${UPLOAD_JITTER_MINUTES.min}~${UPLOAD_JITTER_MINUTES.max}분 이내`,
  mins.every((m) => m >= UPLOAD_JITTER_MINUTES.min && m <= UPLOAD_JITTER_MINUTES.max),
  `실제 ${Math.min(...mins)}~${Math.max(...mins)}분`,
);

// 전부 같은 값이 나오면 분산이 되지 않아 기계적 패턴이 그대로 드러난다.
// 나올 수 있는 값은 15~240분의 정수뿐이라 226개가 상한이다 — 표본 수(500)가 아니라
// 그 상한을 기준으로 봐야 한다. 상한의 80% 를 못 채우면 해시가 뭉치고 있는 것이다.
const span = UPLOAD_JITTER_MINUTES.max - UPLOAD_JITTER_MINUTES.min;
const possible = span + 1;
const distinct = new Set(mins).size;
check(
  '값이 고르게 흩어짐',
  distinct >= possible * 0.8,
  `가능한 ${possible}개 중 ${distinct}개 사용 (기준 ${Math.ceil(possible * 0.8)}개)`,
);

// 한쪽으로 쏠리면 "흩어진 것처럼 보이지만 늘 오전에 몰리는" 패턴이 된다.
// 구간을 넷으로 갈라 각 구간에 최소한씩은 들어가는지 본다.
const buckets = [0, 0, 0, 0];
for (const m of mins) {
  const idx = Math.min(3, Math.floor(((m - UPLOAD_JITTER_MINUTES.min) / span) * 4));
  buckets[idx]!++;
}
const thinnest = Math.min(...buckets);
check(
  '네 구간에 고루 퍼짐',
  thinnest >= ids.length / 8,
  `구간별 ${buckets.join(' / ')} (가장 적은 곳 ${thinnest}개, 기준 ${ids.length / 8}개)`,
);

// 하루 10편이 한 시간 안에 몰리면 분산의 의미가 없다.
// 한 조만 보면 운에 좌우되므로, 10편씩 끊어 전부 보고 최악의 조를 기준으로 삼는다.
const spreads: number[] = [];
for (let i = 0; i + 10 <= mins.length; i += 10) {
  const group = mins.slice(i, i + 10).sort((a, b) => a - b);
  spreads.push((group.at(-1) ?? 0) - (group[0] ?? 0));
}
const worst = Math.min(...spreads);
const median = [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length / 2)]!;
check(
  '10편 묶음이 어느 날이든 90분 이상에 걸쳐 분산',
  worst >= 90,
  `${spreads.length}개 묶음 중 최악 ${worst}분, 중앙값 ${median}분`,
);

console.log('\n예정 시각');

const approvedAt = new Date('2026-09-20T05:00:00Z');
const first = ids[0]!;
const scheduled = jitteredSchedule(first, approvedAt);

check('승인 시각보다 미래', scheduled > approvedAt);
check(
  '재계산해도 동일',
  jitteredSchedule(first, approvedAt).getTime() === scheduled.getTime(),
  scheduled.toISOString(),
);

console.log(failures === 0 ? '\n전부 통과\n' : `\n${failures}건 실패\n`);
process.exit(failures === 0 ? 0 : 1);
