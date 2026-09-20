import Anthropic from '@anthropic-ai/sdk';
import { MODELS, requireEnv } from '../config.js';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return client;
}

export interface CostTracker {
  inputTokens: number;
  outputTokens: number;
}

export const costTracker: CostTracker = { inputTokens: 0, outputTokens: 0 };

type Tier = 'reasoning' | 'fast';

interface AskOptions {
  tier?: Tier;
  system?: string;
  maxTokens?: number;
  /** 이미지(프레임 샘플 등)를 함께 넣을 때 */
  images?: { mediaType: 'image/jpeg' | 'image/png'; base64: string }[];
}

/**
 * 출력 토큰 하한.
 *
 * **Opus 5 는 `thinking` 을 생략하면 adaptive thinking 이 기본으로 켜진다.**
 * (Opus 4.8/4.7 은 생략하면 꺼졌다 — 그 기억으로 짜면 여기서 당한다.)
 * 사고 과정도 출력 토큰을 쓰므로 max_tokens 를 짜게 주면 사고만 하다 예산이 끝나고
 * **본문이 빈 채로 돌아온다.**
 *
 * 실제로 그렇게 멈췄다. 제휴 담당이 800 으로 불렀다가 빈 응답을 받았고,
 * 에러는 "JSON 형태가 아닙니다" 로 떠서 원인을 가렸다. 소싱 담당은 2000 이라
 * 통과했지만 그것도 아슬아슬한 값이다.
 *
 * 호출부가 더 큰 값을 주면 그걸 쓰고, 작게 주면 여기까지 올린다.
 */
const MIN_OUTPUT_TOKENS = 4_096;

export class EmptyResponseError extends Error {
  constructor(model: string, maxTokens: number, stopReason: string | null) {
    super(
      `${model} 이 본문 없이 끝났습니다 (max_tokens ${maxTokens}, stop_reason ${stopReason}).\n` +
        `   Opus 5 는 thinking 이 기본으로 켜져 있어 사고 과정이 출력 예산을 먼저 씁니다.\n` +
        `   호출부의 maxTokens 를 올리세요. (SDK 를 올리면 effort 로 사고 깊이를 낮출 수도 있습니다)`,
    );
    this.name = 'EmptyResponseError';
  }
}

/** 자유 텍스트 응답. */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const model = opts.tier === 'fast' ? MODELS.fast : MODELS.reasoning;
  const maxTokens = Math.max(opts.maxTokens ?? MIN_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS);

  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of opts.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: 'text', text: prompt });

  // thinking 을 명시적으로 보내지 않는다. Opus 5 는 생략하면 adaptive 가 켜지고,
  // 지금 설치된 SDK(0.68)의 타입에는 'adaptive' 도 output_config 도 없다.
  // 사고 깊이를 코드로 조절하려면 SDK 를 올려야 한다 — 그건 따로 할 일이다.
  const res = await anthropic().messages.create({
    model,
    max_tokens: maxTokens,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content }],
  });

  costTracker.inputTokens += res.usage.input_tokens;
  costTracker.outputTokens += res.usage.output_tokens;

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // 빈 본문을 그냥 돌려주면 호출부가 "JSON 이 아니다" 로 오진한다.
  // 진짜 원인은 파싱이 아니라 예산이므로 여기서 그대로 말한다.
  if (!text.trim()) {
    throw new EmptyResponseError(model, maxTokens, res.stop_reason);
  }

  return text;
}

/**
 * JSON 응답을 강제한다.
 *
 * 모델이 설명을 덧붙이는 경우가 있어 첫 `{` 부터 마지막 `}` 까지 잘라낸 뒤 파싱한다.
 * 그래도 실패하면 한 번 더 시도하고, 두 번 실패하면 던진다.
 */
export async function askJson<T>(prompt: string, opts: AskOptions = {}): Promise<T> {
  const system = [
    opts.system,
    'JSON 객체 하나만 출력한다. 코드펜스, 설명, 머리말을 붙이지 않는다.',
  ]
    .filter(Boolean)
    .join('\n\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await ask(prompt, { ...opts, system });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch (e) {
        if (attempt === 2) {
          throw new Error(`JSON 파싱 실패: ${(e as Error).message}\n원문: ${raw.slice(0, 500)}`);
        }
      }
    } else if (attempt === 2) {
      throw new Error(`JSON 형태가 아닙니다: ${raw.slice(0, 500)}`);
    }
  }
  throw new Error('도달 불가');
}

/** 대략적인 비용 추정(USD). 정확한 청구액이 아니라 런당 규모 파악용. */
export function estimateCostUsd(): number {
  const inputPerMTok = 5;
  const outputPerMTok = 25;
  return (
    (costTracker.inputTokens / 1_000_000) * inputPerMTok +
    (costTracker.outputTokens / 1_000_000) * outputPerMTok
  );
}
