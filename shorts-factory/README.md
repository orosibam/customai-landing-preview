# 쇼핑쇼츠 자동 생산 공장

매일 10개(채널 5개 × 2개)의 쇼핑 쇼츠를 자동 생성해 **승인 대기 상태로** 올려둔다.
배포는 대시보드에서 승인 버튼을 눌러야 나간다.

```
S1  상품 선정        수수료율 × 기여도기간 × 가격대 적합도로 점수화 → LLM 최종 선정
S2  레퍼런스 발굴    샤오홍슈·틱톡·인스타에서 팔로워 대비 터진 숏폼 찾기
S3  설계도 추출      훅 유형 · 컷 구성 · 소구 순서만 뽑는다 (픽셀은 안 쓴다)
S4  소재 수집        타오바오 상품 영상 4~5개, 각 5초 이내로만 사용
S5  대본             설계도 구조 고정, 한국어 구어체 문장만 생성
S6  나레이션         타입캐스트, 문장별 합성 → 길이가 곧 자막 타임스탬프
S7  렌더             ffmpeg 로 컷 + 자막 + 나레이션 합성, QC 게이트
─── 승인 대기 ───
S9  배포 + 링크      승인된 것만. 업로드 시각 랜덤 분산
S10 성과 수집        어떤 설계도가 돈이 됐는지 → S1·S2 가중치 갱신
```

## 설계상 양보하지 않는 것

- **`MAX_CLIP_SEC = 5`** — 소스 클립당 사용 길이 상한. 공정이용 근거가 "각 영상에서
  3~5초만" 이라, `ffmpeg.trimToPortrait` 이 이를 넘는 요청을 거부한다. 우회 경로를 만들지 않는다.
- **승인 게이트** — S7까지만 자동이고 배포는 사람이 누른다.
- **실패를 삼키지 않는다** — 스크래퍼가 깨지거나 링크 부착이 실패하면 빈 값으로 넘어가지 않고
  대시보드에 수동 작업으로 남긴다.

## 시작하기

```bash
npm install
npx playwright install chromium

# 발음 정규화 테스트 (네트워크 불필요)
npx tsx src/lib/korean.test.ts

# Phase 0 점검 — 막히는 지점부터 확인한다
npx tsx src/probe.ts

# 전체 파이프라인
npx tsx src/run-daily.ts
```

DB 스키마는 `supabase/migrations/0001_init.sql` 을 Supabase 에 적용한다.

## Phase 0 체크리스트

공장을 다 짓고 여기서 막히는 게 가장 흔한 실패다. 먼저 확인한다.

- [ ] **타입캐스트 API** — 문장별 오디오 *길이* 를 응답에서 받을 수 있는가?
      못 받으면 자막 싱크 전략이 무너진다. 하루 50~70콜이 플랜 한도에 들어가는가?
- [ ] **YouTube API 감사** — 감사 미통과 프로젝트의 API 업로드는 비공개로 고정되고
      공개 전환이 불가능하다. 즉시 신청하고, 테스트 채널에 1건 올려 **직접 확인**한다.
- [ ] **샤오홍슈 / 틱톡 / 인스타** — 각 1건씩 실제로 긁힌다. 전부 막히면
      틱톡 Creative Center 단독으로도 파이프라인은 돈다.
- [ ] **타오바오** — 상품 상세 영상 URL이 실제로 잡힌다.
- [ ] **네이버 클립** — 공식 API가 없다. 구독자 조건 없이 구매 링크 스티커가 붙는
      유일한 채널이라 가장 먼저 자동화할 가치가 있다.
- [ ] **인포크링크 / 텐핑** — 링크 자동 생성이 되는가? 안 되면 자체 리다이렉터
      (`dashboard/app/go`) 로 대체한다.

## 환경변수

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB · 스토리지 |
| `ANTHROPIC_API_KEY` | 설계도 추출 · 대본 |
| `TYPECAST_API_TOKEN` | 나레이션 |
| `TYPECAST_ACTOR_*` | 채널별 보이스 액터 ID (5개) |
| `XIAOHONGSHU_STORAGE_STATE`, `INSTAGRAM_STORAGE_STATE` | 브라우저 세션 JSON |
| `NAVER_STORAGE_STATE`, `TIKTOK_STORAGE_STATE` | 업로드용 브라우저 세션 JSON |
| `NAVER_CLIP_UPLOAD_URL`, `NAVER_CLIP_EDIT_URL`, `TIKTOK_UPLOAD_URL`, `TIKTOK_CONTENT_URL` | 업로드 화면 URL 이 바뀌었을 때만 (선택) |
| `YOUTUBE_CREDENTIALS_*` | 채널별 OAuth (`{client_id, client_secret, refresh_token}`) |
| `REDIRECTOR_BASE_URL` | 클릭 추적 리다이렉터 도메인 (선택) |
| `DUPLICATE_MODE` | `true` 면 2개만 렌더해 5채널에 복사 |
| `FFMPEG_PATH`, `FFPROBE_PATH` | PATH 에 없을 때만 |

## 자주 만지는 설정

전부 `src/config.ts` 에 있다.

- `CHANNELS` — 채널 5개의 플랫폼·카테고리·보이스. 플랫폼을 섞어두면 중복 콘텐츠
  판정이 구조적으로 불가능해진다.
- `REFERENCE_QUOTA` — 플랫폼별 레퍼런스 수집 개수. 샤오홍슈가 깨지면 S2가 나머지로
  자동 재배분한다. S10 성과가 쌓이면 감이 아니라 숫자로 조정한다.
- `COOKIE_DAYS_CAP`, `IMPULSE_PRICE_RANGE` — 상품 점수 튜닝.
- `UPLOAD_JITTER_MINUTES` — 업로드 시각 분산 폭.

## 알려진 미구현

- 인스타 업로드 (`lib/publishers/` — 현재 명시적으로 에러를 던진다)
- 네이버 클립 · 틱톡 업로드는 Playwright 로 구현돼 있으나 **셀렉터가 미검증**이다.
  각 파일 상단의 `SELECTORS` / `URLS` 를 Phase 0 에서 `HEADFUL=true` 로 띄워 맞춰야 한다.
  두 채널 모두 예약 게시는 자동화하지 않았다 (즉시 게시된다).
- 틱톡샵 상품 링크 (셀러 계정 흐름 필요 → 현재 명시적으로 에러를 던진다)
- 유튜브 쇼핑 상품 태그 (공개 API 없음 → Studio 브라우저 자동화 필요)
- 타입캐스트 웹 자동화 폴백 (API 가능 여부 확인 후 판단)
- S10의 플랫폼별 지표 수집 (현재 스켈레톤)
