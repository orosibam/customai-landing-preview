-- 릴스 한 건이 상품 하나만 가질 수 있어서, 나중 상품이 앞 상품의 원본을 빼앗았다.
--
-- ## 무슨 일이 있었나
--
-- references 의 유니크가 (platform, external_id) 였다. 소싱 담당은 같은 해시태그를
-- 매 실행 긁으므로 **같은 릴스가 계속 다시 나온다.** 그 릴스로 새 상품을 만들면
-- upsert 가 기존 행의 product_id 를 새 상품으로 갈아치웠고, 앞 상품은 원본 릴스를
-- 잃은 채 DB 에 남았다.
--
-- 실제로 당했다. "고압 무선 물총형 세차 워터건" 은 좋아요 19만짜리 릴스에서 뽑혔는데
-- (선정 사유에 그렇게 적혀 있다) 나중 실행이 그 릴스를 가져가서, 지금 그 상품에는
-- 레퍼런스가 없다. 소재를 사람이 12개나 수확해온 뒤에야 "베낄 원본이 없습니다" 로
-- 멈추게 되는 상태였다.
--
-- ## 고침
--
-- 유니크를 (product_id, platform, external_id) 로 옮긴다. 같은 릴스가 두 상품에
-- 쓰이면 행이 두 개 생기고, 각 상품이 자기 원본을 그대로 들고 있는다.
--
-- 같은 릴스를 반복해 쓰는 것 자체를 막는 건 여기 일이 아니다. 그건 used_at 쿨다운이
-- 할 일이고, 행을 덮어쓰는 방식으로 하면 이렇게 기록이 사라진다.
alter table "references" drop constraint if exists references_platform_external_id_key;

create unique index if not exists references_product_external_key
  on "references" (product_id, platform, external_id);
