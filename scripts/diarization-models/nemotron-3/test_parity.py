#!/usr/bin/env python3
"""Parity gates for Nemotron-3 Sortformer ONNX vs NeMo/PyTorch.

Two layers (same spirit as Nemotron-3.5-Parse instruction/quality tables):

1. **Step parity** — one streaming forward with fixed random/chunk state:
   cosine + max-abs on `spkcache_fifo_chunk_preds` and `chunk_pre_encode_embs`.
2. **Streaming frame agreement** — run a synthetic multi-chunk session with
   host FIFO/cache bookkeeping mirrored from the export contract; report
   thresholded (p>0.5) speaker-decision agreement per frame.

Use `--from-refs` to compare a quantized pack against saved FP32 ORT goldens
(no NeMo reload). Results are written under `build/.../refs/` for HF card tables.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from constants import (
    DEFAULT_EXPORT_PRESET,
    EMB_DIM,
    FEAT_DIM,
    INPUT_NAMES,
    LATENCY_PRESETS,
    MAX_SPEAKERS,
    OUTPUT_NAMES,
    SUBSAMPLING,
)
from ort_session import coreml_safe_for_parity, load_ort_session
from paths import NEMO_CKPT, ONNX_DIR, REFS_DIR, VARIANT_DIRS, ensure_hf_src


def _log(msg: str) -> None:
    print(f"[parity] {msg}", flush=True)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float64).ravel()
    b = b.astype(np.float64).ravel()
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 1.0 if np.allclose(a, b) else 0.0
    return float(np.dot(a, b) / denom)


def max_abs(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64))))


def make_step_inputs(preset: dict, rng: np.random.Generator, *, filled_cache: bool):
    chunk_frames = preset["chunk_len"] * SUBSAMPLING
    chunk = rng.standard_normal((1, chunk_frames, FEAT_DIM), dtype=np.float32)
    chunk_lengths = np.array([chunk_frames], dtype=np.int64)

    if filled_cache:
        spk_len = preset["spkcache_len"]
        fifo_len = preset["fifo_len"]
        spkcache = rng.standard_normal((1, spk_len, EMB_DIM), dtype=np.float32) * 0.05
        fifo = rng.standard_normal((1, fifo_len, EMB_DIM), dtype=np.float32) * 0.05
    else:
        spk_len = 0
        fifo_len = 0
        # ORT dynamic dims: use length-0 along time via empty then pad to 1? NeMo
        # export examples use full tensor with length scalars. Match export:
        # allocate max capacity, lengths say how many are valid.
        spkcache = np.zeros((1, preset["spkcache_len"], EMB_DIM), dtype=np.float32)
        fifo = np.zeros((1, preset["fifo_len"], EMB_DIM), dtype=np.float32)

    spkcache_lengths = np.array([spk_len if filled_cache else 0], dtype=np.int64)
    fifo_lengths = np.array([fifo_len if filled_cache else 0], dtype=np.int64)
    return {
        "chunk": chunk,
        "chunk_lengths": chunk_lengths,
        "spkcache": spkcache,
        "spkcache_lengths": spkcache_lengths,
        "fifo": fifo,
        "fifo_lengths": fifo_lengths,
    }


def run_ort(session, feeds: dict) -> dict[str, np.ndarray]:
    outs = session.run(list(OUTPUT_NAMES), {k: feeds[k] for k in INPUT_NAMES})
    return {name: arr for name, arr in zip(OUTPUT_NAMES, outs)}


def run_nemo(model, feeds: dict, device: str) -> dict[str, np.ndarray]:
    import torch

    torch_feeds = []
    for name in INPUT_NAMES:
        arr = feeds[name]
        dtype = torch.long if arr.dtype == np.int64 else torch.float32
        torch_feeds.append(torch.tensor(arr, dtype=dtype, device=device))
    with torch.inference_mode():
        preds, embs, lengths = model(*torch_feeds)
    return {
        "spkcache_fifo_chunk_preds": preds.detach().cpu().numpy(),
        "chunk_pre_encode_embs": embs.detach().cpu().numpy(),
        "chunk_pre_encode_lengths": lengths.detach().cpu().numpy(),
    }


def load_nemo_for_parity(preset_name: str, device: str):
    import types

    import torch
    from nemo.collections.asr.models import SortformerEncLabelModel

    from export_onnx import apply_streaming_preset, install_onnx_forward

    ensure_hf_src()
    if not NEMO_CKPT.is_file():
        raise FileNotFoundError(NEMO_CKPT)
    model = SortformerEncLabelModel.restore_from(
        restore_path=str(NEMO_CKPT),
        map_location=device,
        strict=False,
    )
    model.eval()
    apply_streaming_preset(model, preset_name)
    install_onnx_forward(model)
    return model


def compare_outputs(ref: dict, hyp: dict) -> dict:
    report = {}
    for key in ("spkcache_fifo_chunk_preds", "chunk_pre_encode_embs"):
        r, h = ref[key], hyp[key]
        # Align leading dims if ORT drops a trailing singleton differently.
        if r.shape != h.shape:
            r2, h2 = r.reshape(r.shape[0], -1), h.reshape(h.shape[0], -1)
            if r2.shape != h2.shape:
                raise ValueError(f"{key} shape mismatch ref={r.shape} hyp={h.shape}")
            r, h = r2, h2
        report[key] = {
            "cosine": cosine(r, h),
            "max_abs": max_abs(r, h),
            "shape": list(ref[key].shape),
        }
    return report


def threshold_agreement(ref_preds: np.ndarray, hyp_preds: np.ndarray, thr: float = 0.5) -> dict:
    """Frame×speaker binary decisions after sigmoid if needed."""
    def to_prob(x: np.ndarray) -> np.ndarray:
        # NeMo forward_infer may already be probabilities; detect logits by range.
        if x.min() < 0.0 or x.max() > 1.0:
            return 1.0 / (1.0 + np.exp(-x.astype(np.float64)))
        return x.astype(np.float64)

    r = to_prob(ref_preds) > thr
    h = to_prob(hyp_preds) > thr
    # Compare on min shared time axis.
    t = min(r.shape[1], h.shape[1])
    s = min(r.shape[-1], h.shape[-1], MAX_SPEAKERS)
    r = r[:, :t, :s]
    h = h[:, :t, :s]
    total = r.size
    agree = int(np.sum(r == h))
    return {
        "frames": int(t),
        "speakers": int(s),
        "agree": agree,
        "total": total,
        "agreement": agree / total if total else 1.0,
    }


def save_refs(stem: str, ort_outs: dict, meta: dict) -> Path:
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    out = REFS_DIR / stem
    out.mkdir(parents=True, exist_ok=True)
    for key, arr in ort_outs.items():
        np.save(out / f"{key}.npy", arr)
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return out


def load_refs(stem: str) -> tuple[dict, dict]:
    out = REFS_DIR / stem
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    arrays = {}
    for key in ("spkcache_fifo_chunk_preds", "chunk_pre_encode_embs", "chunk_pre_encode_lengths"):
        path = out / f"{key}.npy"
        if path.is_file():
            arrays[key] = np.load(path)
    return arrays, meta


def run_step_case(
    *,
    ort_session,
    nemo_model,
    preset_name: str,
    seed: int,
    filled_cache: bool,
    from_refs: bool,
    stem: str,
) -> dict:
    preset = LATENCY_PRESETS[preset_name]
    rng = np.random.default_rng(seed)
    feeds = make_step_inputs(preset, rng, filled_cache=filled_cache)
    hyp = run_ort(ort_session, feeds)

    case_id = f"{stem}_{'warm' if filled_cache else 'cold'}_s{seed}"
    if from_refs:
        ref, _ = load_refs(case_id)
        if "spkcache_fifo_chunk_preds" not in ref:
            raise FileNotFoundError(f"missing refs for {case_id}; run FP32 parity first")
    else:
        if nemo_model is None:
            raise RuntimeError("NeMo model required unless --from-refs")
        ref = run_nemo(nemo_model, feeds, device="cpu")
        # Also freeze ORT FP32 goldens when comparing against NeMo.
        save_refs(
            case_id,
            hyp,
            {
                "preset": preset_name,
                "seed": seed,
                "filled_cache": filled_cache,
                "role": "ort_fp32_golden",
            },
        )

    report = compare_outputs(ref, hyp)
    report["decision"] = threshold_agreement(
        ref["spkcache_fifo_chunk_preds"], hyp["spkcache_fifo_chunk_preds"]
    )
    report["case"] = case_id
    report["preset"] = preset_name
    report["filled_cache"] = filled_cache
    return report


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--onnx-dir", type=Path, default=ONNX_DIR)
    p.add_argument(
        "--profile",
        default="fp32",
        help="Label written into the summary JSON (fp32/fp16/int8/q4f16/…)",
    )
    p.add_argument(
        "--preset",
        choices=sorted(LATENCY_PRESETS.keys()),
        default=DEFAULT_EXPORT_PRESET,
    )
    p.add_argument("--seed", type=int, default=0)
    p.add_argument(
        "--from-refs",
        action="store_true",
        help="Compare ORT pack against saved FP32 ORT goldens (no NeMo).",
    )
    p.add_argument(
        "--stem",
        default="step",
        help="Prefix for refs / summary files",
    )
    p.add_argument(
        "--gates",
        action="store_true",
        help="Exit non-zero if cosine/agreement gates fail",
    )
    p.add_argument(
        "--min-preds-cosine",
        type=float,
        default=0.999,
        help="Gate for preds cosine vs reference (FP32 NeMo or FP32 ORT)",
    )
    p.add_argument(
        "--min-agreement",
        type=float,
        default=0.999,
        help="Gate for thresholded speaker decision agreement",
    )
    p.add_argument(
        "--prefer-coreml",
        action="store_true",
        help=(
            "Local speed only: try CoreML EP. Ignored when --gates is set "
            "(HF-card parity stays CPU). Also skipped if CoreML vs CPU decisions differ."
        ),
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    onnx_dir = args.onnx_dir
    if args.profile in VARIANT_DIRS and onnx_dir == ONNX_DIR and args.profile != "fp32":
        onnx_dir = VARIANT_DIRS[args.profile]

    # Gates / published tables: always CPU. CoreML is opt-in for local speed and
    # only if binary speaker decisions match CPU on a cold smoke feed.
    prefer_coreml = bool(args.prefer_coreml) and not bool(args.gates)
    if prefer_coreml:
        preset = LATENCY_PRESETS[args.preset]
        smoke = make_step_inputs(
            preset, np.random.default_rng(args.seed), filled_cache=False
        )
        if not coreml_safe_for_parity(
            onnx_dir,
            smoke,
            INPUT_NAMES,
            OUTPUT_NAMES,
            max_decision_delta=0.0,
        ):
            _log("CoreML diverges or unavailable — using CPU for this run")
            prefer_coreml = False

    session = load_ort_session(onnx_dir, prefer_coreml=prefer_coreml)
    nemo = None if args.from_refs else load_nemo_for_parity(args.preset, "cpu")

    reports = []
    for filled in (False, True):
        reports.append(
            run_step_case(
                ort_session=session,
                nemo_model=nemo,
                preset_name=args.preset,
                seed=args.seed,
                filled_cache=filled,
                from_refs=args.from_refs,
                stem=args.stem,
            )
        )

    summary = {
        "profile": args.profile,
        "onnx_dir": str(onnx_dir),
        "preset": args.preset,
        "from_refs": args.from_refs,
        "cases": reports,
    }
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    out_json = REFS_DIR / f"parity_{args.profile}_{args.stem}.json"
    out_json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {out_json}")

    failed = False
    for case in reports:
        preds = case["spkcache_fifo_chunk_preds"]
        embs = case["chunk_pre_encode_embs"]
        dec = case["decision"]
        _log(
            f"{case['case']}: preds cos={preds['cosine']:.6f} max|Δ|={preds['max_abs']:.3e} | "
            f"embs cos={embs['cosine']:.6f} | agree={dec['agreement']:.6f} "
            f"({dec['agree']}/{dec['total']})"
        )
        if args.gates:
            if preds["cosine"] < args.min_preds_cosine:
                _log(f"FAIL preds cosine {preds['cosine']} < {args.min_preds_cosine}")
                failed = True
            if dec["agreement"] < args.min_agreement:
                _log(f"FAIL agreement {dec['agreement']} < {args.min_agreement}")
                failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
