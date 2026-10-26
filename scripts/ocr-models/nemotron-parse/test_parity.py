#!/usr/bin/env python3
"""Compare the ONNX export against Transformers greedy decode.

Saves reference tensors under build/ocr-models/nemotron-3.5-parse/refs/ so the
same page can be re-checked after a later quantization pass.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import torch

from constants import DEFAULT_PROMPT, PATCH_SIZE
from infer_ort import OrtParser, make_document_image, make_hello_image
from navit_pos import add_navit_positions_torch
from paths import HF_SRC, ONNX_DIR, REFS_DIR, ensure_hf_src_on_path

# Same pages and metrics for every pack. Thresholds depend on dtype.
PROFILES = {
    "fp32": {
        "vision_atol": 2e-4,
        "vision_cosine_min": 0.99999,
        "logits_atol": 5e-3,
        "logits_cosine_min": None,
        "token_prefix_ratio": 1.0,
        "layout_coverage_min": 1.0,
    },
    "fp16": {
        "vision_atol": 5e-2,
        "vision_cosine_min": 0.999,
        "logits_atol": 5e-1,
        "logits_cosine_min": 0.999,
        "token_prefix_ratio": 1.0,
        "layout_coverage_min": 0.99,
    },
    "int8": {
        "vision_atol": 1.0,
        "vision_cosine_min": 0.95,
        "logits_atol": 5.0,
        "logits_cosine_min": 0.95,
        "token_prefix_ratio": 0.75,
        "layout_coverage_min": 0.90,
    },
    "q4f16": {
        "vision_atol": 5e-2,
        "vision_cosine_min": 0.999,
        "logits_atol": 10.0,
        "logits_cosine_min": 0.90,
        "token_prefix_ratio": 0.75,
        "layout_coverage_min": 0.90,
    },
}

_LAYOUT_TAG = re.compile(r"<[^>\n]+>")


def layout_text(text: str) -> str:
    return re.sub(r"\s+", " ", _LAYOUT_TAG.sub("", text)).strip()


def layout_coverage(ref_text: str, got_text: str) -> float:
    ref_words = layout_text(ref_text).split()
    got_words = set(layout_text(got_text).split())
    if not ref_words:
        return 1.0
    return sum(word in got_words for word in ref_words) / len(ref_words)


def max_err(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64))))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    x = a.astype(np.float64).reshape(-1)
    y = b.astype(np.float64).reshape(-1)
    denom = np.linalg.norm(x) * np.linalg.norm(y)
    if denom == 0:
        return 1.0 if np.array_equal(x, y) else 0.0
    return float(np.dot(x, y) / denom)


def load_hf():
    ensure_hf_src_on_path()
    from transformers import AutoModel, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(HF_SRC), trust_remote_code=True, local_files_only=True
    )
    model = AutoModel.from_pretrained(
        str(HF_SRC),
        trust_remote_code=True,
        dtype=torch.float32,
        local_files_only=True,
    ).cpu().eval()
    return model, processor


def hf_references(model, processor, image, prompt: str, max_new_tokens: int):
    inputs = processor(
        images=[image], text=prompt, return_tensors="pt", add_special_tokens=False
    )
    pixel_values = inputs["pixel_values"]
    if pixel_values.ndim == 3:
        pass
    elif pixel_values.ndim == 2:
        pixel_values = pixel_values
    image_sizes = inputs["image_sizes"]
    content_sizes = inputs["content_sizes"]
    input_ids = inputs["input_ids"]

    with torch.inference_mode():
        vision, visual_mask = model.encoder(pixel_values, image_sizes, content_sizes)
        text_embeds = model.decoder.embed_tokens(input_ids)
        embeddings = torch.cat((vision, text_embeds), dim=1)
        attn = torch.cat((visual_mask, torch.ones_like(input_ids, dtype=torch.bool)), dim=1)
        from transformers.cache_utils import DynamicCache

        cache = DynamicCache()
        hidden = model.decoder(embeddings, cache, attn)
        prefill_logits = model.lm_head(hidden[:, vision.shape[1] :])

        generation = None
        if max_new_tokens > 0:
            generation = model.generate(
                input_ids=input_ids,
                pixel_values=pixel_values,
                image_sizes=image_sizes,
                content_sizes=content_sizes,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
                repetition_penalty=1.1,
                # generation_config forces EOS on the last slot; that is a
                # serving rule, not a graph property.
                forced_eos_token_id=None,
            )

    embedder = model.encoder.model_encoder.radio_model.model.patch_generator.embedder
    pos_embed = model.encoder.model_encoder.radio_model.model.patch_generator.pos_embed
    patches = pixel_values[0] if pixel_values.ndim == 3 else pixel_values
    image_size = tuple(int(x) for x in image_sizes.view(-1)[:2])
    content_size = tuple(int(x) for x in content_sizes.view(-1)[:2])
    with torch.inference_mode():
        patch_emb = embedder(patches.to(dtype=embedder.weight.dtype)).unsqueeze(0)
        positioned = add_navit_positions_torch(patch_emb, pos_embed, image_size, content_size)

    prompt_len = int(input_ids.shape[1])
    new_tokens = [] if generation is None else generation[0, prompt_len:].tolist()
    return {
        "vision": vision.cpu().float().numpy(),
        "visual_mask": visual_mask.cpu().numpy().astype(np.float32),
        "prefill_logits": prefill_logits.cpu().float().numpy(),
        "patch_tokens": positioned.cpu().float().numpy(),
        "tokens": new_tokens,
        "image_size": image_size,
        "content_size": content_size,
        "prompt_ids": input_ids[0].tolist(),
    }


def compare(
    name: str,
    ref: np.ndarray,
    got: np.ndarray,
    atol: float,
    rtol: float,
    cosine_min: float | None = None,
    abs_cap: float | None = None,
) -> dict:
    err = max_err(ref, got)
    cos = cosine(ref, got)
    close = bool(np.allclose(ref, got, atol=atol, rtol=rtol, equal_nan=False))
    if cosine_min is None:
        ok = close
    else:
        cap = max(atol * 100, 0.05) if abs_cap is None else abs_cap
        ok = bool(cos >= cosine_min and err <= cap)
    print(f"[parity] {name}: max_abs={err:.6g} cosine={cos:.8f} ok={ok}")
    return {"name": name, "max_abs": err, "cosine": cos, "ok": ok}


def longest_common_prefix(left, right) -> int:
    count = 0
    for a, b in zip(left, right):
        if a != b:
            break
        count += 1
    return count


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx-dir", type=Path, default=ONNX_DIR)
    parser.add_argument("--refs-dir", type=Path, default=REFS_DIR)
    parser.add_argument("--image", type=Path, help="Real page image (PNG/JPEG)")
    parser.add_argument(
        "--fixture",
        choices=("hello", "document"),
        default=None,
        help="Built-in page when --image is omitted. Default: hello",
    )
    parser.add_argument("--stem", help="Ref file stem. Default: image stem or fixture name")
    parser.add_argument(
        "--max-side",
        type=int,
        default=0,
        help="Downscale so the longest side is at most this many pixels. 0 keeps native size.",
    )
    parser.add_argument("--max-new-tokens", type=int, default=16)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--skip-generate", action="store_true")
    parser.add_argument(
        "--from-refs",
        action="store_true",
        help="Reuse saved Transformers goldens instead of re-running HF.",
    )
    parser.add_argument(
        "--profile",
        choices=tuple(PROFILES),
        default="fp32",
        help="Acceptance gates for the ONNX dtype under test.",
    )
    parser.add_argument(
        "--result-tag",
        help="Override the parity JSON suffix (default: --profile).",
    )
    return parser.parse_args(argv)


def load_page(args):
    from PIL import Image

    if args.image is not None:
        image = Image.open(args.image).convert("RGB")
        stem = args.stem or args.image.stem
        source = str(args.image)
    else:
        fixture = args.fixture or "hello"
        image = make_document_image() if fixture == "document" else make_hello_image()
        stem = args.stem or fixture
        source = f"fixture:{fixture}"
    max_side = int(args.max_side or 0)
    if max_side > 0:
        longest = max(image.size)
        if longest > max_side:
            scale = max_side / float(longest)
            resized = (
                max(1, int(image.size[0] * scale)),
                max(1, int(image.size[1] * scale)),
            )
            image = image.resize(resized, Image.Resampling.BILINEAR)
            source = f"{source}#max_side={max_side}"
    return image, stem, source


def load_saved_refs(refs_dir: Path, stem: str) -> dict:
    npz_path = refs_dir / f"{stem}.npz"
    json_path = refs_dir / f"{stem}.json"
    if not npz_path.is_file() or not json_path.is_file():
        raise FileNotFoundError(f"missing goldens {npz_path} / {json_path}")
    packed = np.load(npz_path)
    meta = json.loads(json_path.read_text(encoding="utf-8"))
    return {
        "vision": packed["vision"],
        "visual_mask": packed["visual_mask"],
        "prefill_logits": packed["prefill_logits"],
        "patch_tokens": packed["patch_tokens"],
        "tokens": [int(x) for x in packed["tokens"].tolist()],
        "image_size": tuple(int(x) for x in meta["image_size"]),
        "content_size": tuple(int(x) for x in meta["content_size"]),
        "prompt_ids": [int(x) for x in meta["prompt_ids"]],
    }


def save_refs(refs_dir: Path, stem: str, source: str, image, refs: dict, prompt: str) -> None:
    refs_dir.mkdir(parents=True, exist_ok=True)
    np.savez(
        refs_dir / f"{stem}.npz",
        vision=refs["vision"],
        visual_mask=refs["visual_mask"],
        prefill_logits=refs["prefill_logits"],
        patch_tokens=refs["patch_tokens"],
        tokens=np.asarray(refs["tokens"], dtype=np.int64),
    )
    (refs_dir / f"{stem}.json").write_text(
        json.dumps(
            {
                "source": source,
                "page_size": list(image.size),
                "prompt": prompt,
                "image_size": refs["image_size"],
                "content_size": refs["content_size"],
                "prompt_ids": refs["prompt_ids"],
                "tokens": refs["tokens"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    image, stem, source = load_page(args)
    gates = PROFILES[args.profile]
    print(
        f"[parity] page={source} size={image.size} stem={stem} "
        f"profile={args.profile} onnx={args.onnx_dir} "
        f"max_new_tokens={0 if args.skip_generate else args.max_new_tokens}"
    )
    if args.from_refs:
        print("[parity] loading saved Transformers goldens")
        refs = load_saved_refs(args.refs_dir, stem)
    else:
        print("[parity] loading Transformers reference on CPU")
        model, processor = load_hf()
        refs = hf_references(
            model,
            processor,
            image,
            args.prompt,
            0 if args.skip_generate else args.max_new_tokens,
        )
        del model
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        save_refs(args.refs_dir, stem, source, image, refs, args.prompt)

    print("[parity] running ONNX Runtime")
    parser = OrtParser(args.onnx_dir)
    vision, visual_mask, meta = parser.encode_image(image)
    prompt_ids = np.asarray([refs["prompt_ids"]], dtype=np.int64)
    text_embeds = parser.embed_tokens(prompt_ids)
    prefill = np.concatenate([vision, text_embeds], axis=1)
    attn = np.concatenate(
        [visual_mask, np.ones((1, prompt_ids.shape[1]), dtype=np.float32)], axis=1
    )
    from infer_ort import empty_past_numpy

    logits, _ = parser.decode_step(prefill, attn, empty_past_numpy())
    text_len = int(prompt_ids.shape[1])
    text_logits = logits[:, -text_len:]

    rows = refs["image_size"][0] // PATCH_SIZE
    cols = refs["image_size"][1] // PATCH_SIZE
    patch_tokens = refs["patch_tokens"].reshape(1, rows, cols, refs["patch_tokens"].shape[-1])
    vision_from_ref_pos, _ = parser.vision.run(None, {"patch_tokens": patch_tokens})

    results = [
        compare(
            "vision_vs_hf",
            refs["vision"],
            vision,
            atol=gates["vision_atol"],
            rtol=gates["vision_atol"],
            cosine_min=gates["vision_cosine_min"],
        ),
        compare(
            "vision_from_ref_pos",
            refs["vision"],
            vision_from_ref_pos,
            atol=gates["vision_atol"],
            rtol=gates["vision_atol"],
            cosine_min=gates["vision_cosine_min"],
        ),
        compare(
            "prefill_logits",
            refs["prefill_logits"],
            text_logits,
            atol=gates["logits_atol"],
            rtol=gates["logits_atol"],
            cosine_min=gates["logits_cosine_min"],
            abs_cap=max(gates["logits_atol"] * 20, 1.0),
        ),
    ]

    if not args.skip_generate:
        ort_out = parser.generate(
            image, prompt=args.prompt, max_new_tokens=args.max_new_tokens
        )
        prefix = longest_common_prefix(refs["tokens"], ort_out["tokens"])
        required = int(round(len(refs["tokens"]) * float(gates["token_prefix_ratio"])))
        exact = ort_out["tokens"] == refs["tokens"]
        hf_text = parser.processor.tokenizer.decode(refs["tokens"], skip_special_tokens=False)
        coverage = layout_coverage(hf_text, ort_out["text"])
        token_ok = exact or prefix >= required or coverage >= float(gates["layout_coverage_min"])
        print(
            f"[parity] tokens_match={exact} prefix={prefix}/{len(refs['tokens'])} "
            f"required={required} layout_coverage={coverage:.4f} ok={token_ok}"
        )
        print(f"[parity] hf_text={parser.processor.tokenizer.decode(refs['tokens'], skip_special_tokens=False)}")
        print(f"[parity] ort_text={ort_out['text']}")
        results.append(
            {
                "name": "greedy_tokens",
                "ok": token_ok,
                "exact": exact,
                "prefix": prefix,
                "required": required,
                "hf_len": len(refs["tokens"]),
                "ort_len": len(ort_out["tokens"]),
                "hf": refs["tokens"],
                "ort": ort_out["tokens"],
                "hf_text": hf_text,
                "ort_text": ort_out["text"],
                "layout_coverage": coverage,
                "layout_hf": layout_text(hf_text),
                "layout_ort": layout_text(ort_out["text"]),
            }
        )

    summary = {
        "source": source,
        "stem": stem,
        "profile": args.profile,
        "onnx_dir": str(args.onnx_dir),
        "results": results,
        "meta": meta,
    }
    payload = json.dumps(summary, indent=2) + "\n"
    tag = args.result_tag or args.profile
    out_name = f"{stem}.{tag}.parity.json" if tag != "fp32" else f"{stem}.parity.json"
    args.refs_dir.mkdir(parents=True, exist_ok=True)
    (args.refs_dir / out_name).write_text(payload, encoding="utf-8")
    if args.profile == "fp32":
        (args.refs_dir / "parity.json").write_text(payload, encoding="utf-8")
    failed = [row for row in results if not row["ok"]]
    if failed:
        print(f"[parity] FAILED {len(failed)} check(s)")
        return 1
    print("[parity] PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
