"""Default locations for the local Nemotron-3-Diarization ONNX workspace."""

from __future__ import annotations

from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
BUILD_ROOT = REPO_ROOT / "build" / "diarization-models" / "nemotron-3"
HF_SRC = BUILD_ROOT / "hf-src"
NEMO_CKPT = HF_SRC / "Nemotron-3-Diarization.nemo"
ONNX_DIR = BUILD_ROOT / "onnx"
ONNX_FP16_DIR = BUILD_ROOT / "onnx-fp16"
ONNX_INT8_DIR = BUILD_ROOT / "onnx-int8"
ONNX_Q4F16_DIR = BUILD_ROOT / "onnx-q4f16"
EXP_ROOT = BUILD_ROOT / "exp"
HF_STAGE = BUILD_ROOT / "hf-stage"
REFS_DIR = BUILD_ROOT / "refs"
FIXTURES_DIR = BUILD_ROOT / "fixtures"
FIGURES_DIR = SCRIPT_DIR / "figures"
HF_REPO_ID = "XDcobra/Nemotron-3-Diarization-ONNX"
NVIDIA_REPO = "nvidia/Nemotron-3-Diarization"
MODEL_ID = "diar_streaming_nemotron3_sortformer_8spk"

VARIANT_DIRS = {
    "fp32": ONNX_DIR,
    "fp16": ONNX_FP16_DIR,
    "int8": ONNX_INT8_DIR,
    "q4f16": ONNX_Q4F16_DIR,
}


def ensure_hf_src() -> Path:
    if not HF_SRC.is_dir():
        raise FileNotFoundError(
            f"Hugging Face snapshot missing at {HF_SRC}. "
            f"Download {NVIDIA_REPO} first (see README)."
        )
    return HF_SRC
