#!/usr/bin/env python3
"""Encode every Phase 0 instruction prompt (processor only, no weights).

Writes prompt_ids.json / prompt.txt under the golden tree so prompt-id
goldens exist before the slow HF/ORT generate loop finishes.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from fixtures import load_catalog  # noqa: E402
from gate_paths import (  # noqa: E402
    GRANITE_HF,
    NEMOTRON_HF,
    PADDLE_HF,
    REPO_ROOT,
)
from golden import golden_dir  # noqa: E402
from tasks import (  # noqa: E402
    GRANITE_TASKS,
    PADDLEOCR_VL_TASKS,
    granite_user_text,
    nemotron_profiles,
)


def _image(entry: dict) -> Image.Image:
    path = Path(entry["path"])
    if not path.is_absolute():
        path = REPO_ROOT / path
    return Image.open(path).convert("RGB")


def _write(dest: Path, prompt_ids: list[int], prompt_text: str) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "prompt_ids.json").write_text(json.dumps(prompt_ids) + "\n")
    (dest / "prompt.txt").write_text(prompt_text)
    print(
        json.dumps(
            {
                "dir": str(dest.relative_to(REPO_ROOT)),
                "prompt_tokens": len(prompt_ids),
            }
        ),
        flush=True,
    )


def _paddle_prompt(processor, task: str) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": PADDLEOCR_VL_TASKS[task]["prompt"]},
            ],
        }
    ]
    return processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )


def _granite_prompt(processor, user_text: str) -> str:
    messages = [
        {
            "role": "user",
            "content": [{"type": "image"}, {"type": "text", "text": user_text}],
        }
    ]
    return processor.apply_chat_template(messages, add_generation_prompt=True)


def dump_paddle(catalog: dict) -> int:
    from transformers import AutoProcessor

    print(f"[prompt-ids] paddle processor {PADDLE_HF}", flush=True)
    processor = AutoProcessor.from_pretrained(
        str(PADDLE_HF), trust_remote_code=True, local_files_only=True
    )
    count = 0
    for task, spec in PADDLEOCR_VL_TASKS.items():
        prompt = _paddle_prompt(processor, task)
        for fixture_id in spec["fixtures"]:
            entry = catalog[fixture_id]
            features = processor(images=_image(entry), text=[prompt], return_tensors="np")
            ids = features["input_ids"]
            if getattr(ids, "ndim", 1) == 2:
                ids = ids[0]
            dest = golden_dir("paddleocr_vl", task, fixture_id)
            _write(dest, [int(x) for x in ids], prompt)
            count += 1
    return count


def dump_granite(catalog: dict) -> int:
    from transformers import AutoProcessor

    print(f"[prompt-ids] granite processor {GRANITE_HF}", flush=True)
    processor = AutoProcessor.from_pretrained(
        str(GRANITE_HF), trust_remote_code=True, local_files_only=True
    )
    count = 0
    for task, spec in GRANITE_TASKS.items():
        for fixture_id in spec["fixtures"]:
            entry = catalog[fixture_id]
            user_text = granite_user_text(task, entry)
            prompt = _granite_prompt(processor, user_text)
            features = processor(text=prompt, images=[_image(entry)], return_tensors="np")
            ids = features["input_ids"]
            if getattr(ids, "ndim", 1) == 2:
                ids = ids[0]
            dest = golden_dir("doc_vlm", task, fixture_id)
            _write(dest, [int(x) for x in ids], prompt)
            count += 1
    return count


def dump_nemotron(catalog: dict) -> int:
    from transformers import AutoProcessor

    print(f"[prompt-ids] nemotron processor {NEMOTRON_HF}", flush=True)
    processor = AutoProcessor.from_pretrained(
        str(NEMOTRON_HF), trust_remote_code=True, local_files_only=True
    )
    count = 0
    for spec in nemotron_profiles():
        prompt = spec["prompt"]
        for fixture_id in spec["fixtures"]:
            entry = catalog[fixture_id]
            features = processor(
                images=[_image(entry)],
                text=prompt,
                return_tensors="np",
                add_special_tokens=False,
            )
            ids = features["input_ids"]
            if getattr(ids, "ndim", 1) == 2:
                ids = ids[0]
            dest = golden_dir("nemotron_parse", "page", fixture_id, spec["name"])
            _write(dest, [int(x) for x in ids], prompt)
            count += 1
    return count


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--families",
        nargs="+",
        choices=("paddleocr_vl", "doc_vlm", "nemotron_parse"),
        default=("paddleocr_vl", "doc_vlm", "nemotron_parse"),
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    catalog = load_catalog()
    total = 0
    if "paddleocr_vl" in args.families:
        total += dump_paddle(catalog)
    if "doc_vlm" in args.families:
        total += dump_granite(catalog)
    if "nemotron_parse" in args.families:
        total += dump_nemotron(catalog)
    print(f"[prompt-ids] wrote {total} prompts", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
