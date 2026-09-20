#!/usr/bin/env python3
"""
edge-tts 나레이션 — 가입·결제·API 키가 필요 없는 한국어 TTS.

## 왜 여기로 왔나

타입캐스트가 무료 계정을 막았다 (실측 2026-09-20):

    403 {"error_code":"UNUSUAL_ACTIVITY_DETECTED",
         "message":"... your access may be suspended ... subscribe to one of our paid plans"}

키 문제도 코드 문제도 아니고 **요금제 문제**다. 결제 전까지 그쪽은 건드리지 않는다
(응답에 "계속하면 정지될 수 있다" 고 적혀 있다).

edge-tts 는 마이크로소프트 엣지 브라우저의 읽어주기 음성을 쓴다. 키가 없고,
가입이 없고, 한국어 신경망 음성이 있다. 대신 **우리가 통제할 수 없는 서비스**라
막히면 막히는 대로 드러나야 한다 — 그래서 실패를 삼키지 않고 그대로 던진다.

## 쓰는 법

    python3 scrapers-py/tts_edge.py voices
    python3 scrapers-py/tts_edge.py synth --text "안녕하세요" --voice ko-KR-SunHiNeural \
        --rate "+10%" --pitch "+12Hz" --out out.mp3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

try:
    import edge_tts
except ImportError:  # noqa: BLE001
    print(
        "edge-tts 가 설치돼 있지 않습니다. pip install -r scrapers-py/requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)


async def list_korean_voices() -> list[dict[str, str]]:
    """한국어 음성 목록. 몇 개가 실제로 있는지는 추측하지 않고 물어본다."""
    all_voices = await edge_tts.list_voices()
    return [
        {"name": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]}
        for v in all_voices
        if str(v.get("Locale", "")).startswith("ko-")
    ]


async def synth(text: str, voice: str, rate: str, pitch: str, out: str) -> dict[str, object]:
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(out)

    size = Path(out).stat().st_size
    # 빈 파일이나 조각을 성공으로 넘기면 소리 없는 영상이 며칠 뒤에 발견된다.
    if size < 1_024:
        raise RuntimeError(
            f"합성 결과가 {size}바이트뿐입니다. 음성 이름이 틀렸거나 서비스가 거절했습니다: {voice}"
        )
    return {"path": out, "bytes": size, "voice": voice, "rate": rate, "pitch": pitch}


def main() -> int:
    parser = argparse.ArgumentParser(description="edge-tts 나레이션 헬퍼")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("voices")

    p = sub.add_parser("synth")
    p.add_argument("--text", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--rate", default="+0%")
    p.add_argument("--pitch", default="+0Hz")
    p.add_argument("--out", required=True)

    args = parser.parse_args()

    try:
        if args.cmd == "voices":
            result: object = asyncio.run(list_korean_voices())
        elif args.cmd == "synth":
            result = asyncio.run(synth(args.text, args.voice, args.rate, args.pitch, args.out))
        else:
            # 파서에만 등록하고 실행을 안 붙이면 조용히 다른 일을 하게 된다.
            # cn_media.py 에서 그걸로 계측이 통째로 엉뚱해진 적이 있다.
            raise RuntimeError(f"'{args.cmd}' 는 실행이 연결돼 있지 않습니다.")
    except Exception as e:  # noqa: BLE001 - 무엇을 하다 막혔는지 호출부가 읽어야 한다
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
