#!/usr/bin/env python3
"""Phase 0 PaddleOCR-VL instruction probe: HF greedy vs ORT pack."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
INSTR = SCRIPT_DIR.parent / "instructions"
sys.path.insert(0, str(INSTR))

from fixtures import load_catalog  # noqa: E402
from golden import existing_complete, load_hf_cache, save_hf_cache, write_golden  # noqa: E402
from grammar import inspect  # noqa: E402
from gate_paths import PADDLE_HF, PADDLE_ONNX, REPO_ROOT  # noqa: E402
from runtime import (  # noqa: E402
    batch_to_device,
    log_progress,
    peak_rss_mb,
    release_models,
    resolve_device,
    token_heartbeat,
)
from tasks import PADDLEOCR_VL_TASKS  # noqa: E402


def _load_family(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_family_paths = _load_family("paddle_paths", SCRIPT_DIR / "paths.py")
sys.path.insert(0, str(SCRIPT_DIR))
infer_ort = _load_family("paddle_infer_ort", SCRIPT_DIR / "infer_ort.py")
patch_hf_src = _load_family("paddle_patch_hf_src", SCRIPT_DIR / "patch_hf_src.py")

PACK_ID = "paddleocr-vl-1.6-fp16"


def load_hf(device):
    _family_paths.ensure_hf_src_on_path()
    patch_hf_src.apply_causal_mask_patch()
    from transformers import AutoProcessor

    print(f"[probe] loading processor path={PADDLE_HF}", flush=True)
    processor = AutoProcessor.from_pretrained(
        str(PADDLE_HF), trust_remote_code=True, local_files_only=True
    )
    from transformers import AutoModelForCausalLM

    print(f"[probe] loading model dtype=fp32 device={device}", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(PADDLE_HF),
        trust_remote_code=True,
        dtype=torch.float32,
        local_files_only=True,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
    ).to(device).eval()
    if hasattr(model, "visual") and hasattr(model.visual, "config"):
        model.visual.config._attn_implementation = "eager"
    # Pack default is use_cache=False (recomputes the whole prompt every token).
    # Greedy + KV cache is what test_parity.py uses and matches ORT incremental decode.
    model.config.use_cache = True
    if getattr(model, "generation_config", None) is not None:
        model.generation_config.use_cache = True
    print(f"[probe] hf ready rss_mb={peak_rss_mb():.0f} use_cache=True", flush=True)
    return model, processor


def hf_generate(model, processor, image: Image.Image, task: str, max_new_tokens: int) -> dict:
    image, upscaled = infer_ort.maybe_upscale_spotting(image, task)
    pixels = infer_ort.max_pixels_for_task(task)
    image_processor = getattr(processor, "image_processor", None)
    previous = None
    if image_processor is not None and hasattr(image_processor, "max_pixels"):
        previous = image_processor.max_pixels
        image_processor.max_pixels = int(pixels)
    try:
        prompt = infer_ort.ocr_prompt_text(processor, task)
        inputs = batch_to_device(
            processor(images=image, text=[prompt], return_tensors="pt"),
            next(model.parameters()).device,
        )
        input_ids = inputs["input_ids"]
        heartbeat_every = 1 if task == "spotting" else 8
        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
                use_cache=True,
                stopping_criteria=[
                    token_heartbeat(f"task={task}", every=heartbeat_every)
                ],
            )
    finally:
        if image_processor is not None and previous is not None:
            image_processor.max_pixels = previous
    prompt_len = int(input_ids.shape[1])
    tokens = generated[0, prompt_len:].tolist()
    text = processor.tokenizer.decode(tokens, skip_special_tokens=False)
    return {
        "tokens": tokens,
        "text": text,
        "prompt_ids": input_ids[0].tolist(),
        "prompt_text": prompt,
        "upscaled": upscaled,
        "max_pixels": pixels,
        "image_size": list(image.size),
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        action="append",
        choices=tuple(PADDLEOCR_VL_TASKS) + ("all",),
        help="Repeatable. `all` = every PaddleOCR-VL task. Default: ocr.",
    )
    parser.add_argument("--fixture", default=None)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--onnx-dir", type=Path, default=PADDLE_ONNX)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument(
        "--ignore-hf-cache",
        action="store_true",
        help="Regenerate HF even when phase0-cache already has tokens.",
    )
    return parser.parse_args(argv)


def _tasks(raw: list[str] | None) -> list[str]:
    if not raw:
        return ["ocr"]
    if "all" in raw:
        return list(PADDLEOCR_VL_TASKS)
    return raw


def _jobs(catalog: dict, tasks: list[str], fixture: str | None):
    jobs = []
    for task in tasks:
        spec = PADDLEOCR_VL_TASKS[task]
        fixtures = [fixture] if fixture else list(spec["fixtures"])
        for fixture_id in fixtures:
            entry = catalog[fixture_id]
            image_path = Path(entry["path"])
            if not image_path.is_absolute():
                image_path = REPO_ROOT / image_path
            jobs.append((task, spec, fixture_id, entry, image_path))
    return jobs


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    catalog = load_catalog()
    tasks = _tasks(args.task)
    jobs = _jobs(catalog, tasks, args.fixture)
    pending = [
        job
        for job in jobs
        if not existing_complete(
            "paddleocr_vl", job[0], job[2], max_new_tokens=args.max_new_tokens
        )
    ]
    skipped = len(jobs) - len(pending)
    print(
        f"[probe] jobs={len(jobs)} pending={len(pending)} skipped={skipped} tasks={tasks}",
        flush=True,
    )
    hf_runs: list[tuple] = []
    need_hf = []
    for task, spec, fixture_id, entry, image_path in pending:
        cached = (
            None
            if args.ignore_hf_cache
            else load_hf_cache(
                "paddleocr_vl",
                task,
                fixture_id,
                max_new_tokens=args.max_new_tokens,
            )
        )
        if cached is not None:
            print(
                f"[probe] hf_cache task={task} fixture={fixture_id} tokens={len(cached['tokens'])}",
                flush=True,
            )
            hf_runs.append((task, spec, fixture_id, entry, image_path, cached))
        else:
            need_hf.append((task, spec, fixture_id, entry, image_path))
    if need_hf:
        print(f"[probe] load_hf missing={len(need_hf)}", flush=True)
        model, processor = load_hf(resolve_device(args.device))
        hf_t0 = time.time()
        for i, (task, spec, fixture_id, entry, image_path) in enumerate(need_hf, 1):
            image = Image.open(image_path).convert("RGB")
            print(
                f"[probe] hf_generate task={task} fixture={fixture_id} size={image.size}",
                flush=True,
            )
            hf = hf_generate(model, processor, image, task, args.max_new_tokens)
            save_hf_cache(
                "paddleocr_vl",
                task,
                fixture_id,
                hf,
                max_new_tokens=args.max_new_tokens,
            )
            print(
                f"[probe] hf_done task={task} fixture={fixture_id} tokens={len(hf['tokens'])}",
                flush=True,
            )
            log_progress("paddle-hf", i, len(need_hf), hf_t0, f"task={task} fixture={fixture_id}")
            hf_runs.append((task, spec, fixture_id, entry, image_path, hf))
        del model, processor
        print(f"[probe] hf released rss_mb={release_models():.0f}", flush=True)

    if not hf_runs:
        print("[probe] nothing pending", flush=True)
        return 0

    print(f"[probe] load_ort onnx={args.onnx_dir}", flush=True)
    ort = infer_ort.OrtParser(args.onnx_dir)
    print(f"[probe] ort ready rss_mb={peak_rss_mb():.0f}", flush=True)
    results = []
    ort_t0 = time.time()
    for i, (task, spec, fixture_id, entry, image_path, hf) in enumerate(hf_runs, 1):
        image = Image.open(image_path).convert("RGB")
        print(
            f"[probe] ort_generate task={task} fixture={fixture_id} hf_tokens={len(hf['tokens'])}",
            flush=True,
        )
        ort_out = ort.generate(image, task=task, max_new_tokens=args.max_new_tokens)
        identical = hf["tokens"] == ort_out["tokens"]
        grammar = inspect(spec["grammar"], hf["text"])
        dest = write_golden(
            "paddleocr_vl",
            task,
            fixture_id,
            prompt_ids=hf["prompt_ids"],
            prompt_text=hf["prompt_text"],
            hf_tokens=hf["tokens"],
            ort_tokens=ort_out["tokens"],
            hf_text=hf["text"],
            ort_text=ort_out["text"],
            pack_id=PACK_ID,
            preprocess={
                "max_pixels": hf["max_pixels"],
                "upscaled": hf["upscaled"],
                "image_size": hf["image_size"],
                "image": entry["path"],
            },
            grammar=grammar,
            identical=identical,
            max_new_tokens=args.max_new_tokens,
        )
        row = {
            "task": task,
            "fixture": fixture_id,
            "identical": identical,
            "grammar_ok": grammar["ok"],
            "dir": str(dest),
        }
        print(json.dumps(row), flush=True)
        log_progress(
            "paddle-ort",
            i,
            len(hf_runs),
            ort_t0,
            f"task={task} fixture={fixture_id} identical={identical}",
        )
        results.append(row)
    return 0 if all(r["identical"] and r["grammar_ok"] for r in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
