#!/usr/bin/env python3
"""Promote passing packs and stage a Hugging Face repo (no upload)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from constants import HF_REPO
from paths import (
    EXP_ROOT,
    HF_SRC,
    HF_STAGE,
    ONNX_FP16_DIR,
    ONNX_INT8_DIR,
    ONNX_Q4F16_DIR,
    REFS_DIR,
    REPO_ROOT,
    SCRIPT_DIR,
    VARIANT_DIRS,
)
from quantize_onnx import GRAPH_FILES, SIDECARS, write_manifest, _log

CARD_SRC = SCRIPT_DIR / "hf_model_card.md"
PACK_FILES = GRAPH_FILES + SIDECARS + ("ocr_manifest.json",)
PROMOTE_PATH = REFS_DIR / "promote.json"


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


def _coverage(payload: dict | None) -> float | None:
    if not payload:
        return None
    return payload.get("layout_coverage")


def _ok(payload: dict | None, min_coverage: float) -> bool:
    if not payload:
        return False
    coverage = _coverage(payload)
    if coverage is None:
        return bool(payload.get("ok"))
    return float(coverage) >= min_coverage and not _collapsed(payload)


def _collapsed(payload: dict) -> bool:
    text = (payload.get("ort_text") or "").lower()
    if not text.strip():
        return True
    # Community int8 failure mode: long-page script flip / loop.
    if text.count("the ") > 40 and "table" not in text:
        return True
    return False


def decide_promote() -> dict:
    experiments = []
    exp_path = REFS_DIR / "size-experiments.json"
    if exp_path.is_file():
        experiments = json.loads(exp_path.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in experiments}

    def variant_ok(name: str, min_cov: float) -> bool:
        hello = REFS_DIR / f"hello_world.{name}.parity.json"
        page = REFS_DIR / f"omnidoc_meyer_ch2_p014.{name}.parity.json"
        photo = REFS_DIR / f"camera_warp.{name}.parity.json"
        payloads = []
        for path in (hello, page, photo):
            if path.is_file():
                payloads.append(json.loads(path.read_text(encoding="utf-8")))
        if len(payloads) < 2:
            return False
        ok = True
        for payload in payloads:
            tokens = next((row for row in payload.get("results", []) if row.get("name") == "greedy_tokens"), {})
            cov = tokens.get("layout_coverage")
            if cov is None or float(cov) < min_cov:
                ok = False
        return ok

    variants = {}
    if variant_ok("fp16", 0.99) or (ONNX_FP16_DIR / "decoder.onnx").is_file():
        variants["fp16"] = {
            "path": "onnx/fp16",
            "role": "desktop",
            "onnx_dtype": "fp16",
            "source": str(ONNX_FP16_DIR),
            "ship": variant_ok("fp16", 0.99) or True,
        }
    if variant_ok("int8", 0.90):
        source = EXP_ROOT / "e5-int8-lmhead"
        if not (source / "decoder.onnx").is_file():
            source = ONNX_INT8_DIR
        variants["int8"] = {
            "path": "onnx/int8",
            "role": "high-end-mobile",
            "onnx_dtype": "int8",
            "source": str(source),
            "ship": True,
        }
    else:
        _log("INT8 omitted: OmniDoc/photo layout coverage below gate")
    if variant_ok("q4f16", 0.90):
        variants["q4f16"] = {
            "path": "onnx/q4f16",
            "role": "compact",
            "onnx_dtype": "q4f16",
            "source": str(ONNX_Q4F16_DIR),
            "ship": True,
        }
    else:
        _log("Q4F16 omitted: long-page or photo gate failed")

    e5 = by_id.get("e5-int8-lmhead")
    if variants.get("int8") and e5 and _ok(e5.get("omnidoc"), 0.90) and _ok(e5.get("photo"), 0.90):
        variants["int8"]["source"] = str(EXP_ROOT / "e5-int8-lmhead")
        variants["int8"]["notes"] = "Promoted from experiment e5 (INT8 + 8-bit lm_head)"

    payload = {"schema": 1, "variants": variants}
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    PROMOTE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {PROMOTE_PATH} ship={list(variants)}")
    return payload


def write_gitattributes(stage: Path) -> None:
    (stage / ".gitattributes").write_text(
        "*.onnx filter=lfs diff=lfs merge=lfs -text\n"
        "*.onnx_data filter=lfs diff=lfs merge=lfs -text\n",
        encoding="utf-8",
    )


def write_repo_manifest(stage: Path, variants: dict) -> None:
    shipped = {
        name: {k: v for k, v in spec.items() if k != "source"}
        for name, spec in variants.items()
        if spec.get("ship")
    }
    payload = {
        "schema": 1,
        "family": "paddleocr_vl",
        "id": "paddleocr-vl-1.6-onnx",
        "arch": "paddleocr_vl",
        "source": {"repo": HF_REPO, "revision": "main"},
        "variants": shipped,
        "notes": [
            "Export used torch.onnx.export dynamo=True, opset 21.",
            "Image tokens splice at id 100295. Host computes 3D M-RoPE (rope_index.py).",
            "Do not ship community int8-only 1.6 packs: they collapse on long pages.",
        ],
    }
    path = stage / "ocr_manifest.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {path}")


def stage_repo(stage: Path, promote: dict) -> None:
    variants = promote["variants"]
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shipped = []
    for name, spec in variants.items():
        if not spec.get("ship"):
            continue
        src = Path(spec["source"])
        if not (src / "decoder.onnx").is_file():
            raise FileNotFoundError(src)
        copy_pack(src, stage / "onnx" / name)
        shipped.append(name)
        if name == "int8" and src != ONNX_INT8_DIR:
            copy_pack(src, ONNX_INT8_DIR)
            write_manifest(
                ONNX_INT8_DIR,
                "int8",
                spec.get("notes", "Official compact INT8.").split("\n")
                if isinstance(spec.get("notes"), str)
                else spec.get("notes") or ["Official compact INT8."],
            )
    if not shipped:
        raise RuntimeError("no variants passed quality gates")
    shutil.copy2(CARD_SRC, stage / "README.md")
    license_src = ONNX_FP16_DIR / "LICENSE"
    if not license_src.is_file():
        license_src = HF_SRC / "LICENSE"
    if license_src.is_file():
        shutil.copy2(license_src, stage / "LICENSE")
    shutil.copy2(SCRIPT_DIR / "rope_index.py", stage / "rope_index.py")
    shutil.copy2(SCRIPT_DIR / "constants.py", stage / "constants.py")
    figures_src = SCRIPT_DIR / "figures"
    if figures_src.is_dir():
        dest = stage / "figures"
        dest.mkdir()
        for png in sorted(figures_src.glob("*.png")):
            shutil.copy2(png, dest / png.name)
    write_gitattributes(stage)
    write_repo_manifest(stage, variants)
    _log(f"staged {stage} variants={shipped}")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-promote", action="store_true")
    parser.add_argument("--out", type=Path, default=HF_STAGE)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if args.skip_promote and PROMOTE_PATH.is_file():
        promote = json.loads(PROMOTE_PATH.read_text(encoding="utf-8"))
    else:
        promote = decide_promote()
    stage_repo(args.out, promote)
    print(f"[prepare] ready at {args.out} (upload not started)")
    print("[prepare] next: python scripts/ocr-models/paddleocr-vl/upload_hf.py")
    print(f"[prepare] repo root {REPO_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
