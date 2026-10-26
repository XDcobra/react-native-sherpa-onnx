#!/usr/bin/env python3
"""Upload the staged Nemotron-3.5-Parse ONNX repo to Hugging Face.

Dry-run by default. Pass --upload to actually create the repo and push.
Does not run unless that flag is set.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from paths import HF_REPO_ID, HF_STAGE


def list_stage(stage: Path) -> list[Path]:
    return sorted(path for path in stage.rglob("*") if path.is_file())


def format_size(path: Path) -> str:
    size = path.stat().st_size
    if size >= 1_000_000:
        return f"{size / 1e6:.1f} MB"
    return f"{size} B"


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, default=HF_STAGE)
    parser.add_argument("--repo", default=HF_REPO_ID)
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Actually create the HF repo and upload. Default is dry-run.",
    )
    parser.add_argument("--private", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    stage = args.stage
    if not (stage / "README.md").is_file():
        raise FileNotFoundError(f"stage missing {stage}. Run prepare_hf_repo.py first.")
    files = list_stage(stage)
    total = sum(path.stat().st_size for path in files)
    print(f"[upload] repo={args.repo}")
    print(f"[upload] stage={stage}")
    print(f"[upload] files={len(files)} total={total / 1e6:.1f} MB")
    for path in files:
        rel = path.relative_to(stage)
        print(f"  {rel}  {format_size(path)}")
    if not args.upload:
        print("[upload] dry-run only. Re-run with --upload to push.")
        return 0
    from huggingface_hub import HfApi

    api = HfApi(token=os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN"))
    api.create_repo(args.repo, exist_ok=True, private=args.private, repo_type="model")
    api.upload_folder(
        folder_path=str(stage),
        repo_id=args.repo,
        repo_type="model",
        commit_message="Add Nemotron-3.5-Parse ONNX FP16 + compact INT8",
    )
    print(f"[upload] https://huggingface.co/{args.repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
