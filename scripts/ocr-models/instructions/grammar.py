"""Lightweight grammar checks for Phase 0 raw outputs.

These are not the SDK parsers. They decide whether an instruction's output is
stable enough to enter the public API. Unknown constructs fail the gate.
"""

from __future__ import annotations

import re
from typing import Any

DOCTAGS_KNOWN = {
    "doctag",
    "text",
    "paragraph",
    "title",
    "list_item",
    "caption",
    "footnote",
    "formula",
    "code",
    "page_header",
    "page_footer",
    "picture",
    "chart",
    "otsl",
    "fcel",
    "ecel",
    "lcel",
    "ucel",
    "xcel",
    "nl",
    "ched",
    "rhed",
    "srow",
    "checkbox_selected",
    "checkbox_unselected",
    "form",
    "key_value_region",
    "smiles",
    "group",
    "page_break",
    "ordered_list",
    "unordered_list",
    "references",
    "section_header_level_1",
    "section_header_level_2",
    "section_header_level_3",
    "section_header_level_4",
    "section_header_level_5",
    "section_header_level_6",
}

NEMOTRON_CLASSES = {
    "Text",
    "Title",
    "Section-header",
    "List-item",
    "TOC",
    "Bibliography",
    "Footnote",
    "Page-header",
    "Page-footer",
    "Picture",
    "Formula",
    "Code",
    "Table",
    "Caption",
    "Chart",
}

_TAG = re.compile(r"</?([a-zA-Z][a-zA-Z0-9_]*)")
_LOC = re.compile(r"<loc_(\d+)>")
_PADDLE_LOC = re.compile(r"<\|LOC_(\d+)\|>")
_CLASS = re.compile(r"<class_([^>]+)>")
_XY = re.compile(r"<[xy]_([0-9.]+)>")
_OTSL = re.compile(r"<(fcel|ecel|lcel|ucel|xcel|nl|ched|rhed)>")


def inspect(kind: str, raw: str) -> dict[str, Any]:
    if kind == "doctags" or kind.startswith("doctags_"):
        return _doctags(raw, kind)
    if kind == "nemotron":
        return _nemotron(raw)
    if kind == "spotting_loc":
        return _spotting(raw)
    if kind == "otsl":
        return _otsl(raw)
    if kind == "latex":
        return _latex(raw)
    if kind == "chart":
        return _chart(raw)
    if kind in ("plain", "markdown_html"):
        return {"kind": kind, "ok": bool(raw.strip()), "unknown": [], "notes": []}
    return {"kind": kind, "ok": False, "unknown": [f"unrecognized grammar {kind}"], "notes": []}


def _doctags(raw: str, kind: str) -> dict[str, Any]:
    unknown = []
    tags = []
    for match in _TAG.finditer(raw):
        name = match.group(1)
        if name.startswith("loc_"):
            continue
        if name.startswith("row_") or name.startswith("key_") or name.startswith("value_"):
            tags.append(name)
            continue
        if name.startswith("rec_"):
            tags.append(name)
            continue
        if name not in DOCTAGS_KNOWN:
            unknown.append(name)
        tags.append(name)
    notes = []
    if kind == "doctags_otsl" and "otsl" not in tags and not _OTSL.search(raw):
        notes.append("expected otsl/fcel tokens")
    if kind == "doctags_formula" and "formula" not in tags and "\\" not in raw:
        notes.append("expected formula tag or latex")
    if kind == "doctags_code" and "code" not in tags and not raw.strip():
        notes.append("expected code tag or text")
    ok = not unknown and bool(raw.strip())
    if notes and kind != "doctags":
        # element-specific missing tokens are a soft fail recorded for the gate
        ok = ok and False
    return {
        "kind": kind,
        "ok": not unknown and bool(raw.strip()) and (not notes or kind == "doctags"),
        "unknown": sorted(set(unknown)),
        "tags": sorted(set(tags)),
        "loc_count": len(_LOC.findall(raw)),
        "notes": notes,
    }


def _nemotron(raw: str) -> dict[str, Any]:
    classes = _CLASS.findall(raw)
    unknown = [c for c in classes if c not in NEMOTRON_CLASSES]
    return {
        "kind": "nemotron",
        "ok": not unknown,
        "unknown": unknown,
        "class_count": len(classes),
        "box_count": len(_XY.findall(raw)) // 4,
        "notes": [],
    }


def _spotting(raw: str) -> dict[str, Any]:
    locs = [int(x) for x in _PADDLE_LOC.findall(raw)]
    leftover = len(locs) % 8
    return {
        "kind": "spotting_loc",
        "ok": leftover == 0 and len(locs) >= 8,
        "unknown": [] if leftover == 0 else [f"loc_count_mod8={leftover}"],
        "loc_count": len(locs),
        "quad_count": len(locs) // 8,
        "notes": [],
    }


def _otsl(raw: str) -> dict[str, Any]:
    cells = _OTSL.findall(raw)
    return {
        "kind": "otsl",
        "ok": bool(cells),
        "unknown": [] if cells else ["no_otsl_cells"],
        "cell_count": len(cells),
        "notes": [],
        "sample": raw[:400],
    }


def _latex(raw: str) -> dict[str, Any]:
    has = "\\" in raw or any(ch in raw for ch in "=^_{}")
    return {
        "kind": "latex",
        "ok": has and bool(raw.strip()),
        "unknown": [] if has else ["no_latex_markers"],
        "notes": [],
        "sample": raw[:400],
    }


def _chart(raw: str) -> dict[str, Any]:
    """Record the actual chart grammar. Gate later decides table vs reject."""
    has_otsl = bool(_OTSL.findall(raw))
    has_pipe = "|" in raw
    has_tab = "\\begin{tabular" in raw
    has_html = "<table" in raw.lower()
    form = (
        "otsl"
        if has_otsl
        else "gfm"
        if has_pipe
        else "latex_tabular"
        if has_tab
        else "html_table"
        if has_html
        else "other"
    )
    return {
        "kind": "chart",
        "ok": bool(raw.strip()),
        "unknown": [],
        "form": form,
        "notes": [f"chart_form={form}"],
        "sample": raw[:800],
    }
