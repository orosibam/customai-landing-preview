/**
 * 샤오홍슈 검색 결과 링크 수확기 — 로그인된 크롬 콘솔에 붙여넣어 쓴다.
 *
 * 왜 이 단계가 사람 손을 타는가
 * -----------------------------
 * 샤오홍슈는 비로그인 상태에서 키워드 검색이 안 된다. 홈피드는 로그인 없이 열리지만
 * 무작위라 조준이 안 된다 — 실측에서 980건을 뽑아 적중 0건이었다. 그래서 모수를
 * 늘리는 걸로는 해결되지 않는다. 구조적 한계다.
 *
 * 유일하게 검증된 경로는 **로그인된 브라우저에서 검색 결과의 href 를 통째로 긁는 것**이다.
 * 링크마다 xsec_token 이 쿼리스트링에 붙어 있고, 그 토큰만 있으면 그 뒤로는 로그인 없이
 * curl_cffi 로 열린다. 즉 사람 손이 필요한 건 이 1회성 수확뿐이고, 파싱·다운로드는 전부
 * 자동이다.
 *
 * ⚠️ 절대 하지 말 것 — href 를 자르는 것
 * --------------------------------------
 * note id 만 남기고 토큰을 버리면 그 링크는 전부 404 가 된다. 실제로 그렇게 55건을
 * 통째로 날린 적이 있다. 같은 55건인데 토큰을 남긴 쪽은 쓸 수 있고 지운 쪽은 못 쓴다.
 * 그래서 이 파일은 `a.href` 를 **손대지 않고 통째로** 저장한다. 정규화도, 파라미터
 * 정리도 하지 않는다. 보기에 지저분해도 그게 맞다.
 *
 * 쓰는 법
 * -------
 *   1. 크롬에서 샤오홍슈에 로그인한 상태로 키워드를 검색한다
 *   2. F12 → Console 탭 → 이 파일 내용을 통째로 붙여넣고 Enter
 *   3. 자동으로 스크롤하며 모으고, 끝나면 JSON 파일이 다운로드된다
 *   4. 그 파일을 넘긴다:  npm run links import ~/Downloads/xhs-links-*.json
 *
 * 콘솔에 결과를 찍지 않고 파일로 떨구는 이유는 길이 제한이다 — 콘솔 출력은 잘린다.
 */

(async () => {
  const SCROLL_ROUNDS = 12;   // 더 모으고 싶으면 올린다
  const SCROLL_PAUSE_MS = 1200;

  const keyword =
    new URLSearchParams(location.search).get('keyword') ||
    prompt('이 수확에 붙일 키워드(나중에 상품과 연결할 이름)') ||
    'unknown';

  const found = new Map();

  const harvest = () => {
    for (const a of document.querySelectorAll('a[href]')) {
      // a.href 는 절대 URL 로 해석되면서 쿼리스트링을 그대로 보존한다.
      // getAttribute('href') 를 쓰면 상대경로가 나와 토큰 조합이 깨질 수 있다.
      const url = a.href;
      if (!url.includes('/explore/') && !url.includes('/discovery/item/')) continue;
      // 토큰 없는 링크는 저장해봐야 404 다. 여기서 걸러 나중에 헛수고를 막는다.
      if (!url.includes('xsec_token=')) continue;
      if (found.has(url)) continue;

      const title =
        a.querySelector('.title, .note-title')?.textContent?.trim() ||
        a.getAttribute('title') ||
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
      '토큰이 붙은 링크를 한 건도 못 찾았습니다.\n' +
        '  · 로그인이 돼 있는지 확인하세요 (비로그인이면 검색 결과가 안 나옵니다)\n' +
        '  · 검색 결과 페이지가 맞는지 확인하세요 (홈피드에서는 조준이 안 됩니다)',
    );
    return;
  }

  const payload = {
    platform: 'xiaohongshu',
    keyword,
    harvestedAt: new Date().toISOString(),
    count: links.length,
    links,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `xhs-links-${keyword}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);

  console.log(`✅ ${links.length}건 저장 — ${a.download}`);
  console.log('   다음: npm run links import <내려받은 파일>');
})();
