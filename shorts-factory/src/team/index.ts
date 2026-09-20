import type { TeamMember } from './types.js';
import { scout } from './members/scout.js';
import { merchandiser } from './members/merchandiser.js';
import { sourcer } from './members/sourcer.js';
import { analyst } from './members/analyst.js';
import { writer } from './members/writer.js';
import { voice } from './members/voice.js';
import { editor } from './members/editor.js';
import { qa } from './members/qa.js';
import { publisher } from './members/publisher.js';
import { growth } from './members/growth.js';

/**
 * 팀 명부.
 *
 * 영상 한 편은 이 순서대로 담당자들의 손을 거친다. 각자 전문성 하나만 맡고,
 * 자기 결과물을 자기가 검수하고, 다음 담당자에게 메모를 남긴다.
 *
 * publisher 와 growth 는 제작 라인에 들어가지 않는다.
 * 유통은 사람이 승인한 뒤에, 성장 분석은 배포 며칠 뒤에 각각 따로 돈다.
 */
export const PRODUCTION_LINE: TeamMember[] = [
  scout, // 소싱 담당   — 해외 인스타 릴스에서 터진 상품·영상 발굴
  // 제휴 담당이 소재 담당보다 앞에 있는 게 핵심이다. 소재·대본·렌더를 다 하고 나서
  // "한국에서 살 데가 없네" 를 알면 그 비용이 전부 날아간다. 여기서 버린다.
  merchandiser, // 제휴 담당   — 한국 제휴사에서 같은 제품 찾기 (없으면 폐기)
  sourcer, // 소재 담당   — 알리에서 해외 원본 확보
  analyst, // 구조 분석가 — 훅 유형·컷 배치·설득 순서 추출
  writer, // 카피라이터  — 타겟 화법으로 한국어 각색
  voice, // 성우 연출   — 타입캐스트 속도·피치 조율
  editor, // 편집자      — 컷 배정·자막·합성
  qa, // 품질 검수   — 승인 큐에 올릴지 판정
];

export const OFF_LINE_MEMBERS: TeamMember[] = [
  publisher, // 유통 담당   — 승인 후 업로드·링크
  growth, // 성장 분석   — 성과 집계·다음 사이클 조정
];

export const ALL_MEMBERS = [...PRODUCTION_LINE, ...OFF_LINE_MEMBERS];

export function memberById(id: string): TeamMember {
  const found = ALL_MEMBERS.find((m) => m.id === id);
  if (!found) throw new Error(`알 수 없는 담당자: ${id}`);
  return found;
}

/** 팀 구성을 사람이 읽는 형태로. `npx tsx src/stage.ts team` 이 출력한다. */
export function describeTeam(): string {
  const lines = ['제작 라인', ''];
  for (const [i, m] of PRODUCTION_LINE.entries()) {
    lines.push(`  ${i + 1}. ${m.role.padEnd(8)} ${m.expertise}`);
  }
  lines.push('', '라인 밖', '');
  for (const m of OFF_LINE_MEMBERS) {
    lines.push(`     ${m.role.padEnd(8)} ${m.expertise}`);
  }
  return lines.join('\n');
}

export { scout, merchandiser, sourcer, analyst, writer, voice, editor, qa, publisher, growth };
export * from './types.js';
