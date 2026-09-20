-- 수확 행의 단위를 "상품" 에서 "영상" 으로 바꾼다.
--
-- 사람이 브라우저로 상세를 열어 mp4 주소를 뽑기 시작하면서(0004) 행 하나가 영상
-- 하나를 뜻하게 됐다. 그런데 유니크가 아직 (url) 이라, **같은 상품의 두 번째
-- 영상이 조용히 버려진다.**
--
-- 첫 실제 수확에서 바로 드러났다: 상품 9곳 / 영상 12개를 모아왔는데 3곳이 2개씩
-- 낸 것이고, 그대로 넣었으면 9개만 들어가고 3개는 아무 말 없이 사라졌다.
-- 소재가 귀한 상황에서 25%를 버리는 셈이다.
alter table harvested_links drop constraint if exists harvested_links_url_key;

create unique index if not exists harvested_links_url_video_key
  on harvested_links (url, coalesce(video_url, ''));
