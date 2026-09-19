/**
 * 발음 정규화 스모크 테스트.
 *
 * 외부 의존성이 없어 네트워크 없이도 돈다.
 *   npx tsx src/lib/korean.test.ts
 */
import {
  normalizeForSpeech,
  sinoKorean,
  nativeKorean,
  splitIntoLines,
  detectFormalEndings,
  estimateDurationSec,
} from './korean.js';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n       기대: ${e}\n       실제: ${a}`);
  }
}

console.log('\n한자어 수사');
check('0', sinoKorean(0), '영');
check('7', sinoKorean(7), '칠');
check('10', sinoKorean(10), '십');
check('30', sinoKorean(30), '삼십');
check('111', sinoKorean(111), '백십일');
check('1200', sinoKorean(1200), '천이백');
check('12900', sinoKorean(12900), '만이천구백');
check('35000', sinoKorean(35000), '삼만오천');
check('1.5', sinoKorean(1.5), '일점오');

console.log('\n고유어 수사');
check('3', nativeKorean(3), '세');
check('5', nativeKorean(5), '다섯');
check('20', nativeKorean(20), '스무');
check('23', nativeKorean(23), '스물세');
check('범위 밖', nativeKorean(120), null);

console.log('\n문장 정규화');
check(
  '약어',
  normalizeForSpeech('PH 중성 카샴푸예요').text,
  '피에이치 중성 카샴푸예요',
);
check(
  '퍼센트',
  normalizeForSpeech('수수료가 30% 들어와요').text,
  '수수료가 삼십 퍼센트 들어와요',
);
check(
  '가격',
  normalizeForSpeech('12,900원이면 사요').text,
  '만이천구백 원이면 사요',
);
check(
  '용량 단위',
  normalizeForSpeech('1,200ml 대용량이에요').text,
  '천이백 밀리리터 대용량이에요',
);
check(
  '고유어 단위',
  normalizeForSpeech('3개만 쓰면 끝나요').text,
  '세 개만 쓰면 끝나요',
);
check(
  '이모지 제거',
  normalizeForSpeech('이거 진짜 좋아요 ✨🔥').text,
  '이거 진짜 좋아요',
);
check(
  '복합',
  normalizeForSpeech('LED 조명 2개, 5W 밝기로 19,900원').text,
  '엘이디 조명 두 개, 오 와트 밝기로 만구천구백 원',
);

console.log('\n문어체 탐지');
check('탐지됨', detectFormalEndings('이것은 좋은 제품입니다.'), ['입니다']);
check('구어체는 통과', detectFormalEndings('이거 진짜 좋아요.'), []);

console.log('\n문장 분할');
const lines = splitIntoLines(
  '세차했는데도 광택이 금방 사라지는 것 같죠? 중성 카샴푸는 도장면을 자극하지 않고 부드럽게 세정해줘요.',
);
check('모든 줄이 상한 이내', lines.every((l) => l.length <= 24), true);
check('빈 줄 없음', lines.every((l) => l.trim().length > 0), true);
console.log(`       → ${JSON.stringify(lines)}`);

console.log('\n길이 추정');
const est = estimateDurationSec('세차했는데도 광택이 금방 사라지는 것 같죠?');
check('합리적 범위(2~5초)', est > 2 && est < 5, true);
console.log(`       → ${est.toFixed(2)}초`);

console.log(failures === 0 ? '\n전부 통과\n' : `\n${failures}건 실패\n`);
process.exit(failures === 0 ? 0 : 1);
