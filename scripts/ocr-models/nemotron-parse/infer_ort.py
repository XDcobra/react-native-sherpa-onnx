#!/usr/bin/env python3
"""Desktop ONNX Runtime greedy decode for the Nemotron-3.5-Parse export."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

from constants import (
    DEFAULT_PROMPT,
    DECODER_WIDTH,
    EOS_TOKEN_ID,
    HEAD_DIM,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    PATCH_SIZE,
    build_output_prompt,
)
from navit_pos import add_navit_positions_numpy
from paths import HF_SRC, ONNX_DIR, ensure_hf_src_on_path
from wrappers import decoder_input_names, decoder_output_names


def session(path: Path) -> ort.InferenceSession:
    import os

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    threads = max(1, int(os.environ.get("ORT_NUM_THREADS") or os.environ.get("OMP_NUM_THREADS") or "14"))
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


class OrtParser:
    def __init__(self, onnx_dir: Path):
        self.onnx_dir = Path(onnx_dir)
        self.patch_embed = session(self.onnx_dir / "patch_embed.onnx")
        self.vision = session(self.onnx_dir / "vision_encoder.onnx")
        self.embed = session(self.onnx_dir / "embed_tokens.onnx")
        self.decoder = session(self.onnx_dir / "decoder_model_merged.onnx")
        self.pos_embed = np.load(self.onnx_dir / "pos_embed.npy")
        ensure_hf_src_on_path()
        from transformers import AutoProcessor

        self.processor = AutoProcessor.from_pretrained(
            str(HF_SRC), trust_remote_code=True, local_files_only=True
        )

    def encode_image(self, image: Image.Image) -> tuple[np.ndarray, np.ndarray, dict]:
        features = self.processor.image_processor(image, return_tensors="np")
        patches = np.asarray(features["pixel_values"], dtype=np.float32)
        if patches.ndim == 3:
            patches = patches[0]
        image_size = tuple(int(x) for x in np.asarray(features["image_sizes"]).reshape(-1)[:2])
        content_size = tuple(int(x) for x in np.asarray(features["content_sizes"]).reshape(-1)[:2])
        rows, cols = image_size[0] // PATCH_SIZE, image_size[1] // PATCH_SIZE
        patch_emb = self.patch_embed.run(None, {"patches": patches})[0]
        patch_emb = add_navit_positions_numpy(
            patch_emb[None, ...], self.pos_embed, image_size, content_size
        )
        patch_tokens = patch_emb.reshape(1, rows, cols, patch_emb.shape[-1])
        vision, visual_mask = self.vision.run(None, {"patch_tokens": patch_tokens})
        meta = {
            "image_size": image_size,
            "content_size": content_size,
            "rows": rows,
            "cols": cols,
            "vision_len": int(vision.shape[1]),
        }
        return vision, visual_mask.astype(np.float32), meta

    def embed_tokens(self, input_ids: np.ndarray) -> np.ndarray:
        return self.embed.run(None, {"input_ids": input_ids.astype(np.int64)})[0]

    def decode_step(
        self,
        inputs_embeds: np.ndarray,
        attention_mask: np.ndarray,
        past: list[np.ndarray],
    ) -> tuple[np.ndarray, list[np.ndarray]]:
        feeds = {
            "inputs_embeds": inputs_embeds.astype(np.float32),
            "attention_mask": attention_mask.astype(np.float32),
        }
        names = decoder_input_names()
        for name, value in zip(names[2:], past):
            feeds[name] = value
        outputs = self.decoder.run(decoder_output_names(), feeds)
        return outputs[0], list(outputs[1:])

    def generate(
        self,
        image: Image.Image,
        prompt: str = DEFAULT_PROMPT,
        max_new_tokens: int = 64,
        repetition_penalty: float = 1.1,
    ) -> dict:
        vision, visual_mask, meta = self.encode_image(image)
        encoded = self.processor.tokenizer(
            prompt, add_special_tokens=False, return_tensors="np"
        )
        prompt_ids = np.asarray(encoded["input_ids"], dtype=np.int64)
        if prompt_ids.ndim == 1:
            prompt_ids = prompt_ids[None, :]
        text_embeds = self.embed_tokens(prompt_ids)
        prefill = np.concatenate([vision, text_embeds], axis=1)
        attn = np.concatenate(
            [visual_mask, np.ones((1, prompt_ids.shape[1]), dtype=np.float32)], axis=1
        )
        past = empty_past_numpy()
        logits, past = self.decode_step(prefill, attn, past)
        generated = [int(np.argmax(apply_repetition_penalty(logits[0, -1], prompt_ids[0], repetition_penalty)))]
        all_ids = np.concatenate([prompt_ids[0], np.asarray(generated, dtype=np.int64)])
        for _ in range(max_new_tokens - 1):
            if generated[-1] == EOS_TOKEN_ID:
                break
            step_ids = np.asarray([[generated[-1]]], dtype=np.int64)
            step_embeds = self.embed_tokens(step_ids)
            attn = np.concatenate(
                [attn, np.ones((1, 1), dtype=np.float32)], axis=1
            )
            logits, past = self.decode_step(step_embeds, attn, past)
            nxt = int(
                np.argmax(apply_repetition_penalty(logits[0, -1], all_ids, repetition_penalty))
            )
            generated.append(nxt)
            all_ids = np.concatenate([all_ids, [nxt]])
        text = self.processor.tokenizer.decode(generated, skip_special_tokens=False)
        return {
            "tokens": generated,
            "text": text,
            "meta": meta,
            "prompt_ids": prompt_ids[0].tolist(),
        }


def empty_past_numpy(batch: int = 1) -> list[np.ndarray]:
    past = []
    for _ in range(NUM_DECODER_LAYERS):
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
    return past


def apply_repetition_penalty(logits: np.ndarray, ids: np.ndarray, penalty: float) -> np.ndarray:
    if penalty == 1.0:
        return logits
    out = logits.copy()
    for token in np.unique(ids.astype(np.int64)):
        if out[token] < 0:
            out[token] *= penalty
        else:
            out[token] /= penalty
    return out


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_hello_image(width: int = 256, height: int = 192) -> Image.Image:
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.text((16, 64), "Hello World", fill="black", font=_font(36))
    return image


def make_document_image(width: int = 900, height: int = 1200) -> Image.Image:
    """Synthetic multi-block page: title, paragraphs, and a table."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title = _font(36)
    body = _font(20)
    small = _font(16)
    y = 48
    draw.text((48, y), "Quarterly Operations Report", fill="black", font=title)
    y += 64
    draw.text((48, y), "Prepared 12 March 2026  |  Site: Hamburg", fill="#333333", font=small)
    y += 48
    paragraphs = [
        "Inbound shipments were inspected on arrival. Two lots failed the moisture check and were held.",
        "The packing line ran 18 shifts. Mean units per hour was 412, with a peak of 480 on Thursday.",
        "Customer returns concentrated on carton damage. Tape tension was increased after the audit.",
    ]
    for paragraph in paragraphs:
        draw.text((48, y), paragraph, fill="black", font=body)
        y += 40
    y += 16
    draw.text((48, y), "Shift summary", fill="black", font=title)
    y += 48
    headers = ["Shift", "Units", "Rejects", "Notes"]
    rows = [
        ["Mon AM", "3 210", "14", "Normal"],
        ["Mon PM", "2 980", "21", "Jam at seal"],
        ["Tue AM", "3 440", "9", "Normal"],
        ["Tue PM", "3 105", "17", "Label gap"],
        ["Wed AM", "3 520", "8", "Normal"],
    ]
    col_x = [48, 220, 400, 560]
    for index, header in enumerate(headers):
        draw.text((col_x[index], y), header, fill="black", font=body)
    y += 28
    draw.line((48, y, width - 48, y), fill="black", width=1)
    y += 12
    for row in rows:
        for index, cell in enumerate(row):
            draw.text((col_x[index], y), cell, fill="black", font=body)
        y += 32
    y += 24
    draw.text(
        (48, y),
        "Action: replace the seal belt before Friday and re-train the PM crew.",
        fill="black",
        font=body,
    )
    return image


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx-dir", type=Path, default=ONNX_DIR)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--max-new-tokens", type=int, default=32)
    parser.add_argument("--prompt", default=None)
    parser.add_argument(
        "--output-profile",
        metavar="text,layout,pic",
        help="e.g. markdown,boxesAndClasses,nopic  (overrides --prompt)",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    image = Image.open(args.image).convert("RGB") if args.image else make_hello_image()
    prompt = args.prompt
    if args.output_profile:
        parts = [p.strip() for p in args.output_profile.split(",")]
        if len(parts) != 3:
            raise SystemExit("--output-profile must be text,layout,pic")
        prompt = build_output_prompt(parts[0], parts[1], parts[2])
    if not prompt:
        prompt = DEFAULT_PROMPT
    parser = OrtParser(args.onnx_dir)
    result = parser.generate(image, prompt=prompt, max_new_tokens=args.max_new_tokens)
    print(json.dumps(result, indent=2)[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
