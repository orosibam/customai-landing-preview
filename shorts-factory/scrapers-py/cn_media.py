#!/usr/bin/env python3
"""
중국 플랫폼(샤오홍슈·1688) 접근 헬퍼.

왜 파이썬인가
-------------
파이프라인은 전부 TypeScript다. 이 파일만 파이썬인 이유는 하나다 —
**실제로 통한 방법이 curl_cffi 였기 때문이다.**

앞서 헤드리스 크롬(Playwright)으로 「재생 페이지를 열어 미디어 응답을 가로채는」
방식을 구현했고, 샤오홍슈에서 막혔다:

  · 검색 페이지가 「로그인 후 검색결과 보기」로만 렌더된다. 검색 API 호출 자체가
    일어나지 않으므로 응답을 가로챌 것이 없다.
  · 게스트 쿠키를 받아 페이지 컨텍스트의 서명 함수로 직접 호출해도 code -104 (권한 없음).

통한 방법은 브라우저를 아예 안 쓰는 것이다. curl_cffi 로 크롬의 TLS 지문을 흉내 내서
SSR HTML을 그대로 받고, 그 안에 박혀 있는 `window.__INITIAL_STATE__` JSON을 파싱한다.
로그인도 쿠키도 필요 없다. node 에는 크롬 TLS 지문을 흉내 내는 검증된 수단이 없어서
이 한 파일만 파이썬으로 두고 TS 쪽에서 프로세스로 부른다 (`src/lib/scrapers/cn-bridge.ts`).

무엇이 되고 무엇이 안 되는가 (2026-09 기준, 전부 실측)
------------------------------------------------------
  되는 것   · 수확한 URL 로 노트 상세 열기 → 영상 주소·좋아요·수집 수 (로그인 불필요)
            · 1688 상품 상세 → 영상 주소 (로그인 불필요)
            · /explore 피드 SSR (접근 확인용. 조준에는 못 쓴다 — 아래)
  안 되는 것 · 샤오홍슈 키워드 검색 — 로그인 벽
            · 1688 키워드 검색 — 25KB 를 받지만 상품 데이터가 HTML 에 없다 (JS 렌더)
            · 홈피드 반복 호출로 모수 늘리기 — 980건 뽑아 적중 0건. 무작위라 조준 불가
            · 샤오홍슈 계정별 노트 목록 (2026-09-18 재측정에서 noteId 가 전부 빈 문자열)

그래서 **키워드 조준은 사람이 한 번 해야 한다.** 로그인된 크롬에서 검색 결과의 href 를
통째로 수확하고(`harvest/*.js`), 그 뒤 파싱·다운로드는 전부 여기서 로그인 없이 돈다.

⚠️ href 를 자르지 않는다. xsec_token 은 게시물마다 다르고 쿼리스트링에 붙어 있어서,
id 만 남기고 토큰을 버리면 그 링크는 전부 404 다 — 실제로 그렇게 55건을 날린 적이 있다.
이 파일의 함수들이 id+token 이 아니라 **URL 통째로** 받는 이유가 그것이다.

사용법
------
  python3 cn_media.py xhs-note   --url '<수확한 URL 통째로>'
  python3 cn_media.py ali-offer  --url '<수확한 상세 URL 통째로>'
  python3 cn_media.py xhs-feed   --limit 30 [--channel <id>]   # 접근 확인용
  python3 cn_media.py download   --url <u> --referer <r> --out <path>
  python3 cn_media.py ali-probe  --keyword 洗车液              # 계측용
  python3 cn_media.py selfcheck

결과는 stdout 에 JSON 한 덩어리로 나간다. 실패는 stderr + 종료코드 1 이다.
빈 결과를 성공으로 위장하지 않는다 — 조용한 실패는 「영상은 나갔는데 수익이 0」으로
며칠 뒤에 돌아온다.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

try:
    from curl_cffi import requests as cffi_requests
except ImportError:  # pragma: no cover - 설치 안내는 실행 시점에 필요하다
    print(
        "curl_cffi 가 설치돼 있지 않습니다.\n"
        "  pip install 'curl_cffi>=0.7'\n"
        "이 라이브러리가 하는 일(크롬 TLS 지문 흉내)이 이 파일의 존재 이유라 "
        "requests 나 httpx 로 대체할 수 없습니다.",
        file=sys.stderr,
    )
    sys.exit(2)

# 크롬 최신 지문. curl_cffi 가 지원하는 프로필 이름이며, 버전이 올라가면 여기만 바꾼다.
IMPERSONATE = "chrome"

XHS_ORIGIN = "https://www.xiaohongshu.com"
ALI_DETAIL = "https://detail.1688.com/offer/{id}.html"
ALI_SEARCH = "https://s.1688.com/selloffer/offer_search.htm?keywords={kw}"


class Blocked(RuntimeError):
    """요청이 차단됐거나 기대한 구조가 아닐 때. 호출부가 원인을 그대로 읽을 수 있게 한다."""


# ---------------------------------------------------------------------------
# 공통
# ---------------------------------------------------------------------------


def new_session() -> Any:
    s = cffi_requests.Session(impersonate=IMPERSONATE)
    s.headers.update(
        {
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )
    return s


def polite_sleep() -> None:
    """연속 요청 간격. 사람이 읽는 속도에 가깝게 둔다."""
    time.sleep(random.uniform(1.2, 2.8))


def get_html(session: Any, url: str, referer: str | None = None, attempts: int = 3) -> str:
    """
    1688 은 연속 요청을 맞으면 HTTP 200 으로 1KB 대 조각을 돌려준다. 영구 차단이 아니라
    일시적 스로틀이라 잠깐 쉬면 같은 URL 이 25KB 를 준다 — 실측에서 1135바이트가
    나오던 진입로가 다음 실행에서 정상 응답했다.
    그래서 조각은 실패로 보되 바로 포기하지 않고 간격을 벌려 다시 친다.
    끝까지 조각이면 그때는 던진다 (빈 결과로 넘어가지 않는다).
    """
    headers = {"Referer": referer} if referer else {}
    last = ""

    for attempt in range(attempts):
        if attempt > 0:
            time.sleep(2 ** attempt + random.uniform(0, 1.5))
        res = session.get(url, headers=headers, timeout=30)
        if res.status_code != 200:
            raise Blocked(f"HTTP {res.status_code} — {url}")
        text = res.text
        if len(text) >= 2_000:
            return text
        last = text

    raise Blocked(
        f"{attempts}번 시도했지만 응답이 {len(last)}바이트뿐입니다 "
        f"(스로틀 조각으로 보입니다) — {url}"
    )


# ---------------------------------------------------------------------------
# __INITIAL_STATE__ 파싱
# ---------------------------------------------------------------------------

_STATE_RE = re.compile(
    r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>", re.DOTALL
)


def extract_initial_state(html: str) -> dict[str, Any]:
    """
    SSR HTML 안의 `window.__INITIAL_STATE__` 를 뽑아 파싱한다.

    두 가지 함정이 있다.
      1. 샤오홍슈는 JSON 이 아니라 **JS 리터럴**을 심는다. 값이 비면 `null` 이 아니라
         `undefined` 가 들어가서 json.loads 가 그대로 터진다.
      2. Vue 의 ref 가 그대로 직렬화돼 있어서 실제 값이 `_rawValue` 한 겹 아래에 있다.
    여기서 1번을 처리하고, 2번은 unref() 가 처리한다.
    """
    match = _STATE_RE.search(html)
    if not match:
        raise Blocked(
            "__INITIAL_STATE__ 를 찾지 못했습니다. 로그인 벽이거나 SSR 구조가 바뀐 것입니다."
        )

    raw = match.group(1)
    # `undefined` 를 null 로. 문자열 안의 "undefined" 까지 건드리지 않도록
    # 값 자리(: 뒤, [ 뒤, , 뒤)에 오는 것만 바꾼다.
    raw = re.sub(r"(?<=[:\[,])\s*undefined\s*(?=[,\}\]])", " null", raw)

    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise Blocked(f"__INITIAL_STATE__ 파싱 실패: {e}") from e


def unref(node: Any) -> Any:
    """Vue ref 껍데기를 벗긴다. `{__v_isRef: true, _rawValue: X, _value: X}` → X."""
    if isinstance(node, dict):
        if "_rawValue" in node and ("__v_isRef" in node or "_value" in node):
            return unref(node["_rawValue"])
        return {k: unref(v) for k, v in node.items()}
    if isinstance(node, list):
        return [unref(v) for v in node]
    return node


def walk(node: Any) -> Iterator[dict[str, Any]]:
    """중첩 구조의 모든 dict 를 훑는다. 경로가 바뀌어도 찾아내기 위한 폴백."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


def as_int(value: Any) -> int | None:
    """샤오홍슈는 카운트를 "1.2万" 같은 문자열로도 준다."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    match = re.match(r"^([\d.]+)\s*([万千亿])?$", text)
    if not match:
        return None
    num = float(match.group(1))
    return int(num * {"万": 10_000, "千": 1_000, "亿": 100_000_000}.get(match.group(2) or "", 1))


# ---------------------------------------------------------------------------
# 샤오홍슈 — 피드
# ---------------------------------------------------------------------------


def xhs_feed(limit: int, channel: str | None, rounds: int = 1) -> list[dict[str, Any]]:
    """
    /explore 피드를 SSR 로 받아 노트 목록을 만든다.

    검색은 쓸 수 없다(로그인 벽). 피드가 유일한 입구이므로, 키워드 필터링은
    호출부가 캡션을 보고 한다. 「검색한 척」 하지 않는 게 중요하다 —
    실제로는 그날 피드에 뜬 것 중에서 고르는 것이고, 그 한계를 위에서 알아야
    할당량을 다른 플랫폼으로 돌릴지 판단할 수 있다.

    ⚠️ **이걸로 키워드를 조준할 수 없다.** 피드는 무작위라, 반복 호출로 모수를 늘리는
    방법은 실측에서 980건을 뽑아 적중 0건이었다. 비로그인으로는 모수를 못 늘린다는 게
    구조적 결론이고, 키워드 조준에는 `harvest/xiaohongshu.js` 로 수확한 링크를 쓴다.

    그럼 이 함수는 왜 남겨두는가: SSR 접근과 파싱이 살아 있는지 확인하는 용도다
    (`src/probe.ts` 의 점검). 파이프라인의 소재 공급 경로는 아니다.
    """
    session = new_session()
    url = f"{XHS_ORIGIN}/explore"
    if channel:
        url += f"?channel_id={quote(channel)}"

    notes: list[dict[str, Any]] = []
    seen: set[str] = set()

    for round_no in range(max(rounds, 1)):
        if round_no > 0:
            polite_sleep()
        state = unref(extract_initial_state(get_html(session, url)))
        _collect_feed_notes(state, notes, seen, limit)
        if len(notes) >= limit:
            break

    if not notes:
        raise Blocked(
            "피드에서 노트를 한 건도 못 읽었습니다. __INITIAL_STATE__ 는 받았으므로 "
            "차단이 아니라 필드 이름이 바뀐 쪽이 유력합니다 (noteId/xsecToken 을 찾지 못함)."
        )
    return notes


def _collect_feed_notes(
    state: Any,
    notes: list[dict[str, Any]],
    seen: set[str],
    limit: int,
) -> None:
    for node in walk(state):
        note_id = node.get("id") or node.get("noteId")
        token = node.get("xsecToken") or node.get("xsec_token")
        # 토큰이 있는 노드만이 열 수 있는 노트다. 토큰 없는 id 는 유저·태그 id 다.
        if not (isinstance(note_id, str) and note_id and isinstance(token, str) and token):
            continue
        if note_id in seen:
            continue

        card = node.get("noteCard") or node
        if not isinstance(card, dict):
            continue

        interact = card.get("interactInfo") if isinstance(card.get("interactInfo"), dict) else {}
        user = card.get("user") if isinstance(card.get("user"), dict) else {}

        notes.append(
            {
                "noteId": note_id,
                "xsecToken": token,
                "title": (card.get("displayTitle") or card.get("title") or "").strip(),
                "type": card.get("type"),
                "likes": as_int(interact.get("likedCount")),
                "authorId": user.get("userId"),
                "authorName": user.get("nickname") or user.get("nickName"),
            }
        )
        seen.add(note_id)
        if len(notes) >= limit:
            return


# ---------------------------------------------------------------------------
# 샤오홍슈 — 노트 상세
# ---------------------------------------------------------------------------


def _note_id_from_url(url: str) -> str:
    """
    URL 에서 note id 를 읽는다. 기록·중복제거용이며, **이걸로 URL 을 다시 만들지 않는다.**
    """
    match = re.search(r"/(?:explore|discovery/item)/([0-9a-f]{8,})", url)
    if not match:
        raise Blocked(f"note id 를 읽을 수 없는 URL 입니다: {url}")
    return match.group(1)


def _first_video_url(note: dict[str, Any]) -> str | None:
    """
    영상 주소는 media.stream.<코덱>[].masterUrl 아래에 있다.
    코덱은 h264/h265/av1 셋 중 무엇이 채워질지 노트마다 다르다 — ffmpeg 이 셋 다 읽으므로
    있는 것 중 첫 번째를 쓴다.
    """
    stream = (
        note.get("video", {}).get("media", {}).get("stream")
        if isinstance(note.get("video"), dict)
        else None
    )
    if isinstance(stream, dict):
        for codec in ("h264", "h265", "av1"):
            entries = stream.get(codec)
            if isinstance(entries, list) and entries:
                url = entries[0].get("masterUrl") or entries[0].get("backupUrls", [None])[0]
                if url:
                    return url

    # 구조가 바뀌었을 때를 위한 폴백: 트리에서 masterUrl 을 직접 찾는다.
    for node in walk(note):
        url = node.get("masterUrl")
        if isinstance(url, str) and url.startswith("http"):
            return url
    return None


def xhs_note(url: str) -> dict[str, Any]:
    """
    노트 상세를 연다. 인자는 **수확한 URL 통째로**다 — id 와 토큰을 따로 받아 URL 을
    재조립하지 않는다.

    이게 중요한 이유: 예전에 note id 만 남기고 xsec_token 을 벗겼다가 55건을 통째로
    날렸다. 토큰 없는 explore/<id> 는 전부 404 다. 재조립은 그 사고를 코드로 옮겨놓는
    짓이다 — 내가 아는 파라미터만 다시 붙이게 되고, 모르는 건 조용히 사라진다
    (xsec_source 처럼 나중에 필요해질 수 있는 것들).
    그래서 받은 URL 을 한 글자도 건드리지 않고 그대로 친다.
    """
    if "xsec_token=" not in url:
        raise Blocked(
            f"xsec_token 이 없는 URL 입니다 — 이 링크는 열리지 않습니다 (404): {url}\n"
            "   수확 단계에서 href 를 자르지 않았는지 확인하세요. "
            "explore/<id> 만 남은 링크는 복구할 수 없고 다시 수확해야 합니다."
        )

    note_id = _note_id_from_url(url)
    session = new_session()
    state = unref(extract_initial_state(get_html(session, url, referer=f"{XHS_ORIGIN}/explore")))

    note: dict[str, Any] | None = None
    detail_map = state.get("note", {}).get("noteDetailMap")
    if isinstance(detail_map, dict):
        entry = detail_map.get(note_id) or next(iter(detail_map.values()), None)
        if isinstance(entry, dict) and isinstance(entry.get("note"), dict):
            note = entry["note"]

    if note is None:
        # 폴백: interactInfo 와 noteId 를 함께 가진 노드를 찾는다.
        for node in walk(state):
            if isinstance(node.get("interactInfo"), dict) and node.get("noteId") == note_id:
                note = node
                break

    if note is None:
        raise Blocked(
            f"노트 {note_id} 의 상세를 찾지 못했습니다. xsec_token 이 이 노트 것이 맞는지, "
            "그리고 피드에서 받은 직후인지 확인하세요 (토큰은 게시물마다 다르고 만료됩니다)."
        )

    interact = note.get("interactInfo") if isinstance(note.get("interactInfo"), dict) else {}
    user = note.get("user") if isinstance(note.get("user"), dict) else {}
    posted_ms = note.get("time") or note.get("lastUpdateTime")

    return {
        "noteId": note_id,
        # 받은 그대로 돌려준다. 호출부가 다시 열어야 할 때 재조립하지 않게 한다.
        "url": url,
        "title": (note.get("title") or "").strip(),
        "desc": (note.get("desc") or "").strip(),
        "type": note.get("type"),
        "videoUrl": _first_video_url(note),
        "likes": as_int(interact.get("likedCount")),
        "collects": as_int(interact.get("collectedCount")),
        "comments": as_int(interact.get("commentCount")),
        "shares": as_int(interact.get("shareCount")),
        "authorId": user.get("userId"),
        "authorName": user.get("nickname") or user.get("nickName"),
        # 팔로워 수는 노트 상세에 없다. 계정 경로가 막혀 있어 채우지 못하며,
        # null 이면 아웃라이어 점수가 보수적인 기본값으로 계산된다.
        "followerCount": None,
        "postedAtMs": posted_ms if isinstance(posted_ms, (int, float)) else None,
    }


# ---------------------------------------------------------------------------
# 1688 — 소재(상품 영상)
# ---------------------------------------------------------------------------

_OFFER_RE = re.compile(r"detail\.1688\.com/offer/(\d{6,})\.html")
# 상품 id 는 링크 말고 **속성**으로도 박혀 있다.
#
# 이걸 놓쳐서 "1688 검색은 못 뚫는다" 로 결론냈었다. ali-probe 가 m.1688 에서
# offerIdAttr 20개를 세어 보여줬는데도, 추출은 detail 링크만 찾는 _OFFER_RE 로 해서
# offerIds 0 이 나왔다. 계측이 답을 줬는데 읽는 쪽이 못 받은 것이다.
_OFFER_ATTR_RE = re.compile(r'data-offer-id=[\"\'](\d{6,})[\"\']')
_OFFER_JSON_RE = re.compile(r'"offer(?:_)?[Ii]d"\s*:\s*"?(\d{6,})"?')

# 타오바오 상품 id. 상세 주소가 item.taobao.com/item.htm?id=... 형태다.
_TAOBAO_ID_RE = re.compile(r"item\.taobao\.com/item\.htm\?(?:[^\"'\s]*&)?id=(\d{6,})")
_TAOBAO_ATTR_RE = re.compile(r'data-(?:item|nid)-?id=[\"\'](\d{6,})[\"\']')
# 상품 영상은 타오바오 비디오 CDN 에서 내려온다. JSON 안에 이스케이프된 채로 박혀 있어
# 경로 구분자가 `/` 가 아니라 `\/` 다. 역슬래시를 제외하면 호스트 뒤로 한 글자도 못 가므로
# 경계는 따옴표와 공백으로만 잡는다 (JSON 문자열 값이라 따옴표에서 끝난다).
_VIDEO_RE = re.compile(
    r"https?:\\?/\\?/[\w.\-]*(?:cloud\.video\.taobao\.com|video\.1688\.com|"
    r"[\w.\-]*alicdn\.com)[^\"'\s]*?\.mp4[^\"'\s]*"
)
_VIDEO_KEY_RE = re.compile(r'"(?:videoUrl|video_url|videoUrls|mp4Url)"\s*:\s*"([^"]+)"')


def _unescape_url(url: str) -> str:
    # 끝의 홀로 남은 역슬래시는 `\"` 경계에서 딸려온 것이라 URL 의 일부가 아니다.
    return url.replace("\\/", "/").replace("\\u002F", "/").rstrip("\\")


def _ali_variants(keyword: str) -> list[tuple[str, str, bool]]:
    """
    1688 검색 진입로 후보. (이름, URL, 홈 워밍업 여부)

    s.1688.com 직접 호출이 1135바이트짜리 차단 페이지를 돌려주는 걸 실측으로 확인했다
    (2026-09-20, GitHub 러너). 어느 진입로가 열려 있는지는 추측할 게 아니라 재봐야 해서
    후보를 한곳에 모아두고 ali-probe 가 전부 때려본다.
    """
    gbk = quote(keyword, encoding="gbk")
    utf = quote(keyword)
    return [
        ("s.1688-gbk", ALI_SEARCH.format(kw=gbk), False),
        ("s.1688-gbk-warm", ALI_SEARCH.format(kw=gbk), True),
        ("s.1688-utf8", ALI_SEARCH.format(kw=utf), False),
        (
            "marketOfferResultViewService",
            f"https://search.1688.com/service/marketOfferResultViewService?keywords={utf}&beginPage=1",
            True,
        ),
        ("m.1688", f"https://m.1688.com/offer_search/-6D7033.html?keywords={utf}", True),
    ]


def sources_probe(keyword: str, limit: int) -> dict[str, Any]:
    """
    소재 공급처 세 곳을 **검색부터 상세 영상까지** 끝까지 재본다.

    ## 왜 끝까지 가야 하는가

    "검색이 열린다" 와 "소재를 구할 수 있다" 는 다르다. 알리가 그 차이로 두 번
    막혔다 — 검색은 열렸는데 상품 7건 전부 영상이 0개였다. 검색 결과 수만 보고
    "뚫렸다" 고 하면 파이프라인을 얹은 뒤에 그걸 알게 된다.

    그래서 공급처마다 검색 → 상세 → 영상 개수까지 세고, 마지막에 **영상을 실제로
    몇 개 확보했는지**로 판정한다.

    ## 세 곳을 같이 재는 이유

    지금 소재 공급처가 알리 하나뿐이다. 다른 단계는 전부 폴백이 있는데(인스타 안
    되면 틱톡, 쿠팡 안 되면 다나와) 소재만 없어서, 거기가 막히면 파이프라인이 선다.
    셋 중 둘만 살아 있어도 구조가 훨씬 튼튼해진다.
    """
    out: dict[str, Any] = {"keyword": keyword, "sources": []}

    # ── 1688 ────────────────────────────────────────────────
    row: dict[str, Any] = {"name": "1688", "ids": 0, "opened": 0, "withVideo": 0, "videos": 0}
    try:
        ids = ali_search(keyword, limit * 3)
        row["ids"] = len(ids)
        for oid in ids[:limit]:
            polite_sleep()
            try:
                offer = ali_offer(ALI_DETAIL.format(id=oid))
                row["opened"] += 1
                n = len(offer["videoUrls"])
                if n:
                    row["withVideo"] += 1
                    row["videos"] += n
            except Exception as e:  # noqa: BLE001
                row.setdefault("detailErrors", []).append(f"{oid}: {type(e).__name__}")
    except Exception as e:  # noqa: BLE001
        row["error"] = f"{type(e).__name__}: {str(e)[:300]}"
    out["sources"].append(row)

    # ── 타오바오 ─────────────────────────────────────────────
    row = {"name": "taobao", "ids": 0, "opened": 0, "withVideo": 0, "videos": 0}
    try:
        ids = taobao_search(keyword, limit * 3)
        row["ids"] = len(ids)
        for iid in ids[:limit]:
            polite_sleep()
            try:
                item = taobao_item(iid)
                row["opened"] += 1
                if item["loginWall"]:
                    row.setdefault("loginWalls", 0)
                    row["loginWalls"] += 1
                n = len(item["videoUrls"])
                if n:
                    row["withVideo"] += 1
                    row["videos"] += n
            except Exception as e:  # noqa: BLE001
                row.setdefault("detailErrors", []).append(f"{iid}: {type(e).__name__}")
    except Exception as e:  # noqa: BLE001
        row["error"] = f"{type(e).__name__}: {str(e)[:300]}"
    out["sources"].append(row)

    return out


def ali_probe(keyword: str) -> dict[str, Any]:
    """
    1688 이 어디서 막히는지 재본다. 값은 찍지 않고 상태·크기·찾은 상품 수만 낸다 —
    출력을 그대로 공유해도 안전해야 한다.

    진입로별 비교만으로는 「검색만 막혔나, 이 IP 가 통째로 막혔나」를 구분할 수 없다.
    그래서 홈과 상세를 같이 잰다:
      · 홈까지 1KB 대 조각이면 → 이 IP 가 통째로 막힌 것 (요청을 바꿔도 소용없다)
      · 홈·상세는 멀쩡한데 검색만 조각이면 → 검색 경로만 보호된 것
    샤오홍슈는 같은 IP·같은 TLS 지문으로 183KB 를 받았으므로 지문 문제는 아니다.
    """
    results: dict[str, Any] = {"reach": [], "search": []}

    session = new_session()
    for name, url in (
        ("home", "https://www.1688.com/"),
        # 상세가 열리는지만 본다. 없는 상품이어도 1688 이 응답하면 실제 페이지가 오고,
        # 차단이면 검색과 똑같은 1KB 대 조각이 온다. 크기로 갈린다.
        ("detail", ALI_DETAIL.format(id="600000000000")),
    ):
        row: dict[str, Any] = {"route": name}
        try:
            res = session.get(url, timeout=30)
            row.update(
                {
                    "status": res.status_code,
                    "bytes": len(res.text),
                    "looksBlocked": len(res.text) < 5_000,
                    "shape": _shape(res.text),
                }
            )
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
        results["reach"].append(row)
        polite_sleep()

    for row in _ali_search_probe(keyword):
        results["search"].append(row)

    return results


# 페이지의 "모양" 만 세는 표식들. 내용은 찍지 않고 등장 횟수만 낸다 —
# 어떤 추출 패턴을 써야 하는지, 혹은 애초에 검증/로그인 페이지인지를
# 페이지를 들여다보지 않고 판별하기 위한 계측용이다.
_SHAPE_MARKERS: dict[str, str] = {
    "detailLink": r"detail\.1688\.com/offer/\d+",
    "offerIdKey": r'"offerId"',
    "offerIdAttr": r"data-offer-id",
    "offerIdSnake": r'"offer_id"',
    # 아래가 잡히면 25KB 가 상품 목록이 아니라 검증/로그인 벽이라는 뜻이다.
    "captcha": r"captcha|punish|nc_1_n1z|滑动验证",
    "loginWall": r"请登录|登录后|login\.1688",
}


def _shape(html: str) -> dict[str, int]:
    return {
        name: len(re.findall(pattern, html, re.IGNORECASE))
        for name, pattern in _SHAPE_MARKERS.items()
    }


def _ali_search_probe(keyword: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    for name, url, warm in _ali_variants(keyword):
        session = new_session()
        row: dict[str, Any] = {"route": name, "warmed": warm}
        try:
            if warm:
                # 첫 방문에서 쿠키를 받아두면 통과하는 경우가 있다.
                session.get("https://www.1688.com/", timeout=30)
                polite_sleep()
            res = session.get(url, headers={"Referer": "https://www.1688.com/"}, timeout=30)
            html = res.text
            ids = list(dict.fromkeys(_OFFER_RE.findall(html)))
            row.update(
                {
                    "status": res.status_code,
                    "bytes": len(html),
                    "offerIds": len(ids),
                    # 차단 페이지는 짧고 상품 링크가 없다. 둘을 같이 봐야 구분된다.
                    "looksBlocked": len(html) < 5_000 and not ids,
                    "sampleId": ids[0] if ids else None,
                    "shape": _shape(html),
                }
            )
            if ids:
                polite_sleep()
                try:
                    offer = ali_offer(ids[0])
                    row["detailVideos"] = len(offer["videoUrls"])
                except Exception as e:  # noqa: BLE001
                    row["detailError"] = f"{type(e).__name__}: {e}"
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
        results.append(row)
        polite_sleep()

    return results


def _extract_offer_ids(html: str) -> list[str]:
    """
    HTML 에서 1688 상품 id 를 뽑는다. 세 가지 모양을 전부 본다.

    한 가지만 보다가 틀렸다. detail 링크(_OFFER_RE)만 찾았는데 m.1688 은 링크 대신
    `data-offer-id` 속성으로 싣는다. 계측(ali-probe)이 그 속성을 20개 세어 보여줬는데도
    추출이 0 이어서 "검색을 못 뚫는다" 로 결론냈다. 모양이 여러 개면 여러 개를 본다.
    """
    ids: list[str] = []
    for regex in (_OFFER_RE, _OFFER_ATTR_RE, _OFFER_JSON_RE):
        for match in regex.finditer(html):
            oid = match.group(1)
            if oid not in ids:
                ids.append(oid)
    return ids


def ali_search(keyword: str, limit: int) -> list[str]:
    """
    1688 검색 결과에서 상품 id 를 뽑는다.

    진입로를 하나만 쓰지 않는다. PC 검색(s.1688)은 브라우저로 열면 슬라이더 캡차가
    뜨지만, **모바일 검색을 생 HTTP 로 받으면 상품 id 가 속성으로 실려 온다**(실측:
    67KB, data-offer-id 20개). 같은 사이트라도 진입로와 클라이언트에 따라 결과가
    다르므로 순서대로 시도한다.

    0건이면 조용히 빈 목록을 돌려주지 않고 던진다 — 소재가 없는 것과 못 읽은 것은
    대응이 다르고, 섞으면 엉뚱한 데를 고치게 된다.
    """
    gbk = quote(keyword, encoding="gbk")
    utf = quote(keyword)

    # (이름, URL, 홈 워밍업 여부). 실측에서 모바일이 제일 잘 나와서 앞에 둔다.
    routes = [
        ("m.1688", f"https://m.1688.com/offer_search/-6D7033.html?keywords={utf}", True),
        ("s.1688-gbk", ALI_SEARCH.format(kw=gbk), True),
        ("s.1688-utf8", ALI_SEARCH.format(kw=utf), False),
    ]

    tried: list[str] = []
    for name, url, warm in routes:
        session = new_session()
        try:
            if warm:
                session.get("https://www.1688.com/", timeout=30)
                polite_sleep()
            html = get_html(session, url, referer="https://www.1688.com/")
        except Exception as e:  # noqa: BLE001
            tried.append(f"{name}: {type(e).__name__}")
            continue

        ids = _extract_offer_ids(html)
        tried.append(f"{name}: {len(html)}바이트, id {len(ids)}개")
        if ids:
            print(f"1688 검색: {name} 에서 상품 id {len(ids)}개", file=sys.stderr)
            return ids[:limit]
        polite_sleep()

    raise Blocked(
        f'1688 검색 "{keyword}" 에서 상품 id 를 한 건도 못 찾았습니다.\n'
        f"   진입로별: {' / '.join(tried)}\n"
        "   상세 페이지는 로그인 없이 열리므로(실측), id 만 구하면 영상은 받을 수 있습니다."
    )


def taobao_search(keyword: str, limit: int) -> list[str]:
    """
    타오바오 검색에서 상품 id 를 뽑는다.

    앞선 기록은 "타오바오에서는 영상을 한 건도 받지 못했다" 였는데, 그게 검색이
    막혀서인지 상세에 영상이 없어서인지 구분돼 있지 않았다. 둘은 대응이 다르다.
    여기서는 검색만 맡고, 판정은 호출부가 상세까지 열어보고 한다.
    """
    utf = quote(keyword)
    routes = [
        ("s.taobao", f"https://s.taobao.com/search?q={utf}", True),
        ("m.taobao", f"https://h5.m.taobao.com/search.html?q={utf}", True),
    ]

    tried: list[str] = []
    for name, url, warm in routes:
        session = new_session()
        try:
            if warm:
                session.get("https://www.taobao.com/", timeout=30)
                polite_sleep()
            html = get_html(session, url, referer="https://www.taobao.com/")
        except Exception as e:  # noqa: BLE001
            tried.append(f"{name}: {type(e).__name__}")
            continue

        ids: list[str] = []
        for regex in (_TAOBAO_ID_RE, _TAOBAO_ATTR_RE):
            for match in regex.finditer(html):
                if match.group(1) not in ids:
                    ids.append(match.group(1))

        wall = any(m in html for m in ("登录", "滑动验证", "captcha", "punish"))
        tried.append(f"{name}: {len(html)}바이트, id {len(ids)}개{', 벽 표식 있음' if wall else ''}")
        if ids:
            print(f"타오바오 검색: {name} 에서 상품 id {len(ids)}개", file=sys.stderr)
            return ids[:limit]
        polite_sleep()

    raise Blocked(
        f'타오바오 검색 "{keyword}" 에서 상품 id 를 한 건도 못 찾았습니다.\n'
        f"   진입로별: {' / '.join(tried)}"
    )


def taobao_item(item_id: str) -> dict[str, Any]:
    """타오바오 상품 상세에서 영상 주소를 뽑는다. 추출 규칙은 1688 과 같다."""
    session = new_session()
    url = f"https://item.taobao.com/item.htm?id={item_id}"
    html = get_html(session, url, referer="https://s.taobao.com/")

    videos: list[str] = []
    for match in _VIDEO_KEY_RE.finditer(html):
        candidate = _unescape_url(match.group(1))
        if candidate.startswith("http") and candidate not in videos:
            videos.append(candidate)
    for match in _VIDEO_RE.finditer(html):
        candidate = _unescape_url(match.group(0))
        if candidate not in videos:
            videos.append(candidate)

    return {
        "itemId": item_id,
        "productUrl": url,
        "bytes": len(html),
        "loginWall": any(m in html for m in ("登录", "滑动验证", "captcha")),
        "videoUrls": videos,
    }


def ali_offer(url: str) -> dict[str, Any]:
    """
    상품 상세에서 영상 주소를 뽑는다. 1688 은 상세 HTML 에 그대로 박혀 있어 간단하다.

    인자는 수확한 URL 통째로다. 상품 id 로 URL 을 재조립하지 않는다 —
    샤오홍슈에서 토큰을 벗겼다가 55건을 날린 것과 같은 실수를 여기서도 안 하려는 것이다.
    """
    session = new_session()
    offer_match = re.search(r"/offer/(\d+)", url)
    if not offer_match:
        raise Blocked(f"상품 id 를 읽을 수 없는 URL 입니다: {url}")
    offer_id = offer_match.group(1)
    html = get_html(session, url)

    videos: list[str] = []
    for match in _VIDEO_KEY_RE.finditer(html):
        candidate = _unescape_url(match.group(1))
        if candidate.startswith("http") and candidate not in videos:
            videos.append(candidate)
    for match in _VIDEO_RE.finditer(html):
        candidate = _unescape_url(match.group(0))
        if candidate not in videos:
            videos.append(candidate)

    title_match = re.search(r"<title>(.*?)</title>", html, re.DOTALL)

    return {
        "offerId": offer_id,
        "productUrl": url,
        "title": (title_match.group(1).strip() if title_match else ""),
        "videoUrls": videos,
    }


# ---------------------------------------------------------------------------
# 다운로드
# ---------------------------------------------------------------------------


def download(url: str, referer: str | None, out: str) -> dict[str, Any]:
    """
    영상 파일을 받는다. node 의 fetch 가 아니라 여기서 받는 이유는 같은 TLS 지문을
    써야 CDN 이 열어주기 때문이다.
    """
    session = new_session()
    headers = {"Referer": referer} if referer else {}
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)

    res = session.get(url, headers=headers, timeout=120, stream=True)
    if res.status_code != 200:
        raise Blocked(f"다운로드 실패 HTTP {res.status_code} — {url}")

    size = 0
    with path.open("wb") as fh:
        for chunk in res.iter_content(chunk_size=1 << 16):
            fh.write(chunk)
            size += len(chunk)

    # HTML 오류 페이지를 mp4 라고 저장해두면 편집 단계에서야 터진다. 여기서 잡는다.
    if size < 50_000:
        path.unlink(missing_ok=True)
        raise Blocked(f"받은 파일이 {size}바이트뿐입니다 (영상이 아니라 오류 페이지) — {url}")

    return {"path": str(path), "bytes": size}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="샤오홍슈·1688 접근 헬퍼")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("xhs-feed")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--channel", default=None)
    p.add_argument("--rounds", type=int, default=1)

    p = sub.add_parser("xhs-note")
    # URL 통째로 받는다. id+token 으로 쪼개 받으면 재조립하게 되고, 그때 잃는 게 생긴다.
    p.add_argument("--url", required=True)

    p = sub.add_parser("ali-search")
    p.add_argument("--keyword", required=True)
    p.add_argument("--limit", type=int, default=10)

    p = sub.add_parser("ali-offer")
    p.add_argument("--url", required=True)

    p = sub.add_parser("sources-probe")
    p.add_argument("--keyword", required=True, help="중국어 검색어")
    p.add_argument("--limit", type=int, default=4, help="공급처마다 상세를 몇 건 열어볼지")

    p = sub.add_parser("taobao-search")
    p.add_argument("--keyword", required=True)
    p.add_argument("--limit", type=int, default=12)

    p = sub.add_parser("taobao-item")
    p.add_argument("--id", required=True)

    p = sub.add_parser("ali-probe")
    p.add_argument("--keyword", required=True)

    p = sub.add_parser("download")
    p.add_argument("--url", required=True)
    p.add_argument("--referer", default=None)
    p.add_argument("--out", required=True)

    sub.add_parser("selfcheck")

    args = parser.parse_args()

    try:
        if args.cmd == "xhs-feed":
            result: Any = xhs_feed(args.limit, args.channel, args.rounds)
        elif args.cmd == "xhs-note":
            result = xhs_note(args.url)
            polite_sleep()
        elif args.cmd == "ali-search":
            result = ali_search(args.keyword, args.limit)
        elif args.cmd == "ali-offer":
            result = ali_offer(args.url)
            polite_sleep()
        elif args.cmd == "ali-probe":
            result = ali_probe(args.keyword)
        elif args.cmd == "download":
            result = download(args.url, args.referer, args.out)
        else:
            # 값은 하나도 찍지 않는다. 설치와 연결만 확인하고 그대로 공유해도 안전해야 한다.
            session = new_session()
            res = session.get(f"{XHS_ORIGIN}/explore", timeout=30)
            result = {
                "curl_cffi": True,
                "impersonate": IMPERSONATE,
                "xhsStatus": res.status_code,
                "xhsBytes": len(res.text),
                "hasInitialState": "__INITIAL_STATE__" in res.text,
            }
    except Blocked as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001 - 어떤 실패든 호출부가 원인을 읽어야 한다
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
