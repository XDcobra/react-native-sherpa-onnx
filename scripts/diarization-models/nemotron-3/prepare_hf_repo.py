#!/usr/bin/env python3
"""Stage a Hugging Face repo for XDcobra/Nemotron-3-Diarization-ONNX (no upload).

Layout:

  hf-stage/
    README.md
    LICENSE
    .gitattributes
    onnx/fp32/   # optional desktop reference (large)
    onnx/fp16/
    onnx/int8/   # primary mobile candidate when parity passes
    figures/
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from constants import GRAPH_FILE, LICENSE_FILE, MANIFEST_FILE, METADATA_FILE, MODEL_ID, NVIDIA_REPO
from paths import (
    EXP_ROOT,
    FIGURES_DIR,
    HF_SRC,
    HF_STAGE,
    ONNX_DIR,
    ONNX_FP16_DIR,
    ONNX_INT8_DIR,
    SCRIPT_DIR,
    ensure_hf_src,
)

PACK_FILES = (GRAPH_FILE, METADATA_FILE, MANIFEST_FILE, LICENSE_FILE)


def _log(msg: str) -> None:
    print(f"[hf-stage] {msg}", flush=True)


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def copy_pack(src_dir: Path, dst_dir: Path) -> None:
    if not (src_dir / GRAPH_FILE).is_file():
        raise FileNotFoundError(src_dir / GRAPH_FILE)
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True)
    for name in PACK_FILES:
        src = src_dir / name
        if src.is_file():
            link_or_copy(src, dst_dir / name)
        data = Path(str(src_dir / GRAPH_FILE) + "_data")
        if name == GRAPH_FILE and data.is_file():
            link_or_copy(data, dst_dir / data.name)


def write_gitattributes(stage: Path) -> None:
    (stage / ".gitattributes").write_text(
        "*.onnx filter=lfs diff=lfs merge=lfs -text\n"
        "*.onnx_data filter=lfs diff=lfs merge=lfs -text\n"
        "*.png filter=lfs diff=lfs merge=lfs -text\n",
        encoding="utf-8",
    )


def write_repo_manifest(stage: Path, variants: list[str]) -> None:
    payload = {
        "schema": 1,
        "family": "nemotron3_diarization",
        "id": MODEL_ID,
        "arch": "streaming_sortformer_8spk",
        "source": {"repo": NVIDIA_REPO, "revision": "main"},
        "contract": "react-native-sherpa-onnx SortformerStreamingModel",
        "variants": {
            name: {"path": f"onnx/{name}", "onnx": GRAPH_FILE} for name in variants
        },
    }
    (stage / "repo_manifest.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--skip-fp32",
        action="store_true",
        help="Omit onnx/fp32 from the stage (default ships fp32 + fp16 + int8).",
    )
    p.add_argument(
        "--int8-from-exp",
        default="e2-int8",
        help="Promote this experiment pack to onnx/int8 when present",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ensure_hf_src()

    if HF_STAGE.exists():
        shutil.rmtree(HF_STAGE)
    HF_STAGE.mkdir(parents=True)

    card = SCRIPT_DIR / "hf_model_card.md"
    if not card.is_file():
        raise FileNotFoundError(card)
    shutil.copy2(card, HF_STAGE / "README.md")

    license_src = HF_SRC / LICENSE_FILE
    if license_src.is_file():
        shutil.copy2(license_src, HF_STAGE / LICENSE_FILE)
    elif (ONNX_DIR / LICENSE_FILE).is_file():
        shutil.copy2(ONNX_DIR / LICENSE_FILE, HF_STAGE / LICENSE_FILE)

    write_gitattributes(HF_STAGE)

    variants: list[str] = []
    if not args.skip_fp32:
        copy_pack(ONNX_DIR, HF_STAGE / "onnx" / "fp32")
        variants.append("fp32")

    if (ONNX_FP16_DIR / GRAPH_FILE).is_file():
        copy_pack(ONNX_FP16_DIR, HF_STAGE / "onnx" / "fp16")
        variants.append("fp16")
    elif (EXP_ROOT / "e1-fp16" / GRAPH_FILE).is_file():
        copy_pack(EXP_ROOT / "e1-fp16", HF_STAGE / "onnx" / "fp16")
        variants.append("fp16")

    int8_src = EXP_ROOT / args.int8_from_exp
    if (int8_src / GRAPH_FILE).is_file():
        copy_pack(int8_src, HF_STAGE / "onnx" / "int8")
        variants.append("int8")
    elif (ONNX_INT8_DIR / GRAPH_FILE).is_file():
        copy_pack(ONNX_INT8_DIR, HF_STAGE / "onnx" / "int8")
        variants.append("int8")

    if FIGURES_DIR.is_dir():
        fig_dst = HF_STAGE / "figures"
        fig_dst.mkdir(parents=True, exist_ok=True)
        for png in FIGURES_DIR.glob("*.png"):
            shutil.copy2(png, fig_dst / png.name)

    write_repo_manifest(HF_STAGE, variants)
    _log(f"staged {HF_STAGE} variants={variants}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
