#!/usr/bin/env python3
"""Rewrite ONNX external-data locations to a pack-local basename.

Hub graphs point at suffixed blobs (`vision_encoder_quantized.onnx_data`).
Packs flatten those to `vision_encoder.onnx_data` next to `vision_encoder.onnx`.
Does not load or rewrite weight bytes.
"""

from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: rewrite_onnx_external_location.py <graph.onnx> <data-basename>",
            file=sys.stderr,
        )
        return 2
    graph_path, data_basename = sys.argv[1], sys.argv[2]
    try:
        import onnx
    except ImportError as error:
        print(f"onnx is required to flatten DocVLM graphs: {error}", file=sys.stderr)
        return 1

    model = onnx.load(graph_path, load_external_data=False)
    changed = 0
    for initializer in model.graph.initializer:
        for item in initializer.external_data:
            if item.key == "location" and item.value != data_basename:
                item.value = data_basename
                changed += 1
    if changed == 0:
        print(f"{graph_path}: no external locations to rewrite")
        return 0
    onnx.save(model, graph_path)
    print(f"{graph_path}: rewrote {changed} locations → {data_basename}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
