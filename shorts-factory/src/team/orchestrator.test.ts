/**
 * 후보 재시도 테스트. 네트워크도 DB 도 안 탄다 — 가짜 담당자를 라인에 넣는다.
 *   npx tsx src/team/orchestrator.test.ts
 *
 * ## 왜 이걸 테스트하는가
 *
 * 이 경로는 **아래에서 퇴짜가 났을 때만** 돈다. 실제 실행에서는 몇 번에 한 번씩만
 * 지나가는 길이고, 그런 길일수록 틀린 채로 오래 남는다. 실제로 `retryable` 은
 * 처음부터 있었는데 아무도 읽지 않은 상태로 여섯 번을 돌았다.
 */
import { runLine } from './orchestrator.js';
import { HandoffError, PASS, type Brief, type TeamMember } from './types.js';
import { audienceFor } from '../lib/audience.js';
import { CHANNELS } from '../config.js';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.log(`  X   ${label}\n      기대: ${e}\n      실제: ${a}`);
  }
}

const baseBrief = (): Brief => ({
  runId: 'test-run',
  channel: CHANNELS[0]!,
  audience: audienceFor('general'),
  notes: [],
});

/** 후보 셋을 들고 있다가 하나씩 내주는 가짜 소싱 담당. */
function fakeScout(counters: { discoveries: number }): TeamMember {
  const all = ['후보A', '후보B', '후보C'];
  return {
    id: 'scout',
    role: '소싱 담당(가짜)',
    expertise: '',
    charter: '',
    async work(brief) {
      const queued = brief.shortlist?.[0];
      if (queued) {
        return {
          ...brief,
          product: {
            id: queued.productNameKo,
            titleKo: queued.productNameKo,
            keywordsZh: [],
            priceKrw: null,
            rationale: '',
          },
          shortlist: brief.shortlist!.slice(1),
        };
      }
      // 여기까지 왔다는 건 새로 발굴했다는 뜻이다. 재시도가 제대로 돌면
      // 이 숫자는 1이어야 한다 — 2가 되면 매 후보마다 인스타를 다시 긁는 것이다.
      counters.discoveries++;
      const [first, ...rest] = all;
      return {
        ...brief,
        product: {
          id: first!,
          titleKo: first!,
          keywordsZh: [],
          priceKrw: null,
          rationale: '',
        },
        shortlist: rest.map((name) => ({
          productNameKo: name,
          keywordsZh: [],
          keywordEn: '',
          priceKrw: null,
          rationale: '',
          source: { url: '', videoId: '', caption: '', views: null, likes: null, platform: 'test' },
        })),
      };
    },
    async review() {
      return PASS;
    },
  };
}

/** 지정한 상품들을 퇴짜 놓는 가짜 제휴 담당. */
function fakeMerchandiser(rejectThese: string[]): TeamMember {
  return {
    id: 'merchandiser',
    role: '제휴 담당(가짜)',
    expertise: '',
    charter: '',
    async work(brief) {
      const title = brief.product?.titleKo ?? '';
      if (rejectThese.includes(title)) {
        throw new HandoffError('merchandiser', `${title} 는 한국에 없습니다.`, true);
      }
      return brief;
    },
    async review() {
      return PASS;
    },
  };
}

console.log('후보 재시도');

{
  // 6차 제작이 딱 이 모양이었다: 1순위가 한국에 없어서 던졌고, 그대로 끝났다.
  const counters = { discoveries: 0 };
  const line = [fakeScout(counters), fakeMerchandiser(['후보A'])];
  const done = await runLine(baseBrief(), '[테스트]', line);

  check('1순위가 떨어지면 2순위로 간다', done.product?.titleKo, '후보B');
  check('발굴은 한 번만 한다 (재발굴 없음)', counters.discoveries, 1);
  check('퇴짜 기록이 남는다', done.rejected?.map((r) => r.titleKo), ['후보A']);
  check('퇴짜 놓은 담당자도 기록된다', done.rejected?.map((r) => r.by), ['merchandiser']);
}

{
  const counters = { discoveries: 0 };
  const line = [fakeScout(counters), fakeMerchandiser(['후보A', '후보B'])];
  const done = await runLine(baseBrief(), '[테스트]', line);
  check('둘이 떨어지면 3순위까지 간다', done.product?.titleKo, '후보C');
  check('그래도 발굴은 한 번', counters.discoveries, 1);
}

{
  // 셋 다 떨어지면 던진다. 그때 **셋 다** 이름과 이유가 적혀 있어야 한다 —
  // 하나만 보고 "이 카테고리가 문제인가" 를 추측하게 두지 않는다.
  const counters = { discoveries: 0 };
  const line = [fakeScout(counters), fakeMerchandiser(['후보A', '후보B', '후보C'])];
  let thrown: Error | null = null;
  try {
    await runLine(baseBrief(), '[테스트]', line);
  } catch (e) {
    thrown = e as Error;
  }

  check('셋 다 떨어지면 던진다', thrown !== null, true);
  check('세 후보가 전부 메시지에 있다', ['후보A', '후보B', '후보C'].every((n) => thrown?.message.includes(n)), true);
  check('이유도 함께 적는다', thrown?.message.includes('한국에 없습니다'), true);
}

{
  // retryable 이 아닌 실패는 재시도하지 않는다. 같은 값으로 다시 돌면
  // 같은 자리에서 또 죽고 시간만 세 배로 쓴다.
  const counters = { discoveries: 0 };
  const hardFail: TeamMember = {
    id: 'editor',
    role: '편집자(가짜)',
    expertise: '',
    charter: '',
    async work() {
      throw new HandoffError('editor', 'ffmpeg 가 없습니다.', false);
    },
    async review() {
      return PASS;
    },
  };
  let thrown: Error | null = null;
  try {
    await runLine(baseBrief(), '[테스트]', [fakeScout(counters), hardFail]);
  } catch (e) {
    thrown = e as Error;
  }
  check('retryable 아니면 그대로 올린다', thrown?.message.includes('ffmpeg 가 없습니다'), true);
  check('재시도하지 않는다', counters.discoveries, 1);
}

if (failures > 0) {
  console.log(`${failures}건 실패`);
  process.exit(1);
}
console.log('전부 통과');
