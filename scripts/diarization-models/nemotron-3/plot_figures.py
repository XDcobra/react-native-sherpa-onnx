#!/usr/bin/env python3
"""Render HF-card figures from experiment_results.json + latency matrix.

Outputs (committed under scripts/.../figures/ after a real run):

  pack-size.png            published / candidate pack sizes
  experiment-size.png      e1–e3 sizes with pass/fail color
  parity-agreement.png     cold-start thresholded agreement bars
  latency-matrix.png       pack × latency-preset preds-cosine heatmap
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from paths import BUILD_ROOT, FIGURES_DIR, VARIANT_DIRS


def _log(msg: str) -> None:
    print(f"[figures] {msg}", flush=True)


def load_results(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(
            f"missing {path}; run run_size_experiments.py first"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def load_latency_matrix(path: Path) -> dict | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def pack_total_bytes(pack_dir: Path) -> int:
    total = 0
    if not pack_dir.is_dir():
        return 0
    for path in pack_dir.iterdir():
        if path.suffix == ".onnx" or path.name.endswith(".onnx_data"):
            total += path.stat().st_size
    return total


def plot_pack_size(ax, variants: dict[str, int]) -> None:
    labels = list(variants.keys())
    sizes = [variants[k] / 1e6 for k in labels]
    bars = ax.bar(labels, sizes, color="#2F6F8F")
    ax.set_ylabel("Size (MB)")
    ax.set_title("Nemotron-3 Diarization ONNX pack size")
    for bar, size in zip(bars, sizes):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height(),
            f"{size:.0f}",
            ha="center",
            va="bottom",
            fontsize=9,
        )


def plot_experiments(ax, experiments: list[dict]) -> None:
    labels = [e["id"] for e in experiments]
    sizes = [e.get("size", {}).get("total", 0) / 1e6 for e in experiments]
    colors = ["#2A9D8F" if e.get("passed") else "#E76F51" for e in experiments]
    bars = ax.bar(labels, sizes, color=colors)
    ax.set_ylabel("Size (MB)")
    ax.set_title("Size-cut experiments (green=pass / red=fail)")
    for bar, size in zip(bars, sizes):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height(),
            f"{size:.0f}",
            ha="center",
            va="bottom",
            fontsize=9,
        )
    ax.tick_params(axis="x", rotation=20)


def plot_agreement(ax, experiments: list[dict]) -> None:
    labels = []
    values = []
    colors = []
    for e in experiments:
        cold = next(
            (c for c in e.get("cases", []) if "cold" in c.get("case", "")),
            None,
        )
        if not cold:
            continue
        labels.append(e["id"])
        values.append(cold["decision"]["agreement"] * 100.0)
        colors.append("#2A9D8F" if e.get("passed") else "#E76F51")
    bars = ax.bar(labels, values, color=colors)
    ax.set_ylabel("Agreement (%)")
    ax.set_ylim(90, 100.5)
    ax.set_title("Cold-start thresholded speaker agreement vs FP32 ORT")
    for bar, val in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height(),
            f"{val:.3f}",
            ha="center",
            va="bottom",
            fontsize=8,
        )
    ax.tick_params(axis="x", rotation=20)


def plot_latency_matrix(ax, rows: list[dict]) -> None:
    packs = []
    presets = []
    for row in rows:
        if row["pack"] not in packs:
            packs.append(row["pack"])
        if row["preset"] not in presets:
            presets.append(row["preset"])
    grid = np.full((len(packs), len(presets)), np.nan, dtype=np.float64)
    pass_grid = np.zeros((len(packs), len(presets)), dtype=bool)
    for row in rows:
        i = packs.index(row["pack"])
        j = presets.index(row["preset"])
        cos = row.get("cold_preds_cos")
        grid[i, j] = float("nan") if cos is None else float(cos)
        pass_grid[i, j] = bool(row.get("passed"))

    im = ax.imshow(grid, vmin=0.95, vmax=1.0, cmap="RdYlGn", aspect="auto")
    ax.set_xticks(range(len(presets)))
    ax.set_xticklabels(
        [p.replace("_", "\n") for p in presets], fontsize=8
    )
    ax.set_yticks(range(len(packs)))
    ax.set_yticklabels(packs)
    ax.set_title("Latency preset × pack (cold preds cosine vs FP32)")
    for i in range(len(packs)):
        for j in range(len(presets)):
            val = grid[i, j]
            if np.isnan(val):
                text = "n/a"
            else:
                mark = "✓" if pass_grid[i, j] else "✗"
                text = f"{val:.4f}\n{mark}"
            ax.text(j, i, text, ha="center", va="center", fontsize=7, color="black")
    fig = ax.figure
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--results",
        type=Path,
        default=BUILD_ROOT / "experiment_results.json",
    )
    p.add_argument(
        "--latency-matrix",
        type=Path,
        default=BUILD_ROOT / "latency_matrix.json",
    )
    p.add_argument("--out-dir", type=Path, default=FIGURES_DIR)
    return p.parse_args(argv)


def main(argv=None) -> int:
    import matplotlib.pyplot as plt

    args = parse_args(argv or sys.argv[1:])
    data = load_results(args.results)
    experiments = data.get("experiments", [])
    args.out_dir.mkdir(parents=True, exist_ok=True)

    variant_sizes = {
        name: pack_total_bytes(path)
        for name, path in VARIANT_DIRS.items()
        if pack_total_bytes(path) > 0
    }
    # Prefer experiment packs if variant dirs empty.
    if not variant_sizes:
        variant_sizes = {
            e["id"]: e.get("size", {}).get("total", 0) for e in experiments
        }

    fig, ax = plt.subplots(figsize=(6.5, 3.8))
    plot_pack_size(ax, variant_sizes)
    fig.tight_layout()
    out = args.out_dir / "pack-size.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    _log(f"wrote {out}")

    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    plot_experiments(ax, experiments)
    fig.tight_layout()
    out = args.out_dir / "experiment-size.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    _log(f"wrote {out}")

    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    plot_agreement(ax, experiments)
    fig.tight_layout()
    out = args.out_dir / "parity-agreement.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    _log(f"wrote {out}")

    latency = load_latency_matrix(args.latency_matrix)
    if latency and latency.get("rows"):
        fig, ax = plt.subplots(figsize=(8.2, 3.6))
        plot_latency_matrix(ax, latency["rows"])
        fig.tight_layout()
        out = args.out_dir / "latency-matrix.png"
        fig.savefig(out, dpi=140)
        plt.close(fig)
        _log(f"wrote {out}")
    else:
        _log(f"skip latency-matrix.png (missing {args.latency_matrix})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
