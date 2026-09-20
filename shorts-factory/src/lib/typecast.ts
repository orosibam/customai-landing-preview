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

/**
 * API 가 받는 감정 프리셋 전체 목록.
 *
 * 실측(2026-09-20): 여기 없는 값을 보내면 422 로 거부된다. 예전 형식인 'normal-1'
 * 같은 접미사 붙은 값을 쓰고 있었고 그대로 막혔다. 문자열로 두면 오타나 옛 형식이
 * 조용히 들어와 합성 단계에서야 터지므로, 타입으로 좁혀 컴파일 때 잡는다.
 */
export const EMOTION_PRESETS = [
  'normal', 'sad', 'happy', 'angry', 'regret', 'urgent', 'whisper', 'scream',
  'shout', 'trustful', 'soft', 'cold', 'sarcasm', 'inspire', 'cute', 'cheer',
  'casual', 'tonemid', 'toneup', 'tonedown',
] as const;

export type EmotionPreset = (typeof EMOTION_PRESETS)[number];

export interface VoicePreset {
  /** 타입캐스트 voice_id (기존 액터 ID와 같은 형식: tc_ + 24자) */
  actorId: string;
  /** 감정 프리셋. EMOTION_PRESETS 밖의 값은 API 가 422 로 거부한다. */
  emotion: EmotionPreset;
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
 * 채널별 보이스.
 *
 * 액터 ID는 비밀값이 아니라 공개 식별자라 여기 그대로 둔다. Secrets 로 빼면
 * 관리할 비밀이 다섯 개 늘어나는데, 얻는 게 없다. 계정을 바꾸거나 성우를
 * 교체할 때만 환경변수로 덮어쓴다.
 *
 * 속도는 타겟 프로파일(lib/audience.ts)이 덮어쓴다. 여기 값은 그 프로파일이
 * 없을 때의 기본값이다.
 */
export const VOICE_PRESETS: Record<string, VoicePreset> = {
  // 생활·수납용품 채널
  'warm-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_WARM_FEMALE', 'tc_65a0e1eb23a607b9906c0154'),
    emotion: 'normal',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  // 주방용품 채널
  'calm-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_CALM_FEMALE', 'tc_69f2e455ea79fd197aa0476f'),
    emotion: 'normal',
    pitch: 0,
    speed: 0.98,
    pauseSec: 0,
  },
  // 생활·인테리어 채널
  'soft-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_SOFT_FEMALE', 'tc_68d4b115f0486108a7eefb37'),
    emotion: 'normal',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  // 가전·가젯 채널
  'energetic-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_ENERGETIC_MALE', 'tc_6a4f2130d153a5cac8e19996'),
    emotion: 'happy',
    pitch: 1,
    speed: 1.1,
    pauseSec: 0,
  },
  // 뷰티·헬스 채널
  'bright-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_BRIGHT_MALE', 'tc_6a7446c19f2d7dfed990a900'),
    emotion: 'happy',
    pitch: 1,
    speed: 1.05,
    pauseSec: 0,
  },
};

export function voicePreset(key: string): VoicePreset {
  const preset = VOICE_PRESETS[key];
  if (!preset) throw new Error(`알 수 없는 보이스 프리셋: ${key}`);
  if (!preset.actorId) {
    throw new Error(
      `보이스 프리셋 "${key}" 의 actorId 가 비어 있습니다. ` +
        `타입캐스트 계정의 API 메뉴에서 액터 ID를 확인해 환경변수를 채우세요.`,
    );
  }
  // 액터 ID는 tc_ 로 시작한다. 성우 이름이나 화면에 보이는 라벨을 넣는 실수가 잦아서
  // 여기서 막는다 — 안 막으면 합성 요청이 400 으로 떨어지고 원인을 찾기 어렵다.
  if (!/^tc_[0-9a-f]+$/i.test(preset.actorId)) {
    throw new Error(
      `보이스 프리셋 "${key}" 의 actorId 형식이 이상합니다: "${preset.actorId}"\n` +
        `  tc_ 로 시작하는 식별자여야 합니다 (예: tc_60e5426de8b95f1d3000d7b5).\n` +
        `  성우 이름이 아니라 액터 ID를 넣으셨는지 확인하세요.`,
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

const API_BASE = optionalEnv('TYPECAST_API_BASE', 'https://api.typecast.ai/v1');

/**
 * 타입캐스트 합성.
 *
 * ## 이전 구현이 틀렸던 것
 *
 * 「요청을 넣으면 상태 URL 을 주고, done 이 될 때까지 폴링한 뒤 오디오를 받는다」로
 * 짜여 있었다. 실측(2026-09-20)에서 전부 틀린 것으로 드러났다:
 *
 *   · 호스트  typecast.ai/api        →  api.typecast.ai/v1
 *   · 인증    Authorization: Bearer  →  X-API-KEY
 *   · 경로    /speak (404)           →  /text-to-speech
 *   · 흐름    상태 URL → 폴링 → 다운로드  →  오디오가 응답 본문으로 바로 온다
 *
 * 옛 조합은 403 을 돌려줬는데, 403 만 보고 "요금제 문제" 로 단정했으면 엉뚱한 데를
 * 팠을 것이다. 다른 호스트가 401 을 준 게 단서였다 — 401 은 "엔드포인트는 있는데
 * 이 인증이 아니다" 라는 뜻이다.
 *
 * ## 길이는 응답에서 안 온다
 *
 * 헤더에 content-length 뿐이고 재생 길이가 없다. 자막 타임스탬프가 이 값에
 * 달려 있으므로 파일을 받아 ffprobe 로 직접 잰다 (narrate 쪽에서 한다).
 */
async function synthesizeViaApi(
  textSpoken: string,
  preset: VoicePreset,
  outPath: string,
): Promise<void> {
  const token = requireEnv('TYPECAST_API_TOKEN');

  const res = await fetch(`${API_BASE}/text-to-speech`, {
    method: 'POST',
    headers: {
      'X-API-KEY': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      voice_id: preset.actorId,
      text: textSpoken,
      model: optionalEnv('TYPECAST_MODEL', 'ssfm-v21'),
      language: 'kor',
      prompt: {
        emotion_preset: preset.emotion,
      },
      output: {
        // 0.5~2.0 배. 시니어 대상은 1.25 근처를 쓴다.
        audio_tempo: preset.speed,
        // 반음 단위. 영상에서 +1 이 적정, +2 는 과하다고 판정됐다.
        audio_pitch: preset.pitch,
        volume: 100,
        audio_format: 'wav',
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TypecastApiError(
      res.status,
      `${res.status} ${res.statusText} ${body.slice(0, 400)}`,
    );
  }

  const ctype = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());

  // 오디오 대신 JSON 이 200 으로 오는 경우가 있다. 무음 파일을 만들어 넘기느니
  // 여기서 죽는 편이 낫다 — 소리 없는 영상은 며칠 뒤에야 발견된다.
  if (!ctype.includes('audio') && !ctype.includes('octet-stream')) {
    throw new TypecastApiError(
      200,
      `오디오가 아닌 응답입니다 (${ctype}): ${bytes.toString('utf8').slice(0, 300)}`,
    );
  }
  if (bytes.byteLength < 1_024) {
    throw new TypecastApiError(
      200,
      `오디오가 ${bytes.byteLength}바이트뿐입니다. 합성이 실패했을 수 있습니다.`,
    );
  }

  await writeFile(outPath, bytes);
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
  /**
   * 프리셋의 속도를 덮어쓴다.
   *
   * 타입캐스트 기본값은 쇼츠에 쓰기엔 느려서 시청자가 중간에 나간다.
   * 1.2~1.3배 구간이 실전에서 검증된 값이다. 타겟 프로파일이 이 값을 준다.
   */
  speedOverride?: number;
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
  const base = voicePreset(opts.presetKey);
  const preset: VoicePreset = opts.speedOverride
    ? { ...base, speed: opts.speedOverride }
    : base;
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
