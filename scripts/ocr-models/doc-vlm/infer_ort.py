#!/usr/bin/env python3
"""Desktop ONNX Runtime greedy decode for the granite-docling SDK pack."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent / "instructions"))
from gate_paths import GRANITE_HF, GRANITE_ONNX  # noqa: E402
from tasks import GRANITE_TASKS, granite_user_text  # noqa: E402

IMAGE_TOKEN_ID = 100270
EOS_TOKEN_ID = 100257
DOCTAG_END_ID = 100328
NUM_LAYERS = 30
NUM_KV_HEADS = 3
HEAD_DIM = 64
HIDDEN = 576
VOCAB = 100352
DEFAULT_USER = "Convert this page to docling."


def session(path: Path) -> ort.InferenceSession:
    import os

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    threads = max(1, int(os.environ.get("ORT_NUM_THREADS") or os.environ.get("OMP_NUM_THREADS") or "14"))
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


def empty_past(batch: int = 1) -> list[np.ndarray]:
    past = []
    for _ in range(NUM_LAYERS):
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
        past.append(np.zeros((batch, NUM_KV_HEADS, 0, HEAD_DIM), dtype=np.float32))
    return past


def chat_prompt(processor, user_text: str) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": user_text},
            ],
        }
    ]
    return processor.apply_chat_template(messages, add_generation_prompt=True)


class OrtParser:
    def __init__(self, onnx_dir: Path, hf_src: Path):
        self.onnx_dir = Path(onnx_dir)
        self.hf_src = Path(hf_src)
        self.vision = session(self.onnx_dir / "vision_encoder.onnx")
        self.embed = session(self.onnx_dir / "embed_tokens.onnx")
        self.decoder = session(self.onnx_dir / "decoder_model_merged.onnx")
        from transformers import AutoProcessor

        self.processor = AutoProcessor.from_pretrained(
            str(self.hf_src), trust_remote_code=True, local_files_only=True
        )

    def prepare(self, image: Image.Image, user_text: str) -> dict:
        prompt = chat_prompt(self.processor, user_text)
        features = self.processor(text=prompt, images=[image], return_tensors="np")
        input_ids = np.asarray(features["input_ids"], dtype=np.int64)
        if input_ids.ndim == 1:
            input_ids = input_ids[None, :]
        pixel_values = np.asarray(features["pixel_values"], dtype=np.float32)
        mask = features.get("pixel_attention_mask")
        if mask is None:
            raise RuntimeError("granite processor did not return pixel_attention_mask")
        mask = np.asarray(mask)
        attention_mask = np.asarray(
            features.get("attention_mask", np.ones_like(input_ids)), dtype=np.int64
        )
        if attention_mask.ndim == 1:
            attention_mask = attention_mask[None, :]
        return {
            "input_ids": input_ids,
            "pixel_values": pixel_values,
            "pixel_attention_mask": mask,
            "attention_mask": attention_mask.astype(np.int64),
            "prompt_text": prompt,
            "user_text": user_text,
        }

    def encode_image(self, pixel_values: np.ndarray, pixel_attention_mask: np.ndarray) -> np.ndarray:
        pixels = pixel_values
        mask = pixel_attention_mask
        # Accept [N,3,H,W] or [1,N,3,H,W]
        if pixels.ndim == 4:
            pixels = pixels[None, ...]
        if mask.ndim == 3:
            mask = mask[None, ...]
        if pixels.ndim != 5:
            raise RuntimeError(f"unexpected pixel_values ndim {pixels.ndim} shape {pixels.shape}")
        # ORT vision wants bool mask
        mask_bool = mask.astype(bool)
        outputs = self.vision.run(
            None,
            {
                "pixel_values": pixels.astype(np.float32),
                "pixel_attention_mask": mask_bool,
            },
        )
        return outputs[0]

    def embed_tokens(self, input_ids: np.ndarray) -> np.ndarray:
        return self.embed.run(None, {"input_ids": input_ids.astype(np.int64)})[0]

    def scatter_image(self, input_ids: np.ndarray, text_embeds: np.ndarray, image_features: np.ndarray) -> np.ndarray:
        embeds = text_embeds.copy()
        mask = input_ids[0] == IMAGE_TOKEN_ID
        n_tokens = int(mask.sum())
        feats = image_features
        if feats.ndim == 3:
            feats = feats.reshape(-1, feats.shape[-1])
        if n_tokens != feats.shape[0]:
            raise ValueError(f"image tokens {n_tokens} != features {feats.shape[0]}")
        embeds[0, mask] = feats.astype(np.float32)
        return embeds

    def decode_step(
        self,
        inputs_embeds: np.ndarray,
        attention_mask: np.ndarray,
        past: list[np.ndarray],
    ) -> tuple[np.ndarray, list[np.ndarray]]:
        feeds = {
            "inputs_embeds": inputs_embeds.astype(np.float32),
            "attention_mask": attention_mask.astype(np.int64),
        }
        for layer in range(NUM_LAYERS):
            feeds[f"past_key_values.{layer}.key"] = past[2 * layer]
            feeds[f"past_key_values.{layer}.value"] = past[2 * layer + 1]
        out_names = ["logits"] + [
            name
            for layer in range(NUM_LAYERS)
            for name in (f"present.{layer}.key", f"present.{layer}.value")
        ]
        outputs = self.decoder.run(out_names, feeds)
        return outputs[0], list(outputs[1:])

    def generate(
        self,
        image: Image.Image,
        user_text: str = DEFAULT_USER,
        max_new_tokens: int = 64,
    ) -> dict:
        prepared = self.prepare(image, user_text)
        image_features = self.encode_image(
            prepared["pixel_values"], prepared["pixel_attention_mask"]
        )
        input_ids = prepared["input_ids"]
        text_embeds = self.embed_tokens(input_ids)
        prefill = self.scatter_image(input_ids, text_embeds, image_features)
        attn = prepared["attention_mask"]
        past = empty_past()
        logits, past = self.decode_step(prefill, attn, past)
        generated = [int(np.argmax(logits[0, -1]))]
        for _ in range(max_new_tokens - 1):
            token = generated[-1]
            if token in (EOS_TOKEN_ID, DOCTAG_END_ID):
                break
            step_ids = np.asarray([[token]], dtype=np.int64)
            step_embeds = self.embed_tokens(step_ids)
            attn = np.concatenate([attn, np.ones((1, 1), dtype=np.int64)], axis=1)
            logits, past = self.decode_step(step_embeds, attn, past)
            generated.append(int(np.argmax(logits[0, -1])))
        text = self.processor.tokenizer.decode(generated, skip_special_tokens=False)
        return {
            "tokens": generated,
            "text": text,
            "prompt_ids": input_ids[0].tolist(),
            "prompt_text": prepared["prompt_text"],
            "user_text": user_text,
        }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx-dir", type=Path, default=GRANITE_ONNX)
    parser.add_argument("--hf-src", type=Path, default=GRANITE_HF)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--max-new-tokens", type=int, default=32)
    parser.add_argument("--user-text", default=DEFAULT_USER)
    parser.add_argument(
        "--task",
        choices=tuple(GRANITE_TASKS),
        help="Official granite instruction id; overrides --user-text.",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if args.image:
        image = Image.open(args.image).convert("RGB")
    else:
        image = Image.new("RGB", (256, 192), "white")
    user_text = args.user_text
    if args.task:
        entry = {
            "region": {"x": 0, "y": 0, "width": image.size[0], "height": image.size[1]},
            "width": image.size[0],
            "height": image.size[1],
        }
        user_text = granite_user_text(args.task, entry)
    parser = OrtParser(args.onnx_dir, args.hf_src)
    result = parser.generate(
        image, user_text=user_text, max_new_tokens=args.max_new_tokens
    )
    print(json.dumps({k: result[k] for k in result if k != "prompt_ids"}, indent=2)[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
