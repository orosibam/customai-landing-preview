-- 수확한 링크 보관소.
--
-- 왜 필요한가: 샤오홍슈·1688 둘 다 키워드 검색이 비로그인으로 안 된다.
--   · 샤오홍슈 검색 = 로그인 벽
--   · 1688 검색 = 25KB 를 받지만 상품 데이터가 HTML 에 없다 (JS 가 나중에 받아옴)
--   · 홈피드 반복 호출 = 980건 뽑아 적중 0건. 무작위라 조준이 안 된다
--
-- 유일하게 검증된 경로는 **로그인된 브라우저에서 검색 결과 href 를 통째로 긁는 것**이다.
-- 그 1회성 수확만 사람이 하고, 그 뒤 파싱·다운로드는 전부 자동으로 돈다.
-- 매일 도는 Actions 러너에는 브라우저가 없으므로, 수확 결과가 여기 쌓여 있어야 한다.
--
-- ⚠️ url 은 수확한 그대로 저장한다. 정규화하거나 파라미터를 정리하면 안 된다 —
-- xsec_token 이 쿼리스트링에 붙어 있고, 그걸 벗기면 링크가 전부 404 가 된다.
-- 실제로 토큰을 지웠다가 55건을 통째로 날린 적이 있다. 그래서 unique 도 url 전체로 건다.

create table harvested_links (
  id            uuid primary key default gen_random_uuid(),
  -- 'xiaohongshu' | 'ali1688'
  platform      text not null,
  -- 어떤 검색어로 긁었는가. 상품과 연결할 때 쓴다.
  keyword       text not null,
  -- 수확한 URL 통째로. 자르지 않는다.
  url           text not null,
  title         text,
  harvested_at  timestamptz not null default now(),
  -- 한 번 쓴 링크는 다시 쓰지 않는다. 같은 소재가 여러 영상에 반복되면 금방 들킨다.
  used_at       timestamptz,
  -- 열어봤지만 쓸 수 없던 이유 (영상 없음, 404, 토큰 만료 등).
  -- 실패를 지우지 않고 남겨야 같은 링크를 매일 다시 시도하지 않는다.
  failed_reason text,
  created_at    timestamptz not null default now(),
  unique (url)
);

create index harvested_links_pick_idx
  on harvested_links (platform, keyword, harvested_at desc)
  where used_at is null and failed_reason is null;

alter table harvested_links enable row level security;

comment on column harvested_links.url is
  '수확한 URL 통째로. xsec_token 이 쿼리스트링에 있으므로 절대 자르지 않는다.';
