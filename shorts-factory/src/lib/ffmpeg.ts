import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_CLIP_SEC, MIN_CLIP_SEC, VIDEO } from '../config.js';

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

async function ff(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout || stderr;
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        `${bin} 을 찾을 수 없습니다. GitHub Actions ubuntu 러너에는 기본 탑재되어 있고, ` +
          `로컬에서는 설치 후 FFMPEG_PATH / FFPROBE_PATH 로 경로를 지정하세요.`,
      );
    }
    throw new Error(`${bin} 실패: ${err.stderr?.slice(-2000) || err.message}`);
  }
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await ff(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type: string; width?: number; height?: number }[];
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(json.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(json.streams?.some((s) => s.codec_type === 'audio')),
  };
}

/**
 * 소스 클립에서 한 조각을 잘라 9:16 세로 규격으로 정규화한다.
 *
 * 길이 상한(MAX_CLIP_SEC)을 여기서 강제한다. 공정이용 근거가 "각 영상에서 3~5초만" 이므로
 * 호출부가 실수로든 고의로든 더 긴 값을 넘기면 렌더가 진행되지 않고 죽는다.
 * 이 검사를 우회하는 경로를 만들지 않는 것이 이 함수의 존재 이유다.
 */
export interface TrimOptions {
  /**
   * 재생 속도 배율. 소스 상품 영상은 대체로 늘어져서 1.0으로 두면 지루하다.
   * 타겟 프로파일이 값을 준다 (시니어 1.3, 일반 1.0).
   */
  speed?: number;
  /**
   * 좌우 반전. 표준 영상 변환이지만, 이걸 켜는 실무적 이유는 플랫폼의
   * 중복 영상 판정을 피하려는 것이다. 그 판단은 운영자가 한다.
   */
  mirror?: boolean;
  /** 확대 비율. 1.1이면 110%. 크롭 여백을 없애고 워터마크를 프레임 밖으로 밀어낸다. */
  zoom?: number;
}

export async function trimToPortrait(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
  opts: TrimOptions = {},
): Promise<void> {
  if (durationSec > MAX_CLIP_SEC) {
    throw new Error(
      `클립 길이 ${durationSec.toFixed(2)}초가 상한 ${MAX_CLIP_SEC}초를 넘습니다. ` +
        `공정이용 근거가 무너지므로 렌더를 중단합니다.`,
    );
  }
  if (durationSec < MIN_CLIP_SEC) {
    throw new Error(`클립 길이 ${durationSec.toFixed(2)}초가 하한 ${MIN_CLIP_SEC}초 미만입니다.`);
  }

  const { width: W, height: H, fps } = VIDEO;
  const speed = opts.speed ?? 1;
  const zoom = opts.zoom ?? 1;

  // 속도를 올리면 원하는 결과 길이를 얻기 위해 소스를 그만큼 더 읽어야 한다.
  const sourceDuration = durationSec * speed;

  const filters = [
    `scale=${Math.round(W * zoom)}:${Math.round(H * zoom)}:force_original_aspect_ratio=increase`,
    // 짧은 변을 맞춰 확대한 뒤 가운데를 잘라낸다. 여백(레터박스) 없이 화면을 꽉 채운다.
    `crop=${W}:${H}`,
  ];
  if (opts.mirror) filters.push('hflip');
  if (speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  filters.push(`fps=${fps}`, 'setsar=1');

  await ff(FFMPEG, [
    '-y',
    '-ss', startSec.toFixed(3),
    '-t', sourceDuration.toFixed(3),
    '-i', input,
    '-vf', filters.join(','),
    '-an', // 소스 오디오는 버린다. 나레이션만 쓴다.
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    output,
  ]);
}

/** 정규화된 클립들을 순서대로 이어붙인다. 전부 같은 규격이라 재인코딩 없이 붙는다. */
export async function concatClips(inputs: string[], output: string, listFile: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(listFile, inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff(FFMPEG, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    output,
  ]);
}

/** 문장별 나레이션 오디오를 공백 없이 이어붙인다 (끊어읽기 0초). */
export async function concatAudio(inputs: string[], output: string, listFile: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(listFile, inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);
}

export interface MuxOptions {
  video: string;
  narration: string;
  subtitles: string;
  bgm?: string;
  /** BGM 볼륨 비율. 나레이션이 묻히지 않게 낮게 둔다. */
  bgmGain?: number;
  output: string;
}

/**
 * 영상 + 나레이션 + 자막(+BGM)을 합쳐 최종본을 만든다.
 * 자막은 ASS 로 번인한다 — 플랫폼이 자막을 꺼도 항상 보여야 한다.
 */
export async function mux(opts: MuxOptions): Promise<void> {
  const { video, narration, subtitles, bgm, output } = opts;
  const bgmGain = opts.bgmGain ?? 0.12;

  const args = ['-y', '-i', video, '-i', narration];
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm);

  const audioFilter = bgm
    ? `[1:a]aformat=sample_fmts=fltp:sample_rates=48000[voice];` +
      `[2:a]volume=${bgmGain},aformat=sample_fmts=fltp:sample_rates=48000[bed];` +
      `[voice][bed]amix=inputs=2:duration=first:dropout_transition=0[mixed];` +
      `[mixed]loudnorm=I=${VIDEO.targetLoudnessLufs}:TP=-1.5:LRA=11[aout]`
    : `[1:a]loudnorm=I=${VIDEO.targetLoudnessLufs}:TP=-1.5:LRA=11[aout]`;

  const escaped = subtitles.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

  args.push(
    '-filter_complex', `${audioFilter};[0:v]ass='${escaped}'[vout]`,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    // 나레이션이 끝나면 영상도 끝난다. 뒤에 남는 무음 구간을 없앤다.
    '-shortest',
    output,
  );

  await ff(FFMPEG, args);
}

/** 설계도 추출용 프레임 샘플. 균등 간격으로 n장 뽑는다. */
export async function extractFrames(
  input: string,
  outputPattern: string,
  count: number,
): Promise<void> {
  const info = await probe(input);
  const interval = Math.max(info.durationSec / (count + 1), 0.3);
  await ff(FFMPEG, [
    '-y',
    '-i', input,
    '-vf', `fps=1/${interval.toFixed(3)},scale=540:-1`,
    '-frames:v', String(count),
    '-q:v', '4',
    outputPattern,
  ]);
}

export async function thumbnail(input: string, output: string, atSec = 1.0): Promise<void> {
  await ff(FFMPEG, [
    '-y',
    '-ss', atSec.toFixed(2),
    '-i', input,
    '-frames:v', '1',
    '-q:v', '3',
    output,
  ]);
}
