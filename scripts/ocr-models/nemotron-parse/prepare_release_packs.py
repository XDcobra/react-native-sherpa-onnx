#!/usr/bin/env python3
"""Build the two local Nemotron-Parse packs (FP16 + official e5 INT8).

Does not upload. For local export / HF restage. GitHub release CI downloads
the already-published Hub folders instead.

Steps when a pack is missing:
  1. Snapshot `nvidia/Nemotron-3.5-Parse` into `hf-src/`
  2. Export FP32 (`export_onnx.py`)
  3. Quantize FP16, then first-pass INT8 (`quantize_onnx.py`)
  4. Build experiment e5 and promote it over `onnx-int8`
  5. Copy `TOKENIZER_ATTRIBUTION.md` next to each pack

`--free-disk` drops the snapshot, FP32, first-pass leftovers, and `exp/` after
the two release folders exist.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen

from constants import HF_REPO
from paths import (
    BUILD_ROOT,
    EXP_ROOT,
    HF_SRC,
    ONNX_DIR,
    ONNX_FP16_DIR,
    ONNX_INT8_DIR,
    ONNX_Q4F16_DIR,
    SCRIPT_DIR,
)
from prepare_hf_repo import NVIDIA_TOKENIZER_ATTR, promote_int8
from quantize_onnx import _log
from run_size_experiments import build_e5

E5_DIR = EXP_ROOT / "e5-int8-compact"


def graph_ready(pack_dir: Path) -> bool:
    return (pack_dir / "decoder_model_merged.onnx").is_file()


def pack_notes(pack_dir: Path) -> str:
    path = pack_dir / "ocr_manifest.json"
    if not path.is_file():
        return ""
    payload = json.loads(path.read_text(encoding="utf-8"))
    notes = payload.get("notes") or []
    if isinstance(notes, list):
        return " ".join(str(item) for item in notes).lower()
    return str(notes).lower()


def is_official_int8(pack_dir: Path) -> bool:
    return graph_ready(pack_dir) and "e5" in pack_notes(pack_dir)


def run_script(name: str, argv: list[str]) -> None:
    script = SCRIPT_DIR / name
    cmd = [sys.executable, str(script), *argv]
    _log(" ".join(cmd))
    subprocess.check_call(cmd, cwd=str(SCRIPT_DIR))


def ensure_snapshot() -> None:
    if (HF_SRC / "config.json").is_file():
        _log(f"hf-src present at {HF_SRC}")
        return
    HF_SRC.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
    _log(f"snapshot {HF_REPO} -> {HF_SRC}")
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=HF_REPO,
        local_dir=str(HF_SRC),
        token=token,
    )


def download_tokenizer_attr(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = HF_SRC / dest.name
    if src.is_file():
        shutil.copy2(src, dest)
        _log(f"copied {dest}")
        return
    req = Request(
        NVIDIA_TOKENIZER_ATTR,
        headers={"User-Agent": "react-native-sherpa-onnx-nemotron-prepare/1.0"},
    )
    with urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
    _log(f"downloaded {dest}")


def ensure_tokenizer_attr() -> None:
    for pack_dir in (ONNX_FP16_DIR, ONNX_INT8_DIR):
        if not pack_dir.is_dir():
            continue
        dest = pack_dir / "TOKENIZER_ATTRIBUTION.md"
        if dest.is_file() and dest.stat().st_size > 0:
            continue
        try:
            download_tokenizer_attr(dest)
        except Exception as error:
            _log(f"TOKENIZER_ATTRIBUTION.md skipped ({error})")


def free_disk() -> None:
    for path in (HF_SRC, ONNX_DIR, ONNX_Q4F16_DIR, EXP_ROOT, BUILD_ROOT / "hf-stage"):
        if path.exists():
            _log(f"rm {path}")
            shutil.rmtree(path, ignore_errors=True)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild FP16 / e5 INT8 even when the folders already exist",
    )
    parser.add_argument(
        "--free-disk",
        action="store_true",
        help="Delete snapshot, FP32, and experiment folders after the release packs exist",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)

    need_fp16 = args.force or not graph_ready(ONNX_FP16_DIR)
    need_int8 = args.force or not is_official_int8(ONNX_INT8_DIR)
    if not need_fp16 and not need_int8:
        _log("release packs already present")
        ensure_tokenizer_attr()
        if args.free_disk:
            free_disk()
        return 0

    ensure_snapshot()
    if args.force or not graph_ready(ONNX_DIR):
        run_script("export_onnx.py", [])
    if need_fp16:
        run_script("quantize_onnx.py", ["--variant", "fp16"])
    if need_int8:
        run_script("quantize_onnx.py", ["--variant", "int8"])
        _log(f"building e5 -> {E5_DIR}")
        build_e5(E5_DIR)
        promote_int8()

    if not graph_ready(ONNX_FP16_DIR):
        raise FileNotFoundError(ONNX_FP16_DIR)
    if not is_official_int8(ONNX_INT8_DIR):
        raise RuntimeError(f"official e5 INT8 missing at {ONNX_INT8_DIR}")

    ensure_tokenizer_attr()
    if args.free_disk:
        free_disk()
    _log(f"fp16={ONNX_FP16_DIR}")
    _log(f"int8={ONNX_INT8_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
