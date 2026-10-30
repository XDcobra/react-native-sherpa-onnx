"""Shared locations for the OCR instruction evidence gate (Phase 0)."""

from __future__ import annotations

from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
BUILD_ROOT = REPO_ROOT / "build" / "ocr-models"
GOLDEN_ROOT = REPO_ROOT / "test" / "fixtures" / "ocr" / "instructions"
IMAGE_DIR = GOLDEN_ROOT / "_images"
CATALOG_PATH = IMAGE_DIR / "catalog.json"
REPORT_PATH = GOLDEN_ROOT / "phase0-report.json"

PADDLE_HF = BUILD_ROOT / "paddleocr-vl-1.6" / "hf-src"
PADDLE_ONNX = (
    REPO_ROOT / "example" / ".model-cache" / "paddleocr-vl-1.6-fp16"
)
NEMOTRON_HF = BUILD_ROOT / "nemotron-3.5-parse" / "hf-src"
NEMOTRON_ONNX = (
    REPO_ROOT / "example" / ".model-cache" / "nemotron-3.5-parse-int8"
)
GRANITE_HF = BUILD_ROOT / "docvlm-granite-258m" / "hf-src"
GRANITE_ONNX = (
    REPO_ROOT / "example" / ".model-cache" / "docvlm-granite-258m-fp32"
)
