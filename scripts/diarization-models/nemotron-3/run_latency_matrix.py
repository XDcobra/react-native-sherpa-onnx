#!/usr/bin/env python3
"""Latency-preset × pack matrix (Parse "instruction profile" analog).

Why this matters for the HF card *and* SDK wiring:

- Confirms dynamic axes cover NVIDIA's offline / low / very_low / ultra_low
  geometries without re-exporting.
- Surfaces high-res (10 ms) pred shapes vs encoder-frame cache lengths — the
  same indexing the C++ Sortformer runner must honor for Nemotron-3.
- Tells consumers which quant pack stays safe when they pick a live latency.

Skips Q4F16 (already rejected) and CoreML (not a published gate).
No DIHARD-style DER: too heavy for this release card; the step fixture plus
this matrix is the consumer-facing contract, same role as Parse instruction
tables.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from constants import LATENCY_PRESETS, MODEL_ID
from paths import BUILD_ROOT, EXP_ROOT, ONNX_DIR, REFS_DIR, SCRIPT_DIR, VARIANT_DIRS

PACKS = (
    {"id": "fp32", "dir": ONNX_DIR, "min_preds_cosine": 0.999, "min_agreement": 0.999},
    {"id": "fp16", "dir": VARIANT_DIRS["fp16"], "min_preds_cosine": 0.999, "min_agreement": 0.999},
    {
        "id": "int8",
        "dir": EXP_ROOT / "e2-int8",
        "fallback": VARIANT_DIRS["int8"],
        "min_preds_cosine": 0.98,
        "min_agreement": 0.995,
    },
)

PRESET_ORDER = ("offline", "low_latency", "very_low_latency", "ultra_low_latency")


def _log(msg: str) -> None:
    print(f"[latency-matrix] {msg}", flush=True)


def resolve_pack_dir(pack: dict) -> Path:
    path = Path(pack["dir"])
    if (path / "model.onnx").is_file():
        return path
    fallback = pack.get("fallback")
    if fallback and (Path(fallback) / "model.onnx").is_file():
        return Path(fallback)
    raise FileNotFoundError(f"missing ONNX pack for {pack['id']}: {path}")


def run_parity(pack_dir: Path, pack_id: str, preset: str, *, from_refs: bool) -> dict:
    stem = f"step_{preset}"
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "test_parity.py"),
        "--onnx-dir",
        str(pack_dir),
        "--profile",
        f"{pack_id}_{preset}",
        "--preset",
        preset,
        "--stem",
        stem,
        "--gates",
        "--min-preds-cosine",
        str(next(p["min_preds_cosine"] for p in PACKS if p["id"] == pack_id)),
        "--min-agreement",
        str(next(p["min_agreement"] for p in PACKS if p["id"] == pack_id)),
    ]
    if from_refs:
        cmd.append("--from-refs")
    _log(" ".join(cmd))
    proc = subprocess.run(cmd, cwd=str(SCRIPT_DIR), check=False)
    # test_parity writes parity_{profile}_{stem}.json
    summary_path = REFS_DIR / f"parity_{pack_id}_{preset}_{stem}.json"
    summary = {}
    if summary_path.is_file():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    cold = next((c for c in summary.get("cases", []) if "cold" in c.get("case", "")), None)
    warm = next((c for c in summary.get("cases", []) if "warm" in c.get("case", "")), None)
    return {
        "pack": pack_id,
        "preset": preset,
        "passed": proc.returncode == 0,
        "exit_code": proc.returncode,
        "cold_preds_cos": None if not cold else cold["spkcache_fifo_chunk_preds"]["cosine"],
        "cold_agree": None if not cold else cold["decision"]["agreement"],
        "warm_preds_cos": None if not warm else warm["spkcache_fifo_chunk_preds"]["cosine"],
        "warm_agree": None if not warm else warm["decision"]["agreement"],
        "cold_pred_shape": None if not cold else cold["spkcache_fifo_chunk_preds"]["shape"],
        "latency_s": LATENCY_PRESETS[preset]["latency_s"],
    }


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--presets",
        nargs="*",
        default=list(PRESET_ORDER),
        choices=sorted(LATENCY_PRESETS.keys()),
    )
    p.add_argument(
        "--packs",
        nargs="*",
        default=[p["id"] for p in PACKS],
        choices=[p["id"] for p in PACKS],
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    selected_packs = [p for p in PACKS if p["id"] in args.packs]
    rows = []

    for preset in args.presets:
        # Fresh FP32 goldens per preset (NeMo / ORT), then quant packs --from-refs.
        fp32 = next(p for p in selected_packs if p["id"] == "fp32")
        fp32_dir = resolve_pack_dir(fp32)
        rows.append(run_parity(fp32_dir, "fp32", preset, from_refs=False))

        for pack in selected_packs:
            if pack["id"] == "fp32":
                continue
            pack_dir = resolve_pack_dir(pack)
            rows.append(run_parity(pack_dir, pack["id"], preset, from_refs=True))

    out = BUILD_ROOT / "latency_matrix.json"
    payload = {"model_id": MODEL_ID, "rows": rows}
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {out}")

    print("\n| Pack | Preset | Latency | Preds cos (cold) | Agree (cold) | Pass |")
    print("|---|---|---:|---:|---:|:---:|")
    for row in rows:
        cos = row["cold_preds_cos"]
        agr = row["cold_agree"]
        cos_s = "n/a" if cos is None else f"{cos:.6f}"
        agr_s = "n/a" if agr is None else f"{agr:.6f}"
        print(
            f"| {row['pack']} | {row['preset']} | {row['latency_s']} s | "
            f"{cos_s} | {agr_s} | {'yes' if row['passed'] else 'no'} |"
        )

    return 0 if all(r["passed"] for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
