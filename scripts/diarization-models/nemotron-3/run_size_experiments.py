#!/usr/bin/env python3
"""Size-cut experiments for Nemotron-3 diarization ONNX.

Builds packs under build/diarization-models/nemotron-3/exp/ and runs
`test_parity.py --from-refs --gates` against FP32 ORT goldens. Use the
resulting table to decide which variants ship on the HF card (same role as
Nemotron-3.5-Parse e1–e5 experiments).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from constants import GRAPH_FILE, MODEL_ID
from paths import BUILD_ROOT, EXP_ROOT, ONNX_DIR, REFS_DIR, SCRIPT_DIR, VARIANT_DIRS
from quantize_onnx import (
    quantize_fp16,
    quantize_int8,
    quantize_q4f16,
    write_manifest,
    _log,
)

EXPERIMENTS = (
    {
        "id": "e1-fp16",
        "build": "fp16",
        "notes": ["FP16 convert of FP32 export; I/O float32."],
        # Strict FP32-vs-FP16 gates.
        "min_preds_cosine": 0.999,
        "min_agreement": 0.999,
    },
    {
        "id": "e2-int8",
        "build": "int8",
        "notes": ["Per-channel dynamic INT8 MatMul."],
        "min_preds_cosine": 0.98,
        "min_agreement": 0.995,
    },
    {
        "id": "e3-q4f16",
        "build": "q4f16",
        "notes": ["4-bit MatMulNBits on FP16 parent."],
        "min_preds_cosine": 0.95,
        "min_agreement": 0.99,
    },
)


def pack_bytes(pack_dir: Path) -> dict:
    total = 0
    files = {}
    for path in sorted(pack_dir.iterdir()):
        if path.suffix == ".onnx" or path.name.endswith(".onnx_data"):
            size = path.stat().st_size
            files[path.name] = size
            total += size
    return {"total": total, "files": files}


def build_experiment(exp: dict) -> Path:
    out = EXP_ROOT / exp["id"]
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    kind = exp["build"]
    if kind == "fp16":
        quantize_fp16(ONNX_DIR, out)
    elif kind == "int8":
        quantize_int8(ONNX_DIR, out)
    elif kind == "q4f16":
        fp16 = VARIANT_DIRS["fp16"]
        if not (fp16 / GRAPH_FILE).is_file():
            quantize_fp16(ONNX_DIR, fp16)
        quantize_q4f16(fp16, out)
    else:
        raise ValueError(kind)
    write_manifest(out, exp["id"], exp["notes"])
    return out


def run_parity(pack_dir: Path, exp: dict) -> dict:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "test_parity.py"),
        "--onnx-dir",
        str(pack_dir),
        "--profile",
        exp["id"],
        "--from-refs",
        "--stem",
        "step",
        "--gates",
        "--min-preds-cosine",
        str(exp["min_preds_cosine"]),
        "--min-agreement",
        str(exp["min_agreement"]),
    ]
    _log(" ".join(cmd))
    proc = subprocess.run(cmd, cwd=str(SCRIPT_DIR), check=False)
    summary_path = REFS_DIR / f"parity_{exp['id']}_step.json"
    summary = {}
    if summary_path.is_file():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["exit_code"] = proc.returncode
    summary["passed"] = proc.returncode == 0
    summary["size"] = pack_bytes(pack_dir)
    return summary


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--only",
        action="append",
        default=[],
        help="Experiment id to run (repeatable). Default: all.",
    )
    p.add_argument(
        "--skip-build",
        action="store_true",
        help="Reuse existing exp/<id> packs; only re-run parity.",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if not (ONNX_DIR / GRAPH_FILE).is_file():
        raise FileNotFoundError(f"missing {ONNX_DIR / GRAPH_FILE}; export first")

    # Need FP32 goldens under refs/ before --from-refs experiments.
    golden = REFS_DIR / "step_cold_s0" / "spkcache_fifo_chunk_preds.npy"
    if not golden.is_file():
        _log("FP32 goldens missing — running NeMo vs ORT FP32 parity first")
        cmd = [
            sys.executable,
            str(SCRIPT_DIR / "test_parity.py"),
            "--onnx-dir",
            str(ONNX_DIR),
            "--profile",
            "fp32",
            "--stem",
            "step",
            "--gates",
        ]
        subprocess.run(cmd, cwd=str(SCRIPT_DIR), check=True)

    selected = [e for e in EXPERIMENTS if not args.only or e["id"] in args.only]
    results = []
    EXP_ROOT.mkdir(parents=True, exist_ok=True)
    for exp in selected:
        _log(f"=== {exp['id']} ===")
        pack = EXP_ROOT / exp["id"]
        if not args.skip_build or not (pack / GRAPH_FILE).is_file():
            pack = build_experiment(exp)
        summary = run_parity(pack, exp)
        summary["id"] = exp["id"]
        summary["notes"] = exp["notes"]
        results.append(summary)

    out = BUILD_ROOT / "experiment_results.json"
    payload = {"model_id": MODEL_ID, "experiments": results}
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {out}")

    print("\n| ID | Size | Preds cos (cold) | Agree (cold) | Pass |")
    print("|---|---:|---:|---:|:---:|")
    for row in results:
        size_mb = row.get("size", {}).get("total", 0) / 1e6
        cold = next((c for c in row.get("cases", []) if "cold" in c.get("case", "")), None)
        if cold:
            cos = cold["spkcache_fifo_chunk_preds"]["cosine"]
            agr = cold["decision"]["agreement"]
        else:
            cos = agr = float("nan")
        flag = "yes" if row.get("passed") else "no"
        print(f"| {row['id']} | {size_mb:.1f} MB | {cos:.6f} | {agr:.6f} | {flag} |")

    return 0 if all(r.get("passed") for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
