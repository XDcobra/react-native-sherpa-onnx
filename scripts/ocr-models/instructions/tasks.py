"""Official instruction prompts for every family the Phase 0 gate probes.

Prompt strings are the documented HF / IBM / NVIDIA forms. Region locs are
filled later from pixel rectangles via the 0–500 granite grid.
"""

from __future__ import annotations

from typing import Any

PADDLEOCR_VL_TASKS: dict[str, dict[str, Any]] = {
    "ocr": {
        "prompt": "OCR:",
        "max_pixels": 1280 * 28 * 28,
        "upscale_small_2x": False,
        "fixtures": ["page_01", "page_02", "page_03"],
        "grammar": "markdown_html",
    },
    "table": {
        "prompt": "Table Recognition:",
        "max_pixels": 1280 * 28 * 28,
        "upscale_small_2x": False,
        "fixtures": ["table_01", "table_02", "table_03"],
        "grammar": "otsl",
    },
    "formula": {
        "prompt": "Formula Recognition:",
        "max_pixels": 1280 * 28 * 28,
        "upscale_small_2x": False,
        "fixtures": ["formula_01", "formula_02", "formula_03"],
        "grammar": "latex",
    },
    "chart": {
        "prompt": "Chart Recognition:",
        "max_pixels": 1280 * 28 * 28,
        "upscale_small_2x": False,
        "fixtures": ["chart_01", "chart_02", "chart_03"],
        "grammar": "chart",
    },
    "seal": {
        "prompt": "Seal Recognition:",
        "max_pixels": 1280 * 28 * 28,
        "upscale_small_2x": False,
        "fixtures": ["seal_01", "seal_02", "seal_03"],
        "grammar": "plain",
    },
    "spotting": {
        "prompt": "Spotting:",
        "max_pixels": 2048 * 28 * 28,
        "upscale_small_2x": True,
        "upscale_threshold": 1500,
        "fixtures": ["spotting_01", "spotting_02", "spotting_03"],
        "grammar": "spotting_loc",
    },
}

GRANITE_TASKS: dict[str, dict[str, Any]] = {
    "page": {
        "prompt": "Convert this page to docling.",
        "fixtures": ["page_01", "page_02", "page_03"],
        "needs_region": False,
        "grammar": "doctags",
    },
    "element_table": {
        "prompt": "Convert table to OTSL.",
        "fixtures": ["table_01", "table_02", "table_03"],
        "needs_region": False,
        "grammar": "doctags_otsl",
    },
    "element_chart": {
        "prompt": "Convert chart to table.",
        "fixtures": ["chart_01", "chart_02", "chart_03"],
        "needs_region": False,
        "grammar": "doctags_otsl",
    },
    "element_formula": {
        "prompt": "Convert formula to LaTeX.",
        "fixtures": ["formula_01", "formula_02", "formula_03"],
        "needs_region": False,
        "grammar": "doctags_formula",
    },
    "element_code": {
        "prompt": "Convert code to text.",
        "fixtures": ["code_01", "code_02", "code_03"],
        "needs_region": False,
        "grammar": "doctags_code",
    },
    "regionText": {
        "prompt_template": "OCR the text in a specific location: {locs}",
        "fixtures": ["page_01", "page_02", "page_03"],
        "needs_region": True,
        "grammar": "doctags_text",
    },
    "identifyElement": {
        "prompt_template": "Identify element at: {locs}",
        "fixtures": ["page_01", "page_02", "page_03"],
        "needs_region": True,
        "grammar": "doctags_element",
    },
}

NEMOTRON_TEXT = ("markdown", "plain", "none")
NEMOTRON_LAYOUT = ("none", "boxes", "boxesAndClasses")

NEMOTRON_BBOX = {
    "none": "<no_bbox>",
    "boxes": "<predict_bbox>",
    "boxesAndClasses": "<predict_bbox>",
}
NEMOTRON_CLASSES = {
    "none": "<no_classes>",
    "boxes": "<no_classes>",
    "boxesAndClasses": "<predict_classes>",
}
NEMOTRON_OUTPUT = {
    "markdown": "<output_markdown>",
    "plain": "<output_plain>",
    "none": "<output_no_text>",
}
NEMOTRON_PIC = {
    True: "<predict_text_in_pic>",
    False: "<predict_no_text_in_pic>",
}


def nemotron_profiles() -> list[dict[str, Any]]:
    """The 14 valid NVIDIA control-token combinations (plan §2.3)."""
    profiles: list[dict[str, Any]] = []
    for text in ("markdown", "plain"):
        for layout in NEMOTRON_LAYOUT:
            for pic in (True, False):
                profiles.append(_nemotron_profile(text, layout, pic))
    for layout in ("boxes", "boxesAndClasses"):
        profiles.append(_nemotron_profile("none", layout, False))
    if len(profiles) != 14:
        raise RuntimeError(f"expected 14 Nemotron profiles, got {len(profiles)}")
    return profiles


def _nemotron_profile(text: str, layout: str, pic: bool) -> dict[str, Any]:
    prompt = (
        "</s><s>"
        + NEMOTRON_BBOX[layout]
        + NEMOTRON_CLASSES[layout]
        + NEMOTRON_OUTPUT[text]
        + NEMOTRON_PIC[pic]
    )
    name = f"{text}_{layout}_{'pic' if pic else 'nopic'}"
    return {
        "name": name,
        "text": text,
        "layout": layout,
        "textInPictures": pic,
        "prompt": prompt,
        "fixtures": ["page_01", "page_02", "page_03"],
        "grammar": "nemotron",
    }


# Phase 0: NVIDIA card default `markdown_boxesAndClasses_nopic` is not
# token-identical to the int8 ORT pack (prefix_len=0 on all 3 pages).
# Only `markdown_none_pic` passed 3/3.
NEMOTRON_DEFAULT_PROFILE = "markdown_none_pic"


def granite_locs(rect: dict[str, int], frame_w: int, frame_h: int) -> str:
    """Pixel axis-aligned rect → four granite `<loc_n>` tokens, grid 0–500."""

    def to_loc(value: int, extent: int) -> int:
        if extent <= 0:
            raise ValueError("frame extent must be > 0")
        loc = int(round(value / extent * 500.0))
        return max(0, min(500, loc))

    x1 = to_loc(rect["x"], frame_w)
    y1 = to_loc(rect["y"], frame_h)
    x2 = to_loc(rect["x"] + rect["width"], frame_w)
    y2 = to_loc(rect["y"] + rect["height"], frame_h)
    if x2 <= x1:
        x2 = min(500, x1 + 1)
    if y2 <= y1:
        y2 = min(500, y1 + 1)
    return f"<loc_{x1}><loc_{y1}><loc_{x2}><loc_{y2}>"


def granite_user_text(task: str, catalog_entry: dict[str, Any] | None) -> str:
    spec = GRANITE_TASKS[task]
    if spec.get("needs_region"):
        if catalog_entry is None:
            raise ValueError(f"{task} needs a catalog entry with a region")
        region = catalog_entry["region"]
        locs = granite_locs(region, catalog_entry["width"], catalog_entry["height"])
        return spec["prompt_template"].format(locs=locs)
    return spec["prompt"]
