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

const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
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
const distinct = new Set(mins).size;
check('값이 고르게 흩어짐', distinct > 100, `200개 중 서로 다른 값 ${distinct}개`);

// 하루 10편이 한 시간 안에 몰리면 분산의 의미가 없다.
const sample = ids.slice(0, 10).map(jitterMinutesFor).sort((a, b) => a - b);
const spread = (sample.at(-1) ?? 0) - (sample[0] ?? 0);
check('10편 표본이 2시간 이상에 걸쳐 분산', spread >= 120, `${spread}분에 걸침`);

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
