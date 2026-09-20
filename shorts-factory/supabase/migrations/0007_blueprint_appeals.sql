-- 설계도 컬럼 이름이 코드와 달랐다. 17차 제작이 여기서 멈췄다:
--
--   설계도 저장 실패: Could not find the 'appeals' column of 'blueprints'
--
-- 원래 설계는 `appeal_order` — 소구를 "순서" 로만 보던 때의 이름이다. 지금 구조
-- 분석가가 뽑는 건 순서가 아니라 **주장과 그 증명 방법의 쌍**이다:
--
--   [{point: "물이 스며들지 않는다", shown_as: "물을 붓고 3초 뒤 털어낸다"}]
--
-- 이름을 내용에 맞춘다. 코드를 컬럼 이름에 맞추는 쪽도 가능하지만, 그러면 컬럼
-- 이름이 내용에 대해 거짓말을 계속하게 된다.
alter table blueprints rename column appeal_order to appeals;

-- 말이 어떤 순서로 설득했는지. 구조 분석가가 이미 뽑고 있는데 저장할 곳이 없어
-- 노트로만 흘려보내고 있었다. 카피라이터가 다음 단계에서 그대로 쓰는 값이라
-- 남겨야 나중에 "어떤 흐름이 먹혔나" 를 집계할 수 있다.
alter table blueprints add column if not exists narrative_flow text;
