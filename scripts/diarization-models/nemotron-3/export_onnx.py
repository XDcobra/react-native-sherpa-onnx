#!/usr/bin/env python3
"""Export nvidia/Nemotron-3-Diarization to the RN SDK Sortformer streaming ONNX contract.

Produces a single FP32 graph with dynamic time axes:

  inputs:  chunk, chunk_lengths, spkcache, spkcache_lengths, fifo, fifo_lengths
  outputs: spkcache_fifo_chunk_preds, chunk_pre_encode_embs, chunk_pre_encode_lengths

Host Mel frontend + AOSC/FIFO cache stay in the SDK C++ runner
(`SortformerStreamingModel`), same as diar_streaming_sortformer_4spk-v2.1.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import types
from pathlib import Path

import torch

from constants import (
    DEFAULT_EXPORT_PRESET,
    EMB_DIM,
    FEAT_DIM,
    GRAPH_FILE,
    INPUT_NAMES,
    LATENCY_PRESETS,
    LICENSE_FILE,
    MANIFEST_FILE,
    MAX_SPEAKERS,
    METADATA_FILE,
    MODEL_ID,
    NVIDIA_REPO,
    OPSET,
    OUTPUT_NAMES,
    SAMPLE_RATE,
    SUBSAMPLING,
)
from paths import BUILD_ROOT, HF_SRC, NEMO_CKPT, ONNX_DIR, ensure_hf_src


def _log(msg: str) -> None:
    print(f"[export] {msg}", flush=True)


def load_nemo_model(nemo_path: Path, device: str):
    from nemo.collections.asr.models import SortformerEncLabelModel

    _log(f"restore {nemo_path} map_location={device}")
    model = SortformerEncLabelModel.restore_from(
        restore_path=str(nemo_path),
        map_location=device,
        strict=False,
    )
    model.eval()
    return model


def apply_streaming_preset(model, preset_name: str) -> dict:
    preset = LATENCY_PRESETS[preset_name]
    mods = model.sortformer_modules
    mods.chunk_len = preset["chunk_len"]
    mods.chunk_right_context = preset["right_context"]
    mods.fifo_len = preset["fifo_len"]
    mods.spkcache_len = preset["spkcache_len"]
    mods.spkcache_update_period = preset["spkcache_update_period"]
    mods._check_streaming_parameters()
    return preset


def _patch_encoder_for_onnx_export(model) -> None:
    """Nemotron-3's TransformerEncoder defaults to FlexAttention + create_block_mask,
    which cannot be TorchScript-traced. The encoder already has a `for_export=True`
    path that materializes an explicit attn_mask and uses SDPA instead.
    """
    encoder = model.encoder
    original_forward = encoder.forward

    def forward_export(self, audio_signal, length=None, bypass_pre_encode=False):
        if not bypass_pre_encode and audio_signal.shape[-2] != self._feat_in:
            raise ValueError(
                f"If bypass_pre_encode is False, audio_signal should have shape "
                f"(batch, {self._feat_in}, n_frame) but got last dimension "
                f"{audio_signal.shape[-2]}."
            )
        if bypass_pre_encode and audio_signal.shape[-1] != self.d_model:
            raise ValueError(
                f"If bypass_pre_encode is True, audio_signal should have shape "
                f"(batch, n_frame, {self.d_model}) but got last dimension "
                f"{audio_signal.shape[-1]}."
            )
        if bypass_pre_encode:
            self.update_max_seq_length(seq_length=audio_signal.size(1), device=audio_signal.device)
        else:
            self.update_max_seq_length(seq_length=audio_signal.size(2), device=audio_signal.device)
        return self.forward_internal(
            audio_signal,
            length,
            bypass_pre_encode=bypass_pre_encode,
            for_export=True,
        )

    encoder.forward = types.MethodType(forward_export, encoder)
    encoder._onnx_original_forward = original_forward


def install_onnx_forward(model) -> None:
    _patch_encoder_for_onnx_export(model)

    def onnx_forward(
        self,
        chunk,
        chunk_lengths,
        spkcache,
        spkcache_lengths,
        fifo,
        fifo_lengths,
    ):
        # Nemotron-3 uses FeatureStacking pre_encode, which expects (B, C, T).
        # `_call_pre_encode` handles Linear vs FeatureStacking layouts.
        # `chunk` from the RN Sortformer contract is always (B, T, feat_dim).
        chunk_pre_encode_embs, chunk_pre_encode_lengths = self._call_pre_encode(
            chunk, chunk_lengths
        )
        chunk_pre_encode_lengths = chunk_pre_encode_lengths.to(torch.int64)

        concat_embs = torch.cat([spkcache, fifo, chunk_pre_encode_embs], dim=1)
        concat_lens = spkcache_lengths + fifo_lengths + chunk_pre_encode_lengths

        spkcache_fifo_chunk_fc_encoder_embs, spkcache_fifo_chunk_fc_encoder_lengths = (
            self.frontend_encoder(
                processed_signal=concat_embs,
                processed_signal_length=concat_lens,
                bypass_pre_encode=True,
            )
        )

        spkcache_fifo_chunk_preds = self.forward_infer(
            spkcache_fifo_chunk_fc_encoder_embs,
            spkcache_fifo_chunk_fc_encoder_lengths,
        )
        return (
            spkcache_fifo_chunk_preds,
            chunk_pre_encode_embs,
            chunk_pre_encode_lengths,
        )

    model.forward = types.MethodType(onnx_forward, model)


def build_example_inputs(preset: dict, device: str):
    batch = 1
    chunk_frames = preset["chunk_len"] * SUBSAMPLING
    chunk = torch.randn(batch, chunk_frames, FEAT_DIM, device=device)
    chunk_lengths = torch.tensor([chunk_frames], dtype=torch.long, device=device)
    spkcache = torch.zeros(batch, preset["spkcache_len"], EMB_DIM, device=device)
    spkcache_lengths = torch.tensor([0], dtype=torch.long, device=device)
    fifo = torch.zeros(batch, preset["fifo_len"], EMB_DIM, device=device)
    fifo_lengths = torch.tensor([0], dtype=torch.long, device=device)
    return (chunk, chunk_lengths, spkcache, spkcache_lengths, fifo, fifo_lengths)


def write_metadata(out_dir: Path, preset: dict) -> None:
    payload = {
        "id": MODEL_ID,
        "name": "Nemotron 3 Diarization (Sortformer 8-speaker)",
        "model_type": "sortformer",
        "architecture": "streaming_sortformer_8spk_nemotron3",
        "version": "3",
        "streaming": True,
        "sample_rate": SAMPLE_RATE,
        "feature_dim": FEAT_DIM,
        "embedding_dim": EMB_DIM,
        "subsampling": SUBSAMPLING,
        "pred_upsample": SUBSAMPLING,
        "max_speakers": MAX_SPEAKERS,
        "chunk_len": preset["chunk_len"],
        "fifo_len": preset["fifo_len"],
        "spkcache_len": preset["spkcache_len"],
        "right_context": preset["right_context"],
        "spkcache_update_period": preset["spkcache_update_period"],
        "latency_presets": LATENCY_PRESETS,
        "default_latency_preset": DEFAULT_EXPORT_PRESET,
        "license": "openmdw-1.1",
        "attribution": "Licensed by NVIDIA Corporation under the OpenMDW License Agreement v1.1",
        "source_repo": NVIDIA_REPO,
    }
    (out_dir / METADATA_FILE).write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


def write_manifest(out_dir: Path, onnx_path: Path, preset: dict) -> None:
    payload = {
        "schema": 1,
        "family": "nemotron3_diarization",
        "id": MODEL_ID,
        "variant": "fp32",
        "onnx": GRAPH_FILE,
        "bytes": onnx_path.stat().st_size,
        "contract": {
            "inputs": list(INPUT_NAMES),
            "outputs": list(OUTPUT_NAMES),
            "opset": OPSET,
        },
        "export_preset": preset,
        "notes": [
            "FP32 Sortformer streaming step matching react-native-sherpa-onnx.",
            "Mel frontend and AOSC/FIFO cache remain host-side.",
        ],
    }
    (out_dir / MANIFEST_FILE).write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


def copy_license(out_dir: Path) -> None:
    src = HF_SRC / LICENSE_FILE
    if not src.is_file():
        # NVIDIA cards sometimes only ship LICENSE via Hub metadata; try README fallthrough.
        for name in ("LICENSE", "LICENSE.txt", "license.txt"):
            cand = HF_SRC / name
            if cand.is_file():
                src = cand
                break
    if src.is_file():
        shutil.copy2(src, out_dir / LICENSE_FILE)
        _log(f"copied {src.name}")
    else:
        _log("WARNING: no LICENSE found in HF snapshot")


def embed_onnx_metadata(onnx_path: Path, preset: dict) -> None:
    import onnx

    model = onnx.load(str(onnx_path))
    # Clear prior props then write streaming geometry.
    del model.metadata_props[:]
    props = {
        "model_id": MODEL_ID,
        "model_type": "sortformer",
        "max_speakers": str(MAX_SPEAKERS),
        "sample_rate": str(SAMPLE_RATE),
        "feature_dim": str(FEAT_DIM),
        "embedding_dim": str(EMB_DIM),
        "subsampling": str(SUBSAMPLING),
        "chunk_len": str(preset["chunk_len"]),
        "fifo_len": str(preset["fifo_len"]),
        "spkcache_len": str(preset["spkcache_len"]),
        "right_context": str(preset["right_context"]),
        "spkcache_update_period": str(preset["spkcache_update_period"]),
        "source_repo": NVIDIA_REPO,
    }
    for key, value in props.items():
        entry = onnx.StringStringEntryProto(key=key, value=value)
        model.metadata_props.append(entry)
    onnx.save(model, str(onnx_path))
    _log(f"wrote ONNX metadata_props ({len(props)} keys)")


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--nemo",
        type=Path,
        default=None,
        help=f"Path to .nemo (default: {NEMO_CKPT})",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=ONNX_DIR,
        help=f"Output directory (default: {ONNX_DIR})",
    )
    p.add_argument(
        "--preset",
        choices=sorted(LATENCY_PRESETS.keys()),
        default=DEFAULT_EXPORT_PRESET,
        help="Streaming geometry used for the export trace (dynamic axes still)",
    )
    p.add_argument(
        "--device",
        default="cpu",
        help="cpu or cuda (export itself is usually CPU)",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ensure_hf_src()
    nemo_path = args.nemo or NEMO_CKPT
    if not nemo_path.is_file():
        raise FileNotFoundError(
            f"missing {nemo_path}. "
            f"hf download {NVIDIA_REPO} --local-dir {HF_SRC}"
        )

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / GRAPH_FILE

    model = load_nemo_model(nemo_path, args.device)
    preset = apply_streaming_preset(model, args.preset)
    install_onnx_forward(model)

    example = build_example_inputs(preset, args.device)
    _log(
        "shapes "
        f"chunk={tuple(example[0].shape)} "
        f"spkcache={tuple(example[2].shape)} "
        f"fifo={tuple(example[4].shape)}"
    )

    _log(f"torch.onnx.export → {onnx_path}")
    torch.onnx.export(
        model,
        example,
        str(onnx_path),
        input_names=list(INPUT_NAMES),
        output_names=list(OUTPUT_NAMES),
        dynamic_axes={
            "chunk": {0: "batch", 1: "time_chunk"},
            "spkcache": {0: "batch", 1: "time_cache"},
            "fifo": {0: "batch", 1: "time_fifo"},
            "spkcache_fifo_chunk_preds": {0: "batch", 1: "time_out"},
            "chunk_pre_encode_embs": {0: "batch", 1: "time_pre_encode"},
        },
        opset_version=OPSET,
        dynamo=False,
        verbose=False,
    )

    embed_onnx_metadata(onnx_path, preset)
    write_metadata(out_dir, preset)
    write_manifest(out_dir, onnx_path, preset)
    copy_license(out_dir)

    mb = onnx_path.stat().st_size / 1e6
    _log(f"done {onnx_path} ({mb:.1f} MB)")
    _log(f"workspace root {BUILD_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
