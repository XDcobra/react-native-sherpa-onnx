#!/usr/bin/env python3
"""Desktop ONNX Runtime greedy decode for the PaddleOCR-VL-1.6 export."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont, ImageTransform

from constants import (
    DEFAULT_MAX_PIXELS,
    EOS_TOKEN_ID,
    HEAD_DIM,
    IMAGE_TOKEN_ID,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    SPOTTING_MAX_PIXELS,
    SPOTTING_UPSCALE_THRESHOLD,
    TASK_PROMPT,
    TASK_PROMPTS,
)
from paths import HF_SRC, ONNX_DIR, ensure_hf_src_on_path
from rope_index import decode_position_ids, rope_index_numpy
from wrappers import decoder_input_names, decoder_output_names


def session(path: Path) -> ort.InferenceSession:
    import os

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    threads = max(1, int(os.environ.get("ORT_NUM_THREADS") or os.environ.get("OMP_NUM_THREADS") or "14"))
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


def task_prompt_text(task: str) -> str:
    if task not in TASK_PROMPTS:
        raise ValueError(f"unknown paddleocr_vl task {task!r}; expected {sorted(TASK_PROMPTS)}")
    return TASK_PROMPTS[task]


def max_pixels_for_task(task: str) -> int:
    return SPOTTING_MAX_PIXELS if task == "spotting" else DEFAULT_MAX_PIXELS


def maybe_upscale_spotting(image: Image.Image, task: str) -> tuple[Image.Image, bool]:
    if task != "spotting":
        return image, False
    width, height = image.size
    if width < SPOTTING_UPSCALE_THRESHOLD and height < SPOTTING_UPSCALE_THRESHOLD:
        return (
            image.resize((width * 2, height * 2), Image.Resampling.LANCZOS),
            True,
        )
    return image, False


def ocr_prompt_text(processor, task: str = "ocr") -> str:
    messages = [
        {
            "role": "user",
            "content": [{"type": "image"}, {"type": "text", "text": task_prompt_text(task)}],
        }
    ]
    return processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


class OrtParser:
    def __init__(self, onnx_dir: Path):
        self.onnx_dir = Path(onnx_dir)
        self.vision = session(self.onnx_dir / "vision_encoder.onnx")
        self.embed = session(self.onnx_dir / "embedding.onnx")
        self.decoder = session(self.onnx_dir / "decoder.onnx")
        ensure_hf_src_on_path()
        from transformers import AutoProcessor

        self.processor = AutoProcessor.from_pretrained(
            str(HF_SRC), trust_remote_code=True, local_files_only=True
        )

    def prepare(
        self,
        image: Image.Image,
        prompt: str | None = None,
        task: str = "ocr",
        max_pixels: int | None = None,
    ) -> dict:
        text = prompt if prompt is not None else ocr_prompt_text(self.processor, task)
        pixels = max_pixels if max_pixels is not None else max_pixels_for_task(task)
        image_processor = getattr(self.processor, "image_processor", None)
        previous = None
        if image_processor is not None and hasattr(image_processor, "max_pixels"):
            previous = image_processor.max_pixels
            image_processor.max_pixels = int(pixels)
        try:
            features = self.processor(images=image, text=[text], return_tensors="np")
        finally:
            if image_processor is not None and previous is not None:
                image_processor.max_pixels = previous
        pixel_values = np.asarray(features["pixel_values"], dtype=np.float32)
        if pixel_values.ndim == 4:
            pixel_values = pixel_values[None, ...]
        image_grid_thw = np.asarray(features["image_grid_thw"], dtype=np.int64)
        if image_grid_thw.ndim == 1:
            image_grid_thw = image_grid_thw[None, :]
        input_ids = np.asarray(features["input_ids"], dtype=np.int64)
        if input_ids.ndim == 1:
            input_ids = input_ids[None, :]
        attention_mask = np.asarray(
            features.get("attention_mask", np.ones_like(input_ids)), dtype=np.int64
        )
        if attention_mask.ndim == 1:
            attention_mask = attention_mask[None, :]
        return {
            "pixel_values": pixel_values,
            "image_grid_thw": image_grid_thw,
            "input_ids": input_ids,
            "attention_mask": attention_mask.astype(np.float32),
            "prompt_text": text,
            "max_pixels": int(pixels),
            "task": task,
        }

    def encode_image(self, pixel_values: np.ndarray, image_grid_thw: np.ndarray) -> np.ndarray:
        return self.vision.run(
            None,
            {
                "pixel_values": pixel_values.astype(np.float32),
                "image_grid_thw": image_grid_thw.astype(np.int64),
            },
        )[0]

    def embed_tokens(self, input_ids: np.ndarray) -> np.ndarray:
        return self.embed.run(None, {"input_ids": input_ids.astype(np.int64)})[0]

    def splice_image(self, input_ids: np.ndarray, text_embeds: np.ndarray, image_embeds: np.ndarray) -> np.ndarray:
        embeds = text_embeds.copy()
        mask = input_ids[0] == IMAGE_TOKEN_ID
        n_tokens = int(mask.sum())
        if image_embeds.ndim == 3:
            image_flat = image_embeds.reshape(-1, image_embeds.shape[-1])
        else:
            image_flat = image_embeds
        if n_tokens != image_flat.shape[0]:
            raise ValueError(f"image tokens {n_tokens} != features {image_flat.shape[0]}")
        embeds[0, mask] = image_flat.astype(np.float32)
        return embeds

    def decode_step(
        self,
        inputs_embeds: np.ndarray,
        attention_mask: np.ndarray,
        position_ids: np.ndarray,
        past: list[np.ndarray],
    ) -> tuple[np.ndarray, list[np.ndarray]]:
        feeds = {
            "inputs_embeds": inputs_embeds.astype(np.float32),
            "attention_mask": attention_mask.astype(np.float32),
            "position_ids": position_ids.astype(np.int64),
        }
        names = decoder_input_names()
        for name, value in zip(names[3:], past):
            feeds[name] = value
        outputs = self.decoder.run(decoder_output_names(), feeds)
        return outputs[0], list(outputs[1:])

    def generate(
        self,
        image: Image.Image,
        prompt: str | None = None,
        max_new_tokens: int = 64,
        task: str = "ocr",
        max_pixels: int | None = None,
    ) -> dict:
        image, upscaled = maybe_upscale_spotting(image, task)
        prepared = self.prepare(image, prompt, task=task, max_pixels=max_pixels)
        image_embeds = self.encode_image(prepared["pixel_values"], prepared["image_grid_thw"])
        input_ids = prepared["input_ids"]
        text_embeds = self.embed_tokens(input_ids)
        prefill = self.splice_image(input_ids, text_embeds, image_embeds)
        attn = prepared["attention_mask"].astype(np.float32)
        position_ids, rope_delta = rope_index_numpy(
            input_ids, prepared["image_grid_thw"], prepared["attention_mask"]
        )
        past = empty_past_numpy()
        logits, past = self.decode_step(prefill, attn, position_ids, past)
        generated = [int(np.argmax(logits[0, -1]))]
        prompt_len = int(input_ids.shape[1])
        for step in range(max_new_tokens - 1):
            if generated[-1] == EOS_TOKEN_ID:
                break
            step_ids = np.asarray([[generated[-1]]], dtype=np.int64)
            step_embeds = self.embed_tokens(step_ids)
            attn = np.concatenate([attn, np.ones((1, 1), dtype=np.float32)], axis=1)
            pos = decode_position_ids(prompt_len + step, rope_delta, seq=1)
            logits, past = self.decode_step(step_embeds, attn, pos, past)
            generated.append(int(np.argmax(logits[0, -1])))
        text = self.processor.tokenizer.decode(generated, skip_special_tokens=False)
        return {
            "tokens": generated,
            "text": text,
            "prompt_ids": input_ids[0].tolist(),
            "image_grid_thw": prepared["image_grid_thw"].tolist(),
            "image_tokens": int(image_embeds.shape[0]),
            "prompt_text": prepared["prompt_text"],
            "task": prepared["task"],
            "max_pixels": prepared["max_pixels"],
            "upscaled": upscaled,
            "image_size": list(image.size),
        }


def empty_past_numpy(batch: int = 1) -> list[np.ndarray]:
    past = []
    for _ in range(NUM_DECODER_LAYERS):
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
    return past


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


def make_warp_photo(source: Image.Image) -> Image.Image:
    """Perspective-skew a page so it looks like a handheld photo."""
    image = source.convert("RGB")
    width, height = image.size
    canvas = Image.new("RGB", (width, height), (48, 52, 58))
    inset = int(min(width, height) * 0.08)
    quad = (
        inset,
        int(height * 0.12),
        width - inset // 2,
        int(height * 0.04),
        width - int(inset * 1.4),
        height - int(height * 0.08),
        int(inset * 1.6),
        height - int(height * 0.02),
    )
    warped = image.transform(
        (width, height),
        ImageTransform.QuadTransform(quad),
        resample=Image.Resampling.BILINEAR,
        fillcolor=(48, 52, 58),
    )
    canvas.paste(warped)
    return canvas


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx-dir", type=Path, default=ONNX_DIR)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--max-new-tokens", type=int, default=32)
    parser.add_argument("--prompt", default=None)
    parser.add_argument(
        "--task",
        choices=tuple(TASK_PROMPTS),
        default="ocr",
        help="Official PaddleOCR-VL-1.6 task prompt (default OCR:).",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    image = Image.open(args.image).convert("RGB") if args.image else make_hello_image()
    parser = OrtParser(args.onnx_dir)
    result = parser.generate(
        image,
        prompt=args.prompt,
        max_new_tokens=args.max_new_tokens,
        task=args.task,
    )
    print(json.dumps({k: result[k] for k in result if k != "prompt_ids"}, indent=2)[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
