"""Shared constants for the Nemotron-3.5-Parse ONNX export."""

from __future__ import annotations

HF_REPO = "nvidia/Nemotron-3.5-Parse"
# NVIDIA card default is markdown + boxes + classes + no text-in-picture.
# The previous SDK hard-coded text-in-pic; Phase 0 locks the card default.
DEFAULT_PROMPT = "</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>"

OUTPUT_TEXT = {
    "markdown": "<output_markdown>",
    "plain": "<output_plain>",
    "none": "<output_no_text>",
}
OUTPUT_LAYOUT = {
    "none": ("<no_bbox>", "<no_classes>"),
    "boxes": ("<predict_bbox>", "<no_classes>"),
    "boxesAndClasses": ("<predict_bbox>", "<predict_classes>"),
}
OUTPUT_PIC = {
    "pic": "<predict_text_in_pic>",
    "nopic": "<predict_no_text_in_pic>",
}


def build_output_prompt(text: str, layout: str, pic: str) -> str:
    if text not in OUTPUT_TEXT:
        raise ValueError(f"unknown text profile {text!r}")
    if layout not in OUTPUT_LAYOUT:
        raise ValueError(f"unknown layout profile {layout!r}")
    if pic not in OUTPUT_PIC:
        raise ValueError(f"unknown pic profile {pic!r}")
    if text == "none" and layout == "none":
        raise ValueError("text=none requires boxes or boxesAndClasses")
    bbox, classes = OUTPUT_LAYOUT[layout]
    return f"</s><s>{bbox}{classes}{OUTPUT_TEXT[text]}{OUTPUT_PIC[pic]}"

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
