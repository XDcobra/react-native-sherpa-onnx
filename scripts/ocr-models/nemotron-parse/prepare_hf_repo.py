#!/usr/bin/env python3
"""Promote the release packs and stage a Hugging Face repo (no upload).

1. Copy experiment e5 over `onnx-int8` (official compact INT8).
2. Stage `build/ocr-models/nemotron-3.5-parse/hf-stage/` with
   `onnx/fp16`, `onnx/int8`, model card, LICENSE, navit helper.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.request import Request, urlopen

from constants import HF_REPO
from paths import (
    EXP_ROOT,
    HF_SRC,
    HF_STAGE,
    ONNX_FP16_DIR,
    ONNX_INT8_DIR,
    REPO_ROOT,
    SCRIPT_DIR,
)
from quantize_onnx import GRAPH_FILES, SIDECARS, write_manifest, _log

E5_DIR = EXP_ROOT / "e5-int8-compact"
CARD_SRC = SCRIPT_DIR / "hf_model_card.md"
NVIDIA_TOKENIZER_ATTR = (
    "https://huggingface.co/nvidia/Nemotron-3.5-Parse/resolve/main/TOKENIZER_ATTRIBUTION.md"
)
PACK_FILES = GRAPH_FILES + SIDECARS + ("ocr_manifest.json",)


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def copy_pack(src_dir: Path, dst_dir: Path) -> None:
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True)
    for name in PACK_FILES:
        src = src_dir / name
        if src.is_file():
            link_or_copy(src, dst_dir / name)
        data = Path(str(src) + "_data")
        if data.is_file():
            link_or_copy(data, dst_dir / data.name)


def promote_int8() -> None:
    if not (E5_DIR / "decoder_model_merged.onnx").is_file():
        raise FileNotFoundError(
            f"missing {E5_DIR}. Run run_size_experiments.py --only e5-int8-compact first."
        )
    _log(f"promote {E5_DIR} -> {ONNX_INT8_DIR}")
    if ONNX_INT8_DIR.exists():
        shutil.rmtree(ONNX_INT8_DIR)
    copy_pack(E5_DIR, ONNX_INT8_DIR)
    write_manifest(
        ONNX_INT8_DIR,
        "int8",
        [
            "Official compact INT8 (experiment e5).",
            "INT8 vision + INT8 decoder MatMul, INT8 embed_tokens, 8-bit lm_head.",
            "pos_embed.npy is float16; host NaViT still interpolates in float32.",
            "Keeps OmniDoc page header; Hello World tokens match Transformers.",
        ],
    )


def write_gitattributes(stage: Path) -> None:
    (stage / ".gitattributes").write_text(
        "*.onnx filter=lfs diff=lfs merge=lfs -text\n"
        "*.onnx_data filter=lfs diff=lfs merge=lfs -text\n"
        "*.npy filter=lfs diff=lfs merge=lfs -text\n",
        encoding="utf-8",
    )


def write_repo_manifest(stage: Path) -> None:
    payload = {
        "schema": 1,
        "family": "doc_vlm",
        "id": "docvlm-nemotron-3.5-parse-onnx",
        "arch": "nemotron_parse",
        "source": {"repo": HF_REPO, "revision": "main"},
        "variants": {
            "fp16": {"path": "onnx/fp16", "role": "desktop", "onnx_dtype": "fp16"},
            "int8": {"path": "onnx/int8", "role": "high-end-mobile", "onnx_dtype": "int8"},
        },
        "notes": [
            "NaViT positional interpolation is host-side (navit_pos.py).",
            "Do not 4-bit-quantize the vision encoder.",
        ],
    }
    path = stage / "ocr_manifest.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {path}")


def download(url: str, dest: Path) -> None:
    req = Request(url, headers={"User-Agent": "react-native-sherpa-onnx-hf-stage/1.0"})
    with urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
    _log(f"downloaded {dest.name}")


def stage_repo(stage: Path) -> None:
    if not (ONNX_FP16_DIR / "decoder_model_merged.onnx").is_file():
        raise FileNotFoundError(ONNX_FP16_DIR)
    if not (ONNX_INT8_DIR / "decoder_model_merged.onnx").is_file():
        raise FileNotFoundError(ONNX_INT8_DIR)
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    copy_pack(ONNX_FP16_DIR, stage / "onnx" / "fp16")
    copy_pack(ONNX_INT8_DIR, stage / "onnx" / "int8")
    shutil.copy2(CARD_SRC, stage / "README.md")
    license_src = ONNX_FP16_DIR / "LICENSE"
    if license_src.is_file():
        shutil.copy2(license_src, stage / "LICENSE")
    shutil.copy2(SCRIPT_DIR / "navit_pos.py", stage / "navit_pos.py")
    shutil.copy2(SCRIPT_DIR / "constants.py", stage / "constants.py")
    attr = HF_SRC / "TOKENIZER_ATTRIBUTION.md"
    dest_attr = stage / "TOKENIZER_ATTRIBUTION.md"
    if attr.is_file():
        shutil.copy2(attr, dest_attr)
    else:
        try:
            download(NVIDIA_TOKENIZER_ATTR, dest_attr)
        except Exception as error:
            _log(f"TOKENIZER_ATTRIBUTION.md skipped ({error})")
    write_gitattributes(stage)
    write_repo_manifest(stage)
    _log(f"staged {stage}")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-promote", action="store_true")
    parser.add_argument("--out", type=Path, default=HF_STAGE)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if not args.skip_promote:
        promote_int8()
    stage_repo(args.out)
    print(f"[prepare] ready at {args.out} (upload not started)")
    print(f"[prepare] next: python scripts/ocr-models/nemotron-parse/upload_hf.py")
    print(f"[prepare] repo root {REPO_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
