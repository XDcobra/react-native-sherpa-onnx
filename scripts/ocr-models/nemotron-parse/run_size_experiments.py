#!/usr/bin/env python3
"""Isolated size-cut experiments on top of the existing FP16 / INT8 / Q4 packs.

Builds four packs under build/ocr-models/nemotron-3.5-parse/exp/ and runs the
same Hello World + OmniDocBench parity suite. Used to decide the HF desktop
and high-end-mobile release set — not a Hub publish.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from paths import BUILD_ROOT, ONNX_DIR, REFS_DIR, VARIANT_DIRS
from quantize_onnx import (
    copy_graph,
    copy_sidecars,
    load_onnx,
    normalize_external_data,
    quantize_graph_int8,
    save_onnx,
    write_manifest,
    _log,
    _release,
)

EXP_ROOT = BUILD_ROOT / "exp"
PAGE_IMAGE = (
    BUILD_ROOT
    / "pages"
    / "images"
    / "PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png"
)

EXPERIMENTS = (
    {
        "id": "e1-pos-fp16",
        "profile": "q4f16",
        "notes": [
            "Baseline Q4F16 pack with pos_embed.npy stored as float16.",
            "Host interpolation still casts to float32.",
        ],
    },
    {
        "id": "e2-embed-int8",
        "profile": "q4f16",
        "notes": [
            "Baseline Q4F16 pack with per-row INT8 embed_tokens Gather.",
        ],
    },
    {
        "id": "e3-lmhead-int8",
        "profile": "q4f16",
        "notes": [
            "Baseline Q4F16 pack with INT8 lm_head MatMul only.",
        ],
    },
    {
        "id": "e4-hybrid",
        "profile": "int8",
        "notes": [
            "INT8 vision + Q4 decoder + INT8 embed + INT8 lm_head + FP16 pos.",
        ],
    },
    {
        "id": "e5-int8-compact",
        "profile": "int8",
        "notes": [
            "INT8 vision + INT8 decoder + 8-bit lm_head + INT8 embed + FP16 pos.",
            "Keeps the INT8 decoder (better page-header recall than Q4).",
        ],
    },
)


def pack_bytes(pack_dir: Path) -> dict:
    files = {}
    total = 0
    for path in sorted(pack_dir.iterdir()):
        if path.suffix in {".onnx", ".npy"} or path.name.endswith(".onnx_data"):
            size = path.stat().st_size
            files[path.name] = size
            total += size
    return {"total": total, "files": files}


def write_pos_fp16(src: Path, dst: Path) -> None:
    array = np.load(src)
    np.save(dst, array.astype(np.float16, copy=False))
    _log(f"wrote {dst} ({dst.stat().st_size} bytes, was {src.stat().st_size})")


def quantize_embed_int8(src: Path, dst: Path) -> None:
    """Per-row symmetric INT8 Gather. Dequant happens after lookup, not on the table."""
    model = load_onnx(src)
    weight = None
    for init in model.graph.initializer:
        if init.name == "embed_tokens.weight":
            weight = numpy_helper.to_array(init).astype(np.float32)
            break
    if weight is None:
        raise RuntimeError("embed_tokens.weight missing")
    row_max = np.max(np.abs(weight), axis=1).astype(np.float32)
    scale = np.maximum(row_max / 127.0, 1e-8)
    quant = np.clip(np.round(weight / scale[:, None]), -127, 127).astype(np.int8)

    keep = [init for init in model.graph.initializer if init.name != "embed_tokens.weight"]
    del model.graph.initializer[:]
    model.graph.initializer.extend(keep)
    model.graph.initializer.extend(
        [
            numpy_helper.from_array(quant, name="embed_tokens.weight_int8"),
            numpy_helper.from_array(scale.astype(np.float16), name="embed_tokens.row_scale"),
        ]
    )

    gather = next(node for node in model.graph.node if node.op_type == "Gather")
    gather_out = gather.output[0]
    gather.input[0] = "embed_tokens.weight_int8"
    gather.output[0] = "embed_int8"
    model.graph.initializer.append(
        numpy_helper.from_array(np.asarray([2], dtype=np.int64), name="embed_unsq_axes")
    )
    extra = [
        helper.make_node(
            "Cast",
            ["embed_int8"],
            ["embed_int8_fp"],
            to=TensorProto.FLOAT16,
            name="embed_cast_fp16",
        ),
        helper.make_node(
            "Gather",
            ["embed_tokens.row_scale", "input_ids"],
            ["embed_row_scale"],
            name="embed_scale_gather",
        ),
        helper.make_node(
            "Unsqueeze",
            ["embed_row_scale", "embed_unsq_axes"],
            ["embed_row_scale_u"],
            name="embed_scale_unsqueeze",
        ),
        helper.make_node(
            "Mul",
            ["embed_int8_fp", "embed_row_scale_u"],
            [gather_out],
            name="embed_dequant",
        ),
    ]
    nodes = list(model.graph.node)
    g_index = next(i for i, node in enumerate(nodes) if node.name == gather.name)
    model.graph.ClearField("node")
    model.graph.node.extend(nodes[: g_index + 1] + extra + nodes[g_index + 1 :])
    save_onnx(model, dst)
    _release(model, weight, quant)


def quantize_lm_head_only(src: Path, dst: Path) -> None:
    """Weight-only 8-bit MatMulNBits on `/lm_head/MatMul`.

    `quantize_dynamic` inserts DynamicQuantizeLinear, which rejects FP16
    activations on the Q4F16 decoder. MatMulNBits stays weight-only.
    """
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
        bits=8,
    )
    _log(f"int8-nbits lm_head {src}")
    quant = MatMulNBitsQuantizer(
        model=model,
        bits=8,
        block_size=32,
        is_symmetric=True,
        accuracy_level=1,
        nodes_to_include=["/lm_head/MatMul"],
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
    normalize_external_data(dst)
    _release(model, quant)


def copy_pack(src_dir: Path, dst_dir: Path) -> None:
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True)
    copy_sidecars(src_dir, dst_dir)
    for name in (
        "patch_embed.onnx",
        "vision_encoder.onnx",
        "embed_tokens.onnx",
        "decoder_model_merged.onnx",
    ):
        copy_graph(src_dir / name, dst_dir / name)


def build_e1(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["q4f16"], dst)
    write_pos_fp16(ONNX_DIR / "pos_embed.npy", dst / "pos_embed.npy")
    write_manifest(dst, "e1-pos-fp16", EXPERIMENTS[0]["notes"])


def build_e2(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["q4f16"], dst)
    quantize_embed_int8(VARIANT_DIRS["q4f16"] / "embed_tokens.onnx", dst / "embed_tokens.onnx")
    write_manifest(dst, "e2-embed-int8", EXPERIMENTS[1]["notes"])


def build_e3(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["q4f16"], dst)
    quantize_lm_head_only(VARIANT_DIRS["q4f16"] / "decoder_model_merged.onnx", dst / "decoder_model_merged.onnx")
    write_manifest(dst, "e3-lmhead-int8", EXPERIMENTS[2]["notes"])


def build_e4(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["int8"], dst)
    copy_graph(VARIANT_DIRS["int8"] / "vision_encoder.onnx", dst / "vision_encoder.onnx")
    copy_graph(VARIANT_DIRS["int8"] / "patch_embed.onnx", dst / "patch_embed.onnx")
    quantize_embed_int8(VARIANT_DIRS["fp16"] / "embed_tokens.onnx", dst / "embed_tokens.onnx")
    decoder_src = VARIANT_DIRS["q4f16"] / "decoder_model_merged.onnx"
    quantize_lm_head_only(decoder_src, dst / "decoder_model_merged.onnx")
    write_pos_fp16(ONNX_DIR / "pos_embed.npy", dst / "pos_embed.npy")
    write_manifest(dst, "e4-hybrid", EXPERIMENTS[3]["notes"])


def build_e5(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["int8"], dst)
    quantize_embed_int8(VARIANT_DIRS["fp16"] / "embed_tokens.onnx", dst / "embed_tokens.onnx")
    quantize_lm_head_only(VARIANT_DIRS["int8"] / "decoder_model_merged.onnx", dst / "decoder_model_merged.onnx")
    write_pos_fp16(ONNX_DIR / "pos_embed.npy", dst / "pos_embed.npy")
    write_manifest(dst, "e5-int8-compact", EXPERIMENTS[4]["notes"])


BUILDERS = {
    "e1-pos-fp16": build_e1,
    "e2-embed-int8": build_e2,
    "e3-lmhead-int8": build_e3,
    "e4-hybrid": build_e4,
    "e5-int8-compact": build_e5,
}


def run_parity(pack_dir: Path, profile: str, tag: str, stem: str, extra: list[str]) -> dict:
    from test_parity import main as parity_main

    argv = [
        "--onnx-dir",
        str(pack_dir),
        "--profile",
        profile,
        "--from-refs",
        "--stem",
        stem,
        "--result-tag",
        tag,
        "--refs-dir",
        str(REFS_DIR),
        *extra,
    ]
    code = parity_main(argv)
    path = REFS_DIR / f"{stem}.{tag}.parity.json"
    payload = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    payload["exit_code"] = code
    return payload


def summarize_parity(payload: dict) -> dict:
    rows = {row["name"]: row for row in payload.get("results", [])}
    tokens = rows.get("greedy_tokens", {})
    vision = rows.get("vision_vs_hf", {})
    logits = rows.get("prefill_logits", {})
    return {
        "exit_code": payload.get("exit_code"),
        "vision_cosine": vision.get("cosine"),
        "vision_max_abs": vision.get("max_abs"),
        "logits_cosine": logits.get("cosine"),
        "exact": tokens.get("exact"),
        "prefix": tokens.get("prefix"),
        "hf_len": tokens.get("hf_len"),
        "layout_coverage": tokens.get("layout_coverage"),
        "ort_text": tokens.get("ort_text"),
        "ok": all(row.get("ok") for row in payload.get("results", [])) if payload.get("results") else False,
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only",
        nargs="+",
        choices=[row["id"] for row in EXPERIMENTS],
    )
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--skip-omnidoc", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    wanted = args.only or [row["id"] for row in EXPERIMENTS]
    EXP_ROOT.mkdir(parents=True, exist_ok=True)
    report = []
    for spec in EXPERIMENTS:
        exp_id = spec["id"]
        if exp_id not in wanted:
            continue
        dst = EXP_ROOT / exp_id
        if not args.skip_build:
            _log(f"building {exp_id} -> {dst}")
            BUILDERS[exp_id](dst)
        sizes = pack_bytes(dst)
        _log(f"{exp_id} size={sizes['total'] / 1e6:.1f} MB")
        hello = run_parity(
            dst,
            spec["profile"],
            f"{exp_id}-hello",
            "hello_world",
            ["--fixture", "hello", "--max-new-tokens", "16"],
        )
        page = None
        if not args.skip_omnidoc:
            page = run_parity(
                dst,
                spec["profile"],
                f"{exp_id}-omnidoc",
                "omnidoc_meyer_ch2_p014",
                [
                    "--image",
                    str(PAGE_IMAGE),
                    "--max-side",
                    "1024",
                    "--max-new-tokens",
                    "128",
                ],
            )
        row = {
            "id": exp_id,
            "dir": str(dst),
            "profile": spec["profile"],
            "bytes": sizes["total"],
            "mb": round(sizes["total"] / 1e6, 1),
            "files": {name: round(size / 1e6, 1) for name, size in sizes["files"].items()},
            "hello": summarize_parity(hello),
            "omnidoc": summarize_parity(page) if page else None,
        }
        report.append(row)
        _log(
            f"{exp_id} hello exact={row['hello'].get('exact')} "
            f"omnidoc coverage={None if row['omnidoc'] is None else row['omnidoc'].get('layout_coverage')}"
        )
    out = REFS_DIR / "size-experiments.json"
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {out}")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
