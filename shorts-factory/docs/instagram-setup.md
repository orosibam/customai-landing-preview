# 인스타그램 세팅 가이드

작성일: 2026-09-20
대상: 대표님 본인 (명의가 걸린 작업이라 위임 불가 구간이 있음)

## 이 문서의 표기 규칙

조사 환경이 원격 컨테이너라 **Meta 계열 도메인 전체가 egress 정책에 막혀 있었다.**
직접 열어본 1차 출처는 **0개**다. 아래 도메인이 전부 차단 확인됐다.

```
developers.facebook.com   help.instagram.com      about.instagram.com
business.instagram.com    www.instagram.com       www.facebook.com
about.fb.com              graph.facebook.com      partners.coupang.com
```

그래서 아래 내용은 전부 **웹 검색 엔진이 돌려준 요약**과 **차단되지 않은 3자 매체/개발자 문서**에서
얻은 것이다. 신뢰도를 세 단계로 나눠 표기한다.

| 표기 | 뜻 |
|---|---|
| `[확인]` | 서로 독립된 2개 이상의 출처가 같은 내용을 말하거나, Meta 공식 문서 본문이 검색 요약에 그대로 인용된 것 |
| `[추정]` | 3자 블로그·매체 1곳만 말하는 것. 방향은 맞을 가능성이 높으나 숫자·조건은 틀릴 수 있음 |
| `[미확인]` | 끝내 확인 못 함. 이 문서를 믿고 판단하면 안 되는 구간 |

**중요:** API 버전 번호, 정확한 엔드포인트 호스트, Meta 개발자 콘솔의 현재 화면 문구는
전부 1차 출처를 못 봤다. 실제 세팅할 때 화면이 다르면 화면을 믿을 것.

---

## 0. 결론 먼저

1. **API 릴스 업로드는 된다. 브라우저 자동화 필요 없다.** 본인 소유 계정 1개만 올리는 구조라
   **Meta 앱 심사(App Review)도, 사업자 검증(Business Verification)도 필요 없다.** `[확인]`
   2024년 7월 이후 **페이스북 페이지 연결도 필요 없어졌다** (Instagram Login 경로). `[확인]`
2. **팔로워 0명에서 링크 수익 경로는 "프로필 링크(최대 5개)"가 사실상 유일하다.** `[확인]`
   릴스 캡션의 URL은 클릭이 안 되고, **릴스 링크 스티커는 1만 팔로워 또는 Meta Verified가 있어야 한다.** `[확인]`
3. **인스타 네이티브 제휴(Instagram Affiliate)는 한국에서 못 쓴다.** 2026년 3월 재출시됐지만
   출시국이 미국·브라질·인도·인도네시아·태국이고 **한국은 빠져 있다.** 조건도 1,000 팔로워 이상이다. `[확인]`
   → 수익은 **쿠팡 파트너스 같은 외부 제휴 링크 + 프로필 링크**로 낸다.

한 줄 요약: **업로드는 공식 API로 자동화하고, 수익 링크는 프로필에 박는다.**

---

## 1. 단계별 순서

리드타임 순으로 번호를 매겼다. 1~3단계는 하루면 끝난다. 4~6단계가 개발 세팅이고,
7단계는 팔로워가 붙은 뒤에 다시 볼 항목이다.

### 1단계 — 인스타그램 계정 개설 + 2단계 인증

1. 계정이 없으면 https://www.instagram.com/accounts/emailsignup/ 에서 가입한다.
   - 입력: 이메일(또는 휴대폰 번호), 성명, 사용자 이름(@아이디), 비밀번호
   - **@아이디는 나중에 바꿀 수 있지만 자주 바꾸면 제한이 걸린다.** 처음에 채널명으로 정할 것.
2. **2단계 인증을 켠다.** https://www.instagram.com/accounts/two_factor_authentication/
   - 인증 앱(TOTP) 방식을 권장한다. SMS만 켜두면 나중에 기기 바꿀 때 막힌다.
   - **백업 코드를 받아서 비밀번호 관리자에 저장한다.** 채팅에 붙여넣지 말 것.
3. 프로필 사진·소개글을 채운다. 빈 프로필은 신규 계정 제한에 더 잘 걸린다. `[추정]`

> 신규 계정은 만들자마자 API로 하루 수십 개를 쏘면 안 된다. 2~3주는 사람이 쓰는 속도로
> 운영해서 계정을 "익힌" 뒤에 자동화를 붙이는 게 안전하다. `[추정]` — 이건 3자 매체 권고이고
> Meta 공식 수치가 아니다.

### 2단계 — 프로페셔널 계정(크리에이터)으로 전환

API 업로드를 하려면 **프로페셔널 계정(비즈니스 또는 크리에이터)이 필수다.** 개인 계정은 API가 아예 안 붙는다. `[확인]`

**모바일 앱에서만 전환된다.** PC 웹에는 이 메뉴가 없다. `[확인]`

1. 인스타그램 앱 → 내 프로필 → 오른쪽 위 `☰` → **`설정 및 개인정보`**
2. 검색창에 `계정 유형` 입력 → **`계정 유형 및 도구`** → **`프로페셔널 계정으로 전환`**
3. 카테고리를 고른다. → **`디지털 크리에이터`** 를 권장한다.
4. **`크리에이터`** / **`비즈니스`** 중 선택 → **`크리에이터`**

**크리에이터를 고르는 이유:**
- 크리에이터 계정은 **페이스북 페이지 연결이 필수가 아니다.** `[확인]`
- 크리에이터 ↔ 비즈니스는 설정에서 나중에 언제든 바꿀 수 있다. `[확인]`
  → 처음에 오래 고민할 필요 없다.

**전환 시 바뀌는 것:**
- **계정이 강제로 "공개"로 바뀐다.** `[확인]` 비공개로 되돌릴 수 없다(프로페셔널인 동안).
- 인사이트(도달·노출·참여·프로필 방문)가 켜진다. 자동화의 성과 측정에 필요하다. `[확인]`

### 3단계 — 프로필 링크 세팅 (수익이 실제로 나오는 지점)

**여기가 팔로워 0명에서 돈이 나오는 유일한 구멍이다.** 우선순위가 API보다 높다.

1. 인스타 앱 → 프로필 → **`프로필 편집`** → **`링크`** → **`외부 링크 추가`**
   - **링크 편집은 모바일 앱에서만 된다.** PC 웹에서는 안 보인다. `[확인]`
2. **최대 5개까지 넣을 수 있다. 팔로워 조건 없다.** `[확인]`
3. **첫 번째 링크만 프로필에 바로 노출되고, 나머지는 눌러야 펼쳐진다.** `[확인]`
   → **1번 슬롯에 "링크인바이오 허브"를 넣는다.** (아래)

**권장 구성:**

| 슬롯 | 넣을 것 |
|---|---|
| 1 | 링크인바이오 허브 페이지 (오늘 올린 쇼츠들의 상품 링크를 전부 모아둔 곳) |
| 2 | 오늘의 대표 상품 딥링크 1개 |
| 3~5 | 비워두거나 다른 채널(유튜브/틱톡) |

링크인바이오 허브는 **이 저장소에서 직접 만드는 게 낫다.** 외부 서비스(Linktree 등)를 쓰면
쇼츠가 매일 바뀔 때마다 사람이 손으로 갱신해야 한다. 자체 페이지면 쇼츠 생성 파이프라인이
같이 갱신할 수 있다. → `shorts-factory` 에서 정적 페이지 1장을 만들어 배포하고,
그 URL을 1번 슬롯에 고정으로 박아두면 그 뒤로는 손댈 일이 없다.

### 4단계 — 쿠팡 파트너스 가입 + 인스타 채널 등록

수익 링크의 출처다. (다른 담당자 영역과 겹칠 수 있으니 인스타에 걸리는 부분만 적는다.)

1. 쿠팡 계정이 없으면 먼저 만든다 → https://www.coupang.com
2. 쿠팡 파트너스 가입 → https://partners.coupang.com
   - **사업자등록증 없어도 개인으로 가입된다.** `[확인]`
   - 초기 비용 없다. `[확인]`
3. **가입 과정에서 "활동 채널"에 인스타그램 계정 URL을 반드시 등록한다.**
   - `https://www.instagram.com/<내아이디>/`
   - **등록 안 한 계정으로 광고 활동을 하면 부정행위로 간주된다.** `[확인]` 이게 정산 취소 사유다.
   - 유튜브·틱톡·네이버클립도 채널이 생기는 대로 **전부** 추가한다.
4. 마지막에 **해당 채널에 파트너스 링크/배너가 실제로 게시된 스크린샷**을 제출해야 한다. `[확인]`
   → 즉 **3단계(프로필 링크)를 먼저 해두고 그 화면을 찍어야 한다.** 순서를 바꾸면 되돌아온다.

### 5단계 — Meta 개발자 앱 만들기 (API 업로드의 시작)

1. https://developers.facebook.com 접속 → 오른쪽 위 **`시작하기`** → 페이스북 계정으로 로그인
   - 페이스북 계정이 없으면 여기서 만들어야 한다. **개발자 콘솔은 페이스북 계정으로만 들어간다.**
   - (페이스북 *페이지*는 필요 없다. *계정*만 필요하다. 이 둘은 다르다.)
2. **`내 앱`** → **`앱 만들기`**
3. 앱 유형에서 **`비즈니스(Business)`** 를 고른다. `[확인]`
4. 앱 이름을 넣는다. (예: `shorts-factory-ig`) 이름은 아무거나 괜찮다.
5. 앱 대시보드 → **`제품 추가`** → **`Instagram`** (Instagram Platform) → **`설정`**
6. **`Instagram API with Instagram Login`** (= Business Login) 을 선택한다. `[확인]`
   - **이걸 골라야 페이스북 페이지 연결이 면제된다.** `[확인]`
   - 반대쪽인 `Instagram API with Facebook Login` 을 고르면 페이지 연결 + 비즈니스 자산 연동이
     줄줄이 딸려온다. 고르지 말 것.
7. **OAuth 리디렉션 URI**를 등록한다.
   - 여기서 대표님이 하실 건 없다. 개발 쪽에서 URL을 드리면 그대로 붙여넣기만 하면 된다.
   - `[추정]` Meta는 리디렉션 URI에 **HTTPS**를 요구한다. `localhost` 허용 여부는 확인 못 함 `[미확인]`.
     막히면 Vercel 프리뷰 URL 하나를 콜백으로 쓰면 된다.
8. **요청할 권한(scope)** 은 아래 2개다. 더 요청하지 않는다.

   ```
   instagram_business_basic
   instagram_business_content_publish
   ```
   `[확인]` — **불필요한 scope를 더 요청하면 나중에 심사가 필요해질 때 반려 사유가 된다.**

### 6단계 — 토큰 발급 → GitHub Secrets

**여기가 유일하게 비밀값이 오가는 구간이다. 값은 채팅에 절대 붙여넣지 않는다.**

1. 5단계에서 만든 OAuth 링크를 브라우저에서 연다 → 인스타 계정으로 로그인 → **`허용`**
2. 리디렉션으로 돌아온 주소에 `code=...` 가 붙어 온다. → 이걸 **장기 토큰(long-lived)** 으로 교환한다.
   - 단기 토큰 → 장기 토큰 교환이 필요하다. **장기 토큰 유효기간은 60일이다.** `[확인]`
   - **60일 안에 갱신(refresh)하지 않으면 죽는다.** → 자동 갱신 잡을 반드시 같이 넣어야 한다.
3. 아래 이름으로 **GitHub Secrets** 에 넣는다.
   `Settings → Secrets and variables → Actions → New repository secret`

   | Secret 이름 | 들어가는 값 |
   |---|---|
   | `IG_APP_ID` | Meta 앱 대시보드의 앱 ID |
   | `IG_APP_SECRET` | 같은 화면의 앱 시크릿 (`표시` 눌러야 보임) |
   | `IG_LONG_LIVED_TOKEN` | 60일짜리 장기 액세스 토큰 |
   | `IG_USER_ID` | 인스타 프로페셔널 계정의 숫자 ID |

   **이 4개 값을 저에게 보여주지 마세요.** 형식이 맞는지 확인이 필요하면
   `src/probe-typecast.ts` 처럼 **값을 가리고 구조만 찍는 프로브**를 만들어 드리겠습니다.

4. 테스트 릴스 1개를 API로 올려본다. 순서는 3단계다. `[확인]`

   ```
   ① POST /{ig-user-id}/media
        media_type=REELS
        video_url=<공개 접근 가능한 mp4 URL>
        caption=<본문>
        share_to_feed=true        ← 피드에도 같이 노출시키려면
      → creation_id 를 받는다

   ② GET /{creation-id}?fields=status_code
      → status_code 가 FINISHED 가 될 때까지 폴링한다

   ③ POST /{ig-user-id}/media_publish
        creation_id=<①의 값>
   ```

   - 호스트는 Instagram Login 경로에서 `graph.instagram.com` 으로 알려져 있으나
     `graph.facebook.com` 이라는 출처도 있어 **확정 못 함** `[미확인]`. 실제 응답을 보고 확정할 것.
   - API 버전(`/v23.0/` 등)도 **확인 못 함** `[미확인]`. 콘솔에 표시되는 최신 버전을 쓸 것.

### 7단계 — (나중) 릴스 링크 스티커 확보

지금은 못 한다. 조건이 둘 중 하나다. `[확인]`

- **팔로워 10,000명 이상**, 또는
- **Meta Verified 구독** (팔로워 수 무관)

Meta Verified 한국 가격: **인스타 프로필 1개 월 22,000원**, 인스타+페북 묶음 **월 35,900원** `[추정]`
(2023년 국내 도입 시점 보도 기준. 2026년 현재 가격은 **확인 못 함** `[미확인]`)

`[추정]` Meta Verified 등급별로 **링크를 붙일 수 있는 릴스 개수가 월 단위로 제한**된다는
출처가 있다 (Plus 2개 / Premium 4개 / Max 6개). 사실이라면 매일 올리는 우리 구조에는
**거의 쓸모가 없다.** → **당분간 Meta Verified는 사지 않는다.** 프로필 링크로 간다.

---

## 2. 막히는 지점

### 계정·전환 단계

| 증상 | 원인 / 해법 |
|---|---|
| `설정`에 `프로페셔널 계정으로 전환` 이 안 보인다 | PC 웹에서 찾고 있는 것이다. **모바일 앱에서만 된다.** |
| 전환했더니 계정이 공개로 바뀌었다 | 정상이다. 프로페셔널 계정은 비공개가 안 된다. `[확인]` |
| 전환 직후 도달이 떨어졌다 | 3자 매체가 흔히 보고하는 현상 `[추정]`. Meta 공식 확인은 없음. 며칠 지켜볼 것. |
| `프로필 편집`에 `링크` 메뉴가 없다 | PC 웹이다. 모바일 앱으로 들어갈 것. `[확인]` |

### 쿠팡 파트너스 단계

| 증상 | 원인 / 해법 |
|---|---|
| 스크린샷 제출에서 막힌다 | 프로필 링크(3단계)를 먼저 세팅하고 그 화면을 찍어야 한다. 순서 문제다. |
| 나중에 정산이 취소됐다 | **채널 미등록**이 가장 흔한 사유다. `[확인]` 채널이 늘 때마다 즉시 추가할 것. |

### Meta 개발자 앱 단계

| 증상 | 원인 / 해법 |
|---|---|
| "앱 심사를 받아야 한다"고 나온다 | **본인 계정에만 올릴 거면 심사 불필요하다.** `[확인]` 앱을 **개발 모드(Development)** 에 두고, 올릴 인스타 계정이 앱에서 **관리자/개발자/테스터 역할**을 갖고 있으면 Standard Access로 동작한다. Live 모드로 올리고 Advanced Access를 신청하는 순간 심사+사업자 검증이 붙는다. |
| 사업자 검증(Business Verification)을 요구한다 | 위와 같은 원인이다. Advanced Access를 신청했을 때만 나온다. `[확인]` 앱을 개발 모드로 되돌릴 것. |
| 페이스북 페이지를 연결하라고 한다 | `Instagram API with Facebook Login` 쪽을 골랐다. `Instagram API with **Instagram** Login` 으로 다시 설정할 것. `[확인]` |
| 리디렉션 URI가 거부된다 | HTTPS가 아니거나 대시보드에 등록한 문자열과 **완전히 일치**하지 않는 것이다. 끝의 `/` 하나까지 같아야 한다. |

### API 업로드 단계

| 증상 | 원인 / 해법 |
|---|---|
| `media_publish` 가 실패한다 | ②의 `status_code` 가 `FINISHED` 되기 전에 ③을 쐈다. **폴링을 건너뛰지 말 것.** 고정 `sleep`도 위험하다 — 영상 길이에 따라 처리 시간이 다르다. |
| `video_url` 을 못 읽는다고 한다 | Meta 서버가 **직접 GET 할 수 있는 공개 URL**이어야 한다. 인증·서명·Referer 체크가 걸린 URL은 안 된다. `[확인]` |
| 올라갔는데 릴스 탭에 안 뜬다 | 릴스 탭 노출 조건을 못 맞췄다. **9:16 비율 / 5~90초 / H.264 또는 HEVC** `[확인]`. API는 15분짜리도 받아주지만 릴스 탭에는 안 걸린다. |
| 에러 코드 `9` (subcode `2207042`) | **일일 발행 한도 초과**다. `[확인]` |
| 하루 몇 개까지 올릴 수 있는지 모르겠다 | Meta 문서가 **50개와 100개를 서로 다르게 적어놨다** `[확인]`. 추측하지 말고 `GET /{ig-user-id}/content_publishing_limit` 를 호출해 **계정별 실제 값**을 읽을 것. `[확인]` 한도는 자정이 아니라 **각 발행 시점으로부터 24시간 뒤**에 풀린다. `[확인]` |
| 미발행 컨테이너가 쌓여서 막힌다 | **미발행 상태 컨테이너는 동시에 50개까지**다 `[추정]`. 실패한 컨테이너를 방치하지 말 것. |
| 60일쯤 지나 갑자기 전부 401이 뜬다 | 장기 토큰이 만료됐다. `[확인]` **갱신 잡을 미리 넣어두고, 만료 7일 전에 알림이 오게 할 것.** 이건 "영상은 나갔는데 수익이 0"보다 나은 편이지만, 조용히 실패하면 며칠을 날린다. |

### 공정거래위원회 (한국 법령)

제휴 링크는 **경제적 이해관계 표시 대상이다.** `[확인]`

- **릴스는 "영상 초반 3초"와 "모바일 첫 화면"이 검수 기준 위치다.** `[추정]`
  (공정위 심사지침이 "제목 또는 첫 부분"에 표시하도록 개정된 것은 `[확인]`)
- 무료 제품·할인·협찬뿐 아니라 **제휴 링크와 성과 보상도 표시 대상**이다. `[확인]`
- → **쇼츠 생성 파이프라인에서 "광고·제휴 링크 포함" 문구를 영상 첫 3초 자막과 캡션 첫 줄에
  자동으로 넣어야 한다.** 사람이 매번 넣는 구조로 두면 반드시 빠진다.

---

## 3. 대신할 수 없는 것

명의가 걸린 일이다. **Chrome 확장을 붙여도 줄어드는 건 폼을 찾아다니는 시간이지 입력 자체가 아니다.**

1. **인스타그램 가입 시 휴대폰/이메일 인증** — 본인 명의 번호로 오는 SMS
2. **인스타그램 2단계 인증 등록 및 백업 코드 보관**
3. **페이스북 계정 로그인** (Meta 개발자 콘솔 진입용). 계정 이상 징후 시 **셀카 영상 인증**이 뜰 수 있다.
4. **OAuth 동의 화면의 `허용` 클릭** — 권한을 넘기는 행위라 본인이 눌러야 한다.
5. **쿠팡 계정 가입 및 본인인증**
6. **쿠팡 파트너스 정산 정보 입력** — 실명, 주민등록번호(원천징수용), 본인 명의 계좌번호
7. **Meta Verified를 나중에 구매할 경우 신분증 촬영** — 사진이 있는 정부 발행 신분증
8. **GitHub Secrets 에 토큰 값 붙여넣기** — 값 자체는 대표님만 보셔야 한다.

**1~7번 중 어느 것도 제가 하지 않습니다.** 8번은 화면 위치와 Secret 이름까지 드리지만
값은 제가 보지 않습니다.

---

## 4. Claude in Chrome 용 프롬프트

아래를 **대표님 PC의 Claude Code 세션**에 그대로 붙여넣으세요.
그 세션은 이 대화를 모르니 혼자 읽어도 말이 되게 썼습니다.

### 4-1. 인스타 계정 준비 + 프로페셔널 전환 확인

```
너는 Chrome 확장을 통해 내 브라우저를 조작할 수 있다. 아래를 순서대로 진행해줘.
민감 정보(비밀번호, SMS 인증번호, 토큰)가 필요한 입력창이 나오면 절대 추측해서 채우지 말고
거기서 멈춘 뒤 "여기부터는 직접 입력하세요"라고 나에게 말하고 대기해.

목표: 인스타그램 계정을 쇼핑 쇼츠 업로드용으로 세팅하는 것. 아직 팔로워 0명이다.

1) https://www.instagram.com/ 에 접속해서 내가 로그인돼 있는지 확인하고 결과를 알려줘.
   로그인이 안 돼 있으면 거기서 멈추고 나에게 로그인하라고 말해.

2) 로그인돼 있으면 내 프로필로 가서 아래 3가지를 확인해 표로 정리해줘.
   - 현재 계정 유형이 개인(Personal)인지 프로페셔널(크리에이터/비즈니스)인지
   - 프로필에 등록된 외부 링크가 몇 개인지, 각각 어떤 URL인지
   - 계정이 공개인지 비공개인지

3) 프로페셔널 계정이 아직 아니라면: 인스타그램 웹에서는 전환 메뉴가 없다고 알려져 있으니
   웹에서 억지로 찾지 말고, 나에게 "휴대폰 앱에서 해야 한다"고 알려준 뒤
   앱에서 눌러야 할 메뉴 경로를 한 줄로 정리해줘.

4) 다음 주소를 열어서 2단계 인증이 켜져 있는지 확인하고 알려줘. 꺼져 있으면
   켜는 화면까지만 이동하고 멈춰. 인증 앱 등록은 내가 직접 한다.
   https://www.instagram.com/accounts/two_factor_authentication/

작업이 끝나면 확인한 내용만 요약해줘. 비밀번호나 인증번호는 화면에서 읽어도 나에게
되읽어주지 말고, 어떤 파일에도 적지 마.
```

### 4-2. Meta 개발자 앱 만들기 (API 업로드용)

```
너는 Chrome 확장을 통해 내 브라우저를 조작할 수 있다. 아래를 순서대로 진행해줘.
비밀값(App Secret, 액세스 토큰) 입력·복사 구간이 나오면 멈추고 나에게 넘겨.
그 값들을 채팅에 출력하거나 파일에 쓰지 마.

배경: 나는 인스타그램 릴스를 공식 API로 자동 업로드하려고 한다. 올리는 계정은 내 소유
1개뿐이라서 Meta App Review(앱 심사)와 Business Verification(사업자 검증)은 필요 없고,
앱을 개발(Development) 모드에 둔 채로 쓸 계획이다. 이 전제를 유지해줘.
"Advanced Access를 신청하라"는 안내가 나와도 신청하지 마.

1) https://developers.facebook.com 에 접속해서 로그인 상태를 확인해줘.
   로그인이 안 돼 있으면 멈추고 나에게 알려줘.

2) "내 앱(My Apps)"으로 이동해서 기존 앱 목록을 보여줘.
   이미 인스타그램용 앱이 있으면 새로 만들지 말고 그걸 쓴다.

3) 없으면 새 앱을 만들어줘.
   - 앱 유형(Use case / App type): "비즈니스(Business)" 를 선택
   - 앱 이름: shorts-factory-ig
   - 그 외 선택지가 나오면 무엇을 고를지 나에게 먼저 물어봐. 임의로 고르지 마.

4) 앱 대시보드에서 제품(Products)에 "Instagram" 을 추가하고 설정으로 들어가줘.

5) 로그인 방식 선택 화면에서 반드시 다음을 고른다:
   ▶ "Instagram API with Instagram Login" (= Business Login)
   ▶ "Instagram API with Facebook Login" 은 고르지 마. 그쪽은 페이스북 페이지 연결이 필요해진다.

6) 권한(Permissions / Scopes) 화면이 나오면, 아래 2개만 있는지 확인하고 나머지는 추가하지 마.
   - instagram_business_basic
   - instagram_business_content_publish

7) 다음 항목들이 현재 화면에서 각각 어디에 있는지 위치를 알려줘. 값 자체는 읽지 말고
   "어느 메뉴 → 어느 항목" 형태의 경로만 알려줘.
   - 앱 ID (App ID)
   - 앱 시크릿 (App Secret)
   - OAuth 리디렉션 URI 등록란
   - 앱이 개발(Development) 모드인지 라이브(Live) 모드인지 표시되는 곳
   - 앱에 인스타그램 테스터/역할(Roles)을 추가하는 메뉴

8) 마지막으로 앱이 "개발(Development)" 모드인지 확인해서 알려줘. 라이브로 바꾸지 마.

끝나면 3~8단계에서 실제로 무엇을 눌렀고 지금 화면이 어떤 상태인지 요약해줘.
App Secret 과 토큰은 어떤 경우에도 출력하지 마.
```

### 4-3. 쿠팡 파트너스 채널 등록 확인

```
너는 Chrome 확장을 통해 내 브라우저를 조작할 수 있다.
로그인·본인인증·계좌입력 화면이 나오면 거기서 멈추고 나에게 넘겨. 대신 입력하지 마.

배경: 나는 쿠팡 파트너스로 제휴 수수료를 받는다. 인스타그램·유튜브·틱톡·네이버클립에
쇼츠를 올리는데, 쿠팡 파트너스는 활동 채널을 전부 등록해두지 않으면 부정행위로 보고
정산을 취소한다고 알고 있다. 등록 누락이 없는지 점검하고 싶다.

1) https://partners.coupang.com 에 접속해서 로그인 상태를 확인해줘.
   로그인이 안 돼 있으면 멈추고 알려줘.

2) 내 계정 설정에서 "채널 관리" 또는 "활동 채널" 에 해당하는 메뉴를 찾아서 들어가줘.
   메뉴 이름이 다르면 비슷한 것을 찾아보고, 못 찾으면 현재 보이는 메뉴 목록을 나에게 보여줘.

3) 현재 등록된 채널 목록을 URL 그대로 표로 보여줘. 그리고 아래 중 빠진 게 있는지 알려줘.
   - 인스타그램 프로필 URL
   - 유튜브 채널 URL
   - 틱톡 프로필 URL
   - 네이버 클립 프로필 URL

4) 빠진 채널이 있으면 추가하는 화면까지만 이동하고 멈춰. URL은 내가 직접 넣는다.

5) 채널 등록에 "해당 채널에 파트너스 링크가 게시된 스크린샷" 제출이 필요한지
   화면에서 확인해서 알려줘. 필요하면 어떤 조건(어떤 화면을 찍어야 하는지)인지도 같이.

끝나면 등록된 채널과 빠진 채널만 요약해줘.
```

---

## 5. API vs 브라우저 자동화 — 결론

### 결론: **공식 API로 간다. 브라우저 자동화는 쓰지 않는다.**

### 근거

**1) 이 프로젝트 조건에서는 API의 진입 장벽이 거의 없다.**

흔히 "인스타 API는 심사가 빡세다"고 하는데, 그건 **남의 계정을 대신 관리하는 앱** 이야기다.
우리는 **내 계정 1개에만 올린다.** 이 경우:

| 항목 | 우리 경우 | 근거 |
|---|---|---|
| Meta 앱 심사 (App Review) | **불필요** | 본인 계정은 Standard Access로 동작 `[확인]` |
| 사업자 검증 (Business Verification) | **불필요** | Advanced Access 신청할 때만 요구 `[확인]` |
| 페이스북 페이지 연결 | **불필요** | Instagram Login 경로(2024.7~) `[확인]` |
| 앱 라이브 모드 전환 | **불필요** | 개발 모드 유지 `[확인]` |
| 필요한 것 | 페이스북 계정 1개 + 프로페셔널 계정 전환 + 토큰 60일 갱신 | |

**2) 브라우저 자동화는 정책 위반 쪽에 붙어 있다.**

Meta는 **비밀번호·쿠키·스크래핑·브라우저 제어 기반 자동화를 명시적으로 금지**하고,
**공식 Content Publishing API를 통한 예약·자동 게시는 허용**한다. `[확인]`
제재는 단계적으로 올라간다: 기능 제한 → 24시간~30일 정지 → 최대 180일 정지 → 영구 비활성화. `[추정]`

매일 5개 채널에 올리는 구조에서 인스타 계정이 영구 정지되면,
**팔로워뿐 아니라 프로필 링크(= 수익 경로 전부)가 같이 날아간다.**
프로필 링크가 유일한 수익 구멍인 이 설계에서는 계정 정지 = 인스타 수익 0이다.
**리스크 대비 이득이 전혀 맞지 않는다.**

**3) 브라우저 자동화를 써도 얻는 게 없다.**

브라우저 자동화가 API보다 나은 유일한 지점은 "API가 못 하는 기능"인데,
우리가 쓰고 싶은 릴스 업로드·캡션·피드 동시 노출은 **전부 API가 지원한다.** `[확인]`
링크 스티커는 브라우저로 붙여도 **1만 팔로워/Meta Verified 조건 자체를 우회하지 못한다.**
→ 계정을 걸고 얻을 게 없다.

### 그래서 이렇게 설계한다

```
쇼츠 생성
   ↓
사람 승인 (기존 승인 단계 그대로)
   ↓
mp4 를 공개 접근 가능한 URL 에 올린다      ← Meta 서버가 직접 GET 해야 함
   ↓
POST /{ig-user-id}/media  (media_type=REELS, video_url, caption, share_to_feed=true)
   ↓
GET /{creation-id}?fields=status_code  →  FINISHED 될 때까지 폴링
   ↓
POST /{ig-user-id}/media_publish  (creation_id)
   ↓
링크인바이오 허브 페이지 갱신            ← 여기가 수익 경로
```

**같이 넣어야 하는 것 (빠뜨리면 조용히 죽는다):**

- **토큰 갱신 잡** — 장기 토큰 60일. 만료 7일 전 알림.
- **`content_publishing_limit` 사전 조회** — 한도 초과를 에러로 맞지 말고 미리 확인.
- **폴링 실패 시 던지기** — `FINISHED` 안 되면 빈 값으로 넘어가지 말고 실패로 처리.
  조용히 넘어가면 "영상은 나갔는데 수익이 0"으로 며칠 뒤에 돌아온다.
- **공정위 표시 자동 삽입** — 영상 첫 3초 자막 + 캡션 첫 줄.

### 남은 결정 사항 (대표님 판단 필요)

1. **mp4 호스팅을 어디에 둘 것인가.** Meta 서버가 직접 읽을 수 있는 공개 URL이 필요하다.
   이미 Vercel을 쓰고 있으니 거기 얹는 게 가장 싸다.
2. **링크인바이오 허브를 자체 페이지로 만들 것인가.** 권장한다. 외부 서비스를 쓰면
   매일 사람이 갱신해야 한다.

---

## 6. 확인 못 한 것 (정리)

이 목록은 **이 문서를 믿고 판단하면 안 되는 구간**이다.

| 항목 | 상태 |
|---|---|
| API 호스트가 `graph.instagram.com` 인지 `graph.facebook.com` 인지 | `[미확인]` 출처가 엇갈림. 실제 응답으로 확정할 것 |
| 현재 API 버전 번호 (`/v23.0/` 등) | `[미확인]` 콘솔에 뜨는 최신 버전을 쓸 것 |
| OAuth 리디렉션 URI에 `localhost` 가 허용되는지 | `[미확인]` |
| 일일 발행 한도가 50인지 100인지 | `[미확인]` Meta 문서 자체가 엇갈림. `content_publishing_limit` 로 읽을 것 |
| Meta Verified 2026년 현재 한국 가격 | `[미확인]` 2023년 도입 보도 기준 22,000원/35,900원 `[추정]` |
| Meta Verified 등급별 릴스 링크 개수 제한 (Plus 2 / Premium 4 / Max 6) | `[추정]` 블로그 1곳 출처 |
| 인스타 네이티브 제휴의 한국 출시 시점 | `[미확인]` "추후 확대" 라고만 나옴 |
| Meta 개발자 콘솔의 현재 정확한 메뉴 문구 | `[미확인]` 1차 출처 접근 불가 |
| 신규 계정 워밍업 기간 권고 | `[추정]` Meta 공식 수치 아님 |

**1차 출처를 하나도 못 열었다.** 실제 세팅 중 화면이 이 문서와 다르면 **화면을 믿으세요.**
다르게 나온 지점을 알려주시면 이 문서를 고치겠습니다.

---

## 출처

- [Publish Content using the Instagram Platform — Meta Developer Documentation](https://developers.facebook.com/docs/instagram-platform/content-publishing/) (검색 요약으로만 확인, 직접 접근 차단)
- [Instagram Platform API 콘텐츠 발행 구현 가이드 (GitHub Gist)](https://gist.github.com/PrenSJ2/0213e60e834e66b7e09f7f93999163fc) — 직접 열람 성공. scope 이름·페이지 불필요·심사 불필요 근거
- [Instagram API Advanced Access Approval Guide (2026)](https://singhamandeep.com/instagram-api-advanced-access-approval/)
- [Instagram Graph API Error 9: The 25-Post Daily Limit — Ayrshare](https://www.ayrshare.com/solutions/instagram-graph-api-error-9-the-25-post-daily-limit-how-to-fix-it/)
- [Instagram API Rate Limits: The Real Caps — bundle.social](https://bundle.social/blog/instagram-api-rate-limits)
- [Instagram Reels API Publishing Guide (2026) — Postproxy](https://postproxy.dev/blog/instagram-reels-api-publishing-guide/)
- [Instagram Reels API: Complete Developer Guide (2026) — Phyllo](https://www.getphyllo.com/post/a-complete-guide-to-the-instagram-reels-api)
- [Instagram Re-Enters Creator Affiliate Commerce — NetInfluencer](https://www.netinfluencer.com/instagram-re-enters-creator-affiliate-commerce-years-after-rivals-built-lead/)
- [Instagram Reels Now Has Native Affiliate Commerce — JoinBrands](https://joinbrands.com/blog/instagram-shop-2026/)
- [Instagram Now Lets Creators Add Affiliate Links to Reels — Affiverse](https://www.affiversemedia.com/content-hub/instagram-now-lets-creators-add-affiliate-links-to-reels/)
- [Instagram will shut down its affiliate commerce program on Aug. 31 — Digiday](https://digiday.com/future-of-tv/instagram-will-shut-down-its-affiliate-commerce-program-on-aug-31/)
- [How to Add a Clickable Link to an Instagram Reel in 2026 — Inrō](https://www.inro.social/blog/meta-verified-clickable-links-instagram-reels-pricing)
- [Instagram Story Link Sticker Requirements 2026 — ShareB.io](https://shareb.io/blog/instagram-story-link-sticker-requirements)
- [Instagram now allows up to 5 "links in bio" — Search Engine Land](https://searchengineland.com/instagram-now-allows-up-to-5-links-in-bio-395742)
- [Instagram Automation Rules in 2026: What's Allowed — Unfollr](https://www.unfollr.com/blog/instagram-automation-rules)
- [Instagram AI Automation Rules: What's Allowed in 2026 — IntelliCoach](https://intellicoach.ai/blog/instagram-ai-automation-rules-banned-restricted-2026)
- [인스타그램 비즈니스 계정 전환 완벽 가이드 2026 — Linkfarm](https://linkfarm.ai/blog/instagram-business-account-guide-2026)
- [인스타 프로페셔널 계정 전환 — 비즈니스·크리에이터 차이 — 포크레터](https://forcreator.co.kr/blog/instagram-professional-account-switch)
- [페북·인스타 '인증배지' 월 3만5900원…한국에도 도입 — 뉴시스](https://www.newsis.com/view/NISX20231201_0002542495)
- [Meta, 인증배지 구독 서비스 'Meta Verified' 글로벌 확대 도입 — Meta 뉴스룸](https://about.fb.com/ko/news/2023/12/meta-verified/)
- [쿠팡 파트너스 시작 가이드 2026 — Linkfarm](https://linkfarm.ai/blog/coupang-partners-tips-beginners-2026)
- [쿠팡 파트너스 이용 가이드 v.1 (PDF)](https://partners.coupangcdn.com/partners-guide/partners-guide-20240716100922.pdf)
- [「추천·보증 등에 관한 표시·광고 심사지침」 개정·시행 — 공정거래위원회](https://www.ftc.go.kr/www/selectBbsNttView.do?pageUnit=10&pageIndex=1&searchCnd=all&key=12&bordCd=3&searchCtgry=01%2C02&nttSn=47547)
- [뒷광고 방지 체크리스트: 표시광고법 2026 가이드 — 싱클리](https://www.syncly.kr/blog/influencer-disclosure-compliance-checklist-2026)
