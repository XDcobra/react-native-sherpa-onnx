#!/usr/bin/env python3
"""Export isi-nlp/uroman rom_rules into a compact JSON table for the TS engine.

Requires: pip install uroman

Usage (from repo root):
  python3 scripts/alignment-romanization/export-uroman-tables.py
  python3 scripts/alignment-romanization/export-uroman-tables.py --goldens
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RULES_OUT = ROOT / "src/alignment/romanization/uroman/data/rules.json"
GOLDENS_OUT = ROOT / "src/alignment/romanization/__fixtures__/uroman-goldens.json"

ISO1_TO_3 = {
    "ru": "rus",
    "el": "ell",
    "hi": "hin",
    "ur": "urd",
    "ja": "jpn",
    "ko": "kor",
    "zh": "zho",
    "ar": "ara",
    "de": "deu",
    "en": "eng",
    "fr": "fra",
    "es": "spa",
    "it": "ita",
    "pt": "por",
    "vi": "vie",
}


def mms_normalize(text: str) -> str:
    text = text.lower()
    text = text.replace("’", "'").replace("‘", "'")
    text = re.sub(r"[^a-z' ]", " ", text)
    text = re.sub(r" +", " ", text)
    return text.strip()


def export_rules() -> dict:
    from uroman.uroman import Uroman

    u = Uroman()
    rules: dict[str, list[dict]] = defaultdict(list)
    max_len = 1
    for s, lst in u.rom_rules.items():
        max_len = max(max_len, len(s))
        for r in lst:
            d = r.__dict__
            t = d.get("t")
            if t is None:
                continue
            entry: dict = {"t": t}
            lcodes = d.get("lcodes") or []
            if lcodes:
                entry["lcodes"] = list(lcodes)
            if d.get("use-only-at-start-of-word"):
                entry["startOnly"] = True
            if d.get("dont-use-at-start-of-word"):
                entry["notStart"] = True
            rules[s].append(entry)

    compact: dict[str, list[dict]] = {}
    for s, entries in rules.items():
        seen: set[tuple] = set()
        uniq: list[dict] = []
        for e in entries:
            key = (
                e["t"],
                tuple(e.get("lcodes") or ()),
                e.get("startOnly"),
                e.get("notStart"),
            )
            if key in seen:
                continue
            seen.add(key)
            uniq.append(e)
        compact[s] = uniq

    payload = {"maxLen": max_len, "rules": compact}
    RULES_OUT.parent.mkdir(parents=True, exist_ok=True)
    RULES_OUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {RULES_OUT} ({RULES_OUT.stat().st_size} bytes, {len(compact)} sources)")
    return payload


def export_goldens() -> None:
    from uroman.uroman import Uroman

    u = Uroman()
    samples = [
        {"text": "café naïve", "language": None},
        {"text": "Непал", "language": "ru"},
        {"text": "Νεπάλ", "language": "el"},
        {"text": "नेपाल", "language": "hi"},
        {"text": "نیپال", "language": "ur"},
        {"text": "こんにちは", "language": "ja"},
        {"text": "안녕하세요", "language": "ko"},
        {"text": "你好", "language": "zh"},
        {"text": "العربية", "language": "ar"},
        {"text": "Straße", "language": "de"},
        {
            "text": "Ельцин",
            "language": "ru",
            "note": "language-sensitive ye/e",
        },
        {
            "text": "Ельцин",
            "language": None,
            "note": "no-language baseline for Ельцин",
        },
        {
            "text": "Xin chào Việt Nam",
            "language": "vi",
            "note": "Vietnamese phrase with tone marks",
        },
        {
            "text": "người",
            "language": "vi",
            "note": "Vietnamese ươ + tone",
        },
        {
            "text": "Đặng",
            "language": "vi",
            "note": "Vietnamese Đ/đ + tone",
        },
        {
            "text": "Hà Nội",
            "language": "vi",
            "note": "Vietnamese place name",
        },
        {
            "text": "tiếng Việt",
            "language": "vi",
            "note": "Vietnamese language name",
        },
    ]
    goldens = []
    for s in samples:
        lang = s.get("language")
        lcode = ISO1_TO_3.get(lang) if lang else None
        rom = u.romanize_string(s["text"], lcode=lcode)
        row = {
            "text": s["text"],
            "language": lang,
            "uroman": rom,
            "mmsNormalized": mms_normalize(rom),
        }
        if s.get("note"):
            row["note"] = s["note"]
        goldens.append(row)

    GOLDENS_OUT.parent.mkdir(parents=True, exist_ok=True)
    GOLDENS_OUT.write_text(
        json.dumps(goldens, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {GOLDENS_OUT} ({len(goldens)} samples)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--goldens",
        action="store_true",
        help="Also regenerate __fixtures__/uroman-goldens.json",
    )
    parser.add_argument(
        "--goldens-only",
        action="store_true",
        help="Only regenerate goldens (skip rules.json)",
    )
    args = parser.parse_args()
    if not args.goldens_only:
        export_rules()
    if args.goldens or args.goldens_only:
        export_goldens()


if __name__ == "__main__":
    main()
