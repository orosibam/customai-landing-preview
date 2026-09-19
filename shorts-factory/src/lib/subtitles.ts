import { writeFile } from 'node:fs/promises';
import { VIDEO } from '../config.js';

/**
 * ASS 자막 생성.
 *
 * 타입캐스트가 문장별 오디오 길이를 주기 때문에, 그 길이를 누적하면
 * 자막 타임스탬프가 그대로 나온다. 원본 방법론이 쓰던 브루(Vrew) 싱크 단계가
 * 통째로 필요 없어지는 지점이다.
 */

export interface SubtitleLine {
  text: string;
  durationSec: number;
}

function toAssTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** ASS 특수문자 이스케이프 + 줄바꿈 처리. */
function escape(text: string): string {
  return text.replace(/\\/g, '＼').replace(/\{/g, '（').replace(/\}/g, '）').replace(/\n/g, '\\N');
}

/**
 * 긴 문장을 두 줄로 쪼갠다. 쇼츠 화면에서 한 줄이 너무 길면 읽히지 않는다.
 * 어절 경계에서만 자른다.
 */
function wrap(text: string, maxPerLine = 16): string {
  if (text.length <= maxPerLine) return text;
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current && (current + ' ' + w).length > maxPerLine) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  // 3줄 이상이면 화면을 가린다. 2줄로 강제 병합.
  if (lines.length > 2) {
    const mid = Math.ceil(lines.length / 2);
    return [lines.slice(0, mid).join(' '), lines.slice(mid).join(' ')].join('\n');
  }
  return lines.join('\n');
}

export interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  /** 화면 아래에서 띄울 거리(px). 플랫폼 UI에 가리지 않을 높이. */
  marginBottom: number;
}

export const DEFAULT_STYLE: SubtitleStyle = {
  fontName: 'NanumGothic',
  fontSize: 72,
  primaryColor: '&H00FFFFFF', // 흰색
  outlineColor: '&H00000000', // 검은 테두리
  outlineWidth: 5,
  marginBottom: 420,
};

export async function writeAss(
  lines: SubtitleLine[],
  outputPath: string,
  style: SubtitleStyle = DEFAULT_STYLE,
  /** 한 줄 최대 글자수. 글자를 크게 쓸수록 줄이 짧아야 화면을 안 넘는다. */
  maxCharsPerLine = 16,
): Promise<void> {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${VIDEO.width}`,
    `PlayResY: ${VIDEO.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Main,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},&H00000000,-1,0,0,0,100,100,0,0,1,${style.outlineWidth},2,2,80,80,${style.marginBottom},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  let cursor = 0;
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.durationSec;
    events.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Main,,0,0,0,,${escape(wrap(line.text, maxCharsPerLine))}`,
    );
    cursor = end;
  }

  await writeFile(outputPath, [...header, ...events].join('\n'), 'utf8');
}

/** 자막 전체 길이. 영상 길이 검증에 쓴다. */
export function totalDuration(lines: SubtitleLine[]): number {
  return lines.reduce((sum, l) => sum + l.durationSec, 0);
}
