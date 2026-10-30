#!/usr/bin/env python3
"""Compare the ONNX export against Transformers greedy decode.

Saves goldens under build/ocr-models/paddleocr-vl-1.6/refs/ so quantized
packs can reuse the same pages with --from-refs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import torch

from infer_ort import OrtParser, empty_past_numpy, make_hello_image, make_warp_photo, ocr_prompt_text
from patch_hf_src import apply_causal_mask_patch
from paths import HF_SRC, ONNX_DIR, PAGES_DIR, REFS_DIR, ensure_hf_src_on_path
from rope_index import rope_index_numpy

PROFILES = {
    "fp32": {
        "vision_atol": 2e-3,
        "vision_cosine_min": 0.9999,
        "logits_atol": 5e-2,
        "logits_cosine_min": 0.999,
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

_MARKUP = re.compile(r"<[^>]+>")
_MD_TICK = re.compile(r"[#*_`]+")


def layout_text(text: str) -> str:
    cleaned = _MARKUP.sub(" ", text)
    cleaned = _MD_TICK.sub(" ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


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
    apply_causal_mask_patch()
    from transformers import AutoModelForCausalLM, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(HF_SRC), trust_remote_code=True, local_files_only=True
    )
    model = AutoModelForCausalLM.from_pretrained(
        str(HF_SRC),
        trust_remote_code=True,
        dtype=torch.float32,
        local_files_only=True,
        attn_implementation="eager",
    ).cpu().eval()
    if hasattr(model.visual, "config"):
        model.visual.config._attn_implementation = "eager"
    return model, processor


def hf_references(model, processor, image, max_new_tokens: int):
    prompt = ocr_prompt_text(processor)
    inputs = processor(images=image, text=[prompt], return_tensors="pt")
    input_ids = inputs["input_ids"]
    pixel_values = inputs["pixel_values"]
    image_grid_thw = inputs["image_grid_thw"]
    attention_mask = inputs.get("attention_mask")
    if attention_mask is None:
        attention_mask = torch.ones_like(input_ids)

    with torch.inference_mode():
        outputs = model(
            input_ids=input_ids,
            pixel_values=pixel_values,
            image_grid_thw=image_grid_thw,
            attention_mask=attention_mask,
            use_cache=True,
        )
        prefill_logits = outputs.logits
        pixel = pixel_values
        if pixel.ndim == 4:
            pixel = pixel.unsqueeze(0)
        image_embeds = official_image_embeds(model, pixel, image_grid_thw)
        generation = None
        if max_new_tokens > 0:
            generation = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
            )

    prompt_len = int(input_ids.shape[1])
    new_tokens = [] if generation is None else generation[0, prompt_len:].tolist()
    return {
        "image_embeds": image_embeds.cpu().float().numpy(),
        "prefill_logits": prefill_logits.cpu().float().numpy(),
        "tokens": new_tokens,
        "prompt_ids": input_ids[0].tolist(),
        "image_grid_thw": image_grid_thw.cpu().numpy().astype(np.int64),
        "prompt_text": prompt,
    }


def official_image_embeds(model, pixel_values, image_grid_thw):
    """Gold vision features from the Hugging Face modules (not the ONNX wrapper)."""
    pixel = pixel_values.float()
    if pixel.ndim == 4:
        pixel = pixel.unsqueeze(0)
    grids = []
    for thw in image_grid_thw:
        grids.append(tuple(int(x) for x in thw.detach().cpu().tolist()))
    numel = int(np.prod(grids[0]))
    siglip_position_ids = torch.arange(numel, device=pixel.device) % np.prod(grids[0][1:])
    sample_indices = torch.zeros(numel, dtype=torch.int64, device=pixel.device)
    cu_seqlens = torch.tensor([0, numel], dtype=torch.int32, device=pixel.device)
    vision_outputs = model.visual(
        pixel_values=pixel,
        image_grid_thw=grids,
        position_ids=siglip_position_ids,
        vision_return_embed_list=True,
        interpolate_pos_encoding=True,
        sample_indices=sample_indices,
        cu_seqlens=cu_seqlens,
        return_pooler_output=False,
        use_rope=True,
        window_size=-1,
    )
    image_embeds = model.mlp_AR(vision_outputs.last_hidden_state, image_grid_thw)
    if isinstance(image_embeds, (list, tuple)):
        image_embeds = torch.cat(image_embeds, dim=0)
    return image_embeds


def compare(name: str, ref: np.ndarray, got: np.ndarray, atol: float, rtol: float, cosine_min: float | None, abs_cap: float | None = None) -> dict:
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
    parser.add_argument("--image", type=Path)
    parser.add_argument(
        "--fixture",
        choices=("hello", "omnidoc", "photo"),
        default=None,
    )
    parser.add_argument("--stem", help="Ref file stem")
    parser.add_argument("--max-side", type=int, default=0)
    parser.add_argument("--max-new-tokens", type=int, default=16)
    parser.add_argument("--skip-generate", action="store_true")
    parser.add_argument("--from-refs", action="store_true")
    parser.add_argument("--profile", choices=tuple(PROFILES), default="fp32")
    parser.add_argument("--result-tag")
    return parser.parse_args(argv)


def omnidoc_path() -> Path:
    return PAGES_DIR / "images" / "PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png"


def photo_path() -> Path:
    return PAGES_DIR / "images" / "meyer_page_014_warp.jpg"


def load_page(args):
    from PIL import Image

    if args.image is not None:
        image = Image.open(args.image).convert("RGB")
        stem = args.stem or args.image.stem
        source = str(args.image)
    else:
        fixture = args.fixture or "hello"
        if fixture == "omnidoc":
            image = Image.open(omnidoc_path()).convert("RGB")
            stem = args.stem or "omnidoc_meyer_ch2_p014"
            source = str(omnidoc_path())
        elif fixture == "photo":
            path = photo_path()
            if path.is_file():
                image = Image.open(path).convert("RGB")
                source = str(path)
            else:
                image = make_warp_photo(Image.open(omnidoc_path()).convert("RGB"))
                source = "fixture:photo-warp"
            stem = args.stem or "camera_warp"
        else:
            image = make_hello_image()
            stem = args.stem or "hello_world"
            source = "fixture:hello"
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
        "image_embeds": packed["image_embeds"],
        "prefill_logits": packed["prefill_logits"],
        "tokens": [int(x) for x in packed["tokens"].tolist()],
        "prompt_ids": [int(x) for x in meta["prompt_ids"]],
        "image_grid_thw": np.asarray(meta["image_grid_thw"], dtype=np.int64),
        "prompt_text": meta.get("prompt_text"),
    }


def save_refs(refs_dir: Path, stem: str, source: str, image, refs: dict) -> None:
    refs_dir.mkdir(parents=True, exist_ok=True)
    np.savez(
        refs_dir / f"{stem}.npz",
        image_embeds=refs["image_embeds"],
        prefill_logits=refs["prefill_logits"],
        tokens=np.asarray(refs["tokens"], dtype=np.int64),
    )
    (refs_dir / f"{stem}.json").write_text(
        json.dumps(
            {
                "source": source,
                "page_size": list(image.size),
                "prompt_ids": refs["prompt_ids"],
                "tokens": refs["tokens"],
                "image_grid_thw": np.asarray(refs["image_grid_thw"]).tolist(),
                "prompt_text": refs.get("prompt_text"),
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
        f"max_new_tokens={0 if args.skip_generate else args.max_new_tokens}",
        flush=True,
    )
    if args.from_refs:
        print("[parity] loading saved Transformers goldens", flush=True)
        refs = load_saved_refs(args.refs_dir, stem)
    else:
        print("[parity] loading Transformers reference on CPU", flush=True)
        model, processor = load_hf()
        refs = hf_references(
            model,
            processor,
            image,
            0 if args.skip_generate else args.max_new_tokens,
        )
        del model
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        save_refs(args.refs_dir, stem, source, image, refs)

    print("[parity] running ONNX Runtime", flush=True)
    parser = OrtParser(args.onnx_dir)
    prepared = parser.prepare(image, refs.get("prompt_text"))
    image_embeds = parser.encode_image(prepared["pixel_values"], prepared["image_grid_thw"])
    prompt_ids = np.asarray([refs["prompt_ids"]], dtype=np.int64)
    text_embeds = parser.embed_tokens(prompt_ids)
    prefill = parser.splice_image(prompt_ids, text_embeds, image_embeds)
    attn = prepared["attention_mask"].astype(np.float32)
    position_ids, _ = rope_index_numpy(prompt_ids, prepared["image_grid_thw"], attn)
    logits, _ = parser.decode_step(prefill, attn, position_ids, empty_past_numpy())

    results = [
        compare(
            "vision_vs_hf",
            refs["image_embeds"],
            image_embeds,
            atol=gates["vision_atol"],
            rtol=gates["vision_atol"],
            cosine_min=gates["vision_cosine_min"],
        ),
        compare(
            "prefill_logits",
            refs["prefill_logits"],
            logits,
            atol=gates["logits_atol"],
            rtol=gates["logits_atol"],
            cosine_min=gates["logits_cosine_min"],
            abs_cap=max(gates["logits_atol"] * 20, 1.0),
        ),
    ]

    if not args.skip_generate:
        ort_out = parser.generate(
            image, prompt=refs.get("prompt_text"), max_new_tokens=args.max_new_tokens
        )
        prefix = longest_common_prefix(refs["tokens"], ort_out["tokens"])
        required = int(round(len(refs["tokens"]) * float(gates["token_prefix_ratio"])))
        exact = ort_out["tokens"] == refs["tokens"]
        hf_text = parser.processor.tokenizer.decode(refs["tokens"], skip_special_tokens=False)
        coverage = layout_coverage(hf_text, ort_out["text"])
        token_ok = exact or prefix >= required or coverage >= float(gates["layout_coverage_min"])
        print(
            f"[parity] tokens_match={exact} prefix={prefix}/{len(refs['tokens'])} "
            f"required={required} layout_coverage={coverage:.4f} ok={token_ok}",
            flush=True,
        )
        print(f"[parity] hf_text={hf_text[:500]}", flush=True)
        print(f"[parity] ort_text={ort_out['text'][:500]}", flush=True)
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
        "image_grid_thw": np.asarray(refs["image_grid_thw"]).tolist(),
        "image_tokens": int(image_embeds.shape[0]),
    }
    payload = json.dumps(summary, indent=2) + "\n"
    tag = args.result_tag or args.profile
    out_name = f"{stem}.{tag}.parity.json" if tag != "fp32" else f"{stem}.parity.json"
    args.refs_dir.mkdir(parents=True, exist_ok=True)
    (args.refs_dir / out_name).write_text(payload, encoding="utf-8")
    if args.profile == "fp32" and stem in {"hello_world", "hello"}:
        (args.refs_dir / "parity.json").write_text(payload, encoding="utf-8")
    failed = [row for row in results if not row["ok"]]
    if failed:
        print(f"[parity] FAILED {len(failed)} check(s)", flush=True)
        return 1
    print("[parity] PASSED", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
