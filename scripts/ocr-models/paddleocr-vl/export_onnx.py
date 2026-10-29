#!/usr/bin/env python3
"""Export PaddleOCR-VL-1.6 to three ONNX Runtime graphs (FP32).

Graphs:
  vision_encoder.onnx  NaViT + projector (pixel_values, image_grid_thw)
  embedding.onnx       token table
  decoder.onnx         18-layer ERNIE-4.5 with KV cache

Uses torch.onnx.export(..., dynamo=True), opset 21 so NaViT Resize stays
dynamic. TorchScript bakes one page size into the vision graph.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import torch
from torch import nn

from constants import (
    DECODER_WIDTH,
    HEAD_DIM,
    HF_REPO,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    PATCH_SIZE,
    SPATIAL_MERGE,
    VISION_HIDDEN,
)
from patch_hf_src import apply_causal_mask_patch
from paths import HF_SRC, ONNX_DIR, ensure_hf_src_on_path
from wrappers import (
    DecoderONNX,
    EmbedTokensONNX,
    VisionEncoderONNX,
    decoder_input_names,
    decoder_output_names,
    empty_past,
)

OPSET = 21


def _save_onnx(
    model: nn.Module,
    path: Path,
    inputs: tuple,
    input_names,
    output_names,
    dynamic_axes=None,
    dynamic_shapes=None,
):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.onnx")
    if tmp.exists():
        tmp.unlink()
    data_tmp = Path(str(tmp) + "_data")
    if data_tmp.exists():
        data_tmp.unlink()

    model.eval()
    print(f"[export] dynamo export {path.name} opset={OPSET}", flush=True)
    kwargs = {
        "input_names": list(input_names),
        "output_names": list(output_names),
        "opset_version": OPSET,
        "dynamo": True,
        "external_data": True,
    }
    if dynamic_shapes is not None:
        kwargs["dynamic_shapes"] = dynamic_shapes
    elif dynamic_axes is not None:
        kwargs["dynamic_axes"] = dynamic_axes
    torch.onnx.export(model, inputs, str(tmp), **kwargs)

    import onnx
    from onnx.external_data_helper import convert_model_to_external_data

    loaded = onnx.load(str(tmp), load_external_data=True)
    onnx.checker.check_model(loaded, full_check=False)
    final_data = Path(str(path) + "_data")
    if path.exists():
        path.unlink()
    if final_data.exists():
        final_data.unlink()
    convert_model_to_external_data(
        loaded,
        all_tensors_to_one_file=True,
        location=final_data.name,
        size_threshold=1024,
        convert_attribute=False,
    )
    onnx.save(loaded, str(path))
    if tmp.exists():
        tmp.unlink()
    if data_tmp.exists():
        data_tmp.unlink()
    extra = final_data.stat().st_size if final_data.exists() else 0
    print(f"[export] wrote {path} ({path.stat().st_size} + {extra} bytes)", flush=True)


def load_hf_model(dtype: torch.dtype = torch.float32, device: str = "cpu"):
    ensure_hf_src_on_path()
    apply_causal_mask_patch()
    from transformers import AutoModelForCausalLM

    print(f"[export] loading {HF_SRC} dtype={dtype} device={device}", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(HF_SRC),
        trust_remote_code=True,
        dtype=dtype,
        local_files_only=True,
        attn_implementation="eager",
    )
    model = model.to(device).eval()
    if hasattr(model.visual, "config"):
        model.visual.config._attn_implementation = "eager"
    return model


def export_vision(model, out_dir: Path, dtype: torch.dtype):
    wrapper = VisionEncoderONNX(model).to(dtype=dtype).eval()
    t, h, w = 1, 16, 16
    num_patches = t * h * w
    pixel_values = torch.zeros(1, num_patches, 3, PATCH_SIZE, PATCH_SIZE, dtype=dtype)
    image_grid_thw = torch.tensor([[t, h, w]], dtype=torch.int64)
    _save_onnx(
        wrapper,
        out_dir / "vision_encoder.onnx",
        (pixel_values, image_grid_thw),
        ["pixel_values", "image_grid_thw"],
        ["image_embeds"],
        {
            "pixel_values": {1: "num_patches"},
            "image_embeds": {0: "image_tokens"},
        },
    )


def export_embed(model, out_dir: Path, dtype: torch.dtype):
    wrapper = EmbedTokensONNX(model).to(dtype=dtype).eval()
    input_ids = torch.zeros(1, 8, dtype=torch.int64)
    _save_onnx(
        wrapper,
        out_dir / "embedding.onnx",
        (input_ids,),
        ["input_ids"],
        ["embeddings"],
        {"input_ids": {0: "batch", 1: "seq"}, "embeddings": {0: "batch", 1: "seq"}},
    )


def export_decoder(model, out_dir: Path, dtype: torch.dtype):
    wrapper = DecoderONNX(model).to(dtype=dtype).eval()
    batch, seq, past_len = 1, 4, 1
    inputs_embeds = torch.zeros(batch, seq, DECODER_WIDTH, dtype=dtype)
    attention_mask = torch.ones(batch, past_len + seq, dtype=dtype)
    position_ids = torch.arange(seq, dtype=torch.int64).view(1, 1, -1).expand(3, batch, -1).contiguous()
    past = empty_past(batch=batch, past_len=past_len, dtype=dtype)
    _save_onnx(
        wrapper,
        out_dir / "decoder.onnx",
        (inputs_embeds, attention_mask, position_ids, *past),
        decoder_input_names(),
        decoder_output_names(),
        dynamic_shapes=_decoder_dynamic_shapes(),
    )


def _decoder_dynamic_shapes():
    """Match DecoderONNX.forward(inputs_embeds, attention_mask, position_ids, *past)."""
    past_axis = {0: "batch", 2: "past_len"}
    return {
        "inputs_embeds": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "total_len"},
        "position_ids": {1: "batch", 2: "seq"},
        "past": tuple(dict(past_axis) for _ in range(NUM_DECODER_LAYERS * 2)),
    }


def copy_tokenizer(out_dir: Path):
    names = [
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "config.json",
        "generation_config.json",
        "preprocessor_config.json",
        "processor_config.json",
        "chat_template.jinja",
        "image_processing_paddleocr_vl.py",
        "processing_paddleocr_vl.py",
        "configuration_paddleocr_vl.py",
        "modeling_paddleocr_vl.py",
        "LICENSE",
    ]
    for name in names:
        src = HF_SRC / name
        if src.is_file():
            shutil.copy2(src, out_dir / name)


def write_manifest(out_dir: Path, dtype: str):
    manifest = {
        "schema": 1,
        "family": "paddleocr_vl",
        "id": f"paddleocr-vl-1.6-{dtype}",
        "arch": "paddleocr_vl",
        "onnx_dtype": dtype,
        "source": {"repo": HF_REPO, "revision": "main"},
        "files": {
            "vision_encoder": "vision_encoder.onnx",
            "embedding": "embedding.onnx",
            "decoder": "decoder.onnx",
            "tokenizer": "tokenizer.json",
            "preprocessor_config": "preprocessor_config.json",
        },
        "vision": {
            "patch_size": PATCH_SIZE,
            "hidden_size": VISION_HIDDEN,
            "decoder_width": DECODER_WIDTH,
            "spatial_merge": SPATIAL_MERGE,
            "navit": "onnx_resize",
        },
        "decoder": {
            "num_layers": NUM_DECODER_LAYERS,
            "num_kv_heads": NUM_KV_HEADS,
            "head_dim": HEAD_DIM,
        },
        "notes": [
            "Exported with torch.onnx.export dynamo=True, opset 21.",
            "Image tokens splice at id 100295. Host computes 3D M-RoPE indices.",
            "FP32 only. Quantization is a follow-up step.",
        ],
    }
    path = out_dir / "ocr_manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[export] wrote {path}", flush=True)


def _weights_ready() -> bool:
    if (HF_SRC / "model.safetensors").is_file():
        return True
    return (HF_SRC / "model.safetensors.index.json").is_file()


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=ONNX_DIR)
    parser.add_argument(
        "--component",
        choices=("all", "vision", "embed", "decoder"),
        default="all",
    )
    parser.add_argument("--dtype", choices=("fp32",), default="fp32")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if not _weights_ready():
        raise FileNotFoundError(f"missing weights under {HF_SRC}")
    dtype = torch.float32
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    model = load_hf_model(dtype=dtype, device="cpu")
    with torch.inference_mode():
        if args.component in ("all", "vision"):
            export_vision(model, out_dir, dtype)
        if args.component in ("all", "embed"):
            export_embed(model, out_dir, dtype)
        if args.component in ("all", "decoder"):
            export_decoder(model, out_dir, dtype)
    copy_tokenizer(out_dir)
    write_manifest(out_dir, args.dtype)
    print(f"[export] done -> {out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
