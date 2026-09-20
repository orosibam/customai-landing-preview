#!/usr/bin/env python3
"""
벤치마킹 대상이 **어떻게 말하는지**를 가져오는 도구.

## 왜 이게 필요한가

홈스토리에서 베낄 것은 제품이 아니라 파는 방식이다 — 첫 문장을 어떻게 여는지,
말투가 어떤지, 소구점을 몇 번째에 꺼내는지, CTA 를 어디에 두는지.
제품 목록만 봐서는 그걸 알 수 없다.

틱톡·인스타는 로그인 없이 게시물을 안 내준다(실측). 유튜브는 공개다. 그리고
쇼츠에는 자동 자막이 붙어서 **나레이션 전문을 타임스탬프째로** 받을 수 있다.
영상을 내려받지 않고 자막만 받으므로 빠르고, 저작물을 복제하지도 않는다.

## 무엇을 내는가

영상마다: 제목 · 조회수 · 길이 · 자막 전문(초 단위 타임스탬프 포함).
여기서 읽어야 할 것은 다음 넷이다.

  · 0~2초 구간의 문장  → 훅 문형. "여러분 이거 아세요" 류인지, 문제 선언인지
  · 문장 길이와 어미   → 말투
  · 소구점이 나오는 초 → 순서
  · 마지막 2초의 문장  → CTA 문형

## 막힐 수 있는 지점

유튜브는 데이터센터 IP 에 「Sign in to confirm you're not a bot」을 띄우는 일이 있다.
그 경우 조용히 0건으로 넘어가지 않고 무엇에 막혔는지 적고 실패로 끝낸다.

실행:  python3 scrapers-py/voice_probe.py @Homestory_official --limit 8
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

try:
    from yt_dlp import YoutubeDL
except ImportError:  # pragma: no cover - 러너에서 pip 로 깔린다
    print("yt-dlp 가 없습니다. pip install yt-dlp 후 다시 실행하세요.", file=sys.stderr)
    raise SystemExit(1)


BOT_WALL = re.compile(r"sign in to confirm|not a bot|confirm you'?re not", re.I)


class Blocked(RuntimeError):
    pass


def _ydl(**extra: Any) -> YoutubeDL:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignoreerrors": False,
        # 러너 IP 가 한국 밖이라 지역 기본값을 맞춰준다. 자막 언어 선택에 영향이 있다.
        "extractor_args": {"youtube": {"lang": ["ko"]}},
    }
    opts.update(extra)
    return YoutubeDL(opts)


def list_shorts(handle: str, limit: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    채널의 쇼츠를 조회수순으로 뽑는다.

    flat 으로 먼저 목록만 받는다 — 영상마다 상세를 부르면 채널 하나에 수백 번
    요청이 나가고 그게 바로 차단 사유가 된다.
    """
    url = f"https://www.youtube.com/{handle}/shorts"
    with _ydl(extract_flat="in_playlist", playlistend=200) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if BOT_WALL.search(msg):
                raise Blocked(
                    "유튜브가 이 IP 를 사람으로 확인하라고 막았습니다 "
                    "(Sign in to confirm you're not a bot). "
                    "러너 IP 라서 그렇습니다 — 쿠키를 넣거나 다른 경로가 필요합니다."
                ) from e
            raise Blocked(f"채널 목록을 못 받았습니다: {msg[:300]}") from e

    entries = [e for e in (info or {}).get("entries") or [] if e]
    if not entries:
        raise Blocked(
            f"{handle}/shorts 에서 영상을 한 건도 못 찾았습니다. "
            "핸들이 틀렸거나 쇼츠 탭이 비어 있습니다."
        )

    # 조회수가 flat 응답에 없을 수 있다. 있으면 그걸로 정렬하고, 없으면 최신순 그대로 둔다.
    entries.sort(key=lambda e: e.get("view_count") or 0, reverse=True)
    return info or {}, entries[:limit]


def fetch_subs(video_id: str) -> tuple[dict[str, Any], list[tuple[float, str]]]:
    """한 영상의 메타와 한국어 자막(자동 포함)을 받는다."""
    with _ydl(
        writesubtitles=True,
        writeautomaticsub=True,
        subtitleslangs=["ko", "ko-orig"],
        subtitlesformat="json3",
    ) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)

    if not info:
        return {}, []

    # 수동 자막이 있으면 그쪽이 정확하다. 없으면 자동 자막.
    tracks = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    chosen = None
    for source in (tracks, auto):
        for lang in ("ko", "ko-orig"):
            if lang in source:
                chosen = source[lang]
                break
        if chosen:
            break

    if not chosen:
        return info, []

    url = next((t["url"] for t in chosen if t.get("ext") == "json3"), None)
    if not url:
        return info, []

    with _ydl() as ydl:
        raw = ydl.urlopen(url).read().decode("utf-8", "replace")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return info, []

    lines: list[tuple[float, str]] = []
    for ev in data.get("events") or []:
        segs = ev.get("segs") or []
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text or text == "\n":
            continue
        lines.append((round((ev.get("tStartMs") or 0) / 1000, 1), re.sub(r"\s+", " ", text)))
    return info, lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("handle", help="유튜브 핸들 (예: @Homestory_official)")
    ap.add_argument("--limit", type=int, default=8)
    args = ap.parse_args()

    handle = args.handle if args.handle.startswith("@") else f"@{args.handle}"

    print(f"{handle} 의 쇼츠를 조회수순으로 {args.limit}건 봅니다.")
    print("영상은 내려받지 않습니다 — 메타와 자막만 받습니다.\n")

    channel, entries = list_shorts(handle, args.limit)

    # 같은 이름의 채널이 여럿이다. 엉뚱한 채널을 분석하고 결론을 내는 게 제일 나쁘다 —
    # 먼저 이게 그 홈스토리(쇼핑 숏폼)가 맞는지 눈으로 확인할 수 있게 찍는다.
    print("── 채널 확인 ──")
    print(f"   이름: {channel.get('channel') or channel.get('title')}")
    subs = channel.get("channel_follower_count")
    print(f"   구독자: {subs:,}명" if subs else "   구독자: (비공개)")
    desc = re.sub(r"\s+", " ", (channel.get("description") or ""))[:240]
    print(f"   소개: {desc or '(없음)'}")
    print(f"   → moneying/인포크 링크가 보이면 우리가 찾던 그 계정입니다.\n")

    print(f"목록 {len(entries)}건 확보.\n")

    ok = 0
    for i, e in enumerate(entries, 1):
        vid = e.get("id")
        if not vid:
            continue
        title = e.get("title") or "(제목 없음)"
        print("═" * 66)
        print(f"{i}. {title}")
        print(f"   https://www.youtube.com/shorts/{vid}")

        try:
            info, lines = fetch_subs(vid)
        except Exception as ex:  # noqa: BLE001
            # 한 건이 막혀도 나머지는 봐야 한다. 다만 무엇에 막혔는지는 남긴다.
            print(f"   ✗ 자막을 못 받았습니다: {str(ex)[:200]}")
            continue

        views = info.get("view_count")
        dur = info.get("duration")
        print(f"   조회 {views:,}회 / 길이 {dur}초" if views else f"   길이 {dur}초")

        if not lines:
            print("   (한국어 자막 없음 — 자동 자막도 안 붙어 있습니다)")
            continue

        ok += 1
        print("   ── 나레이션 ──")
        for t, text in lines:
            print(f"   {t:6.1f}  {text}")
        print()

    print("═" * 66)
    if ok == 0:
        raise Blocked(
            f"{len(entries)}건을 훑었지만 나레이션을 한 건도 못 받았습니다. "
            "자막이 안 붙어 있거나 유튜브가 자막 요청을 막고 있습니다."
        )
    print(f"나레이션을 받은 영상: {ok}/{len(entries)}건")
    print("\n여기서 읽을 것: 0~2초 문형(훅) / 어미와 문장길이(말투) /")
    print("소구점이 나오는 초(순서) / 마지막 문장(CTA 문형)")


if __name__ == "__main__":
    try:
        main()
    except Blocked as e:
        print(f"\n막혔습니다: {e}", file=sys.stderr)
        raise SystemExit(1)
