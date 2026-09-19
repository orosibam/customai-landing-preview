/**
 * 한국어 TTS 발음 정규화.
 *
 * TTS가 어색하게 들리는 원인 대부분은 목소리가 아니라 "읽을 수 없는 표기를
 * 그대로 넘긴 것" 이다. `PH 중성`, `1,200ml`, `30%` 같은 걸 그대로 주면
 * 성우가 더듬거나 영어로 읽어버린다. 타입캐스트에 넣기 전에 여기서 전부 한글로 바꾼다.
 *
 * 문법적 변형(문어체 → 구어체)은 여기서 하지 않는다. 정규식으로 한국어 어미를
 * 활용시키면 오히려 틀린 문장이 나온다. 그건 S5의 대본 생성 프롬프트가 담당하고,
 * 여기서는 빠져나온 문어체를 '탐지'만 해서 재생성 신호를 준다.
 */

const SINO_DIGITS = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'] as const;
const SMALL_UNITS = ['', '십', '백', '천'] as const;
const BIG_UNITS = ['', '만', '억', '조', '경'] as const;

/** 한자어 수사. 가격·단위·퍼센트를 읽을 때 쓴다. (1234 → 천이백삼십사) */
export function sinoKorean(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '영';
  if (n < 0) return `마이너스 ${sinoKorean(-n)}`;

  const intPart = Math.floor(n);
  const decimals = n - intPart;

  let result = '';
  let groupIndex = 0;
  let remaining = intPart;

  while (remaining > 0) {
    const group = remaining % 10_000;
    if (group > 0) {
      let groupText = '';
      const digits = String(group).split('').map(Number);
      const len = digits.length;
      for (let i = 0; i < len; i++) {
        const digit = digits[i]!;
        const unitIdx = len - 1 - i;
        if (digit === 0) continue;
        // 십/백/천 자리의 1은 읽지 않는다. 111 → 백십일 (일백일십일 아님)
        const digitText = digit === 1 && unitIdx > 0 ? '' : SINO_DIGITS[digit]!;
        groupText += digitText + SMALL_UNITS[unitIdx]!;
      }
      result = groupText + BIG_UNITS[groupIndex]! + result;
    }
    remaining = Math.floor(remaining / 10_000);
    groupIndex++;
  }

  // 말할 때는 "일만 이천" 이 아니라 "만 이천" 이라고 한다. 최상위 '일만'의 일만 떨군다.
  result = result.replace(/^일만/, '만');

  if (decimals > 0) {
    const decText = String(n).split('.')[1] ?? '';
    result += '점' + decText.split('').map((d) => SINO_DIGITS[Number(d)]!).join('');
  }

  return result;
}

const NATIVE_ATTRIBUTIVE: Record<number, string> = {
  1: '한', 2: '두', 3: '세', 4: '네', 5: '다섯', 6: '여섯', 7: '일곱',
  8: '여덟', 9: '아홉', 10: '열', 20: '스무',
};
const NATIVE_TENS: Record<number, string> = {
  10: '열', 20: '스물', 30: '서른', 40: '마흔', 50: '쉰',
  60: '예순', 70: '일흔', 80: '여든', 90: '아흔',
};

/** 고유어 수사(관형형). 개·번·가지처럼 고유어로 세는 단위에 쓴다. (3개 → 세 개) */
export function nativeKorean(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  if (NATIVE_ATTRIBUTIVE[n]) return NATIVE_ATTRIBUTIVE[n]!;
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  const tensText = tens === 20 ? '스물' : NATIVE_TENS[tens];
  if (!tensText) return null;
  return ones === 0 ? tensText : tensText + NATIVE_ATTRIBUTIVE[ones]!;
}

/** 고유어로 세는 단위. 이 앞의 숫자는 고유어 수사로 읽는다. */
const NATIVE_COUNTERS = ['개', '번', '가지', '명', '분', '살', '켤레', '장', '병', '잔', '통'];

/**
 * 단위 기호 → 읽는 말.
 *
 * 토큰만 들고 있고 경계 처리는 쓰는 쪽에서 붙인다. `5W` 처럼 숫자와 붙어 있으면
 * 앞에 단어 경계가 없어서 `\bW\b` 로는 절대 안 잡힌다 — 이게 정규화가 조용히
 * 실패하는 대표적인 경로다. 긴 토큰이 먼저 와야 `ml` 이 `m` 으로 잘리지 않는다.
 */
interface UnitRule {
  tokens: string[];
  spoken: string;
  /** 대소문자를 가리지 않아도 되는가. mAh 처럼 표기가 고정된 건 false. */
  ci: boolean;
}

const UNIT_RULES: UnitRule[] = [
  { tokens: ['mAh'], spoken: '밀리암페어시', ci: false },
  { tokens: ['㎖', 'ml'], spoken: '밀리리터', ci: true },
  { tokens: ['㎗', 'dl'], spoken: '데시리터', ci: true },
  { tokens: ['㎏', 'kg'], spoken: '킬로그램', ci: true },
  { tokens: ['mg'], spoken: '밀리그램', ci: true },
  { tokens: ['㎝', 'cm'], spoken: '센티미터', ci: true },
  { tokens: ['mm'], spoken: '밀리미터', ci: true },
  { tokens: ['km'], spoken: '킬로미터', ci: true },
  { tokens: ['GB'], spoken: '기가바이트', ci: true },
  { tokens: ['TB'], spoken: '테라바이트', ci: true },
  { tokens: ['MB'], spoken: '메가바이트', ci: true },
  { tokens: ['inch', '인치'], spoken: '인치', ci: true },
  { tokens: ['℃', '°C'], spoken: '도', ci: false },
  { tokens: ['L', '리터'], spoken: '리터', ci: false },
  { tokens: ['W', '와트'], spoken: '와트', ci: false },
  { tokens: ['V'], spoken: '볼트', ci: false },
  { tokens: ['A'], spoken: '암페어', ci: false },
  { tokens: ['g'], spoken: '그램', ci: false },
  { tokens: ['m'], spoken: '미터', ci: false },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 숫자 바로 뒤에 붙은 단위. 앞의 숫자가 앵커라 단어 경계가 필요 없다. */
function numberedUnitPattern(rule: UnitRule): RegExp {
  const alt = rule.tokens.map(escapeRe).join('|');
  return new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:${alt})(?![A-Za-z])`, rule.ci ? 'gi' : 'g');
}

/**
 * 숫자 없이 홀로 쓰인 단위.
 *
 * 기호형(㎖, ℃)만 처리한다. 알파벳 한 글자(m, g, A)를 단독으로 바꾸면
 * 멀쩡한 영문 약어를 망가뜨리므로 건드리지 않는다.
 */
function standaloneUnitPattern(rule: UnitRule): RegExp | null {
  const symbols = rule.tokens.filter((t) => !/^[A-Za-z]+$/.test(t) && !/^[가-힣]+$/.test(t));
  if (symbols.length === 0) return null;
  return new RegExp(symbols.map(escapeRe).join('|'), 'g');
}

/** 영문 약어 → 한글 발음. 상품 설명에 자주 나오는 것만. */
const ABBREVIATION_MAP: [RegExp, string][] = [
  [/\bpH\b|\bPH\b/g, '피에이치'],
  [/\bLED\b/g, '엘이디'],
  [/\bUSB\b/g, '유에스비'],
  [/\bUV\b/g, '유브이'],
  [/\bAS\b|\bA\/S\b/g, '에이에스'],
  [/\bDIY\b/g, '디아이와이'],
  [/\bIoT\b/g, '아이오티'],
  [/\bTV\b/g, '티브이'],
  [/\bPC\b/g, '피씨'],
  [/\bLCD\b/g, '엘씨디'],
  [/\bABS\b/g, '에이비에스'],
  [/\bPVC\b/g, '피브이씨'],
  [/\bSUS\b/g, '에스유에스'],
  [/\bXL\b/g, '엑스라지'],
  [/\bOK\b/gi, '오케이'],
];

/** TTS가 읽지 못하거나 이상하게 읽는 문자들. */
const STRIP_PATTERN =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

export interface NormalizeResult {
  text: string;
  /** 문어체가 남아 있으면 여기에 담긴다. 비어있지 않으면 대본을 재생성한다. */
  formalEndings: string[];
}

/**
 * 한 문장을 타입캐스트에 넣을 수 있는 형태로 바꾼다.
 *
 * 순서가 중요하다: 약어 → 퍼센트/통화 → 단위 → 남은 숫자.
 * 단위를 먼저 한글로 바꾸면 그 앞 숫자를 찾을 수 없게 된다.
 */
export function normalizeForSpeech(input: string): NormalizeResult {
  let text = input.normalize('NFC');

  text = text.replace(STRIP_PATTERN, ' ');

  for (const [pattern, replacement] of ABBREVIATION_MAP) {
    text = text.replace(pattern, replacement);
  }

  // 퍼센트: 30% → 삼십 퍼센트
  text = text.replace(/(\d[\d,]*(?:\.\d+)?)\s*%/g, (_, num: string) =>
    `${sinoKorean(Number(num.replace(/,/g, '')))} 퍼센트`,
  );

  // 가격: 12,900원 → 만이천구백 원
  // 숫자가 앵커라 뒤에 조사가 붙어도(원이면, 원에) 그대로 잡힌다.
  text = text.replace(/(\d[\d,]*)\s*원/g, (_, num: string) =>
    `${sinoKorean(Number(num.replace(/,/g, '')))} 원`,
  );

  // 숫자 + 단위: 1,200ml → 천이백 밀리리터, 5W → 오 와트
  for (const rule of UNIT_RULES) {
    text = text.replace(numberedUnitPattern(rule), (_, num: string) =>
      `${sinoKorean(Number(num.replace(/,/g, '')))} ${rule.spoken}`,
    );
  }
  // 숫자 없이 홀로 남은 기호형 단위
  for (const rule of UNIT_RULES) {
    const pattern = standaloneUnitPattern(rule);
    if (pattern) text = text.replace(pattern, rule.spoken);
  }

  // 고유어로 세는 단위: 3개 → 세 개
  // 여기도 숫자가 앵커다. "3개만" 의 '만' 같은 조사 때문에 놓치면 안 된다.
  const counterPattern = new RegExp(`(\\d+)\\s*(${NATIVE_COUNTERS.join('|')})`, 'g');
  text = text.replace(counterPattern, (whole, num: string, counter: string) => {
    const native = nativeKorean(Number(num));
    return native ? `${native} ${counter}` : whole;
  });

  // 남은 숫자는 한자어로
  text = text.replace(/(\d[\d,]*(?:\.\d+)?)/g, (_, num: string) =>
    sinoKorean(Number(num.replace(/,/g, ''))),
  );

  // 읽히지 않는 구두점 정리 (문장부호는 억양에 필요하므로 남긴다)
  text = text.replace(/[~^*_#|<>{}[\]]/g, ' ');
  text = text.replace(/\s{2,}/g, ' ').trim();

  return { text, formalEndings: detectFormalEndings(text) };
}

const FORMAL_ENDING_PATTERN = /(합니다|입니다|습니다|됩니다|십시오|하십시오|드립니다)(?=[.!?,\s]|$)/g;

/**
 * 문어체 어미 탐지.
 *
 * 쇼츠 나레이션이 "~합니다" 로 끝나면 광고 낭독처럼 들린다. 정규식으로 고치지 않고
 * 탐지만 해서 S5가 구어체로 다시 쓰게 만든다 — 한국어 활용을 치환으로 처리하면
 * 비문이 나오기 때문이다.
 */
export function detectFormalEndings(text: string): string[] {
  return [...text.matchAll(FORMAL_ENDING_PATTERN)].map((m) => m[1]!);
}

/**
 * 나레이션을 문장 단위로 쪼갠다.
 *
 * 타입캐스트는 문장이 길수록 억양이 무너진다. 12~18자 구간을 목표로 하되
 * 어절 경계에서만 자른다.
 */
export function splitIntoLines(text: string, minChars = 12, maxChars = 18): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const lines: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      lines.push(sentence);
      continue;
    }
    const words = sentence.split(' ');
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current.length >= minChars) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) {
      // 마지막 조각이 너무 짧으면 앞 줄에 붙인다. 한 단어짜리 자막은 어색하다.
      const last = lines[lines.length - 1];
      if (current.length < minChars / 2 && last && last.length + current.length <= maxChars + 6) {
        lines[lines.length - 1] = `${last} ${current}`;
      } else {
        lines.push(current);
      }
    }
  }
  return mergeDanglingAuxiliaries(lines, maxChars);
}

/** 보조용언 어간. 앞 용언과 한 덩어리라 줄 앞에 혼자 떨어지면 안 읽힌다. */
const AUXILIARY_STEMS = ['않', '못', '있', '없', '같', '싶', '주', '보', '드리', '버리', '하'];

/**
 * "자극하지 / 않고" 처럼 보조용언이 다음 줄 머리로 떨어진 경우를 앞 줄에 되붙인다.
 *
 * 길이만 보고 어절 경계에서 자르면 문법적으로는 맞아도 읽을 때 의미가 끊긴다.
 * 자막은 소리와 같이 흐르므로 이 한 가지만 잡아줘도 체감이 꽤 달라진다.
 */
function mergeDanglingAuxiliaries(lines: string[], maxChars: number): string[] {
  const merged: string[] = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    const startsWithAux = AUXILIARY_STEMS.some((stem) => line.startsWith(stem));
    const prevEndsConnective = prev ? /(지|고|서|며|면)$/.test(prev) : false;
    if (prev && startsWithAux && prevEndsConnective && prev.length + line.length <= maxChars + 8) {
      merged[merged.length - 1] = `${prev} ${line}`;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

/**
 * 글자수로 발화 길이를 추정한다(초).
 *
 * 한국어 TTS는 보통 초당 5~7음절. 실측 길이가 이 추정에서 크게 벗어나면
 * 전처리가 실패한 것(읽지 못하는 표기가 남아 더듬었다)으로 보고 재생성한다.
 */
export function estimateDurationSec(text: string, syllablesPerSec = 6.2): number {
  const syllables = (text.match(/[가-힣]/g) ?? []).length;
  const others = text.replace(/[가-힣\s]/g, '').length;
  return (syllables + others * 0.5) / syllablesPerSec;
}
