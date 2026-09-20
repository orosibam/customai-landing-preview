#!/usr/bin/env python3
"""
cn_media.py 의 파싱 로직 테스트.

네트워크는 건드리지 않는다. 검증하는 건 「응답을 받았을 때 거기서 값을 제대로 뽑는가」다.
샤오홍슈 SSR 에는 json.loads 를 그냥 터뜨리는 함정이 둘 있어서(JS `undefined` 리터럴,
Vue ref 껍데기) 그 둘을 고정해두지 않으면 조용히 빈 결과가 나온다.

  python3 scrapers-py/test_cn_media.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import cn_media as m

failures: list[str] = []


def check(name: str, got: object, want: object) -> None:
    if got == want:
        print(f"  ok  {name}")
    else:
        failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


def html_with(state: str) -> str:
    """__INITIAL_STATE__ 를 품은 SSR 페이지 흉내. 길이 검사를 통과하도록 패딩을 넣는다."""
    return (
        "<!doctype html><html><head><title>x</title></head><body>"
        + "<!--" + "p" * 3000 + "-->"
        + f"<script>window.__INITIAL_STATE__={state}</script>"
        + "</body></html>"
    )


print("extract_initial_state")
# JS 리터럴 `undefined` 는 JSON 이 아니다. 이걸 통과시키지 못하면 샤오홍슈는 통째로 0건이 된다.
state = m.extract_initial_state(html_with('{"a":1,"b":undefined,"c":[undefined,2]}'))
check("undefined → null", state, {"a": 1, "b": None, "c": [None, 2]})

# 문자열 안의 "undefined" 는 건드리면 안 된다.
state = m.extract_initial_state(html_with('{"t":"undefined behaviour","b":undefined}'))
check("문자열 안은 보존", state["t"], "undefined behaviour")

try:
    m.extract_initial_state("<html>" + "x" * 3000 + "</html>")
    failures.append("state 없음: 던지지 않았다")
    print("  FAIL state 없음: 던지지 않았다")
except m.Blocked:
    print("  ok  state 없으면 Blocked")

print("unref (Vue ref 껍데기)")
check(
    "한 겹 벗기기",
    m.unref({"feeds": {"__v_isRef": True, "_rawValue": [1, 2], "_value": [1, 2]}}),
    {"feeds": [1, 2]},
)
check(
    "중첩",
    m.unref({"a": {"__v_isRef": True, "_rawValue": {"b": {"_rawValue": 7, "_value": 7}}}}),
    {"a": {"b": 7}},
)
check("ref 아닌 dict 는 그대로", m.unref({"_rawValue2": 1}), {"_rawValue2": 1})

print("as_int")
check("정수", m.as_int(1234), 1234)
check("万", m.as_int("1.2万"), 12000)
check("千", m.as_int("3千"), 3000)
check("쉼표", m.as_int("1,234"), 1234)
check("빈 값", m.as_int(""), None)
check("None", m.as_int(None), None)

print("xhs 영상 주소")
note = {
    "video": {"media": {"stream": {"h264": [{"masterUrl": "https://sns.example/a.mp4"}]}}}
}
check("h264 masterUrl", m._first_video_url(note), "https://sns.example/a.mp4")

# h264 가 비고 h265 만 차 있는 노트가 있다. ffmpeg 은 둘 다 읽으므로 있는 걸 써야 한다.
note = {"video": {"media": {"stream": {"h264": [], "h265": [{"masterUrl": "https://sns.example/b.mp4"}]}}}}
check("h265 폴백", m._first_video_url(note), "https://sns.example/b.mp4")

# 구조가 바뀌어도 트리 워크로 찾아낸다.
check(
    "트리 워크 폴백",
    m._first_video_url({"weird": {"nest": {"masterUrl": "https://sns.example/c.mp4"}}}),
    "https://sns.example/c.mp4",
)
check("영상 없는 노트", m._first_video_url({"type": "normal"}), None)

print("1688 정규식")
check(
    "offer id",
    m._OFFER_RE.findall('<a href="//detail.1688.com/offer/912345678.html">x</a>'),
    ["912345678"],
)
check(
    "videoUrl 키",
    m._VIDEO_KEY_RE.findall('{"videoUrl":"https://cloud.video.taobao.com/play/u/1/p/2.mp4"}'),
    ["https://cloud.video.taobao.com/play/u/1/p/2.mp4"],
)
escaped = '{"x":"https:\\/\\/cloud.video.taobao.com\\/play\\/u\\/1.mp4"}'
found = [m._unescape_url(u) for u in m._VIDEO_RE.findall(escaped)]
check("이스케이프된 URL", found, ["https://cloud.video.taobao.com/play/u/1.mp4"])

print("xhs 피드 파싱 (네트워크 없이 상태만 주입)")
feed_state = m.unref(
    {
        "feed": {
            "__v_isRef": True,
            "_rawValue": {
                "feeds": [
                    {
                        "id": "note1",
                        "xsecToken": "TOKEN1",
                        "noteCard": {
                            "displayTitle": "洗车液 测评",
                            "type": "video",
                            "interactInfo": {"likedCount": "1.2万"},
                            "user": {"userId": "u1", "nickname": "차차"},
                        },
                    },
                    # 토큰 없는 노드는 노트가 아니다 (유저·태그 id). 걸러져야 한다.
                    {"id": "tag9", "name": "태그"},
                ]
            },
        }
    }
)
notes = []
seen: set[str] = set()
for node in m.walk(feed_state):
    nid, tok = node.get("id"), node.get("xsecToken")
    if isinstance(nid, str) and nid and isinstance(tok, str) and tok and nid not in seen:
        card = node.get("noteCard") or node
        notes.append((nid, tok, m.as_int(card.get("interactInfo", {}).get("likedCount"))))
        seen.add(nid)
check("노트만 추출", notes, [("note1", "TOKEN1", 12000)])

print()
# ---------------------------------------------------------------------------
# 상품 id 추출 — "계측은 맞았는데 추출이 못 읽은" 버그의 회귀 테스트
# ---------------------------------------------------------------------------
#
# ali-probe 가 m.1688 에서 data-offer-id 20개를 세어 보여줬는데도, 추출이
# detail 링크만 찾는 정규식이라 0건이 나왔다. 그걸 보고 "1688 검색은 HTTP 로
# 못 뚫는다" 고 결론냈다 — 계측이 답을 줬는데 읽는 쪽이 못 받은 것이다.
#
# 모양이 여러 개인 걸 코드가 기억하게 테스트로 묶어둔다.

print("1688 상품 id 추출")

_DETAIL = '<a href="https://detail.1688.com/offer/612345678901.html">상품</a>'
_ATTR = '<div data-offer-id="712345678902" class="card"></div>'
_ATTR_SQ = "<div data-offer-id='812345678903'></div>"
_JSON_STR = '{"offerId":"912345678904","title":"x"}'
_JSON_NUM = '{"offer_id": 1012345678905}'

check("detail 링크", m._extract_offer_ids(_DETAIL), ["612345678901"])
check("data-offer-id 속성 (이걸 못 읽어 0건이 났었다)", m._extract_offer_ids(_ATTR), ["712345678902"])
check("속성이 홑따옴표", m._extract_offer_ids(_ATTR_SQ), ["812345678903"])
check("JSON 문자열 값", m._extract_offer_ids(_JSON_STR), ["912345678904"])
check("JSON 숫자 값", m._extract_offer_ids(_JSON_NUM), ["1012345678905"])
check(
    "세 모양이 섞여도 전부, 중복 없이",
    m._extract_offer_ids(_DETAIL + _ATTR + _JSON_STR + _DETAIL),
    ["612345678901", "712345678902", "912345678904"],
)
check("짧은 숫자는 상품 id 가 아니다", m._extract_offer_ids('<div data-offer-id="123"></div>'), [])

print("타오바오 상품 id 추출")
_TB = '<a href="//item.taobao.com/item.htm?spm=a1z10&id=712345678906">상품</a>'
check("상세 링크에서 id (앞에 다른 파라미터가 있어도)", m._TAOBAO_ID_RE.search(_TB).group(1), "712345678906")

# ---------------------------------------------------------------------------
# 서브커맨드 배선 — 등록만 하고 실행을 안 붙인 걸 잡는다
# ---------------------------------------------------------------------------
#
# sources-probe / taobao-search / taobao-item 을 파서에는 등록해놓고 main() 의
# if-elif 사슬에 안 붙였다. 마지막 else 가 selfcheck 폴백이라, 워크플로우가
# sources-probe 를 시키면 **selfcheck 결과가 찍혔다.** 종료코드는 0이고 JSON 도
# 나오니 계측을 돌렸다고 믿게 된다 — 조용한 실패 중에 제일 나쁜 종류다.
#
# 소스를 읽어서 "등록된 이름이 전부 분기에 있는가" 만 본다. 네트워크는 안 탄다.

print("서브커맨드 배선")

_SRC = (Path(m.__file__).read_text())
_registered = set(re.findall(r'sub\.add_parser\("([a-z-]+)"\)', _SRC))
_dispatched = set(re.findall(r'args\.cmd == "([a-z-]+)"', _SRC))

check("등록한 서브커맨드가 하나도 안 빠지고 분기에 있다", sorted(_registered - _dispatched), [])
check("분기만 있고 등록이 없는 이름은 없다", sorted(_dispatched - _registered), [])

if failures:
    print(f"{len(failures)}건 실패")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("전부 통과")
