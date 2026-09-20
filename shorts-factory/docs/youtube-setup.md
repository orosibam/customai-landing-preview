# 유튜브 세팅 가이드

작성일: 2026-09-20
대상: 대표님 본인 (명의·결제·본인인증이 걸린 구간은 위임 불가)

## 이 문서의 표기 규칙

조사 환경이 원격 컨테이너라 **`support.google.com`, `developers.google.com`, `blog.google`,
국내 언론사 대부분이 egress 정책에 막혀 있었다. 직접 열어본 페이지는 0개다.**
아래 내용은 전부 웹 검색이 돌려준 요약과 그 요약이 인용한 공식 문서 문구에서 얻었다.
신뢰도를 세 단계로 나눠 표기한다.

| 표기 | 뜻 |
|---|---|
| `[확인]` | 구글 공식 문서(고객센터·개발자 문서)의 본문 문구가 검색 요약에 그대로 인용된 것. 사실로 취급해도 됨 |
| `[추정]` | 3자 매체·개발자 블로그만 출처인 것. 방향은 맞을 가능성이 높으나 숫자·날짜는 틀릴 수 있음 |
| `[미확인]` | 끝내 확인 못 함. 이 문서를 믿고 판단하면 안 되는 구간 |

**`[추정]`을 `[확인]`처럼 다루지 말 것.** 특히 아래 두 가지는 실제 화면에서 눈으로
확인하기 전까지 계획의 전제로 삼으면 안 된다.

- 감사(audit) 심사 기간 (2~4주는 3자 출처다)
- OAuth 앱을 "프로덕션"으로 게시할 때 구글 검증(verification)이 강제되는지 여부

---

## 0. 결론 먼저

1. **API 업로드는 오늘 당장 되지만, 감사를 통과하기 전까지 올린 영상은 전부 비공개로
   잠기고 공개 전환이 안 된다.** `[확인]` 그래서 **감사 신청이 이 채널의 임계 경로**이고,
   다른 무엇보다 먼저 내야 한다. 심사는 2~4주로 알려져 있다. `[추정]`
2. **유튜브 쇼핑 제휴(수수료 수익)는 구독자 0명으로 못 쓴다.** YPP 가입이 전제이고,
   YPP는 구독자 500명 + 90일 내 공개 영상 3개 + (쇼츠 90일 300만 조회 또는 롱폼 12개월
   3,000시간)을 요구한다. `[확인]` 현실적으로 **몇 달짜리 목표**다.
3. **그동안의 수익은 설명란·고정댓글 제휴링크(인포크링크/쿠팡파트너스)로 낸다.**
   이건 조건이 없어 첫날부터 된다. 단 **공정위 경제적 이해관계 표시가 의무**이고,
   "자세히 보기"를 누르지 않아도 보이는 위치에 문구가 있어야 한다. `[확인]`

한 줄 요약: **오늘 감사 신청을 내고, 채널은 인포크링크로 굴리면서 500명을 모은다.**

---

## 1. 단계별 순서

리드타임이 긴 것부터 번호를 매겼다. **7단계(감사 신청)가 가장 오래 걸리므로,
1~6단계는 7단계를 내기 위한 준비라고 생각하고 하루에 몰아서 끝내는 게 맞다.**

### 1단계 — 구글 계정 준비 + 2단계 인증

1. 이 사업 전용 구글 계정을 하나 판다. 개인 계정과 섞지 않는다.
   가입: https://accounts.google.com/signup
2. **2단계 인증을 켠다.** https://myaccount.google.com/signinoptions/twosv
3. **백업 코드를 받아서 따로 보관한다.** https://myaccount.google.com/signinoptions/backupcodes
   - 이 계정이 잠기면 채널 2개와 GCP 프로젝트가 같이 잠긴다. 복구 수단을 미리 만든다.

입력할 것: 본인 명의 휴대폰 번호, 복구 이메일.

> 채널을 2개 운영하더라도 **구글 계정은 1개면 충분하다.** 2단계에서 브랜드 계정으로 나눈다.

---

### 2단계 — 브랜드 계정으로 유튜브 채널 2개 만들기

**한 구글 계정으로 여러 채널을 만들 수 있다.** 브랜드 계정 방식이고, 상한은 100개로
알려져 있다. `[추정]` (2개 만드는 데는 상한이 문제될 일이 없다)

1. https://www.youtube.com/account 접속 (1단계 계정으로 로그인)
2. `채널 추가 또는 관리` 클릭
   - 직접 링크: https://www.youtube.com/channel_switcher
3. `채널 만들기` 클릭 → **채널 이름** 입력 → 만들기
4. **같은 화면에서 한 번 더 반복해 두 번째 채널을 만든다.**
5. 채널 2개의 이름 예시 (README의 `CHANNELS` 와 맞춰두면 나중에 덜 헷갈린다)
   - 채널 A → `yt-gadget` (가전·가젯) — 코드에 이미 있는 채널
   - 채널 B → 새로 정할 키 (예: `yt-kitchen`). **아래 6번 섹션의 주의사항을 먼저 읽을 것**

**중요:**
- **PC 웹에서만 채널 추가가 된다.** 모바일 유튜브 앱에는 이 메뉴가 없다. `[추정]`
- 채널을 만든 직후 **각 채널에서 별도로 확인(휴대폰 인증)을 해야** 15분 초과 영상 업로드,
  맞춤 썸네일 등이 열린다: https://www.youtube.com/verify
  쇼츠만 올릴 거면 당장은 없어도 되지만, 어차피 해두는 게 낫다.
- 채널을 전환한 상태에서 OAuth 동의를 해야 그 채널의 토큰이 나온다. **6단계에서 이게 핵심이다.**

---

### 3단계 — GCP 프로젝트 생성 + YouTube Data API v3 활성화

1. https://console.cloud.google.com/projectcreate 접속
2. **프로젝트 이름**: `shorts-factory` (아무거나 되지만 감사 신청서에 적을 이름이라
   서비스 성격이 드러나는 이름이 낫다)
3. `만들기` → 상단 프로젝트 선택기에서 방금 만든 프로젝트가 선택됐는지 확인
4. **프로젝트 번호를 메모한다.** (감사 신청서에 숫자로 들어간다) `[확인]`
   - https://console.cloud.google.com/home/dashboard → `프로젝트 정보` 카드의 `프로젝트 번호`
5. YouTube Data API v3 활성화:
   https://console.cloud.google.com/apis/library/youtube.googleapis.com
   → `사용` (Enable) 클릭

**채널이 2개여도 GCP 프로젝트는 1개면 된다.** `videos.insert` 는 호출당 1,600 units,
프로젝트 일일 기본 할당량은 10,000 units 이므로 하루 6건(9,600)까지가 한계다. `[확인]`
현재 설계(유튜브 채널당 2건)면 채널 2개 = 4건 = 6,400 units 으로 들어간다.
**채널을 더 늘리거나 재시도가 잦아지면 이 벽에 먼저 부딪힌다** — 그때는 7단계 감사 신청서에서
할당량 증액을 같이 요청한다(같은 폼이다).

---

### 4단계 — OAuth 동의화면 설정 + **프로덕션으로 게시**

**이 단계를 대충 넘기면 7일마다 토큰이 죽는다.** 자동화가 일주일 뒤 조용히 멈추는
가장 흔한 원인이다.

2024~2026년에 콘솔 UI가 바뀌어 옛날 블로그의 `OAuth 동의 화면` 메뉴는 지금
**`Google Auth Platform`** 으로 이름이 바뀌었다. `[추정]`

1. https://console.cloud.google.com/auth/overview 접속
   (프로젝트가 3단계에서 만든 것인지 상단에서 확인)
2. 처음이면 `시작하기`(Get started) 버튼 → 4단계 위저드가 뜬다 `[추정]`
   - **앱 이름**: `shorts-factory` (동의 화면에 보일 이름)
   - **사용자 지원 이메일**: 1단계 계정 선택
   - **대상(Audience) / User type**: **`외부`(External)** 선택
     (Workspace 유료 계정이 아니면 `내부`는 선택지에 없다)
   - **연락처 이메일**: 1단계 계정 입력
3. 위저드를 끝낸 뒤 **https://console.cloud.google.com/auth/audience** 로 간다.
4. **게시 상태(Publishing status)가 `테스트`(Testing)이면 `앱 게시`(Publish app)를 눌러
   `프로덕션`(In production)으로 바꾼다.** ← **이 단계가 핵심이다**
   - 이유: 동의 화면이 `외부` + `테스트` 상태이면 **발급된 refresh token이 7일 뒤 만료된다.**
     `[확인]` 프로덕션이면 만료되지 않는다(취소되거나 6개월간 미사용이면 만료). `[추정]`
   - **검증(verification)을 통과하지 않아도 게시 자체는 가능하고, 동의 화면에
     "Google에서 확인하지 않은 앱" 경고가 뜨는 정도로 알려져 있다.** `[추정]`
     경고 화면에서는 `고급` → `<앱 이름>(으)로 이동` 을 눌러 진행한다.
   - **만약 게시 버튼이 검증 제출을 강제한다면** 그 화면을 캡처해서 알려달라.
     설계를 바꿔야 한다(7일마다 토큰 재발급을 자동화하거나, Workspace 계정으로 `내부` 전환).
     → 이 분기는 **`[미확인]`** 이다.
5. **스코프(Data Access)** 에 아래 둘을 추가한다.
   https://console.cloud.google.com/auth/scopes
   - `https://www.googleapis.com/auth/youtube.upload` — 업로드
   - `https://www.googleapis.com/auth/youtube.force-ssl` — 고정 댓글(인포크링크 모드에서 쓴다)

---

### 5단계 — OAuth 클라이언트 ID 만들기

1. https://console.cloud.google.com/auth/clients 접속
2. `클라이언트 만들기`(Create client) 클릭
3. **애플리케이션 유형: `데스크톱 앱`(Desktop app)** 선택
   - 웹 앱을 고르면 리디렉션 URI를 맞춰야 해서 번거롭다. 우리는 서버에서 도는
     배치 작업이므로 데스크톱 앱이 맞다.
4. 이름: `shorts-factory-uploader`
5. `만들기` → **`JSON 다운로드`** 를 눌러 파일을 받아 **로컬 PC에만** 둔다.
   - 이 파일에 `client_id` 와 `client_secret` 이 들어있다.
   - **채팅·이슈·커밋에 붙여넣지 않는다.** 값은 6단계에서 GitHub Secrets 로 바로 넣는다.

**클라이언트는 1개면 된다.** 채널 2개는 같은 클라이언트로 각각 동의를 받아
**refresh token 만 2개** 만들면 된다.

---

### 6단계 — refresh token 발급 (채널 2개 각각) → GitHub Secrets

`src/lib/publishers/youtube.ts` 가 요구하는 형식은 **JSON 한 덩어리**다.

```json
{ "client_id": "...", "client_secret": "...", "refresh_token": "..." }
```

**발급은 대표님 로컬 PC에서 한다.** 이 컨테이너에는 브라우저가 없고,
토큰을 이 대화로 가져올 이유도 없다.

1. 로컬 PC에서 아래를 실행한다 (5단계에서 받은 JSON 파일 경로를 넣는다).

```bash
pip install google-auth-oauthlib
python3 - <<'PY'
from google_auth_oauthlib.flow import InstalledAppFlow
import json, pathlib
SECRETS = "여기에_5단계에서_받은_client_secret_....json_경로"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.force-ssl"]
flow = InstalledAppFlow.from_client_secrets_file(SECRETS, SCOPES)
creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
out = {"client_id": creds.client_id,
       "client_secret": creds.client_secret,
       "refresh_token": creds.refresh_token}
pathlib.Path("yt-credentials.json").write_text(json.dumps(out))
print("yt-credentials.json 에 저장했습니다. 터미널에 값은 찍지 않았습니다.")
PY
```

2. 브라우저가 뜨면 **어느 계정/채널로 동의하는지 반드시 확인한다.**
   - 구글 계정 선택 후 **채널 선택 화면**이 나온다. **여기서 채널 A를 고른다.**
   - "Google에서 확인하지 않은 앱" 경고가 뜨면 `고급` → `<앱 이름>(으)로 이동`
3. `yt-credentials.json` 이 생긴다. **열어서 값을 읽지 말고**, 아래로 바로 올린다.
4. **채널 B를 위해 2번을 반복한다.** 브라우저에서 먼저 로그아웃하거나 시크릿 창을 쓰고,
   채널 선택 화면에서 **채널 B** 를 고른다. 파일 이름을 다르게 저장한다.
   - 같은 채널로 두 번 동의받으면 **토큰 2개가 같은 채널을 가리켜서**, 한 채널에만
     하루 4건이 올라간다. 대시보드에서는 정상으로 보인다. 조용히 틀어지는 종류의 실수다.
5. GitHub Secrets 에 넣는다 (값은 파일 내용을 그대로 붙여넣기):
   `https://github.com/<소유자>/<저장소>/settings/secrets/actions` → `New repository secret`
   - 이름은 5번 섹션 목록 참고. **값은 이 대화에 붙여넣지 않는다.**
6. 다 넣었으면 파일을 지운다: `rm yt-credentials.json`

---

### 7단계 — **감사(audit) 신청** ← 가장 먼저 냈어야 하는 것

**2020년 7월 28일 이후에 만들어진 API 프로젝트에서 `videos.insert` 로 올린 영상은
전부 비공개(private)로 제한되고, 감사를 통과해야 풀린다.** `[확인]`
지금도 유효하다 — 이 제한을 없애는 다른 방법은 없다.

1. 신청 폼: **https://support.google.com/youtube/contact/yt_api_form** `[확인]`
2. 적어 넣을 것 `[확인]`
   - 이름·국가·주소·연락처 이메일 (개인 또는 사업자)
   - **GCP 프로젝트 번호** (3단계에서 메모한 숫자)
   - **개인정보처리방침 URL** — 공개적으로 접근 가능한 실제 페이지여야 한다.
     없으면 여기서 막힌다. **이게 7단계 전에 준비해야 할 유일한 외부 자산이다.**
     랜딩 저장소(`customai-landing-preview`)에 정적 페이지 하나를 올려 URL을 만드는 게 빠르다.
   - **사용 사례 설명** — "자체 제작한 쇼핑 리뷰 쇼츠를 우리가 소유한 유튜브 채널에
     업로드하는 내부 배치 도구. 제3자에게 서비스를 제공하지 않으며, 유튜브 데이터를
     외부에 표시하지 않는다" 취지로 정확히 쓴다. 과장하면 심사가 길어진다.
   - **스크린샷 / 데모** — 로그인이 필요한 클라이언트면 데모 계정과 접근 방법을 제공하라고
     요구한다. 우리는 UI 없는 배치 스크립트이므로 **그 사실을 그대로 쓰고,
     업로드 결과 화면(Studio)과 코드 구조를 스크린샷으로 대신한다.** `[추정]`
3. **할당량 증액이 필요하면 같은 폼에서 함께 요청한다.** (별도 폼이 아니다) `[확인]`
4. 심사 기간: **2~4주로 알려져 있으나 보장된 기한은 없다.** `[추정]`
   구글이 수동으로 검토하며, 추가 질의 메일이 올 수 있으니 1단계 계정의 메일함을 본다.

---

### 8단계 — 감사 통과 여부를 **눈으로** 확인

감사 승인 메일이 와도, 실제로 공개 전환이 되는지는 올려봐야 안다.

1. 채널 A에 테스트 영상 1건을 API로 올린다.
   ```bash
   npm run probe -- youtube-audit   # 자격증명 존재만 확인한다. 감사 통과 여부는 알 수 없다
   ```
   → **이 점검은 "키가 있다"까지만 말해준다.** 실제 확인은 아래 2번이다.
2. https://studio.youtube.com → 콘텐츠 → 방금 올린 영상의 공개 상태를 **`공개`로 바꿔본다.**
   - 바뀌면 통과. 바뀌지 않거나 "비공개로 잠김" 안내가 뜨면 **아직 통과 안 된 것**이다.
3. 통과 전까지는 **업로드 자동화를 켜지 않는다.** 올려봐야 아무도 못 보고,
   나중에 지워야 할 비공개 영상만 쌓인다.

---

### 9단계 — 수익 경로: 지금(인포크링크)과 나중(쇼핑 제휴)

#### 지금 — 설명란·고정댓글 제휴링크 (조건 없음)

- 유튜브 쇼핑 제휴 자격이 없어도 **설명란에 외부 제휴 링크를 넣는 것 자체는 막혀 있지 않다.**
  인포크링크·쿠팡파트너스 링크를 설명란/고정댓글에 넣는 방식이 일반적으로 쓰인다. `[추정]`
- **정책상 제약 — 반드시 지킬 것:**
  - **경제적 이해관계 표시(공정위)가 의무다.** 제휴 링크 근처에 표시해야 하고,
    유튜브에서는 **사용자가 "자세히 보기"를 누르지 않아도 보이는 위치**에 문구가 있어야 한다
    (= 설명란 첫 줄, 또는 고정 댓글 상단). `[확인]`
    문구 예: `이 영상은 쿠팡 파트너스 활동의 일환으로 수수료를 제공받습니다.`
  - 단축 링크보다 **원본 추적 링크**가 안전하다고 안내된다. `[추정]`
  - 링크가 설명란에서 클릭되지 않는 사례(스팸 필터·채널 미확인)가 보고된다. `[추정]`
    → **2단계의 채널 확인(https://www.youtube.com/verify)을 먼저 해둘 것.**
- **`[미확인]`:** 자동 생성 쇼츠를 대량으로 올리면서 매 영상에 제휴 링크를 다는 것이
  유튜브 스팸/반복 콘텐츠 정책에 걸리는 임계점이 어디인지는 확인하지 못했다.
  채널 2개로 시작해 반응을 보는 쪽이 안전하다.

#### 나중 — 유튜브 쇼핑 제휴 프로그램

- **자격 (한국 포함):** `[확인]`
  1. **YPP(유튜브 파트너 프로그램) 가입 상태**일 것
  2. **구독자 500명 이상** — 2026년 3월 말 기준으로 기존 **10,000명에서 500명으로 완화**됐다 `[추정: 완화 시점]`
  3. 거주 국가에 **대한민국 포함** `[확인]`
  4. 채널이 아동용으로 설정돼 있지 않고, 아동용 영상이 많지 않을 것 `[확인]`
  5. 음악 채널 / 공식 아티스트 채널이 아닐 것 `[확인]`
- **YPP 가입 조건 (위 1번의 전제):** `[확인]`
  - 구독자 **500명** + 최근 **90일 내 유효한 공개 영상 업로드 3건**
  - **그리고** 다음 중 하나:
    - 최근 **90일간 공개 쇼츠 유효 조회수 300만 회**
    - 또는 최근 **12개월간 롱폼 유효 시청 시간 3,000시간**
- **→ 그래서 "구독자 500명만 넘으면 쇼핑 태그가 열린다"는 말은 틀렸다.**
  쇼츠만 올리는 우리 설계에서는 **90일 300만 조회**가 진짜 관문이다.
  (이게 6번 섹션에서 지적하는 코드 문제와 직결된다)
- **한국 제휴사:** 쿠팡이 먼저 참여했고, 카페24 연동 브랜드 직영몰 다수,
  이후 올리브영·컬리·오늘의집 등이 합류한 것으로 보도됐다. `[추정]`
- **신청 경로:** YouTube Studio → 수익 창출 → 쇼핑 탭. 자격이 되면 여기서
  제휴 프로그램 허브가 열린다. `[추정]`
- **상품 태그 자동화는 불가능하다.** 공개 API가 없어 Studio 브라우저 자동화가 필요하고,
  코드에서도 현재 명시적으로 에러를 던진다(`src/lib/publishers/youtube.ts`).

---

## 2. 막히는 지점

| 증상 | 원인 | 해법 |
|---|---|---|
| 일주일 뒤 업로드가 전부 `invalid_grant` 로 실패 | 동의화면이 `외부`+`테스트` 상태 → refresh token 7일 만료 `[확인]` | 4단계 4번. **프로덕션으로 게시**하고 토큰을 재발급한다 |
| 영상이 올라가는데 계속 비공개고 공개 전환이 안 됨 | 감사 미통과 프로젝트의 정상 동작 `[확인]` | 7단계. 감사 통과 전에는 방법이 없다. 자동화를 켜지 말 것 |
| 동의 화면에 "Google에서 확인하지 않은 앱" 경고 | 검증 미완 앱의 정상 표시 `[추정]` | `고급` → `<앱 이름>(으)로 이동`. 본인 계정만 쓰므로 문제되지 않는다 |
| 하루 7건째 업로드부터 `quotaExceeded` | `videos.insert` 1,600 units × 일 10,000 units 상한 `[확인]` | 7단계 폼에서 할당량 증액을 함께 요청. 그전엔 하루 6건이 상한 |
| 토큰 2개가 같은 채널에 올라감 | 6단계에서 채널 선택 화면을 대충 넘김 | 시크릿 창으로 다시 동의. 채널 선택 화면을 반드시 확인 |
| 감사 신청 폼에서 개인정보처리방침 URL 에서 막힘 | 공개 URL이 실제로 필요하다 `[확인]` | 7단계 2번. 랜딩 저장소에 정적 페이지를 먼저 올린다 |
| 채널 추가 메뉴가 안 보임 | 모바일 앱에는 없다 `[추정]` | PC 웹 https://www.youtube.com/channel_switcher |
| 설명란 제휴 링크가 클릭이 안 됨 | 채널 미확인 / 스팸 필터 `[추정]` | https://www.youtube.com/verify 로 채널 확인 |

---

## 3. 대신할 수 없는 것

**아래는 명의가 걸린 일이라 누구도, 어떤 자동화로도 대신할 수 없다.**
Claude in Chrome 확장을 붙여도 마찬가지다. 줄어드는 건 폼을 찾아다니는 시간이지
입력 자체가 아니다.

- **구글 계정 가입 시 휴대폰 SMS 인증** — 본인 명의 번호
- **2단계 인증 등록 및 백업 코드 보관**
- **유튜브 채널 확인(https://www.youtube.com/verify)의 휴대폰 인증** — 채널마다 따로
- **OAuth 동의 화면에서 "허용" 클릭** — 계정 소유자 본인의 의사표시다. 대신 누르지 않는다
- **감사 신청서의 법적 신원 정보** — 이름, 주소, 국가, (사업자라면) 사업자 정보
- **YPP 가입 시 본인 확인 · 애드센스 계정 연결 · 세금 정보(W-8BEN) · 정산 계좌 등록**
  — 나중 단계지만 미리 말해둔다. 전부 명의와 세무가 걸려 대리 불가다
- **결제수단 등록** — GCP는 YouTube Data API 기본 할당량 범위에서는 결제 계정 없이도
  쓸 수 있는 것으로 알려져 있으나 `[미확인]`, 요구받으면 본인 카드여야 한다

또한 **토큰·클라이언트 시크릿·쿠키 값을 이 대화에 붙여넣지 않는다.**
값은 GitHub Secrets 에만 넣고, 우리는 이름만 안다.

---

## 4. Claude in Chrome 용 프롬프트

아래 블록을 **대표님 PC의 Claude Code 세션에 그대로 붙여넣으면** 브라우저를 대신 몰아준다.
그 세션은 이 문서와 이 대화를 전혀 모르므로, 혼자서도 말이 되게 써 두었다.

**주의:** 이 프롬프트는 **클릭과 입력까지만** 시킨다. 본인인증·동의 버튼·신원 정보는
대표님이 직접 한다(3번 섹션).

````text
너는 내 Chrome 브라우저를 조작할 수 있다. 나는 유튜브에 자동 업로드하는 개인용 배치
도구를 만들고 있고, 그 사전 세팅을 하려 한다. 아래를 순서대로 진행해라.

[지켜야 할 규칙]
- client_secret, refresh_token, 비밀번호, 쿠키 값을 채팅창에 출력하지 마라.
  파일로 저장하고 "저장했다"고만 말해라.
- 휴대폰 SMS 인증, 계정 로그인, OAuth 동의 화면의 "허용" 버튼, 신원 정보 입력은
  네가 누르지 말고 나에게 넘겨라. "여기서 네가 해야 한다"고 말하고 멈춰라.
- 각 단계가 끝나면 현재 화면을 요약하고 다음으로 넘어가라.
- 화면 구성이 아래 설명과 다르면 추측해서 진행하지 말고, 보이는 메뉴를 그대로
  나열한 뒤 나에게 물어라. Google Cloud 콘솔 UI는 자주 바뀐다.

[1] 유튜브 채널 2개 만들기
  - https://www.youtube.com/channel_switcher 를 열어라.
  - "채널 만들기"로 채널을 2개 만든다. 이름은 나에게 물어라.
  - 각 채널에 대해 https://www.youtube.com/verify 로 이동해 채널 확인 절차를
    시작하되, 휴대폰 번호 입력과 인증코드 입력은 나에게 넘겨라.

[2] Google Cloud 프로젝트 만들고 API 켜기
  - https://console.cloud.google.com/projectcreate 에서 프로젝트를 만든다.
    이름은 shorts-factory.
  - https://console.cloud.google.com/home/dashboard 에서 "프로젝트 번호"(숫자)를
    읽어 나에게 알려주고, 메모장 파일에도 저장해라. (이건 비밀값이 아니다)
  - https://console.cloud.google.com/apis/library/youtube.googleapis.com 에서
    "사용"(Enable)을 눌러 YouTube Data API v3 를 켜라.

[3] OAuth 동의 화면 설정 — 여기가 제일 중요하다
  - https://console.cloud.google.com/auth/overview 를 열어라.
  - 설정이 안 돼 있으면 "시작하기"를 눌러 위저드를 진행한다.
    앱 이름 shorts-factory, 사용자 유형은 "외부"(External), 지원/연락 이메일은
    현재 로그인된 계정.
  - https://console.cloud.google.com/auth/audience 로 가라.
  - ★ 게시 상태(Publishing status)가 "테스트"(Testing)이면 "앱 게시"(Publish app)를
    눌러 "프로덕션"(In production)으로 바꿔라. 이유: 외부+테스트 상태에서 발급된
    refresh token 은 7일 뒤 만료되어 자동화가 일주일 만에 멈춘다.
  - 만약 게시하려면 구글 검증(verification) 제출이 강제되어 진행이 막히면,
    거기서 멈추고 그 화면에 뭐라고 쓰여 있는지 그대로 나에게 알려라. 중요하다.
  - https://console.cloud.google.com/auth/scopes 에서 아래 두 스코프를 추가해라.
      https://www.googleapis.com/auth/youtube.upload
      https://www.googleapis.com/auth/youtube.force-ssl

[4] OAuth 클라이언트 만들기
  - https://console.cloud.google.com/auth/clients 에서 "클라이언트 만들기".
  - 애플리케이션 유형은 반드시 "데스크톱 앱"(Desktop app). 이름은
    shorts-factory-uploader.
  - 만든 뒤 JSON 을 다운로드해서 ~/yt-oauth/ 폴더에 저장해라.
    파일 내용은 절대 채팅에 출력하지 마라.

[5] refresh token 2개 발급 (채널당 1개)
  - 터미널에서 `pip install google-auth-oauthlib` 를 실행해라.
  - 아래 파이썬을 실행하되, SECRETS 경로는 [4]에서 받은 파일로 채워라.
    OUT 파일명은 채널마다 다르게 해라 (예: yt-a.json, yt-b.json).

      from google_auth_oauthlib.flow import InstalledAppFlow
      import json, pathlib
      SECRETS = "<[4]에서 받은 json 경로>"
      OUT = "yt-a.json"
      SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/youtube.force-ssl"]
      flow = InstalledAppFlow.from_client_secrets_file(SECRETS, SCOPES)
      creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
      pathlib.Path(OUT).write_text(json.dumps({
          "client_id": creds.client_id,
          "client_secret": creds.client_secret,
          "refresh_token": creds.refresh_token}))
      print("saved", OUT)

  - 브라우저 동의 창이 뜨면 계정 선택과 "허용" 클릭은 나에게 넘겨라.
    단, ★ 채널 선택 화면이 나오면 "지금 어느 채널을 고를 차례인지"를 나에게
    명확히 물어라. 두 번 다 같은 채널을 고르면 세팅이 조용히 망가진다.
  - 두 번째 채널은 시크릿 창에서 다시 실행해라.
  - 두 파일이 생기면 "생성됐다"고만 말하고 내용은 출력하지 마라.

[6] 감사(audit) 신청 폼 채우기 — 이게 가장 리드타임이 길다
  - https://support.google.com/youtube/contact/yt_api_form 를 열어라.
  - [2]에서 메모한 GCP 프로젝트 번호를 넣어라.
  - 개인정보처리방침 URL 칸이 있다. 내가 URL 을 주기 전까지 멈추고 나에게 물어라.
  - 사용 사례 설명란에는 아래 취지로 적되, 자연스러운 영어로 다듬어라:
      "개인/소규모 사업자가 자체 제작한 짧은 상품 리뷰 영상을 본인이 소유한
       유튜브 채널에 업로드하는 내부 배치 도구다. 제3자에게 서비스를 제공하지 않고,
       유튜브 데이터를 외부에 표시하거나 재배포하지 않는다. videos.insert 와
       commentThreads.insert 만 사용한다."
  - 이름/주소/국가 등 신원 정보 칸은 채우지 말고 나에게 넘겨라.
  - 제출 버튼도 내가 누른다. 다 채운 뒤 멈춰라.

[7] 마지막으로 요약해라
  - 완료한 것, 내가 직접 해야 해서 멈춘 것, 화면이 설명과 달랐던 것을 구분해서
    목록으로 알려줘라.
````

---

## 5. GitHub Secrets 에 넣을 이름 목록

`https://github.com/<소유자>/<저장소>/settings/secrets/actions` → `New repository secret`

**값은 여기에 적지 않는다. 이 대화에도 붙여넣지 않는다.**

| Secret 이름 | 값의 형태 | 비고 |
|---|---|---|
| `YOUTUBE_CREDENTIALS_YT_GADGET` | `{"client_id":"...","client_secret":"...","refresh_token":"..."}` | 채널 A. `CHANNELS` 의 `yt-gadget` 에 대응 |
| `YOUTUBE_CREDENTIALS_YT_KITCHEN` | 위와 같은 형태 | 채널 B. **아래 6번 섹션의 이름 불일치 문제를 먼저 읽을 것** |

이름 규칙: `src/lib/publishers/youtube.ts` 의 `loadCredentials()` 가
**DB `channels.credentials_ref` 에 적힌 문자열을 그대로 환경변수 이름으로 읽는다.**
즉 **Secret 이름과 DB의 `credentials_ref` 값이 글자 단위로 같아야 한다.**
채널을 DB에 넣을 때 `credentials_ref` 를 위 표의 이름과 똑같이 적어라.

관련 환경변수(이미 README에 있는 것, 유튜브와 직접 관련된 것만):

| 이름 | 비고 |
|---|---|
| `REDIRECTOR_BASE_URL` | 인포크링크 모드의 클릭 추적. 없으면 클릭 데이터가 안 쌓인다 |

---

## 6. 이 문서를 쓰면서 발견한, 코드와 사실이 어긋나는 지점

세팅과 직접 관련되므로 남긴다. **이 문서 작성자는 다른 파일을 수정하지 않았다.**
고칠지는 대표님이 정한다.

### (1) `YT_SHOPPING_SUBSCRIBER_THRESHOLD` 는 사실과 다른 판단을 내린다 — **중요**

`src/config.ts:222`
```ts
/** 유튜브 쇼핑 제휴 태그가 열리는 구독자 기준. 미만이면 인포크링크 모드. */
export const YT_SHOPPING_SUBSCRIBER_THRESHOLD = 500;
```

`src/lib/affiliate.ts:50` 은 **구독자 수만** 보고 쇼핑 태그 모드로 승격한다.
그런데 바로 위 주석(`affiliate.ts:49`)은 *"조건(구독자 + 90일 내 조회수)을 넘겨야"* 라고
쓰여 있다. **주석이 약속한 조회수 조건이 구현돼 있지 않다.**

실제 조건은 **YPP 가입**이고, YPP는 구독자 500명 **+** 90일 내 공개 영상 3건 **+**
(쇼츠 90일 300만 조회 **또는** 롱폼 12개월 3,000시간)을 요구한다 `[확인]`.
구독자 500명만 넘긴 채널은 **거의 확실히 쇼핑 태그를 못 쓴다.**

이 상태로 두면, 구독자 500명을 넘긴 순간 `attachLink()` 가 `yt_shopping_tag` 로 가고
`youtube.ts:116` 이 **"공개 API가 없습니다"로 에러를 던진다.** 즉 **그날부터 유튜브 채널의
링크 부착이 전부 실패한다** — 인포크링크로 잘 돌던 것이 500명 도달을 계기로 멈춘다.

판단 근거가 되는 설정이 거짓말을 하고 있으므로, 둘 중 하나를 권한다.
- 쇼핑 태그 승격을 **구독자 수가 아니라 "사람이 켜는 플래그"** 로 바꾼다
  (Studio 에서 실제로 태그가 열린 걸 확인한 뒤 켜는 스위치)
- 또는 이 임계값 설정 자체를 없애고 당분간 인포크링크로 고정한다

### (2) `probe.ts` 가 존재하지 않는 채널의 시크릿을 본다

`src/probe.ts:137` 은 `YOUTUBE_CREDENTIALS_YT_KITCHEN` 을 확인한다.
그런데 `src/config.ts` 의 `CHANNELS` 에 있는 유튜브 채널은 **`yt-gadget` 하나뿐**이고
`yt-kitchen` 은 없다 (`tt-kitchen` 은 틱톡이다).

지금 상태로는 `yt-gadget` 자격증명을 제대로 넣어도 `npm run probe -- youtube-audit` 이
**"자격증명이 없습니다"로 실패한다.** 5번 섹션의 Secret 이름을 정하기 전에
어느 쪽에 맞출지 결정해야 한다.

### (3) 유튜브 채널이 코드에는 1개, 계획에는 2개

`src/lib/publishers/youtube.ts:13` 주석은 *"유튜브 채널 2개 × 2개 = 4업로드 = 6,400 units"*
로 계산하는데, `CHANNELS` 에는 유튜브 채널이 1개뿐이다(`dailyCount: 2`).
**채널 2개 운영이 확정이면 `CHANNELS` 에 항목을 하나 추가해야 한다.**
할당량 계산(6,400 / 10,000)은 채널 2개 기준으로는 맞다.

---

## 출처

- YouTube Shopping 제휴 프로그램 개요 및 자격 요건 — https://support.google.com/youtube/answer/13376398?hl=ko *(egress 차단, 검색 요약으로 확인)*
- YouTube 파트너 프로그램 개요 및 자격요건 — https://support.google.com/youtube/answer/72851?hl=ko *(동일)*
- Quota and Compliance Audits (YouTube Data API) — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits *(동일)*
- YouTube API Services - Audit and Quota Extension Form — https://support.google.com/youtube/contact/yt_api_form
- Videos: insert (YouTube Data API) — https://developers.google.com/youtube/v3/docs/videos/insert
- Manage App Audience (OAuth 게시 상태와 7일 만료) — https://support.google.com/cloud/answer/15549945
- 구독자 500명 완화 보도 — https://www.news1.kr/it-science/general-it/6118301 , https://www.digitaltoday.co.kr/news/articleView.html?idxno=649235 *(모두 egress 차단)*
- 쿠팡·카페24 등 한국 제휴사 보도 — https://www.newsis.com/view/NISX20240605_0002762624 , https://www.cafe24.com/youtubeshopping/affiliate.html *(모두 egress 차단)*

**다시 강조:** 위 URL 중 **직접 열어본 것은 하나도 없다.** 전부 검색 엔진이 돌려준
요약에서 얻은 내용이다. `[확인]` 표기는 "공식 문서 문구가 요약에 인용됐다"는 뜻이지
"내가 원문을 봤다"는 뜻이 아니다.
