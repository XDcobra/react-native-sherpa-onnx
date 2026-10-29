"""Default locations for the local PaddleOCR-VL-1.6 ONNX workspace."""

from __future__ import annotations

from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
BUILD_ROOT = REPO_ROOT / "build" / "ocr-models" / "paddleocr-vl-1.6"
HF_SRC = BUILD_ROOT / "hf-src"
ONNX_DIR = BUILD_ROOT / "onnx"
ONNX_FP16_DIR = BUILD_ROOT / "onnx-fp16"
ONNX_INT8_DIR = BUILD_ROOT / "onnx-int8"
ONNX_Q4F16_DIR = BUILD_ROOT / "onnx-q4f16"
EXP_ROOT = BUILD_ROOT / "exp"
HF_STAGE = BUILD_ROOT / "hf-stage"
REFS_DIR = BUILD_ROOT / "refs"
PAGES_DIR = BUILD_ROOT / "pages"
HF_REPO_ID = "XDcobra/PaddleOCR-VL-1.6-ONNX"

VARIANT_DIRS = {
    "fp32": ONNX_DIR,
    "fp16": ONNX_FP16_DIR,
    "int8": ONNX_INT8_DIR,
    "q4f16": ONNX_Q4F16_DIR,
}


def ensure_hf_src_on_path() -> Path:
    import sys

    if not HF_SRC.is_dir():
        raise FileNotFoundError(
            f"Hugging Face snapshot missing at {HF_SRC}. "
            "Download PaddlePaddle/PaddleOCR-VL-1.6 first."
        )
    path = str(HF_SRC)
    if path not in sys.path:
        sys.path.insert(0, path)
    return HF_SRC
