-- 수확물에 영상 주소를 직접 담는다.
--
-- 왜 필요해졌나
-- -------------
-- 지금까지 수확은 **상품 상세 URL** 만 모았다. "상세 페이지는 로그인 없이 열리니
-- 주소만 있으면 나머지는 자동" 이라는 전제였다. 그 전제가 깨졌다.
--
-- 실측(2026-09-20, GitHub 러너):
--   · 알리익스프레스  상세 26번 열어 0번 열림 (전부 "_____tmd_____" 검증 페이지)
--   · 1688            검색 세 진입로 전부 차단 조각 응답
--   · 타오바오        검색 페이지는 오지만 상품 id 0개
--
-- 데이터센터 IP 자체가 막힌 것이라 요청을 바꿔서 될 일이 아니다. 그래서 상세를
-- **사람 브라우저에서 열고 거기서 mp4 주소까지 뽑아** 여기에 저장한다.
-- 러너는 그 주소로 CDN 에서 파일만 받는다 (CDN 은 상품 페이지와 다른 호스트다).
--
-- video_url 이 비어 있는 행은 예전 방식(상세 URL만)이다. 러너가 상세를 열 수 있을
-- 때만 쓸모가 있으므로, 파이프라인은 video_url 이 있는 행을 먼저 쓴다.
alter table harvested_links
  add column if not exists video_url text;

comment on column harvested_links.video_url is
  '판매자 상품영상 mp4 주소. 사람 브라우저에서 뽑아 저장한다. 비어 있으면 러너가 상세를 열어야 한다.';

-- 쓸 수 있는 것부터 꺼내기 위한 인덱스. video_url 이 있는 행만 담는다.
create index if not exists harvested_links_video_idx
  on harvested_links (platform, keyword, harvested_at desc)
  where used_at is null and failed_reason is null and video_url is not null;
