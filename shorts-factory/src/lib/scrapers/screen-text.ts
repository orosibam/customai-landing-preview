import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFrames } from '../ffmpeg.js';
import { askJson } from '../llm.js';

/**
 * 화면에 중국어가 박힌 소재를 걸러낸다.
 *
 * ## 왜 필요한가
 *
 * 1688·타오바오 판매자 영상에는 중국어 자막과 워터마크가 화면에 그대로 박혀 있다.
 * 그걸 한국 시청자에게 내보내면 **한 컷 만에 "남의 나라 광고" 로 읽힌다.** 사용자가
 * 첫 완성본을 보고 제일 먼저 지적한 것이 이것이다.
 *
 * 자르거나 가릴 수도 있지만 위치가 제각각이라(위·아래·구석·화면 한가운데) 잘라내면
 * 제품이 같이 잘린다. 소재가 12개쯤 되므로 **깨끗한 것만 골라 쓰는 편이 낫다.**
 *
 * ## 한 번에 물어본다
 *
 * 클립마다 한 장씩 뽑아 **한 번의 호출**로 전부 판정한다. 12개를 12번 물어보면
 * 느리고 비싸다. 싼 모델로 충분한 일이다 — "글자가 있나 없나" 는 판단이 아니라
 * 관찰이다.
 */
export interface ScreenTextVerdict {
  /** 화면에 중국어(한자)가 보이는 소재의 인덱스 */
  chinese: number[];
  /** 왜 그렇게 봤는지 한 줄씩. 로그에 남겨 사람이 확인할 수 있게 한다. */
  why: string;
}

/**
 * 클립마다 대표 프레임 한 장을 떠서 중국어 유무를 판정한다.
 *
 * 프레임을 한 장만 보는 건 타협이다. 워터마크는 대개 영상 내내 있으므로 한 장이면
 * 잡히지만, 중간에만 뜨는 자막은 놓칠 수 있다. 놓친 건 승인 화면에서 사람이 본다.
 */
export async function findChineseOnScreen(clipPaths: string[]): Promise<ScreenTextVerdict> {
  if (clipPaths.length === 0) return { chinese: [], why: '소재가 없습니다.' };

  const images: { mediaType: 'image/jpeg'; base64: string }[] = [];
  const kept: number[] = [];

  for (const [i, path] of clipPaths.entries()) {
    try {
      const dir = await mkdtemp(join(tmpdir(), 'screentext-'));
      // 가운데쯤 한 장. 맨 앞은 검은 화면인 경우가 잦다.
      await extractFrames(path, join(dir, 'f-%02d.jpg'), 1);
      const files = (await readdir(dir)).filter((f) => f.startsWith('f-')).sort();
      const first = files[0];
      if (!first) continue;
      images.push({
        mediaType: 'image/jpeg',
        base64: (await readFile(join(dir, first))).toString('base64'),
      });
      kept.push(i);
    } catch (e) {
      // 프레임을 못 뜨는 소재는 판정 대상에서 빼되 조용히 넘기지 않는다.
      console.warn(`소재 ${i} 프레임 추출 실패, 중국어 판정에서 제외: ${(e as Error).message}`);
    }
  }

  if (images.length === 0) return { chinese: [], why: '프레임을 한 장도 못 떴습니다.' };

  const answer = await askJson<{ chinese_indexes: number[]; why: string }>(
    `첨부한 이미지들은 쇼핑 쇼츠에 쓸 영상 소재에서 뽑은 화면이다.
순서대로 0번부터다 (총 ${images.length}장).

각 화면에 **중국어(한자)가 글자로 보이는지** 판정해라.

포함: 자막, 워터마크, 로고, 상품 포장의 한자, 화면 구석의 판매자명.
제외: 제품 자체에 아주 작게 새겨져 읽을 수 없는 각인. 영어·한국어·숫자.

우리 시청자는 한국인이다. 화면에 한자가 보이면 그 한 컷에 "남의 나라 광고" 로
읽혀서 이탈한다. 애매하면 **있다고 본다** — 쓸 수 있는 소재는 남아 있다.

{"chinese_indexes":[0,3],"why":"각 판정 이유를 한 줄로"}`,
    { tier: 'fast', maxTokens: 4096, images },
  );

  // LLM 이 돌려준 인덱스는 "프레임을 뜬 것들" 기준이다. 원래 소재 인덱스로 되돌린다.
  // 이걸 빼먹으면 엉뚱한 소재가 버려진다.
  const chinese = (answer.chinese_indexes ?? [])
    .map((i) => kept[i])
    .filter((i): i is number => i !== undefined);

  return { chinese, why: answer.why ?? '' };
}
