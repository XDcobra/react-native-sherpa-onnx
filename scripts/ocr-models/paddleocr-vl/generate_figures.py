#!/usr/bin/env python3
"""Pillow PNG charts for the Hugging Face model card (no mermaid/SVG)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from paths import REFS_DIR, SCRIPT_DIR, VARIANT_DIRS

FIGURES = SCRIPT_DIR / "figures"
BG = (248, 249, 251)
INK = (28, 32, 38)
MUTED = (90, 98, 110)
ACCENT = (36, 99, 168)
BAR = (56, 132, 214)
BAR2 = (46, 160, 120)
BAR3 = (196, 92, 62)
GRID = (220, 224, 230)


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    names = (
        ("Arial Bold.ttf", "Helvetica.ttc", "DejaVuSans-Bold.ttf")
        if bold
        else ("Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf")
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def pack_mb(pack_dir: Path) -> float:
    total = 0
    if not pack_dir.is_dir():
        return 0.0
    for path in pack_dir.iterdir():
        if path.suffix == ".onnx" or path.name.endswith(".onnx_data"):
            total += path.stat().st_size
    return total / 1e6


def _bar_chart(path: Path, title: str, labels: list[str], values: list[float], unit: str, colors: list[tuple[int, int, int]]):
    width, height = 1100, 560
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    title_font = _font(28, bold=True)
    axis_font = _font(16)
    label_font = _font(15)
    draw.text((40, 24), title, fill=INK, font=title_font)
    plot = (80, 90, width - 40, height - 90)
    draw.rectangle(plot, outline=GRID)
    max_val = max(values) * 1.15 if values else 1.0
    n = max(len(labels), 1)
    gap = 28
    bar_w = max(24, int((plot[2] - plot[0] - gap * (n + 1)) / n))
    for i, (label, value, color) in enumerate(zip(labels, values, colors)):
        x = plot[0] + gap + i * (bar_w + gap)
        bar_h = int((plot[3] - plot[1] - 8) * (value / max_val))
        y = plot[3] - bar_h
        draw.rectangle((x, y, x + bar_w, plot[3] - 1), fill=color)
        caption = f"{value:.2f}{unit}" if unit == "" else f"{value:.1f} {unit}"
        if unit == "%" or unit == "":
            caption = f"{value:.3f}" if unit == "" and value <= 1 else caption
        draw.text((x, y - 24), caption, fill=INK, font=axis_font)
        draw.text((x, plot[3] + 12), label, fill=MUTED, font=label_font)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    print(f"[figures] wrote {path}")


def coverage_from_parity(path: Path) -> float | None:
    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    for row in payload.get("results", []):
        if row.get("name") == "greedy_tokens":
            return float(row.get("layout_coverage") or 0.0)
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=FIGURES)
    args = parser.parse_args(argv or sys.argv[1:])
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    sizes = []
    size_labels = []
    size_colors = []
    for name, color in (
        ("fp32", (120, 128, 140)),
        ("fp16", BAR),
    ):
        mb = pack_mb(VARIANT_DIRS[name])
        if mb > 0:
            size_labels.append(name.upper())
            sizes.append(mb)
            size_colors.append(color)
    _bar_chart(out / "pack-size.png", "Published pack size (ONNX + weights)", size_labels, sizes, "MB", size_colors)

    fixtures = (
        ("Hello", "hello_world"),
        ("OmniDoc", "omnidoc_meyer_ch2_p014"),
        ("Photo", "camera_warp"),
    )
    # Prefer fp16 coverage; fall back to fp32.
    cov_labels = [row[0] for row in fixtures]
    cov_values = []
    for _, stem in fixtures:
        value = coverage_from_parity(REFS_DIR / f"{stem}.fp16.parity.json")
        if value is None:
            value = coverage_from_parity(REFS_DIR / f"{stem}.parity.json")
        cov_values.append(0.0 if value is None else value)
    _bar_chart(
        out / "layout-coverage.png",
        "Layout coverage (reference words recovered)",
        cov_labels,
        cov_values,
        "",
        [BAR, BAR2, ACCENT],
    )

    exp_path = REFS_DIR / "size-experiments.json"
    if exp_path.is_file():
        report = json.loads(exp_path.read_text(encoding="utf-8"))
        labels = [row["id"].split("-", 1)[0] for row in report]
        values = [float(row.get("mb") or 0) for row in report]
        colors = [BAR] * len(labels)
        _bar_chart(out / "experiment-size.png", "Size-cut experiment packs", labels, values, "MB", colors)
    else:
        print(f"[figures] skip experiment-size.png (missing {exp_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
