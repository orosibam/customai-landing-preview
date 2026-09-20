import { writeFile, mkdir } from 'node:fs/promises';
import { optionalEnv, requireEnv } from '../config.js';
import { estimateDurationSec, normalizeForSpeech } from './korean.js';
import { probe } from './ffmpeg.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /**
   * edge-tts 음성 이름.
   *
   * 엣지의 한국어 음성은 몇 개 안 돼서 프리셋 여럿이 같은 음성을 공유한다.
   * 다섯 채널에 다섯 목소리가 있는 척하지 않는다 — 실제로 있는 건 여성/남성
   * 두 갈래이고, 채널 구분은 속도·피치로만 낸다. 몇 개가 실제로 있는지는
   * `python3 scrapers-py/tts_edge.py voices` 가 답한다.
   */
  edgeVoice: string;
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
    edgeVoice: optionalEnv('EDGE_VOICE_FEMALE', 'ko-KR-SunHiNeural'),
    emotion: 'normal',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  // 주방용품 채널
  'calm-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_CALM_FEMALE', 'tc_69f2e455ea79fd197aa0476f'),
    edgeVoice: optionalEnv('EDGE_VOICE_FEMALE', 'ko-KR-SunHiNeural'),
    emotion: 'normal',
    pitch: 0,
    speed: 0.98,
    pauseSec: 0,
  },
  // 생활·인테리어 채널
  'soft-female': {
    actorId: optionalEnv('TYPECAST_ACTOR_SOFT_FEMALE', 'tc_68d4b115f0486108a7eefb37'),
    edgeVoice: optionalEnv('EDGE_VOICE_FEMALE', 'ko-KR-SunHiNeural'),
    emotion: 'normal',
    pitch: 1,
    speed: 1.0,
    pauseSec: 0,
  },
  // 가전·가젯 채널
  'energetic-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_ENERGETIC_MALE', 'tc_6a4f2130d153a5cac8e19996'),
    edgeVoice: optionalEnv('EDGE_VOICE_MALE', 'ko-KR-InJoonNeural'),
    emotion: 'happy',
    pitch: 1,
    speed: 1.1,
    pauseSec: 0,
  },
  // 뷰티·헬스 채널
  'bright-male': {
    actorId: optionalEnv('TYPECAST_ACTOR_BRIGHT_MALE', 'tc_6a7446c19f2d7dfed990a900'),
    edgeVoice: optionalEnv('EDGE_VOICE_MALE', 'ko-KR-InJoonNeural'),
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
  /** 어느 제공자로 합성했는가. narrations.source_mode 에 그대로 남는다. */
  mode: 'edge' | 'api' | 'browser';
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
/**
 * edge-tts 합성 — 지금의 기본 경로.
 *
 * ## 왜 기본이 됐나
 *
 * 타입캐스트 무료 계정이 막혔다 (실측 2026-09-20):
 *   403 {"error_code":"UNUSUAL_ACTIVITY_DETECTED", ... "subscribe to one of our paid plans"}
 * 키도 코드도 아니고 요금제 문제라 코드로 풀 수 없다. 결제 전까지는 건드리지도
 * 않는다 — 응답에 "계속하면 접근이 정지될 수 있다" 고 적혀 있다.
 *
 * edge-tts 는 키·가입·결제가 없다. 대신 **우리가 통제할 수 없는 서비스**이므로
 * 막히면 막히는 대로 드러나야 한다. 파이썬 쪽이 빈 파일을 걸러 던지고, 여기서는
 * 그 메시지를 그대로 올린다.
 *
 * ## 프리셋 값을 어떻게 옮기는가
 *
 * 타입캐스트의 speed(배율)·pitch(반음)를 엣지의 rate(%)·pitch(Hz)로 바꾼다.
 *   · speed 1.1  →  rate "+10%"
 *   · pitch 1    →  pitch "+12Hz"   (반음 하나가 대략 6%, 여성 음역 200Hz 기준)
 *
 * 뒤쪽 환산은 **어림값이다.** 정확한 대응이 아니라서, 실제 들어보고 조정할
 * 여지를 env 로 열어뒀다(EDGE_PITCH_HZ_PER_SEMITONE).
 */
async function synthesizeViaEdge(
  textSpoken: string,
  preset: VoicePreset,
  outPath: string,
): Promise<void> {
  const ratePct = Math.round((preset.speed - 1) * 100);
  const hzPerSemitone = Number(optionalEnv('EDGE_PITCH_HZ_PER_SEMITONE', '12'));
  const pitchHz = Math.round(preset.pitch * hzPerSemitone);

  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

  await runPython([
    'synth',
    '--text',
    textSpoken,
    '--voice',
    preset.edgeVoice,
    '--rate',
    `${sign(ratePct)}%`,
    '--pitch',
    `${sign(pitchHz)}Hz`,
    '--out',
    outPath,
  ]);
}

/** tts_edge.py 호출. 실패하면 파이썬이 적은 이유를 그대로 올린다. */
function runPython(args: string[]): Promise<unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, '..', '..', 'scrapers-py', 'tts_edge.py');
  const python = optionalEnv('PYTHON_BIN', 'python3');

  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) =>
      reject(new Error(`${python} 를 실행하지 못했습니다 (${e.message}).`)),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`edge-tts 합성 실패: ${err.trim() || `종료코드 ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({});
      }
    });
  });
}

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

  /**
   * 어느 제공자를 쓸 것인가.
   *
   * 기본은 edge 다 — 타입캐스트 무료 계정이 403 UNUSUAL_ACTIVITY_DETECTED 로
   * 막혔고(실측 2026-09-20), 그건 결제로만 풀린다. 결제한 뒤에는
   * TTS_PROVIDER=typecast 한 줄로 되돌아온다.
   */
  const provider = optionalEnv('TTS_PROVIDER', 'edge');
  let mode: 'edge' | 'api' | 'browser' =
    opts.forceBrowser ? 'browser' : provider === 'typecast' ? 'api' : 'edge';
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

    if (mode === 'edge') {
      await synthesizeViaEdge(normalized.text, preset, audioPath);
    } else if (mode === 'api') {
      try {
        await synthesizeViaApi(normalized.text, preset, audioPath);
      } catch (e) {
        // 폴백을 없앴다.
        //
        // 403·401 이면 브라우저 경로로 넘어가게 되어 있었는데 **그 경로는 구현돼
        // 있지 않다.** 결과적으로 로그의 마지막 말이 "웹 자동화가 아직 구현되지
        // 않았습니다" 가 되어, 원인이 미구현인 것처럼 보였다. 진짜 원인은 그 앞의
        // 403 이고 대응도 전혀 다르다. 없는 폴백을 가리키느니 진짜 이유로 죽는다.
        //
        // 특히 UNUSUAL_ACTIVITY_DETECTED 는 **더 때리면 안 되는** 신호다 —
        // 계정이 정지될 수 있다고 응답에 적혀 있다. 재시도도 폴백도 하지 않는다.
        if (e instanceof TypecastApiError && e.message.includes('UNUSUAL_ACTIVITY_DETECTED')) {
          throw new Error(
            `타입캐스트 무료 계정이 막혔습니다 (403 UNUSUAL_ACTIVITY_DETECTED).\n` +
              `   키나 코드 문제가 아닙니다. 무료 계정으로 API 를 반복 호출한 게 걸린 것이고,\n` +
              `   응답에 "계속하면 접근이 정지될 수 있다" 고 적혀 있어 재시도하지 않습니다.\n` +
              `   유료 플랜이 필요합니다: https://typecast.ai/pricing/api\n` +
              `   원문: ${e.message}`,
          );
        }
        throw e;
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
