"""Shared constants for the PaddleOCR-VL-1.6 ONNX export."""

from __future__ import annotations

HF_REPO = "PaddlePaddle/PaddleOCR-VL-1.6"
# Official page-parse prompt. Image placeholders are inserted by the processor.
TASK_PROMPT = "OCR:"

DECODER_WIDTH = 1024
VISION_HIDDEN = 1152
NUM_DECODER_LAYERS = 18
NUM_ATTENTION_HEADS = 16
NUM_KV_HEADS = 2
HEAD_DIM = 128
PATCH_SIZE = 14
SPATIAL_MERGE = 2
VOCAB_SIZE = 103424
IMAGE_TOKEN_ID = 100295
VISION_START_TOKEN_ID = 101305
BOS_TOKEN_ID = 1
EOS_TOKEN_ID = 2
PAD_TOKEN_ID = 0
MROPE_SECTION = (16, 24, 24)
ROPE_THETA = 500000.0
POS_GRID = 27  # 384 / 14
