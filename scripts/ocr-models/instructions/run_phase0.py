#!/usr/bin/env python3
"""Run the Phase 0 evidence gate for every accepted OCR instruction.

Writes goldens under test/fixtures/ocr/instructions/ and a JSON report.
Exit 0 only when every probed instruction meets the plan's pass criteria
(token-identical HF vs ORT on all fixtures of that instruction, grammar ok).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from fixtures import generate_all, load_catalog  # noqa: E402
from gate_paths import REPORT_PATH, REPO_ROOT  # noqa: E402
from tasks import (  # noqa: E402
    GRANITE_TASKS,
    NEMOTRON_DEFAULT_PROFILE,
    PADDLEOCR_VL_TASKS,
    nemotron_profiles,
)

BUILD_VENV = REPO_ROOT / "build" / "ocr-models"
PYTHON_PADDLE = BUILD_VENV / ".venv-tf4" / "bin" / "python"
PYTHON_NEMOTRON = BUILD_VENV / ".venv" / "bin" / "python"
PYTHON_GRANITE = PYTHON_PADDLE if PYTHON_PADDLE.is_file() else Path(sys.executable)
PADDLE_PROBE = SCRIPT_DIR.parent / "paddleocr-vl" / "probe_instructions.py"
NEMOTRON_PROBE = SCRIPT_DIR.parent / "nemotron-parse" / "probe_instructions.py"
GRANITE_PROBE = SCRIPT_DIR.parent / "doc-vlm" / "probe_instructions.py"


def run_probe(python: Path, script: Path, extra: list[str], max_new_tokens: int) -> dict:
    interpreter = python if python.is_file() else Path(sys.executable)
    cmd = [str(interpreter), str(script), "--max-new-tokens", str(max_new_tokens), *extra]
    print(f"[phase0] {' '.join(cmd)}", flush=True)
    proc = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
    )
    rows = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return {
        "cmd": cmd,
        "returncode": proc.returncode,
        "rows": rows,
        "stdout_tail": proc.stdout[-2000:],
        "stderr_tail": proc.stderr[-4000:],
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument(
        "--families",
        nargs="+",
        choices=("paddleocr_vl", "nemotron_parse", "doc_vlm"),
        default=("paddleocr_vl", "nemotron_parse", "doc_vlm"),
    )
    parser.add_argument("--skip-generate-fixtures", action="store_true")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if args.skip_generate_fixtures:
        catalog = load_catalog()
    else:
        catalog = generate_all()
    print(f"[phase0] fixtures={len(catalog)}", flush=True)

    dump = SCRIPT_DIR / "dump_prompt_ids.py"
    verify = SCRIPT_DIR / "verify_prompt_ids.py"
    print("[phase0] dump_prompt_ids", flush=True)
    dump_run = subprocess.run(
        [
            str(PYTHON_PADDLE if PYTHON_PADDLE.is_file() else sys.executable),
            str(dump),
            "--families",
            "paddleocr_vl",
            "doc_vlm",
        ],
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
    )
    if dump_run.returncode != 0:
        print(dump_run.stderr[-2000:], flush=True)
        return 2
    nemo_dump = subprocess.run(
        [
            str(PYTHON_NEMOTRON if PYTHON_NEMOTRON.is_file() else sys.executable),
            str(dump),
            "--families",
            "nemotron_parse",
        ],
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
    )
    if nemo_dump.returncode != 0:
        print(nemo_dump.stderr[-2000:], flush=True)
        return 2
    verify_run = subprocess.run(
        [sys.executable, str(verify)],
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
    )
    print(verify_run.stdout[-1500:], flush=True)
    if verify_run.returncode != 0:
        return 2

    report = {
        "max_new_tokens": args.max_new_tokens,
        "families": {},
        "nemotron_default_profile": NEMOTRON_DEFAULT_PROFILE,
        "pass": True,
    }

    if "paddleocr_vl" in args.families:
        family_run = run_probe(
            PYTHON_PADDLE,
            PADDLE_PROBE,
            ["--task", "all", "--device", args.device],
            args.max_new_tokens,
        )
        family_run["pass"] = family_run["returncode"] == 0
        if not family_run["pass"]:
            report["pass"] = False
        report["families"]["paddleocr_vl"] = family_run

    if "nemotron_parse" in args.families:
        family_run = run_probe(
            PYTHON_NEMOTRON,
            NEMOTRON_PROBE,
            ["--output-profile", "all", "--device", args.device],
            args.max_new_tokens,
        )
        family_run["pass"] = family_run["returncode"] == 0
        if not family_run["pass"]:
            report["pass"] = False
        report["families"]["nemotron_parse"] = family_run

    if "doc_vlm" in args.families:
        family_run = run_probe(
            PYTHON_GRANITE,
            GRANITE_PROBE,
            ["--task", "all", "--device", args.device],
            args.max_new_tokens,
        )
        family_run["pass"] = family_run["returncode"] == 0
        if not family_run["pass"]:
            report["pass"] = False
        report["families"]["doc_vlm"] = family_run

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(f"[phase0] report={REPORT_PATH} pass={report['pass']}", flush=True)
    return 0 if report["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
