#!/usr/bin/env python3
"""Quantize the local Nemotron-3.5-Parse FP32 ONNX pack.

Variants (same graph names, different weights):

  onnx-fp16    weight/compute FP16; graph I/O stay float32
  onnx-int8    dynamic INT8 MatMul on vision + decoder; embeddings/neck/lm_head stay FP16
  onnx-q4f16   4-bit MatMulNBits on FP16 vision + decoder; embeddings/neck/lm_head stay FP16

NaViT `pos_embed.npy` stays FP32 (host interpolation). LayerNorm stays FP32
inside the FP16 conversion so the neck and decoder norms do not collapse.
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

from constants import (
    DECODER_WIDTH,
    HEAD_DIM,
    HF_REPO,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    PATCH_SIZE,
    VISION_WIDTH,
)
from paths import ONNX_DIR, VARIANT_DIRS

GRAPH_FILES = (
    "patch_embed.onnx",
    "vision_encoder.onnx",
    "embed_tokens.onnx",
    "decoder_model_merged.onnx",
)
SIDECARS = (
    "pos_embed.npy",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "preprocessor_config.json",
    "processor_config.json",
    "generation_config.json",
    "config.json",
    "chat_template.jinja",
    "LICENSE",
)

# First-layer projection and token table stay out of INT8 / Q4.
HIGH_PREC_GRAPHS = ("patch_embed.onnx", "embed_tokens.onnx")
DECODER_EXCLUDE = ["/lm_head/MatMul"]
# Uniform / MLP-only 4-bit on C-RADIO drops encoder cosine to ~0.87–0.91
# and flips bbox tokens. The Q4F16 pack therefore keeps the vision graph
# in FP16 and only 4-bit-quantizes the decoder.
VISION_INT8_EXCLUDE: list[str] = []


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


def save_onnx(model: onnx.ModelProto, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data_path = Path(str(path) + "_data")
    if path.exists():
        path.unlink()
    if data_path.exists():
        data_path.unlink()
    convert_model_to_external_data(
        model,
        all_tensors_to_one_file=True,
        location=data_path.name,
        size_threshold=1024,
        convert_attribute=False,
    )
    onnx.save(model, str(path))
    size = path.stat().st_size
    extra = data_path.stat().st_size if data_path.exists() else 0
    _log(f"wrote {path} ({size} + {extra} bytes)")


def graph_ready(path: Path) -> bool:
    data = Path(str(path) + "_data")
    alt = path.with_suffix(".onnx.data")
    return path.is_file() and (data.is_file() or alt.is_file() or path.stat().st_size > 1024)


def normalize_external_data(path: Path) -> None:
    """Force Hub-style `*.onnx_data` next to the graph (ORT may write `*.onnx.data`)."""
    target = Path(str(path) + "_data")
    model = onnx.load(str(path), load_external_data=False)
    current = None
    for initializer in model.graph.initializer:
        for item in initializer.external_data:
            if item.key == "location":
                current = item.value
                break
        if current:
            break
    if not current:
        return
    src = path.parent / current
    if src != target and src.is_file():
        if target.exists():
            target.unlink()
        src.rename(target)
    changed = 0
    for initializer in model.graph.initializer:
        for item in initializer.external_data:
            if item.key == "location" and item.value != target.name:
                item.value = target.name
                changed += 1
    if changed:
        onnx.save(model, str(path))
        _log(f"normalized {path.name} -> {target.name} ({changed} tensors)")
    _release(model)


def copy_sidecars(src_dir: Path, dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in SIDECARS:
        src = src_dir / name
        if src.is_file():
            shutil.copy2(src, dst_dir / name)


def write_manifest(out_dir: Path, dtype: str, notes: list[str]) -> None:
    manifest = {
        "schema": 1,
        "family": "nemotron_parse",
        "id": f"nemotron-3.5-parse-{dtype}",
        "arch": "nemotron_parse",
        "onnx_dtype": dtype,
        "source": {"repo": HF_REPO, "revision": "main"},
        "files": {
            "patch_embed": "patch_embed.onnx",
            "vision_encoder": "vision_encoder.onnx",
            "pos_embed": "pos_embed.npy",
            "embed_tokens": "embed_tokens.onnx",
            "decoder": "decoder_model_merged.onnx",
            "tokenizer": "tokenizer.json",
            "preprocessor_config": "preprocessor_config.json",
        },
        "vision": {
            "patch_size": PATCH_SIZE,
            "hidden_size": VISION_WIDTH,
            "decoder_width": DECODER_WIDTH,
            "navit": "host",
        },
        "decoder": {
            "num_layers": NUM_DECODER_LAYERS,
            "num_kv_heads": NUM_KV_HEADS,
            "head_dim": HEAD_DIM,
        },
        "notes": notes,
    }
    path = out_dir / "ocr_manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {path}")


def convert_graph_fp16(src: Path, dst: Path, force_initializers: bool) -> None:
    from onnxruntime.transformers.float16 import convert_float_to_float16

    model = load_onnx(src)
    # Do not block LayerNormalization: incoming activations are FP16, so LN
    # scale/bias must convert with them or ORT rejects the mixed T binding.
    converted = convert_float_to_float16(
        model,
        keep_io_types=True,
        disable_shape_infer=True,
        force_fp16_initializers=force_initializers,
    )
    save_onnx(converted, dst)
    _release(model, converted)


def quantize_graph_int8(src: Path, dst: Path, nodes_to_exclude: list[str]) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dst.parent.mkdir(parents=True, exist_ok=True)
    data_path = Path(str(dst) + "_data")
    if dst.exists():
        dst.unlink()
    if data_path.exists():
        data_path.unlink()
    _log(f"int8 {src.name} exclude={nodes_to_exclude}")
    quantize_dynamic(
        str(src),
        str(dst),
        op_types_to_quantize=["MatMul"],
        per_channel=True,
        weight_type=QuantType.QInt8,
        nodes_to_exclude=list(nodes_to_exclude),
        use_external_data_format=True,
        extra_options={"MatMulConstBOnly": True},
    )
    extra = data_path.stat().st_size if data_path.exists() else 0
    _log(f"wrote {dst} ({dst.stat().st_size} + {extra} bytes)")
    normalize_external_data(dst)


def quantize_graph_q4f16(src: Path, dst: Path, nodes_to_exclude: list[str]) -> None:
    from onnxruntime.quantization.matmul_nbits_quantizer import (
        DefaultWeightOnlyQuantConfig,
        MatMulNBitsQuantizer,
    )
    from onnxruntime.quantization.quant_utils import QuantFormat

    model = load_onnx(src)
    config = DefaultWeightOnlyQuantConfig(
        block_size=32,
        is_symmetric=True,
        accuracy_level=1,
        quant_format=QuantFormat.QOperator,
        bits=4,
    )
    _log(f"q4f16 {src.name} exclude={nodes_to_exclude}")
    quant = MatMulNBitsQuantizer(
        model=model,
        bits=4,
        block_size=32,
        is_symmetric=True,
        accuracy_level=1,
        nodes_to_exclude=list(nodes_to_exclude),
        algo_config=config,
    )
    quant.process()
    dst.parent.mkdir(parents=True, exist_ok=True)
    data_path = Path(str(dst) + "_data")
    if dst.exists():
        dst.unlink()
    if data_path.exists():
        data_path.unlink()
    quant.model.save_model_to_file(str(dst), True)
    extra = data_path.stat().st_size if data_path.exists() else 0
    _log(f"wrote {dst} ({dst.stat().st_size} + {extra} bytes)")
    normalize_external_data(dst)
    _release(model, quant)


def copy_graph(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    src_data = Path(str(src) + "_data")
    dst_data = Path(str(dst) + "_data")
    if src_data.is_file():
        shutil.copy2(src_data, dst_data)
    _log(f"copied {src.name}")


def build_fp16(src_dir: Path, dst_dir: Path, skip_existing: bool) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in GRAPH_FILES:
        dst = dst_dir / name
        if skip_existing and graph_ready(dst):
            _log(f"skip existing {dst}")
            continue
        convert_graph_fp16(
            src_dir / name,
            dst,
            force_initializers=name in HIGH_PREC_GRAPHS,
        )
    copy_sidecars(src_dir, dst_dir)
    write_manifest(
        dst_dir,
        "fp16",
        [
            "NaViT positional interpolation runs in host code (navit_pos.py).",
            "Weights, LayerNorm, and MatMul compute are FP16; graph I/O stay float32.",
            "pos_embed.npy stays FP32 for host NaViT interpolation.",
        ],
    )


def build_int8(src_dir: Path, fp16_dir: Path, dst_dir: Path, skip_existing: bool) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in HIGH_PREC_GRAPHS:
        dst = dst_dir / name
        if skip_existing and graph_ready(dst):
            _log(f"skip existing {dst}")
            continue
        copy_graph(fp16_dir / name, dst)
    vision_dst = dst_dir / "vision_encoder.onnx"
    if not (skip_existing and graph_ready(vision_dst)):
        quantize_graph_int8(src_dir / "vision_encoder.onnx", vision_dst, VISION_INT8_EXCLUDE)
    else:
        _log(f"skip existing {vision_dst}")
    decoder_dst = dst_dir / "decoder_model_merged.onnx"
    if not (skip_existing and graph_ready(decoder_dst)):
        quantize_graph_int8(src_dir / "decoder_model_merged.onnx", decoder_dst, DECODER_EXCLUDE)
    else:
        _log(f"skip existing {decoder_dst}")
    copy_sidecars(src_dir, dst_dir)
    write_manifest(
        dst_dir,
        "int8",
        [
            "Dynamic INT8 on vision/decoder MatMul with constant B (ORT quantize_dynamic).",
            "patch_embed, embed_tokens, lm_head, neck Conv/Gemm stay FP16.",
            "pos_embed.npy stays FP32 for host NaViT interpolation.",
        ],
    )


def build_q4f16(fp16_dir: Path, dst_dir: Path, skip_existing: bool) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in HIGH_PREC_GRAPHS:
        dst = dst_dir / name
        if skip_existing and graph_ready(dst):
            _log(f"skip existing {dst}")
            continue
        copy_graph(fp16_dir / name, dst)
    vision_dst = dst_dir / "vision_encoder.onnx"
    if not (skip_existing and graph_ready(vision_dst)):
        copy_graph(fp16_dir / "vision_encoder.onnx", vision_dst)
    else:
        _log(f"skip existing {vision_dst}")
    decoder_dst = dst_dir / "decoder_model_merged.onnx"
    if not (skip_existing and graph_ready(decoder_dst)):
        quantize_graph_q4f16(fp16_dir / "decoder_model_merged.onnx", decoder_dst, DECODER_EXCLUDE)
    else:
        _log(f"skip existing {decoder_dst}")
    copy_sidecars(fp16_dir, dst_dir)
    write_manifest(
        dst_dir,
        "q4f16",
        [
            "MatMulNBits 4-bit (block 32, default) on the FP16 decoder only.",
            "accuracy_level=1 keeps MatMulNBits accumulation in FP32.",
            "Vision encoder stays FP16: 4-bit ViT failed encoder/token parity.",
            "patch_embed, embed_tokens, and lm_head stay FP16.",
            "pos_embed.npy stays FP32 for host NaViT interpolation.",
        ],
    )


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src-dir", type=Path, default=ONNX_DIR)
    parser.add_argument(
        "--variant",
        choices=("all", "fp16", "int8", "q4f16"),
        default="all",
    )
    parser.add_argument("--skip-existing", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    src_dir = args.src_dir
    if not (src_dir / "decoder_model_merged.onnx").is_file():
        raise FileNotFoundError(f"FP32 pack missing at {src_dir}")
    variants = ("fp16", "int8", "q4f16") if args.variant == "all" else (args.variant,)
    fp16_dir = VARIANT_DIRS["fp16"]
    if "fp16" in variants or "int8" in variants or "q4f16" in variants:
        if "fp16" in variants or not graph_ready(fp16_dir / "decoder_model_merged.onnx"):
            _log(f"building fp16 -> {fp16_dir}")
            build_fp16(src_dir, fp16_dir, args.skip_existing)
    if "int8" in variants:
        _log(f"building int8 -> {VARIANT_DIRS['int8']}")
        build_int8(src_dir, fp16_dir, VARIANT_DIRS["int8"], args.skip_existing)
    if "q4f16" in variants:
        _log(f"building q4f16 -> {VARIANT_DIRS['q4f16']}")
        build_q4f16(fp16_dir, VARIANT_DIRS["q4f16"], args.skip_existing)
    _log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
