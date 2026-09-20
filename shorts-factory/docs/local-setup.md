# 로컬에서 돌리기

## 왜 옮기는가

하루 종일 파이프라인을 막은 것의 정체가 **데이터센터 IP 차단**이었다.
같은 날 같은 코드로 잰 값:

| | GitHub Actions 러너 | 사용자 브라우저 |
|---|---|---|
| 알리익스프레스 상세 | 26번 열어 **0번** 열림 (전부 검증 페이지) | — |
| 1688 검색 | 세 진입로 전부 차단 조각 | **로그인·캡차 없이 상품 9곳** |
| 1688 상세 → 영상 | 0개 | **영상 12개** |
| 쿠팡 검색 | HTTP 403 (Akamai) | 열림 |
| 틱톡 게시물 목록 | 스크롤 12회에 0건 | — |

사이트가 우리를 막은 게 아니라 **그 IP 대역을 막은 것**이다. 가정용 IP 에서는 같은
코드가 그냥 돈다. 그래서 소재 수집을 사람이 20분씩 손으로 하고 있었는데, 로컬로
옮기면 그 작업이 통째로 사라진다.

## 로컬로도 안 풀리는 것

정직하게 적어둔다. 옮긴다고 전부 되는 게 아니다.

1. **쿠팡 파트너스 최종승인** — 계정 승인 문제라 IP 와 무관하다. 승인 전까지
   제휴 링크를 자동으로 못 만들고, 그러면 **영상이 나가도 수수료가 0원**이다.
2. **PC 가 켜져 있어야 한다** — 새벽 자동 실행이면 잠들지 않게 해둬야 한다.
   GitHub 은 알아서 돌았지만 그 편의는 없어진다.
3. **업로드 셀렉터** — 아직 어디서도 검증 못 했다. 로컬이 유리하긴 하다
   (로그인된 브라우저 프로필을 그대로 쓴다).

## 설치

macOS 기준. 한 번만 하면 된다.

```bash
# 1) 도구
brew install node@22 python@3.12 ffmpeg

# 2) 레포
git clone https://github.com/orosibam/customai-landing-preview.git
cd customai-landing-preview/shorts-factory
git checkout claude/auto-shorts-generation-upload-zxewpu

# 3) 의존성
npm ci
pip3 install -r scrapers-py/requirements.txt
npx playwright install chromium

# 4) 환경변수
cp .env.example .env
# .env 를 열어 값을 채운다. 값은 채팅에 붙여넣지 않는다.
```

## 돌리기

```bash
# 한 편 만들기 (발굴부터 렌더까지)
npm run stage one -- --channel=yt-gadget

# 특정 제품으로 (이미 DB 에 있는 상품)
npm run stage one -- --channel=yt-gadget --product=无线高压水枪

# 완성본 링크 뽑기
npm run stage share

# 수확 재고 보기
npm run links status
```

## 막히면

- **캡차가 뜬다** → `.env` 에 `HEADFUL=true` 를 두면 브라우저가 보인다.
  한 번 풀어주면 그 세션 동안은 통과한다.
- **`spawn ffmpeg ENOENT`** → ffmpeg 이 설치 안 됐거나 PATH 에 없다.
- **`curl_cffi 가 설치돼 있지 않습니다`** → `pip3 install -r scrapers-py/requirements.txt`.
  node 의존성만 깔고 파이썬을 빼먹으면 1688·타오바오 경로가 통째로 죽는다
  (제작 워크플로우에서 실제로 그렇게 당했다).
- **소재가 0개** → 그 제품의 수확 재고가 없다는 뜻이다. 로컬에서는 자동 수집이
  돌아야 정상이므로, 0 이면 알리/1688 쪽 에러 원문을 읽는다.

## 매일 자동으로

먼저 손으로 몇 번 돌려 끝까지 가는 걸 확인한 뒤에 걸어야 한다. 안 그러면
매일 새벽에 조용히 실패한다.

```bash
# crontab -e  — 매일 새벽 5시
0 5 * * * cd /경로/customai-landing-preview/shorts-factory && /opt/homebrew/bin/npm run stage daily >> ~/shorts.log 2>&1
```

macOS 는 잠들면 cron 이 안 돈다. `caffeinate` 를 쓰거나 전원 설정에서 예약 기상을
걸어둔다.
