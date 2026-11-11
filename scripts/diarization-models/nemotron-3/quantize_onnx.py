#!/usr/bin/env python3
"""Quantize the Nemotron-3 diarization FP32 Sortformer ONNX pack.

Variants (same graph name `model.onnx`, different weights):

  onnx-fp16   weight/compute FP16; graph I/O stay float32
  onnx-int8   dynamic INT8 MatMul (weights)
  onnx-q4f16  4-bit MatMulNBits on an FP16 parent

Parity (`test_parity.py`) decides which cuts ship. Do not publish a cut that
fails streaming frame agreement gates.
"""

from __future__ import annotations

import argparse
import gc
import json
import shutil
import sys
from pathlib import Path

import onnx
from onnx.external_data_helper import convert_model_to_external_data

from constants import GRAPH_FILE, LICENSE_FILE, MANIFEST_FILE, METADATA_FILE, MODEL_ID
from paths import ONNX_DIR, VARIANT_DIRS


def _log(msg: str) -> None:
    print(f"[quantize] {msg}", flush=True)


def _release(*objects) -> None:
    for obj in objects:
        del obj
    gc.collect()


def load_onnx(path: Path) -> onnx.ModelProto:
    if not path.is_file():
        raise FileNotFoundError(path)
    _log(f"load {path}")
    return onnx.load(str(path), load_external_data=True)


def save_onnx(model: onnx.ModelProto, path: Path, *, external: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    data_path = Path(str(path) + "_data")
    if data_path.exists():
        data_path.unlink()
    if external:
        convert_model_to_external_data(
            model,
            all_tensors_to_one_file=True,
            location=data_path.name,
            size_threshold=1024,
            convert_attribute=False,
        )
    onnx.save(model, str(path))
    _log(f"save {path} ({path.stat().st_size} bytes)")


def copy_sidecars(src: Path, dst: Path) -> None:
    for name in (METADATA_FILE, LICENSE_FILE):
        s = src / name
        if s.is_file():
            shutil.copy2(s, dst / name)


def write_manifest(out_dir: Path, variant: str, notes: list[str]) -> None:
    onnx_path = out_dir / GRAPH_FILE
    data_path = Path(str(onnx_path) + "_data")
    total = onnx_path.stat().st_size if onnx_path.is_file() else 0
    if data_path.is_file():
        total += data_path.stat().st_size
    payload = {
        "schema": 1,
        "family": "nemotron3_diarization",
        "id": MODEL_ID,
        "variant": variant,
        "onnx": GRAPH_FILE,
        "bytes": total,
        "notes": notes,
    }
    (out_dir / MANIFEST_FILE).write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


def quantize_fp16(src: Path, dst: Path) -> None:
    from onnxruntime.transformers.float16 import convert_float_to_float16

    model = load_onnx(src / GRAPH_FILE)
    converted = convert_float_to_float16(
        model,
        keep_io_types=True,
        disable_shape_infer=False,
    )
    _release(model)
    save_onnx(converted, dst / GRAPH_FILE, external=True)
    _release(converted)
    copy_sidecars(src, dst)
    write_manifest(
        dst,
        "fp16",
        [
            "FP16 weights/compute; I/O remain float32.",
            "Candidate for high-end desktop / GPU EP packs.",
        ],
    )


def quantize_int8(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    tmp = dst / "_tmp_int8.onnx"
    if tmp.exists():
        tmp.unlink()
    _log(f"int8 dynamic MatMul {src / GRAPH_FILE}")
    quantize_dynamic(
        model_input=str(src / GRAPH_FILE),
        model_output=str(tmp),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul"],
        per_channel=True,
        reduce_range=False,
        extra_options={"WeightSymmetric": True},
    )
    model = load_onnx(tmp)
    save_onnx(model, dst / GRAPH_FILE, external=True)
    _release(model)
    tmp.unlink(missing_ok=True)
    data_tmp = Path(str(tmp) + "_data")
    data_tmp.unlink(missing_ok=True)
    copy_sidecars(src, dst)
    write_manifest(
        dst,
        "int8",
        [
            "Dynamic per-channel INT8 MatMul weights.",
            "Primary mobile / high-end-on-device candidate.",
        ],
    )


def quantize_q4f16(src_fp16: Path, dst: Path) -> None:
    from onnxruntime.quantization.matmul_nbits_quantizer import (
        DefaultWeightOnlyQuantConfig,
        MatMulNBitsQuantizer,
    )
    from onnxruntime.quantization.quant_utils import QuantFormat

    model = load_onnx(src_fp16 / GRAPH_FILE)
    config = DefaultWeightOnlyQuantConfig(
        block_size=32,
        is_symmetric=True,
        accuracy_level=1,
        quant_format=QuantFormat.QOperator,
        bits=4,
    )
    quant = MatMulNBitsQuantizer(
        model=model,
        bits=4,
        block_size=32,
        is_symmetric=True,
        accuracy_level=1,
        algo_config=config,
    )
    quant.process()
    save_onnx(quant.model.model, dst / GRAPH_FILE, external=True)
    _release(model, quant)
    copy_sidecars(src_fp16, dst)
    write_manifest(
        dst,
        "q4f16",
        [
            "4-bit MatMulNBits on FP16 parent.",
            "Often rejected by parity — keep only if frame agreement holds.",
        ],
    )


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--variant",
        choices=["fp16", "int8", "q4f16", "all"],
        default="all",
    )
    p.add_argument("--src", type=Path, default=ONNX_DIR)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    src = args.src
    if not (src / GRAPH_FILE).is_file():
        raise FileNotFoundError(f"missing {src / GRAPH_FILE}; run export_onnx.py first")

    variants = ["fp16", "int8", "q4f16"] if args.variant == "all" else [args.variant]
    for name in variants:
        out = VARIANT_DIRS[name]
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        _log(f"=== {name} → {out} ===")
        if name == "fp16":
            quantize_fp16(src, out)
        elif name == "int8":
            quantize_int8(src, out)
        elif name == "q4f16":
            fp16 = VARIANT_DIRS["fp16"]
            if not (fp16 / GRAPH_FILE).is_file():
                quantize_fp16(src, fp16)
            quantize_q4f16(fp16, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
