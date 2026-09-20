/**
 * 검색어 넓히기 테스트. 네트워크 없이 돈다.
 *   npx tsx src/lib/scrapers/keywords.test.ts
 */
import { broadenKeyword, searchPlan } from './keywords.js';

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

console.log('검색어 넓히기');

// 5차 제작이 이 검색어로 상품 7건만 받고 멈췄다. 그 경우를 그대로 고정해둔다.
check('수식어를 앞에서부터 뗀다', broadenKeyword('mini portable massage gun'), [
  'mini portable massage gun',
  'portable massage gun',
  'massage gun',
]);

check('두 단어는 그대로 둔다 (한 단어까지 가지 않는다)', broadenKeyword('massage gun'), [
  'massage gun',
]);

check('한 단어는 넓힐 게 없다', broadenKeyword('humidifier'), ['humidifier']);

check('빈 문자열은 빈 목록', broadenKeyword('   '), []);

check('앞뒤 공백과 겹공백을 정리한다', broadenKeyword('  car   wash foam '), [
  'car wash foam',
  'wash foam',
]);

check('max 로 개수를 제한한다', broadenKeyword('a b c d e', 2), ['a b c d e', 'b c d e']);

console.log('검색 계획');

check(
  '여러 검색어를 순서대로 펼치고 중복을 없앤다',
  searchPlan(['mini air duster', undefined, 'air duster', '']),
  ['mini air duster', 'air duster'],
);

// 중국어는 띄어쓰기가 없어 한 덩어리로 들어온다. 그때는 원문만 남아야 한다.
check('중국어 한 덩어리는 그대로', searchPlan(['吹尘枪', '无线吹尘枪']), ['吹尘枪', '无线吹尘枪']);

if (failures > 0) {
  console.log(`${failures}건 실패`);
  process.exit(1);
}
console.log('전부 통과');
