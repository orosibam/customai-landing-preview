-- 쇼핑쇼츠 자동 생산 공장 · 초기 스키마
--
-- 파이프라인이 S1 → S10 으로 흐르면서 각 단계가 자기 테이블에 행을 남긴다.
-- 어떤 영상이 왜 그렇게 만들어졌는지를 나중에 역추적할 수 있어야 하므로
-- 중간 산출물(선정 근거, 설계도, 문장별 길이)을 전부 보존한다.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 실행 단위
-- ---------------------------------------------------------------------------

create type run_status as enum ('running', 'awaiting_approval', 'published', 'failed');

create table runs (
  id            uuid primary key default gen_random_uuid(),
  run_date      date not null,
  status        run_status not null default 'running',
  -- 스테이지별 성공/실패/소요시간. 실패 원인을 여기서 먼저 본다.
  stage_log     jsonb not null default '[]'::jsonb,
  cost_usd      numeric(10, 4) not null default 0,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  unique (run_date)
);

-- ---------------------------------------------------------------------------
-- 제휴사 · 상품
-- ---------------------------------------------------------------------------

create type merchant_platform as enum ('tenping', 'yt_shopping', 'coupang', 'inpock');

create table merchants (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  platform          merchant_platform not null,
  commission_rate   numeric(5, 4) not null,
  -- 기여도(쿠키) 기간. 상품 점수에 곱으로 들어가는 핵심 변수.
  -- 쿠팡 1일 vs 30일짜리는 기대수익이 자릿수가 다르다.
  cookie_days       integer not null default 1,
  affiliate_base_url text,
  active            boolean not null default true,
  synced_at         timestamptz not null default now(),
  unique (platform, name)
);

create index merchants_score_idx on merchants ((commission_rate * cookie_days) desc)
  where active;

create table products (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references merchants(id) on delete cascade,
  external_id   text,
  title_ko      text not null,
  -- 타오바오 검색과 샤오홍슈 검색에 같이 쓰는 중국어 표기.
  -- S1에서 한 번 만들어 S2/S4가 재사용한다.
  title_zh      text,
  title_en      text,
  price_krw     integer,
  product_url   text,
  score         numeric(10, 4),
  -- LLM이 왜 이 상품을 골랐는지. 나중에 왜 틀렸는지 복기하려면 필요하다.
  score_reason  text,
  picked_at     timestamptz,
  created_at    timestamptz not null default now()
);

create index products_picked_idx on products (picked_at desc nulls last);

-- ---------------------------------------------------------------------------
-- 터진 릴스 레퍼런스 · 설계도
-- ---------------------------------------------------------------------------

create type reference_platform as enum ('xiaohongshu', 'tiktok', 'instagram');

create table "references" (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid references products(id) on delete set null,
  platform        reference_platform not null,
  external_url    text not null,
  external_id     text,
  caption         text,
  -- 조회수. 샤오홍슈는 비공개인 경우가 많아 null 이 될 수 있다.
  views           bigint,
  likes           bigint,
  -- 샤오홍슈 수집(收藏). 조회수가 없을 때 인게이지먼트 대체 지표로 쓴다.
  collects        bigint,
  follower_count  bigint,
  -- 인게이지먼트 / 팔로워수. 팔로워 기반이 아니라 콘텐츠 힘으로 터진 것만 고르는 기준.
  outlier_score   numeric(10, 4) not null,
  posted_at       timestamptz,
  used_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (platform, external_id)
);

create index references_outlier_idx on "references" (outlier_score desc);
create index references_cooldown_idx on "references" (used_at desc nulls first);

create table blueprints (
  id                uuid primary key default gen_random_uuid(),
  reference_id      uuid not null references "references"(id) on delete cascade,
  hook_type         text not null,
  hook_duration_sec numeric(5, 2) not null,
  -- [{t:[start,end], shot:"...", purpose:"hook"|...}]
  cuts              jsonb not null,
  appeal_order      jsonb not null,
  climax_at_sec     numeric(5, 2),
  cta_position      text,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 소재 (타오바오 클립)
-- ---------------------------------------------------------------------------

create table assets (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  source_url    text not null,
  source_site   text not null default 'taobao',
  storage_path  text not null,
  -- 원본 클립 전체 길이. 실제 사용 구간은 renders 단계에서 5초 이내로 잘린다.
  duration_sec  numeric(6, 2) not null,
  width         integer,
  height         integer,
  -- LLM이 붙인 샷 태그. 설계도의 cut.shot 과 매칭할 때 쓴다.
  shot_tags     jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index assets_product_idx on assets (product_id);

-- ---------------------------------------------------------------------------
-- 대본 · 나레이션
-- ---------------------------------------------------------------------------

create table scripts (
  id            uuid primary key default gen_random_uuid(),
  blueprint_id  uuid not null references blueprints(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  -- 문장 단위 배열. 타입캐스트에 문장별로 넣어야 길이를 개별로 받을 수 있다.
  -- [{ idx, text, text_spoken, cut_index }]
  lines         jsonb not null,
  cta           text,
  created_at    timestamptz not null default now()
);

create table narrations (
  id                uuid primary key default gen_random_uuid(),
  script_id         uuid not null references scripts(id) on delete cascade,
  voice_preset      text not null,
  -- 문장별 오디오 파일 경로
  line_audio_paths  jsonb not null,
  -- 문장별 실측 길이(초). 이 값을 누적하면 자막 타임스탬프가 나온다.
  -- 브루(Vrew) 같은 싱크 도구가 필요 없어지는 지점.
  line_durations    jsonb not null,
  full_audio_path   text,
  total_duration_sec numeric(6, 2) not null,
  -- API 로 뽑았는지 웹 자동화로 뽑았는지
  source_mode       text not null default 'api',
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 채널 · 렌더 · 업로드
-- ---------------------------------------------------------------------------

create type channel_platform as enum ('youtube', 'naverclip', 'instagram', 'tiktok');
-- tiktok_shop: 사업자 인증을 마치면 팔로워 0명부터 열린다.
-- lib/affiliate.ts 의 LinkMode 와 값이 정확히 일치해야 한다.
create type link_mode as enum ('inpock', 'yt_shopping_tag', 'naver_sticker', 'tiktok_shop');

create table channels (
  id                uuid primary key default gen_random_uuid(),
  -- config.ts CHANNELS[].key 와 매칭
  key               text not null unique,
  platform          channel_platform not null,
  handle            text,
  category          text not null,
  -- 자격증명 자체는 여기 두지 않는다. Actions secrets / Vault 키 이름만 보관.
  credentials_ref   text not null,
  voice_preset      text not null,
  subscriber_count  integer not null default 0,
  link_mode         link_mode not null default 'inpock',
  daily_count       integer not null default 2,
  active            boolean not null default true,
  -- 브라우저 세션 만료 등으로 사람 손이 필요할 때 사유를 남긴다.
  blocked_reason    text,
  updated_at        timestamptz not null default now()
);

create type approval_status as enum ('pending', 'approved', 'rejected', 'regenerate');

create table renders (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references runs(id) on delete cascade,
  narration_id      uuid not null references narrations(id) on delete cascade,
  channel_id        uuid not null references channels(id) on delete cascade,
  storage_path      text not null,
  thumb_path        text,
  duration_sec      numeric(6, 2) not null,
  -- ffprobe 기반 품질 게이트 통과 여부. false 면 승인 큐에 올라가지 않는다.
  qc_passed         boolean not null default false,
  qc_notes          jsonb not null default '[]'::jsonb,
  approval_status   approval_status not null default 'pending',
  approved_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index renders_queue_idx on renders (run_id, approval_status);

create table uploads (
  id            uuid primary key default gen_random_uuid(),
  render_id     uuid not null references renders(id) on delete cascade,
  channel_id    uuid not null references channels(id) on delete cascade,
  external_id   text,
  external_url  text,
  -- 업로드 시각 랜덤 분산 결과. 기계적 패턴을 피하려고 흩뿌린 값.
  scheduled_at  timestamptz,
  published_at  timestamptz,
  link_status   text not null default 'pending',
  link_url      text,
  -- 쇼핑 태그 자동화가 실패하면 여기에 사유를 남기고 대시보드에 수동 작업으로 띄운다.
  link_error    text,
  created_at    timestamptz not null default now(),
  unique (render_id, channel_id)
);

-- ---------------------------------------------------------------------------
-- 성과
-- ---------------------------------------------------------------------------

create table metrics (
  id            uuid primary key default gen_random_uuid(),
  upload_id     uuid not null references uploads(id) on delete cascade,
  metric_date   date not null,
  views         bigint not null default 0,
  impressions   bigint not null default 0,
  -- 첫 3초 이탈률. 훅 품질의 직접 지표라 설계도 평가에 그대로 쓴다.
  retention_3s  numeric(5, 4),
  clicks        bigint not null default 0,
  conversions   bigint not null default 0,
  revenue_krw   numeric(12, 2) not null default 0,
  collected_at  timestamptz not null default now(),
  unique (upload_id, metric_date)
);

create index metrics_date_idx on metrics (metric_date desc);

-- 리다이렉터가 클릭을 셀 때 쓴다.
-- 같은 업로드·같은 날짜에 대해 원자적으로 +1 한다 (읽고-쓰면 동시 클릭을 잃는다).
create function increment_click(p_upload_id uuid, p_date date)
returns void
language sql
as $$
  insert into metrics (upload_id, metric_date, clicks)
  values (p_upload_id, p_date, 1)
  on conflict (upload_id, metric_date)
  do update set clicks = metrics.clicks + 1;
$$;

-- ---------------------------------------------------------------------------
-- 피드백 루프용 뷰
-- ---------------------------------------------------------------------------

-- 어떤 플랫폼의 설계도가 실제로 돈이 됐는지.
-- S2의 REFERENCE_QUOTA 를 감이 아니라 숫자로 조정하기 위한 근거.
create view blueprint_performance as
select
  r.platform                              as reference_platform,
  b.hook_type,
  count(distinct rd.id)                   as render_count,
  avg(m.retention_3s)                     as avg_retention_3s,
  sum(m.revenue_krw)                      as total_revenue_krw,
  sum(m.revenue_krw) / nullif(count(distinct rd.id), 0) as revenue_per_video
from blueprints b
join "references" r on r.id = b.reference_id
join scripts s      on s.blueprint_id = b.id
join narrations n   on n.script_id = s.id
join renders rd     on rd.narration_id = n.id
join uploads u      on u.render_id = rd.id
left join metrics m on m.upload_id = u.id
group by r.platform, b.hook_type;

-- 기여도 기간대별 실제 수익. COOKIE_DAYS_CAP 튜닝 근거.
create view cookie_window_performance as
select
  case
    when mc.cookie_days >= 30 then '30d+'
    when mc.cookie_days >= 7  then '7-29d'
    when mc.cookie_days >= 2  then '2-6d'
    else '1d'
  end                                     as cookie_bucket,
  count(distinct u.id)                    as upload_count,
  sum(m.revenue_krw)                      as total_revenue_krw,
  sum(m.revenue_krw) / nullif(count(distinct u.id), 0) as revenue_per_upload
from uploads u
join renders rd     on rd.id = u.render_id
join narrations n   on n.id = rd.narration_id
join scripts s      on s.id = n.script_id
join products p     on p.id = s.product_id
join merchants mc   on mc.id = p.merchant_id
left join metrics m on m.upload_id = u.id
group by 1;

-- ---------------------------------------------------------------------------
-- 접근 제어
-- ---------------------------------------------------------------------------

-- 이 테이블들은 파이프라인(서비스 롤)만 읽고 쓴다. 서비스 롤은 RLS 를 통과하므로
-- 정책을 하나도 두지 않는 것이 곧 "그 외 전부 차단" 이 된다.
--
-- 켜두지 않으면 공개 키(anon)를 가진 누구나 상품 선정 근거, 대본, 수익 지표를
-- 읽을 수 있다. 이 프로젝트는 결제 앱과 DB 를 공유하므로 특히 느슨하게 두면 안 된다.
alter table runs        enable row level security;
alter table merchants   enable row level security;
alter table products    enable row level security;
alter table "references" enable row level security;
alter table blueprints  enable row level security;
alter table assets      enable row level security;
alter table scripts     enable row level security;
alter table narrations  enable row level security;
alter table channels    enable row level security;
alter table renders     enable row level security;
alter table uploads     enable row level security;
alter table metrics     enable row level security;

-- 뷰는 정의한 사람의 권한이 아니라 조회하는 사람의 권한으로 돌게 한다.
-- 그래야 아래 테이블의 RLS 가 뷰를 통해 우회되지 않는다.
alter view blueprint_performance     set (security_invoker = on);
alter view cookie_window_performance set (security_invoker = on);
