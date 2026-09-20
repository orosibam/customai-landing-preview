/**
 * 1688 검색 결과 링크 수확기 — 로그인된 크롬 콘솔에 붙여넣어 쓴다.
 *
 * 왜 이 단계가 사람 손을 타는가
 * -----------------------------
 * 1688 검색 페이지는 HTTP 로 받으면 껍데기만 온다. 실측(2026-09-20)에서 25KB 를 받았지만
 * 그 안에 detail.1688.com/offer 링크도 offerId 키도 0건이었다 — 캡차도 로그인 벽도 아니고,
 * 상품 목록을 JS 가 나중에 받아온다. 그래서 진입로를 바꿔봐야 소용없다.
 *
 * 반면 **상품 상세 페이지는 로그인 없이 열린다.** 그러니 필요한 건 상세 URL 목록뿐이고,
 * 그건 브라우저에서 한 번 긁어오면 된다. 샤오홍슈와 같은 구조다 —
 * 사람 손은 이 1회성 수확에만 쓰고, 그 뒤 파싱·다운로드는 전부 자동이다.
 *
 * ⚠️ href 를 자르지 않는다
 * ------------------------
 * 샤오홍슈에서 xsec_token 을 벗겼다가 55건을 통째로 날린 적이 있다. 1688 은 토큰이
 * 필수는 아니지만, 링크에 붙은 파라미터가 나중에 무슨 역할을 할지 지금 단정할 수 없다.
 * 그래서 여기서도 `a.href` 를 **손대지 않고 통째로** 저장한다. 상품 id 는 나중에 필요하면
 * URL 에서 뽑으면 되고, 그 반대(id 로 URL 재조립)는 잃는 게 생긴다.
 *
 * 쓰는 법
 * -------
 *   1. 크롬에서 1688 에 로그인한 상태로 중국어 키워드를 검색한다 (예: 洗车液)
 *   2. F12 → Console 탭 → 이 파일 내용을 통째로 붙여넣고 Enter
 *   3. 자동으로 스크롤하며 모으고, 끝나면 JSON 파일이 다운로드된다
 *   4. 그 파일을 넘긴다:  npm run links import ~/Downloads/ali-links-*.json
 *
 * 영상이 있는 상품만 고르는 건 여기서 하지 않는다. 상세를 열어봐야 알 수 있고,
 * 그건 자동화 쪽 일이다. 여기서는 후보를 넉넉히 긁어두는 게 이득이다.
 */

(async () => {
  const SCROLL_ROUNDS = 10;
  const SCROLL_PAUSE_MS = 1200;

  const keyword =
    new URLSearchParams(location.search).get('keywords') ||
    prompt('이 수확에 붙일 키워드(중국어 상품명)') ||
    'unknown';

  const found = new Map();

  const harvest = () => {
    for (const a of document.querySelectorAll('a[href]')) {
      // a.href 는 절대 URL 로 해석되면서 쿼리스트링을 그대로 보존한다.
      const url = a.href;
      if (!/detail\.1688\.com\/offer\/\d+/.test(url)) continue;
      if (found.has(url)) continue;

      const title =
        a.getAttribute('title') ||
        a.querySelector('img')?.getAttribute('alt') ||
        a.textContent?.trim().slice(0, 120) ||
        '';

      found.set(url, { url, title });
    }
  };

  harvest();
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, SCROLL_PAUSE_MS));
    harvest();
    console.log(`  스크롤 ${i + 1}/${SCROLL_ROUNDS} — 누적 ${found.size}건`);
  }

  const links = [...found.values()];

  if (links.length === 0) {
    console.error(
      '상품 링크를 한 건도 못 찾았습니다.\n' +
        '  · 검색 결과 페이지가 맞는지 확인하세요 (s.1688.com/selloffer/...)\n' +
        '  · 결과가 iframe 안에 있으면 그 프레임을 콘솔에서 선택한 뒤 다시 실행하세요',
    );
    return;
  }

  const payload = {
    platform: 'ali1688',
    keyword,
    harvestedAt: new Date().toISOString(),
    count: links.length,
    links,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ali-links-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);

  console.log(`✅ ${links.length}건 저장 — ${a.download}`);
  console.log('   다음: npm run links import <내려받은 파일>');
})();
