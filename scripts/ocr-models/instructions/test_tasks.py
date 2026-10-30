#!/usr/bin/env python3
"""Host checks for Phase 0 instruction tables (no model weights)."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from tasks import (  # noqa: E402
    GRANITE_TASKS,
    NEMOTRON_DEFAULT_PROFILE,
    PADDLEOCR_VL_TASKS,
    granite_locs,
    granite_user_text,
    nemotron_profiles,
)


def test_nemotron_fourteen():
    profiles = nemotron_profiles()
    assert len(profiles) == 14, len(profiles)
    names = [p["name"] for p in profiles]
    assert len(set(names)) == 14, names
    assert NEMOTRON_DEFAULT_PROFILE in names
    default = next(p for p in profiles if p["name"] == NEMOTRON_DEFAULT_PROFILE)
    assert default["prompt"] == (
        "</s><s><no_bbox><no_classes>"
        "<output_markdown><predict_text_in_pic>"
    )
    invalid = [p for p in profiles if p["text"] == "none" and p["layout"] == "none"]
    assert invalid == []


def test_granite_locs():
    locs = granite_locs({"x": 0, "y": 0, "width": 900, "height": 1200}, 900, 1200)
    assert locs == "<loc_0><loc_0><loc_500><loc_500>", locs
    title = granite_locs({"x": 48, "y": 55, "width": 452, "height": 33}, 900, 1200)
    tokens = [int(part[5:-1]) for part in title.replace("><", ">|<").split("|")]
    assert tokens[0] < tokens[2] and tokens[1] < tokens[3]
    assert all(0 <= n <= 500 for n in tokens)


def test_granite_region_prompt():
    entry = {
        "region": {"x": 48, "y": 55, "width": 452, "height": 33},
        "width": 900,
        "height": 1200,
    }
    text = granite_user_text("regionText", entry)
    assert text.startswith("OCR the text in a specific location: <loc_")
    ident = granite_user_text("identifyElement", entry)
    assert ident.startswith("Identify element at: <loc_")
    assert granite_user_text("page", entry) == "Convert this page to docling."


def test_accepted_task_counts():
    assert list(PADDLEOCR_VL_TASKS) == [
        "ocr",
        "table",
        "formula",
        "chart",
        "seal",
        "spotting",
    ]
    assert set(GRANITE_TASKS) == {
        "page",
        "element_table",
        "element_chart",
        "element_formula",
        "element_code",
        "regionText",
        "identifyElement",
    }


if __name__ == "__main__":
    test_nemotron_fourteen()
    test_granite_locs()
    test_granite_region_prompt()
    test_accepted_task_counts()
    print("ok")
