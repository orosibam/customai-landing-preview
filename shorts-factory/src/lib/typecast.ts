import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalEnv, requireEnv } from '../config.js';
import { estimateDurationSec, normalizeForSpeech } from './korean.js';
import { probe } from './ffmpeg.js';

/**
 * 타입캐스트 나레이션 클라이언트.
 *
 * 원본 방법론이 쓰는 도구를 그대로 쓴다. 자동화 경로는 두 가지:
 *   1) 공식 API  — 기본 경로
 *   2) 웹 자동화 — API가 막히거나 플랜 한도를 넘을 때 폴백
 *
 * 어느 쪽이든 반드시 **문장별로** 합성한다. 한 번에 통으로 뽑으면 문장별 길이를
 * 알 수 없고, 그러면 자막 싱크를 맞출 방법이 사라진다. 문장별 길이를 받아야
 * 원본이 쓰던 브루(Vrew) 싱크 단계를 통째로 건너뛸 수 있다.
 */

export interface VoicePreset {
  /** 타입캐스트 액터(성우) 식별자 */
  actorId: string;
  /** 감정 프리셋 */
  emotion: string;
  /** 피치. 영상에서 +1이 적정, +2는 과하다고 판정됐다. */
  pitch: number;
  /** 읽기 속도 배율 */
  speed: number;
  /**
   * 문장 사이 공백(초). 0으로 둔다.
   * 원본: "쇼츠에서 이 공백이 있으면 사람들은 되게 루즈해한다."
   */
  pauseSec: number;
}

/**
 * 채널별 보이스. actorId 는 계정마다 다르므로 환경변수로 뺀다.
 * Phase 0에서 실제 액터 목록을 확인해 채운다.
 */
export const VOICE_PRESETS: Record<string, VoicePreset> = {
  'warm-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_WARM_FEMALE', ''),
    emotion: 'normal-1',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  'bright-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_BRIGHT_MALE', ''),
    emotion: 'happy-1',
    pitch: 1,
    speed: 1.05,
    pauseSec: 0,
  },
  'calm-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_CALM_FEMALE', ''),
    emotion: 'normal-1',
    pitch: 0,
    speed: 0.98,
    pauseSec: 0,
  },
  'soft-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_SOFT_FEMALE', ''),
    emotion: 'normal-1',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  'energetic-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_ENERGETIC_MALE', ''),
    emotion: 'happy-1',
    pitch: 1,
    speed: 1.1,
    pauseSec: 0,
  },
};

export function voicePreset(key: string): VoicePreset {
  const preset = VOICE_PRESETS[key];
  if (!preset) throw new Error(`알 수 없는 보이스 프리셋: ${key}`);
  if (!preset.actorId) {
    throw new Error(
      `보이스 프리셋 "${key}" 의 actorId 가 비어 있습니다. ` +
        `Phase 0에서 타입캐스트 액터 목록을 확인해 환경변수를 채우세요.`,
    );
  }
  return preset;
}

export interface NarrationLine {
  idx: number;
  /** 화면에 뜰 원문 */
  text: string;
  /** 타입캐스트에 실제로 넘긴 발음 정규화본 */
  textSpoken: string;
  audioPath: string;
  durationSec: number;
  /** 추정 대비 실측이 크게 어긋나면 여기에 사유가 담긴다 */
  warning?: string;
}

export interface NarrationResult {
  lines: NarrationLine[];
  totalDurationSec: number;
  mode: 'api' | 'browser';
}

/**
 * 실측 길이가 추정에서 이 배수만큼 벗어나면 이상으로 본다.
 * 보통 원인은 전처리가 놓친 표기(영문·기호)를 성우가 더듬은 것이다.
 */
const DURATION_TOLERANCE = { min: 0.45, max: 2.2 } as const;

// ---------------------------------------------------------------------------
// API 경로
// ---------------------------------------------------------------------------

const API_BASE = optionalEnv('TYPECAST_API_BASE', 'https://typecast.ai/api');

/**
 * 타입캐스트 합성 요청 한 건.
 *
 * 요청/응답 매핑을 이 함수 하나에 가둬둔다. API 스펙이 바뀌거나 Phase 0 확인 결과가
 * 다르면 여기만 고치면 된다 — 나머지 파이프라인은 손대지 않는다.
 */
async function synthesizeViaApi(
  textSpoken: string,
  preset: VoicePreset,
  outPath: string,
): Promise<void> {
  const token = requireEnv('TYPECAST_API_TOKEN');

  const res = await fetch(`${API_BASE}/speak`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actor_id: preset.actorId,
      text: textSpoken,
      lang: 'auto',
      tempo: preset.speed,
      volume: 100,
      pitch: preset.pitch,
      emotion_tone_preset: preset.emotion,
      xapi_hd: true,
      // 문장 사이 공백 0 — 루즈해지지 않게.
      max_seconds: 30,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TypecastApiError(res.status, `${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { result?: { speak_v2_url?: string; audio_download_url?: string } };
  const audioUrl = payload.result?.audio_download_url ?? payload.result?.speak_v2_url;
  if (!audioUrl) {
    throw new TypecastApiError(200, `응답에 오디오 URL이 없습니다: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const audio = await fetch(audioUrl);
  if (!audio.ok) throw new TypecastApiError(audio.status, `오디오 다운로드 실패: ${audio.status}`);
  await writeFile(outPath, Buffer.from(await audio.arrayBuffer()));
}

export class TypecastApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`타입캐스트 API: ${message}`);
    this.name = 'TypecastApiError';
  }
}

// ---------------------------------------------------------------------------
// 브라우저 폴백 경로
// ---------------------------------------------------------------------------

/**
 * 웹 UI 자동화로 합성한다.
 *
 * API가 없거나 한도를 넘었을 때만 탄다. 웹 UI는 언제든 바뀌므로 실패하면
 * 조용히 넘어가지 말고 그대로 던진다 — 호출부가 대시보드에 수동 작업으로 띄운다.
 */
async function synthesizeViaBrowser(
  _textSpoken: string,
  _preset: VoicePreset,
  _outPath: string,
): Promise<void> {
  throw new Error(
    '타입캐스트 웹 자동화 경로가 아직 구현되지 않았습니다. ' +
      'Phase 0에서 API 사용이 가능한지 먼저 확인하고, 불가할 때 이 경로를 구현하세요. ' +
      '(로그인 세션을 storageState 로 보관 → 에디터에 문장 입력 → 다운로드 버튼)',
  );
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export interface NarrateOptions {
  presetKey: string;
  outDir: string;
  /** true 면 API를 건너뛰고 바로 브라우저 경로를 쓴다. */
  forceBrowser?: boolean;
}

/**
 * 문장 배열을 나레이션으로 만든다.
 *
 * 각 문장은 발음 정규화를 거친 뒤 개별 합성되고, 합성된 파일의 실제 길이를
 * ffprobe 로 재서 돌려준다. 이 길이가 그대로 자막 타임스탬프가 된다.
 */
export async function narrate(
  texts: string[],
  opts: NarrateOptions,
): Promise<NarrationResult> {
  const preset = voicePreset(opts.presetKey);
  await mkdir(opts.outDir, { recursive: true });

  let mode: 'api' | 'browser' = opts.forceBrowser ? 'browser' : 'api';
  const lines: NarrationLine[] = [];

  for (const [idx, raw] of texts.entries()) {
    const normalized = normalizeForSpeech(raw);
    if (normalized.formalEndings.length > 0) {
      throw new Error(
        `문어체 어미가 남아 있습니다: ${normalized.formalEndings.join(', ')} — "${raw}"\n` +
          `S5 대본 생성이 구어체 규칙을 못 지켰습니다. 대본을 재생성하세요.`,
      );
    }

    const audioPath = join(opts.outDir, `line-${String(idx).padStart(2, '0')}.wav`);

    if (mode === 'api') {
      try {
        await synthesizeViaApi(normalized.text, preset, audioPath);
      } catch (e) {
        if (e instanceof TypecastApiError && (e.status === 401 || e.status === 403 || e.status === 429)) {
          // 인증 실패나 한도 초과면 나머지 문장도 똑같이 실패한다. 경로를 바꾼다.
          console.warn(`타입캐스트 API 사용 불가(${e.status}) → 브라우저 경로로 전환합니다.`);
          mode = 'browser';
          await synthesizeViaBrowser(normalized.text, preset, audioPath);
        } else {
          throw e;
        }
      }
    } else {
      await synthesizeViaBrowser(normalized.text, preset, audioPath);
    }

    const info = await probe(audioPath);
    const expected = estimateDurationSec(normalized.text) / preset.speed;
    const ratio = info.durationSec / expected;

    const line: NarrationLine = {
      idx,
      text: raw,
      textSpoken: normalized.text,
      audioPath,
      durationSec: info.durationSec,
    };
    if (ratio < DURATION_TOLERANCE.min || ratio > DURATION_TOLERANCE.max) {
      line.warning =
        `길이 이상: 실측 ${info.durationSec.toFixed(2)}초 / 추정 ${expected.toFixed(2)}초 ` +
        `(비율 ${ratio.toFixed(2)}). 정규화가 놓친 표기가 있는지 확인하세요.`;
    }
    lines.push(line);
  }

  return {
    lines,
    totalDurationSec: lines.reduce((sum, l) => sum + l.durationSec, 0),
    mode,
  };
}
