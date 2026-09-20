/**
 * Phase 0 점검 스크립트.
 *
 * 나머지를 다 지어놓고 여기서 막히는 게 가장 흔한 실패다. 공장을 짓기 전에
 * 막히는 지점부터 확인한다. 네트워크가 열린 환경(로컬 또는 Actions)에서 돌린다.
 *
 *   npx tsx src/probe.ts                        전체
 *   npx tsx src/probe.ts typecast               하나만
 *   npx tsx src/probe.ts cn-bridge xiaohongshu  골라서
 */

import { VOICE_PRESETS } from './lib/typecast.js';
import { tiktokScraper } from './lib/scrapers/tiktok.js';
import { instagramScraper } from './lib/scrapers/instagram.js';
import { xiaohongshuScraper } from './lib/scrapers/xiaohongshu.js';
import { collectClips } from './lib/scrapers/ali1688.js';
import { selfcheck } from './lib/scrapers/cn-bridge.js';
import { outlierScore } from './lib/scrapers/types.js';
import { closeBrowser } from './lib/browser.js';
import { probe as probeMedia } from './lib/ffmpeg.js';
import { optionalEnv } from './config.js';

interface Check {
  name: string;
  /** 이게 막히면 파이프라인 전체가 못 돈다 */
  blocking: boolean;
  run: () => Promise<string>;
}

const CHECKS: Check[] = [
  {
    name: 'ffmpeg',
    blocking: true,
    run: async () => {
      // 1초짜리 무음 영상을 만들어 probe 해본다.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const out = join(tmpdir(), `probe-${Date.now()}.mp4`);
      await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=1', '-c:v', 'libx264', out,
      ]);
      const info = await probeMedia(out);
      return `${info.width}x${info.height}, ${info.durationSec.toFixed(1)}초 생성·분석 성공`;
    },
  },
  {
    name: 'typecast',
    blocking: true,
    run: async () => {
      const missing = Object.entries(VOICE_PRESETS)
        .filter(([, p]) => !p.actorId)
        .map(([k]) => k);
      if (missing.length > 0) {
        throw new Error(
          `보이스 프리셋의 actorId 가 비어 있습니다: ${missing.join(', ')}\n` +
            `   타입캐스트 계정에서 액터 ID를 확인해 환경변수를 채우세요.`,
        );
      }
      if (!process.env.TYPECAST_API_TOKEN) {
        throw new Error(
          'TYPECAST_API_TOKEN 이 없습니다. API 플랜이 가능한지 확인하고, ' +
            '불가하면 웹 자동화 경로를 구현해야 합니다.',
        );
      }
      const { narrate } = await import('./lib/typecast.js');
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'tc-probe-'));
      const first = Object.keys(VOICE_PRESETS)[0]!;
      const result = await narrate(['세차했는데도 광택이 금방 사라지죠?'], {
        presetKey: first,
        outDir: dir,
      });
      const line = result.lines[0]!;
      return `합성 성공 (${result.mode}) — "${line.textSpoken}" ${line.durationSec.toFixed(2)}초`;
    },
  },
  {
    name: 'tiktok',
    blocking: false,
    run: async () => {
      const refs = await tiktokScraper.search({ keyword: 'car shampoo', limit: 3, maxAgeDays: 90 });
      if (refs.length === 0) throw new Error('결과 0건');
      return `${refs.length}건 (최고 아웃라이어 ${outlierScore(refs[0]!).toFixed(1)}x)`;
    },
  },
  {
    name: 'instagram',
    blocking: false,
    run: async () => {
      const refs = await instagramScraper.search({ keyword: 'carshampoo', limit: 3, maxAgeDays: 90 });
      if (refs.length === 0) throw new Error('결과 0건');
      return `${refs.length}건`;
    },
  },
  {
    // 아래 두 점검보다 먼저 본다. 여기서 막히면 샤오홍슈·1688 둘 다 의미가 없다.
    name: 'cn-bridge',
    blocking: true,
    run: async () => {
      const s = await selfcheck();
      if (!s.hasInitialState) {
        throw new Error(
          `샤오홍슈가 HTTP ${s.xhsStatus}, ${s.xhsBytes}바이트를 줬지만 __INITIAL_STATE__ 가 ` +
            `없습니다. TLS 지문 흉내가 안 먹히거나(curl_cffi 프로필 '${s.impersonate}') 차단된 것입니다.`,
        );
      }
      return `curl_cffi(${s.impersonate}) → HTTP ${s.xhsStatus}, SSR ${s.xhsBytes}바이트, __INITIAL_STATE__ 있음`;
    },
  },
  {
    // 수확 재고가 없으면 이 둘은 돌 수 없다. 그건 코드 고장이 아니라 사람 손이
    // 필요하다는 신호라, 다른 실패와 섞이지 않게 문구를 구분한다.
    name: 'xiaohongshu',
    blocking: false,
    run: async () => {
      const refs = await xiaohongshuScraper.search({ keyword: '洗车液', limit: 3, maxAgeDays: 90 });
      const withVideo = refs.filter((r) => r.videoUrl).length;
      return `${refs.length}건 (영상 있는 것 ${withVideo}건)`;
    },
  },
  {
    name: '1688',
    blocking: false,
    run: async () => {
      const clips = await collectClips({ keywordZh: '洗车液', limit: 5 });
      return `상품 영상 ${clips.length}개 발견`;
    },
  },
  {
    name: 'youtube-audit',
    blocking: true,
    run: async () => {
      if (!optionalEnv('YOUTUBE_CREDENTIALS_YT_KITCHEN', '')) {
        throw new Error('채널 자격증명이 없습니다. OAuth refresh token 을 먼저 발급하세요.');
      }
      return (
        '자격증명 확인됨. ⚠️ 이 점검으로는 감사 통과 여부를 알 수 없습니다 — ' +
        '테스트 채널에 1건 업로드한 뒤 Studio 에서 공개 전환이 되는지 직접 확인하세요.'
      );
    },
  },
];

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const checks = only.length > 0 ? CHECKS.filter((c) => only.includes(c.name)) : CHECKS;

  // 이름을 잘못 적었는데 조용히 0건을 돌리면 "점검했다" 고 착각하게 된다.
  const unknown = only.filter((name) => !CHECKS.some((c) => c.name === name));
  if (unknown.length > 0) {
    console.error(
      `알 수 없는 점검: ${unknown.join(', ')}\n사용 가능: ${CHECKS.map((c) => c.name).join(', ')}`,
    );
    process.exit(1);
  }

  console.log('\nPhase 0 점검\n');
  let blockingFailures = 0;

  for (const check of checks) {
    process.stdout.write(`  ${check.name.padEnd(16)} `);
    try {
      const detail = await check.run();
      console.log(`✓  ${detail}`);
    } catch (e) {
      // 재고 소진은 고장이 아니다. 같은 '✗' 로 찍으면 코드를 고치려 들게 된다.
      const isEmpty = (e as Error).name === 'LinkStoreEmptyError';
      const mark = isEmpty ? '·  [재고없음]' : check.blocking ? '✗  [차단]' : '!  [비차단]';
      console.log(`${mark} ${(e as Error).message}`);
      if (check.blocking && !isEmpty) blockingFailures++;
    }
  }

  await closeBrowser();

  console.log(
    blockingFailures === 0
      ? '\n차단 항목 없음. Phase 1로 진행할 수 있습니다.\n'
      : `\n차단 항목 ${blockingFailures}건. 이걸 먼저 뚫어야 합니다.\n`,
  );
  process.exit(blockingFailures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
