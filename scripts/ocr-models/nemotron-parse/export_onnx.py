#!/usr/bin/env python3
"""Export Nemotron-3.5-Parse to desktop ONNX Runtime graphs (FP32).

Graphs:
  patch_embed.onnx          Linear 768 -> 1152
  vision_encoder.onnx       27-layer ViT + neck (NaViT pos is host-side)
  embed_tokens.onnx         scaled token embeddings
  decoder_model_merged.onnx causal GQA decoder with KV cache

NaViT interpolation stays in host code so image sizes stay dynamic without
baking a single canvas into the vision graph.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

from constants import (
    DECODER_WIDTH,
    HEAD_DIM,
    HF_REPO,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    PATCH_SIZE,
    VISION_WIDTH,
)
from paths import BUILD_ROOT, HF_SRC, ONNX_DIR, ensure_hf_src_on_path
from wrappers import (
    DecoderONNX,
    EmbedTokensONNX,
    PatchEmbedONNX,
    VisionEncoderONNX,
    decoder_input_names,
    decoder_output_names,
    empty_past,
)

OPSET = 18


def _save_onnx(model: nn.Module, path: Path, inputs: tuple, input_names, output_names, dynamic_axes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.onnx")
    if tmp.exists():
        tmp.unlink()
    data_tmp = Path(str(tmp) + "_data")
    if data_tmp.exists():
        data_tmp.unlink()

    model.eval()
    torch.onnx.export(
        model,
        inputs,
        str(tmp),
        input_names=list(input_names),
        output_names=list(output_names),
        dynamic_axes=dynamic_axes,
        opset_version=OPSET,
        do_constant_folding=True,
        dynamo=False,
        external_data=True,
    )

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
    print(f"[export] wrote {path} ({path.stat().st_size} bytes)")
    if final_data.exists():
        print(f"[export] wrote {final_data} ({final_data.stat().st_size} bytes)")


def load_hf_model(dtype: torch.dtype = torch.float32, device: str = "cpu"):
    ensure_hf_src_on_path()
    from transformers import AutoModel

    print(f"[export] loading {HF_SRC} dtype={dtype} device={device}")
    model = AutoModel.from_pretrained(
        str(HF_SRC),
        trust_remote_code=True,
        dtype=dtype,
        local_files_only=True,
    )
    model = model.to(device).eval()
    return model


def export_patch_embed(model, out_dir: Path, dtype: torch.dtype):
    wrapper = PatchEmbedONNX(model.encoder).to(dtype=dtype).eval()
    patches = torch.zeros(32, 768, dtype=dtype)
    _save_onnx(
        wrapper,
        out_dir / "patch_embed.onnx",
        (patches,),
        ["patches"],
        ["patch_tokens"],
        {"patches": {0: "num_patches"}, "patch_tokens": {0: "num_patches"}},
    )


def export_vision(model, out_dir: Path, dtype: torch.dtype):
    wrapper = VisionEncoderONNX(model.encoder).to(dtype=dtype).eval()
    rows, cols = 8, 12
    patch_tokens = torch.zeros(1, rows, cols, VISION_WIDTH, dtype=dtype)
    _save_onnx(
        wrapper,
        out_dir / "vision_encoder.onnx",
        (patch_tokens,),
        ["patch_tokens"],
        ["vision", "visual_mask"],
        {
            "patch_tokens": {1: "rows", 2: "cols"},
            "vision": {1: "vision_len"},
            "visual_mask": {1: "vision_len"},
        },
    )
    pos = model.encoder.model_encoder.radio_model.model.patch_generator.pos_embed
    np.save(out_dir / "pos_embed.npy", pos.detach().cpu().float().numpy())
    print(f"[export] wrote {out_dir / 'pos_embed.npy'}")


def export_embed(model, out_dir: Path, dtype: torch.dtype):
    wrapper = EmbedTokensONNX(model).to(dtype=dtype).eval()
    input_ids = torch.zeros(1, 8, dtype=torch.int64)
    _save_onnx(
        wrapper,
        out_dir / "embed_tokens.onnx",
        (input_ids,),
        ["input_ids"],
        ["inputs_embeds"],
        {"input_ids": {0: "batch", 1: "seq"}, "inputs_embeds": {0: "batch", 1: "seq"}},
    )


def export_decoder(model, out_dir: Path, dtype: torch.dtype):
    wrapper = DecoderONNX(model).to(dtype=dtype).eval()
    batch, seq, past_len = 1, 4, 0
    inputs_embeds = torch.zeros(batch, seq, DECODER_WIDTH, dtype=dtype)
    attention_mask = torch.ones(batch, past_len + seq, dtype=dtype)
    past = empty_past(batch=batch, dtype=dtype)
    _save_onnx(
        wrapper,
        out_dir / "decoder_model_merged.onnx",
        (inputs_embeds, attention_mask, *past),
        decoder_input_names(),
        decoder_output_names(),
        _decoder_dynamic_axes(),
    )


def _decoder_dynamic_axes():
    axes = {
        "inputs_embeds": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "total_len"},
        "logits": {0: "batch", 1: "seq"},
    }
    for layer in range(NUM_DECODER_LAYERS):
        axes[f"past_key_{layer}"] = {0: "batch", 2: "past_len"}
        axes[f"past_value_{layer}"] = {0: "batch", 2: "past_len"}
        axes[f"present_key_{layer}"] = {0: "batch", 2: "total_len"}
        axes[f"present_value_{layer}"] = {0: "batch", 2: "total_len"}
    return axes


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
    ]
    for name in names:
        src = HF_SRC / name
        if src.is_file():
            shutil.copy2(src, out_dir / name)
    license_src = HF_SRC / "LICENSE"
    if not license_src.is_file():
        # Snapshot may omit LICENSE; keep provenance in the manifest.
        license_src = None
    else:
        shutil.copy2(license_src, out_dir / "LICENSE")


def write_manifest(out_dir: Path, dtype: str):
    manifest = {
        "schema": 1,
        "family": "doc_vlm",
        "id": "docvlm-nemotron-3.5-parse-fp32",
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
        "notes": [
            "NaViT positional interpolation runs in host code (navit_pos.py).",
            "Decoder is a merged prefill/decode graph with empty past_len=0.",
            "FP32 only. Quantization is a follow-up step.",
        ],
    }
    path = out_dir / "ocr_manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[export] wrote {path}")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=ONNX_DIR)
    parser.add_argument(
        "--component",
        choices=("all", "patch_embed", "vision", "embed", "decoder"),
        default="all",
    )
    parser.add_argument("--dtype", choices=("fp32",), default="fp32")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if not (HF_SRC / "model.safetensors").is_file():
        raise FileNotFoundError(f"missing {HF_SRC / 'model.safetensors'}")
    dtype = torch.float32
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    model = load_hf_model(dtype=dtype, device="cpu")
    with torch.inference_mode():
        if args.component in ("all", "patch_embed"):
            export_patch_embed(model, out_dir, dtype)
        if args.component in ("all", "vision"):
            export_vision(model, out_dir, dtype)
        if args.component in ("all", "embed"):
            export_embed(model, out_dir, dtype)
        if args.component in ("all", "decoder"):
            export_decoder(model, out_dir, dtype)
    copy_tokenizer(out_dir)
    write_manifest(out_dir, args.dtype)
    print(f"[export] done -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
