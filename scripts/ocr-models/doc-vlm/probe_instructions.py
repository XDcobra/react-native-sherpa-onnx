#!/usr/bin/env python3
"""Phase 0 granite instruction probe: HF greedy vs ORT pack, plus prompt ids."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent / "instructions"))
sys.path.insert(0, str(SCRIPT_DIR))

from fixtures import load_catalog  # noqa: E402
from golden import existing_complete, load_hf_cache, save_hf_cache, write_golden  # noqa: E402
from grammar import inspect  # noqa: E402
from infer_ort import OrtParser, chat_prompt  # noqa: E402
from gate_paths import GRANITE_HF, GRANITE_ONNX, REPO_ROOT  # noqa: E402
from runtime import (  # noqa: E402
    batch_to_device,
    family_lock,
    log_progress,
    peak_rss_mb,
    release_models,
    resolve_device,
    token_heartbeat,
)
from tasks import GRANITE_TASKS, granite_user_text  # noqa: E402

PACK_ID = "docvlm-granite-258m-fp32"


def load_hf(hf_src: Path, device):
    from transformers import AutoModelForVision2Seq, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(hf_src), trust_remote_code=True, local_files_only=True
    )
    try:
        model = AutoModelForVision2Seq.from_pretrained(
            str(hf_src),
            trust_remote_code=True,
            dtype=torch.float32,
            local_files_only=True,
            low_cpu_mem_usage=True,
        )
    except Exception:
        from transformers import AutoModelForImageTextToText

        model = AutoModelForImageTextToText.from_pretrained(
            str(hf_src),
            trust_remote_code=True,
            dtype=torch.float32,
            local_files_only=True,
            low_cpu_mem_usage=True,
        )
    print(f"[probe] hf ready rss_mb={peak_rss_mb():.0f} device={device}", flush=True)
    return model.to(device).eval(), processor


def hf_generate(model, processor, image: Image.Image, user_text: str, max_new_tokens: int) -> dict:
    prompt = chat_prompt(processor, user_text)
    inputs = batch_to_device(
        processor(text=prompt, images=[image], return_tensors="pt"),
        next(model.parameters()).device,
    )
    input_ids = inputs["input_ids"]
    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=1,
            stopping_criteria=[token_heartbeat(f"user={user_text[:40]!r}")],
        )
    prompt_len = int(input_ids.shape[1])
    tokens = generated[0, prompt_len:].tolist()
    text = processor.tokenizer.decode(tokens, skip_special_tokens=False)
    return {
        "tokens": tokens,
        "text": text,
        "prompt_ids": input_ids[0].tolist(),
        "prompt_text": prompt,
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        action="append",
        choices=tuple(GRANITE_TASKS) + ("all",),
        help="Repeatable. `all` = every granite instruction. Default: page.",
    )
    parser.add_argument("--fixture", default=None)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--onnx-dir", type=Path, default=GRANITE_ONNX)
    parser.add_argument("--hf-src", type=Path, default=GRANITE_HF)
    parser.add_argument("--ids-only", action="store_true")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument(
        "--ignore-hf-cache",
        action="store_true",
        help="Regenerate HF even when phase0-cache already has tokens.",
    )
    return parser.parse_args(argv)


def _tasks(raw: list[str] | None) -> list[str]:
    if not raw:
        return ["page"]
    if "all" in raw:
        return list(GRANITE_TASKS)
    return raw


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    catalog = load_catalog()
    tasks = _tasks(args.task)
    jobs = []
    for task in tasks:
        spec = GRANITE_TASKS[task]
        fixtures = [args.fixture] if args.fixture else list(spec["fixtures"])
        for fixture_id in fixtures:
            entry = catalog[fixture_id]
            jobs.append((task, spec, fixture_id, entry))

    if args.ids_only:
        print(f"[probe] load_ort onnx={args.onnx_dir} ids_only", flush=True)
        ort = OrtParser(args.onnx_dir, args.hf_src)
        for task, spec, fixture_id, entry in jobs:
            image = Image.open(REPO_ROOT / entry["path"]).convert("RGB")
            user_text = granite_user_text(task, entry)
            prepared = ort.prepare(image, user_text)
            print(
                json.dumps(
                    {
                        "task": task,
                        "fixture": fixture_id,
                        "prompt_ids": prepared["input_ids"][0].tolist(),
                        "user_text": user_text,
                    }
                )[:2000],
                flush=True,
            )
        return 0

    pending = [
        job
        for job in jobs
        if not existing_complete(
            "doc_vlm", job[0], job[2], max_new_tokens=args.max_new_tokens
        )
    ]
    print(
        f"[probe] jobs={len(jobs)} pending={len(pending)} skipped={len(jobs) - len(pending)} tasks={tasks}",
        flush=True,
    )
    hf_runs: list[tuple] = []
    need_hf = []
    for task, spec, fixture_id, entry in pending:
        user_text = granite_user_text(task, entry)
        cached = (
            None
            if args.ignore_hf_cache
            else load_hf_cache(
                "doc_vlm", task, fixture_id, max_new_tokens=args.max_new_tokens
            )
        )
        if cached is not None:
            print(
                f"[probe] hf_cache task={task} fixture={fixture_id} tokens={len(cached['tokens'])}",
                flush=True,
            )
            hf_runs.append((task, spec, fixture_id, entry, user_text, cached))
        else:
            need_hf.append((task, spec, fixture_id, entry, user_text))
    if need_hf:
        print(f"[probe] load_hf missing={len(need_hf)}", flush=True)
        model, processor = load_hf(args.hf_src, resolve_device(args.device))
        hf_t0 = time.time()
        for i, (task, spec, fixture_id, entry, user_text) in enumerate(need_hf, 1):
            image = Image.open(REPO_ROOT / entry["path"]).convert("RGB")
            print(
                f"[probe] hf_generate task={task} fixture={fixture_id} user={user_text!r}",
                flush=True,
            )
            hf = hf_generate(model, processor, image, user_text, args.max_new_tokens)
            save_hf_cache(
                "doc_vlm",
                task,
                fixture_id,
                hf,
                max_new_tokens=args.max_new_tokens,
            )
            print(
                f"[probe] hf_done task={task} fixture={fixture_id} tokens={len(hf['tokens'])}",
                flush=True,
            )
            log_progress("granite-hf", i, len(need_hf), hf_t0, f"task={task} fixture={fixture_id}")
            hf_runs.append((task, spec, fixture_id, entry, user_text, hf))
        del model, processor
        print(f"[probe] hf released rss_mb={release_models():.0f}", flush=True)

    if not hf_runs:
        print("[probe] nothing pending", flush=True)
        return 0

    print(f"[probe] load_ort onnx={args.onnx_dir}", flush=True)
    ort = OrtParser(args.onnx_dir, args.hf_src)
    print(f"[probe] ort ready rss_mb={peak_rss_mb():.0f}", flush=True)
    results = []
    ort_t0 = time.time()
    for i, (task, spec, fixture_id, entry, user_text, hf) in enumerate(hf_runs, 1):
        image = Image.open(REPO_ROOT / entry["path"]).convert("RGB")
        print(
            f"[probe] ort_generate task={task} fixture={fixture_id} hf_tokens={len(hf['tokens'])}",
            flush=True,
        )
        ort_out = ort.generate(
            image, user_text=user_text, max_new_tokens=args.max_new_tokens
        )
        identical = hf["tokens"] == ort_out["tokens"]
        grammar = inspect(spec["grammar"], hf["text"])
        dest = write_golden(
            "doc_vlm",
            task,
            fixture_id,
            prompt_ids=hf["prompt_ids"],
            prompt_text=hf["prompt_text"],
            hf_tokens=hf["tokens"],
            ort_tokens=ort_out["tokens"],
            hf_text=hf["text"],
            ort_text=ort_out["text"],
            pack_id=PACK_ID,
            preprocess={"user_text": user_text, "image": entry["path"]},
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
            "user_text": user_text,
        }
        print(json.dumps(row), flush=True)
        log_progress(
            "granite-ort",
            i,
            len(hf_runs),
            ort_t0,
            f"task={task} fixture={fixture_id} identical={identical}",
        )
        results.append(row)
    return 0 if all(r.get("identical") and r.get("grammar_ok") for r in results) else 2


if __name__ == "__main__":
    with family_lock("doc_vlm"):
        raise SystemExit(main())
