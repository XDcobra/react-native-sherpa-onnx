#!/usr/bin/env python3
"""Check Phase 0 prompt_ids.json against the documented token maps.

No model weights. Exit 0 only when every dumped prompt matches the plan.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from fixtures import load_catalog  # noqa: E402
from gate_paths import GOLDEN_ROOT, REPO_ROOT  # noqa: E402
from golden import HF_CACHE_ROOT, golden_dir  # noqa: E402
from tasks import (  # noqa: E402
    GRANITE_TASKS,
    PADDLEOCR_VL_TASKS,
    granite_user_text,
    nemotron_profiles,
)

# Plan §1.1 — shipped Nemotron tokenizer added specials.
NEMOTRON_IDS = {
    "</s>": 2,
    "<s>": 0,
    "<output_plain>": 50000,
    "<output_markdown>": 50001,
    "<output_no_text>": 50002,
    "<output_ocr>": 50003,
    "<predict_bbox>": 50004,
    "<no_bbox>": 50005,
    "<no_classes>": 50007,
    "<predict_classes>": 50008,
    "<predict_text_in_pic>": 50009,
    "<predict_no_text_in_pic>": 50010,
}


def _read_ids(path: Path) -> list[int]:
    return json.loads(path.read_text())


def encode_nemotron_prompt(prompt: str) -> list[int]:
    ids: list[int] = []
    rest = prompt
    tokens = sorted(NEMOTRON_IDS, key=len, reverse=True)
    while rest:
        for tok in tokens:
            if rest.startswith(tok):
                ids.append(NEMOTRON_IDS[tok])
                rest = rest[len(tok) :]
                break
        else:
            raise ValueError(f"unparsed remainder {rest!r} in {prompt!r}")
    return ids


def check_nemotron() -> list[str]:
    errors = []
    for spec in nemotron_profiles():
        expected = encode_nemotron_prompt(spec["prompt"])
        for fixture_id in spec["fixtures"]:
            dest = golden_dir("nemotron_parse", "page", fixture_id, spec["name"])
            got = _read_ids(dest / "prompt_ids.json")
            text = (dest / "prompt.txt").read_text()
            if got != expected:
                errors.append(
                    f"nemotron {spec['name']}/{fixture_id} ids {got} != {expected}"
                )
            if text != spec["prompt"]:
                errors.append(
                    f"nemotron {spec['name']}/{fixture_id} text {text!r} != {spec['prompt']!r}"
                )
            if 50003 in got:
                errors.append(f"nemotron {spec['name']} encoded undocumented <output_ocr>")
    return errors


def check_paddle(catalog: dict) -> list[str]:
    errors = []
    for task, spec in PADDLEOCR_VL_TASKS.items():
        suffix = spec["prompt"]
        for fixture_id in spec["fixtures"]:
            dest = golden_dir("paddleocr_vl", task, fixture_id)
            text = (dest / "prompt.txt").read_text()
            ids = _read_ids(dest / "prompt_ids.json")
            if suffix not in text:
                errors.append(f"paddle {task}/{fixture_id} missing {suffix!r} in {text!r}")
            if "Assistant:" not in text:
                errors.append(f"paddle {task}/{fixture_id} missing generation prompt")
            if not ids:
                errors.append(f"paddle {task}/{fixture_id} empty prompt ids")
    cache = (
        HF_CACHE_ROOT / "paddleocr_vl" / "ocr" / "page_01" / "hf-64.json"
    )
    if cache.is_file():
        dumped = _read_ids(
            golden_dir("paddleocr_vl", "ocr", "page_01") / "prompt_ids.json"
        )
        hf_ids = json.loads(cache.read_text())["hf"]["prompt_ids"]
        if dumped != hf_ids:
            errors.append("paddle ocr/page_01 dump prompt_ids != HF generate prompt_ids")
    return errors


def check_granite(catalog: dict) -> list[str]:
    errors = []
    for task, spec in GRANITE_TASKS.items():
        for fixture_id in spec["fixtures"]:
            dest = golden_dir("doc_vlm", task, fixture_id)
            text = (dest / "prompt.txt").read_text()
            user = granite_user_text(task, catalog[fixture_id])
            if user not in text:
                errors.append(
                    f"granite {task}/{fixture_id} missing user text {user!r}"
                )
            if spec.get("needs_region") and "<loc_" not in text:
                errors.append(f"granite {task}/{fixture_id} missing loc tokens")
            ids = _read_ids(dest / "prompt_ids.json")
            if not ids:
                errors.append(f"granite {task}/{fixture_id} empty prompt ids")
    return errors


def main() -> int:
    catalog = load_catalog()
    errors = check_nemotron() + check_paddle(catalog) + check_granite(catalog)
    report = {
        "ok": not errors,
        "errors": errors,
        "counts": {
            "paddleocr_vl": 18,
            "doc_vlm": 21,
            "nemotron_parse": 42,
        },
        "nemotron_default_ids": encode_nemotron_prompt(
            "</s><s><predict_bbox><predict_classes>"
            "<output_markdown><predict_no_text_in_pic>"
        ),
    }
    out = GOLDEN_ROOT / "prompt-ids-verify.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)
    print(f"report={out.relative_to(REPO_ROOT)}", flush=True)
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
