#!/usr/bin/env python3
"""Phase 0 Nemotron-Parse output-profile probe: HF greedy vs ORT pack."""

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
from gate_paths import NEMOTRON_HF, NEMOTRON_ONNX, REPO_ROOT  # noqa: E402
from runtime import (  # noqa: E402
    batch_to_device,
    family_lock,
    log_progress,
    peak_rss_mb,
    release_models,
    resolve_device,
    token_heartbeat,
)
from tasks import NEMOTRON_DEFAULT_PROFILE, nemotron_profiles  # noqa: E402


def _load_family(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_family_paths = _load_family("nemotron_paths", SCRIPT_DIR / "paths.py")
sys.path.insert(0, str(SCRIPT_DIR))
infer_ort = _load_family("nemotron_infer_ort", SCRIPT_DIR / "infer_ort.py")

PACK_ID = "nemotron-3.5-parse-int8"
PROFILES = {p["name"]: p for p in nemotron_profiles()}


def load_hf(device):
    _family_paths.ensure_hf_src_on_path()
    from transformers import AutoModel, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(NEMOTRON_HF), trust_remote_code=True, local_files_only=True
    )
    print(f"[probe] loading model dtype=fp32 device={device}", flush=True)
    model = AutoModel.from_pretrained(
        str(NEMOTRON_HF),
        trust_remote_code=True,
        dtype=torch.float32,
        local_files_only=True,
        low_cpu_mem_usage=True,
    )
    print(f"[probe] hf ready rss_mb={peak_rss_mb():.0f}", flush=True)
    return model.to(device).eval(), processor


def hf_generate(model, processor, image: Image.Image, prompt: str, max_new_tokens: int) -> dict:
    inputs = batch_to_device(
        processor(
            images=[image], text=prompt, return_tensors="pt", add_special_tokens=False
        ),
        next(model.parameters()).device,
    )
    input_ids = inputs["input_ids"]
    with torch.inference_mode():
        generated = model.generate(
            input_ids=input_ids,
            pixel_values=inputs["pixel_values"],
            image_sizes=inputs["image_sizes"],
            content_sizes=inputs["content_sizes"],
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=1,
            repetition_penalty=1.1,
            forced_eos_token_id=None,
            stopping_criteria=[token_heartbeat("nemotron")],
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
        "--output-profile",
        action="append",
        help="Repeatable profile name, or `all`. Default: NVIDIA card default.",
    )
    parser.add_argument("--fixture", default=None)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--onnx-dir", type=Path, default=NEMOTRON_ONNX)
    parser.add_argument("--ids-only", action="store_true")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument(
        "--ignore-hf-cache",
        action="store_true",
        help="Regenerate HF even when phase0-cache already has tokens.",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    raw_profiles = args.output_profile or [NEMOTRON_DEFAULT_PROFILE]
    if "all" in raw_profiles:
        profile_names = list(PROFILES)
    else:
        profile_names = raw_profiles
    unknown = [name for name in profile_names if name not in PROFILES]
    if unknown:
        raise SystemExit(f"unknown profile {unknown}; have {sorted(PROFILES)}")
    catalog = load_catalog()
    jobs = []
    for profile_name in profile_names:
        spec = PROFILES[profile_name]
        fixtures = [args.fixture] if args.fixture else list(spec["fixtures"])
        for fixture_id in fixtures:
            entry = catalog[fixture_id]
            image_path = Path(entry["path"])
            if not image_path.is_absolute():
                image_path = REPO_ROOT / image_path
            jobs.append((profile_name, spec, fixture_id, entry, image_path))

    if args.ids_only:
        print(f"[probe] load_ort onnx={args.onnx_dir} ids_only", flush=True)
        ort = infer_ort.OrtParser(args.onnx_dir)
        for profile_name, spec, fixture_id, entry, image_path in jobs:
            encoded = ort.processor.tokenizer(
                spec["prompt"], add_special_tokens=False, return_tensors="np"
            )
            ids = encoded["input_ids"]
            if getattr(ids, "ndim", 1) == 2:
                ids = ids[0]
            print(
                json.dumps(
                    {
                        "profile": profile_name,
                        "fixture": fixture_id,
                        "prompt_ids": [int(x) for x in ids],
                        "prompt": spec["prompt"],
                    }
                ),
                flush=True,
            )
        return 0

    pending = [
        job
        for job in jobs
        if not existing_complete(
            "nemotron_parse",
            "page",
            job[2],
            max_new_tokens=args.max_new_tokens,
            profile=job[1]["name"],
        )
    ]
    print(
        f"[probe] jobs={len(jobs)} pending={len(pending)} skipped={len(jobs) - len(pending)} profiles={profile_names}",
        flush=True,
    )
    hf_runs: list[tuple] = []
    need_hf = []
    for profile_name, spec, fixture_id, entry, image_path in pending:
        cached = (
            None
            if args.ignore_hf_cache
            else load_hf_cache(
                "nemotron_parse",
                "page",
                fixture_id,
                max_new_tokens=args.max_new_tokens,
                profile=spec["name"],
            )
        )
        if cached is not None:
            print(
                f"[probe] hf_cache profile={profile_name} fixture={fixture_id} tokens={len(cached['tokens'])}",
                flush=True,
            )
            hf_runs.append((profile_name, spec, fixture_id, entry, image_path, cached))
        else:
            need_hf.append((profile_name, spec, fixture_id, entry, image_path))
    if need_hf:
        print(f"[probe] load_hf missing={len(need_hf)}", flush=True)
        model, processor = load_hf(resolve_device(args.device))
        hf_t0 = time.time()
        for i, (profile_name, spec, fixture_id, entry, image_path) in enumerate(need_hf, 1):
            image = Image.open(image_path).convert("RGB")
            print(
                f"[probe] hf_generate profile={profile_name} fixture={fixture_id}",
                flush=True,
            )
            hf = hf_generate(model, processor, image, spec["prompt"], args.max_new_tokens)
            save_hf_cache(
                "nemotron_parse",
                "page",
                fixture_id,
                hf,
                max_new_tokens=args.max_new_tokens,
                profile=spec["name"],
            )
            print(
                f"[probe] hf_done profile={profile_name} fixture={fixture_id} tokens={len(hf['tokens'])}",
                flush=True,
            )
            log_progress(
                "nemotron-hf",
                i,
                len(need_hf),
                hf_t0,
                f"profile={profile_name} fixture={fixture_id}",
            )
            hf_runs.append((profile_name, spec, fixture_id, entry, image_path, hf))
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
    for i, (profile_name, spec, fixture_id, entry, image_path, hf) in enumerate(hf_runs, 1):
        image = Image.open(image_path).convert("RGB")
        print(
            f"[probe] ort_generate profile={profile_name} fixture={fixture_id} hf_tokens={len(hf['tokens'])}",
            flush=True,
        )
        ort_out = ort.generate(
            image, prompt=spec["prompt"], max_new_tokens=args.max_new_tokens
        )
        identical = hf["tokens"] == ort_out["tokens"]
        grammar = inspect(spec["grammar"], hf["text"])
        dest = write_golden(
            "nemotron_parse",
            "page",
            fixture_id,
            prompt_ids=hf["prompt_ids"],
            prompt_text=hf["prompt_text"],
            hf_tokens=hf["tokens"],
            ort_tokens=ort_out["tokens"],
            hf_text=hf["text"],
            ort_text=ort_out["text"],
            pack_id=PACK_ID,
            preprocess={"prompt": spec["prompt"], "image": entry["path"]},
            grammar=grammar,
            identical=identical,
            profile=spec["name"],
            max_new_tokens=args.max_new_tokens,
        )
        row = {
            "profile": profile_name,
            "fixture": fixture_id,
            "identical": identical,
            "grammar_ok": grammar["ok"],
            "dir": str(dest),
        }
        print(json.dumps(row), flush=True)
        log_progress(
            "nemotron-ort",
            i,
            len(hf_runs),
            ort_t0,
            f"profile={profile_name} fixture={fixture_id} identical={identical}",
        )
        results.append(row)
    return 0 if all(r["identical"] and r["grammar_ok"] for r in results) else 2


if __name__ == "__main__":
    with family_lock("nemotron_parse"):
        raise SystemExit(main())
