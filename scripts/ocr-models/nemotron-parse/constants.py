"""Shared constants for the Nemotron-3.5-Parse ONNX export."""

from __future__ import annotations

HF_REPO = "nvidia/Nemotron-3.5-Parse"
DEFAULT_PROMPT = "</s><s><predict_bbox><predict_classes><output_markdown><predict_text_in_pic>"

VISION_WIDTH = 1152
VISION_PATCH = 768
DECODER_WIDTH = 1024
NUM_QUERY_HEADS = 16
NUM_KV_HEADS = 8
HEAD_DIM = DECODER_WIDTH // NUM_QUERY_HEADS
NUM_DECODER_LAYERS = 10
NUM_CLS_TOKENS = 10
PATCH_SIZE = 16
POS_GRID = 128
VOCAB_SIZE = 72512
EMBED_SCALE = DECODER_WIDTH**0.5  # scale_embedding=True

BOS_TOKEN_ID = 0
PAD_TOKEN_ID = 1
EOS_TOKEN_ID = 2
