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

/** 자유 텍스트 응답. */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const model = opts.tier === 'fast' ? MODELS.fast : MODELS.reasoning;

  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of opts.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: 'text', text: prompt });

  const res = await anthropic().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content }],
  });

  costTracker.inputTokens += res.usage.input_tokens;
  costTracker.outputTokens += res.usage.output_tokens;

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
