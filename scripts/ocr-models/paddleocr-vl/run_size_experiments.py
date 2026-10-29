#!/usr/bin/env python3
"""Isolated size-cut experiments on top of the FP16 / INT8 / Q4 packs."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from paths import BUILD_ROOT, ONNX_DIR, PAGES_DIR, REFS_DIR, VARIANT_DIRS
from quantize_onnx import (
    copy_graph,
    copy_sidecars,
    load_onnx,
    normalize_external_data,
    quantize_graph_int8,
    write_manifest,
    _log,
    _release,
)

EXP_ROOT = BUILD_ROOT / "exp"
OMNIDOC = PAGES_DIR / "images" / "PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png"
PHOTO = PAGES_DIR / "images" / "meyer_page_014_warp.jpg"

EXPERIMENTS = (
    {
        "id": "e1-int8-vision",
        "profile": "int8",
        "notes": ["INT8 vision MatMul, FP16 decoder, FP32 embedding."],
    },
    {
        "id": "e2-int8-decoder",
        "profile": "int8",
        "notes": ["FP16 vision, INT8 decoder MatMul, FP32 embedding."],
    },
    {
        "id": "e3-int8-both",
        "profile": "int8",
        "notes": ["INT8 vision + INT8 decoder, embedding FP32 (default INT8 pack)."],
    },
    {
        "id": "e4-q4-decoder",
        "profile": "q4f16",
        "notes": ["FP16 vision, 4-bit decoder, FP32 embedding (default Q4F16 pack)."],
    },
    {
        "id": "e5-int8-lmhead",
        "profile": "int8",
        "notes": [
            "INT8 vision + INT8 decoder + 8-bit MatMulNBits lm_head.",
            "Embedding stays FP32.",
        ],
    },
)


def pack_bytes(pack_dir: Path) -> dict:
    files = {}
    total = 0
    for path in sorted(pack_dir.iterdir()):
        if path.suffix in {".onnx"} or path.name.endswith(".onnx_data"):
            size = path.stat().st_size
            files[path.name] = size
            total += size
    return {"total": total, "files": files}


def quantize_lm_head_only(src: Path, dst: Path) -> None:
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
    for name in ("vision_encoder.onnx", "embedding.onnx", "decoder.onnx"):
        copy_graph(src_dir / name, dst_dir / name)


def build_e1(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["fp16"], dst)
    copy_graph(ONNX_DIR / "embedding.onnx", dst / "embedding.onnx")
    quantize_graph_int8(ONNX_DIR / "vision_encoder.onnx", dst / "vision_encoder.onnx", [])
    write_manifest(dst, "e1-int8-vision", EXPERIMENTS[0]["notes"])


def build_e2(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["fp16"], dst)
    copy_graph(ONNX_DIR / "embedding.onnx", dst / "embedding.onnx")
    quantize_graph_int8(ONNX_DIR / "decoder.onnx", dst / "decoder.onnx", ["/lm_head/MatMul"])
    write_manifest(dst, "e2-int8-decoder", EXPERIMENTS[1]["notes"])


def build_e3(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["int8"], dst)
    write_manifest(dst, "e3-int8-both", EXPERIMENTS[2]["notes"])


def build_e4(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["q4f16"], dst)
    copy_graph(ONNX_DIR / "embedding.onnx", dst / "embedding.onnx")
    write_manifest(dst, "e4-q4-decoder", EXPERIMENTS[3]["notes"])


def build_e5(dst: Path) -> None:
    copy_pack(VARIANT_DIRS["int8"], dst)
    copy_graph(ONNX_DIR / "embedding.onnx", dst / "embedding.onnx")
    quantize_lm_head_only(VARIANT_DIRS["int8"] / "decoder.onnx", dst / "decoder.onnx")
    write_manifest(dst, "e5-int8-lmhead", EXPERIMENTS[4]["notes"])


BUILDERS = {
    "e1-int8-vision": build_e1,
    "e2-int8-decoder": build_e2,
    "e3-int8-both": build_e3,
    "e4-q4-decoder": build_e4,
    "e5-int8-lmhead": build_e5,
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
    parser.add_argument("--skip-photo", action="store_true")
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
                    str(OMNIDOC),
                    "--max-side",
                    "1024",
                    "--max-new-tokens",
                    "128",
                ],
            )
        photo = None
        if not args.skip_photo:
            photo = run_parity(
                dst,
                spec["profile"],
                f"{exp_id}-photo",
                "camera_warp",
                [
                    "--image",
                    str(PHOTO),
                    "--max-side",
                    "1024",
                    "--max-new-tokens",
                    "64",
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
            "photo": summarize_parity(photo) if photo else None,
        }
        report.append(row)
        _log(
            f"{exp_id} hello exact={row['hello'].get('exact')} "
            f"omnidoc coverage={None if row['omnidoc'] is None else row['omnidoc'].get('layout_coverage')} "
            f"photo coverage={None if row['photo'] is None else row['photo'].get('layout_coverage')}"
        )
    out = REFS_DIR / "size-experiments.json"
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    _log(f"wrote {out}")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
