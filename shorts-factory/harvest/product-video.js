/**
 * 판매자 상품영상 수확기 — 상품 **상세 페이지**에서 mp4 주소를 직접 뽑는다.
 *
 * 왜 새로 만들었나
 * ----------------
 * 기존 `ali1688.js` 는 검색 결과에서 **상세 URL 만** 모았다. "상세는 로그인 없이
 * 열리니 주소만 있으면 나머지는 자동" 이라는 전제였는데, 그 전제가 깨졌다.
 *
 * 실측 (2026-09-20, GitHub 러너):
 *   · 알리익스프레스  상세 26번 열어서 0번 열림 — 전부 "_____tmd_____" 검증 페이지
 *   · 1688            검색 세 진입로 전부 차단 조각 응답
 *   · 타오바오        검색 페이지는 오는데 상품 id 0개
 *
 * 데이터센터 IP 가 막힌 것이라 요청을 바꿔서 될 일이 아니다. 그래서 **상세를 여는
 * 일까지** 사람 브라우저가 맡는다. 여기서 mp4 주소를 뽑아두면 러너는 CDN 에서
 * 파일만 받으면 된다 — CDN 은 상품 페이지와 다른 호스트라 정책도 다르다.
 *
 * 어디서 쓰나
 * -----------
 * 1688 / 알리익스프레스 / 타오바오 **상품 상세 페이지**에서 쓴다. 검색 결과 페이지가
 * 아니다. 영상이 있는 상품이어야 하므로, 페이지에 재생 버튼이 보이는 상품을 연다.
 *
 * 쓰는 법
 * -------
 *   1. 상품 상세 페이지를 연다
 *   2. F12 → Console → 이 파일을 통째로 붙여넣고 Enter
 *   3. 찾은 mp4 주소가 **브라우저 저장소에 쌓인다** (파일은 아직 안 받는다)
 *   4. 다음 상품으로 넘어가 2~3 을 반복한다 — 서로 다른 판매자 4곳 이상
 *   5. 다 모았으면 콘솔에 `__shortsHarvest.save()` 를 치면 JSON 파일이 내려받아진다
 *   6. 그 파일을 넘긴다:  npm run links import ~/Downloads/video-links-*.json
 *
 * 왜 저장소에 쌓나
 * ----------------
 * 상품마다 파일이 하나씩 내려받아지면 4~12개를 일일이 합쳐야 한다. localStorage 에
 * 쌓아두면 브라우저를 닫았다 열어도 남아 있고, 마지막에 한 번만 저장하면 된다.
 *
 * ⚠️ 주소를 자르지 않는다
 * ----------------------
 * CDN 주소의 쿼리스트링에 서명이 붙어 있는 경우가 있다. 예전에 샤오홍슈에서
 * xsec_token 을 벗겼다가 55건을 통째로 날렸다. 찾은 문자열을 **그대로** 저장한다.
 */

(() => {
  const STORE_KEY = '__shorts_harvest_v1';

  /** 페이지 HTML 안에 JSON 문자열로 이스케이프된 채 박혀 있는 mp4 주소까지 잡는다. */
  const VIDEO_RE =
    /https?:\\?\/\\?\/[^"'\s\\]*(?:alicdn\.com|aliexpress\.com|cloud\.video\.taobao\.com|1688\.com)[^"'\s]*?\.mp4[^"'\s]*/gi;

  const unescapeUrl = (u) =>
    u.replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\+$/, '');

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const store = (rows) => localStorage.setItem(STORE_KEY, JSON.stringify(rows));

  const platformOf = (host) => {
    if (host.includes('1688.com')) return 'ali1688';
    if (host.includes('aliexpress')) return 'aliexpress';
    if (host.includes('taobao') || host.includes('tmall')) return 'taobao';
    return null;
  };

  const platform = platformOf(location.host);
  if (!platform) {
    console.error(
      '이 페이지는 1688 · 알리익스프레스 · 타오바오 상품 페이지가 아닙니다.\n' +
        `  현재: ${location.host}`,
    );
    return;
  }

  // 1) HTML 에 박힌 것 + 2) 실제로 붙어 있는 <video> 태그. 둘 다 본다 —
  //    사이트마다 싣는 방식이 다르고, 한쪽만 보면 조용히 0건이 된다.
  const fromHtml = [...new Set((document.documentElement.innerHTML.match(VIDEO_RE) || []).map(unescapeUrl))];
  const fromTags = [...document.querySelectorAll('video, video source')]
    .map((n) => n.src || n.getAttribute('src') || '')
    .filter((u) => u.startsWith('http'));

  const videos = [...new Set([...fromHtml, ...fromTags])].filter((u) => u.startsWith('http'));

  if (videos.length === 0) {
    console.error(
      '이 상품에서 영상 주소를 못 찾았습니다.\n' +
        '  · 상세 페이지가 맞는지 (검색 결과 페이지에서는 안 됩니다)\n' +
        '  · 영상이 있는 상품인지 — 재생 버튼이 보이는 상품을 고르세요\n' +
        '  · 영상을 한 번 재생시킨 뒤 다시 실행하면 잡히는 경우가 있습니다 ' +
        '(재생 전에는 주소를 안 싣는 사이트가 있습니다)',
    );
    return;
  }

  const keyword =
    localStorage.getItem('__shorts_harvest_keyword') ||
    prompt('이 수확에 붙일 검색어 (상품을 찾을 때 쓴 중국어/영어 키워드)') ||
    '';

  if (!keyword) {
    console.error('검색어 없이는 저장하지 않습니다 — 나중에 어느 상품 소재인지 못 찾습니다.');
    return;
  }
  // 다음 상품에서 또 묻지 않도록 기억해둔다. 키워드를 바꾸려면:
  //   localStorage.removeItem('__shorts_harvest_keyword')
  localStorage.setItem('__shorts_harvest_keyword', keyword);

  const title = (document.title || '').trim().slice(0, 120);
  const rows = load();
  const before = rows.length;

  for (const videoUrl of videos) {
    if (rows.some((r) => r.videoUrl === videoUrl)) continue;
    rows.push({ platform, keyword, url: location.href, title, videoUrl });
  }
  store(rows);

  const added = rows.length - before;
  const products = new Set(rows.map((r) => r.url)).size;

  console.log(
    `✅ 이 상품에서 영상 ${videos.length}개 (새로 ${added}개) — ` +
      `누적 ${rows.length}개 / 상품 ${products}곳`,
  );
  if (products < 4) {
    // 같은 판매자 영상만 모으면 각도와 동작이 겹쳐 짜깁기할 게 없다.
    // 파이프라인도 서로 다른 상품 4곳을 요구한다(MIN_SOURCE_COUNT).
    console.log(`   서로 다른 상품이 4곳은 돼야 합니다 — ${4 - products}곳 더 필요`);
  } else {
    console.log('   충분합니다. 저장하려면:  __shortsHarvest.save()');
  }

  window.__shortsHarvest = {
    /** 쌓인 것을 JSON 파일로 내려받는다. */
    save() {
      const all = load();
      if (all.length === 0) {
        console.error('쌓인 게 없습니다.');
        return;
      }
      const payload = {
        platform: 'mixed',
        keyword: all[0].keyword,
        harvestedAt: new Date().toISOString(),
        count: all.length,
        links: all,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `video-links-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      console.log(`✅ ${all.length}건 저장 — ${a.download}`);
      console.log('   다음: npm run links import <내려받은 파일>');
      console.log('   비우려면: __shortsHarvest.clear()');
    },
    /** 저장한 뒤 비운다. 안 비우면 다음 수확에 섞인다. */
    clear() {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem('__shorts_harvest_keyword');
      console.log('비웠습니다.');
    },
    /** 지금까지 쌓인 것 보기 */
    list: () => load(),
  };
})();
