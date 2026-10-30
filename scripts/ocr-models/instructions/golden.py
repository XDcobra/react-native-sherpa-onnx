"""Write and load Phase 0 instruction goldens."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from gate_paths import BUILD_ROOT, GOLDEN_ROOT, REPO_ROOT

HF_CACHE_ROOT = BUILD_ROOT / "phase0-cache"


def golden_dir(family: str, task: str, fixture_id: str, profile: str | None = None) -> Path:
    parts = [family, task]
    if profile:
        parts.append(profile)
    parts.append(fixture_id)
    path = GOLDEN_ROOT.joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_golden(
    family: str,
    task: str,
    fixture_id: str,
    *,
    prompt_ids: list[int],
    prompt_text: str,
    hf_tokens: list[int],
    ort_tokens: list[int],
    hf_text: str,
    ort_text: str,
    pack_id: str,
    preprocess: dict[str, Any],
    grammar: dict[str, Any],
    identical: bool,
    profile: str | None = None,
    max_new_tokens: int | None = None,
) -> Path:
    dest = golden_dir(family, task, fixture_id, profile)
    (dest / "prompt_ids.json").write_text(json.dumps(prompt_ids) + "\n")
    # Canonical raw is HF when identical, otherwise both are stored and raw.txt
    # is HF so a later parser can still run against a known reference.
    (dest / "raw.txt").write_text(hf_text)
    (dest / "hf_tokens.json").write_text(json.dumps(hf_tokens) + "\n")
    (dest / "ort_tokens.json").write_text(json.dumps(ort_tokens) + "\n")
    (dest / "ort_raw.txt").write_text(ort_text)
    meta = {
        "family": family,
        "task": task,
        "profile": profile,
        "fixture_id": fixture_id,
        "pack_id": pack_id,
        "prompt_text": prompt_text,
        "preprocess": preprocess,
        "token_identical": identical,
        "hf_token_count": len(hf_tokens),
        "ort_token_count": len(ort_tokens),
        "prefix_len": _prefix_len(hf_tokens, ort_tokens),
        "grammar": grammar,
        "repo_relative_dir": str(dest.relative_to(REPO_ROOT)),
    }
    if max_new_tokens is not None:
        meta["max_new_tokens"] = int(max_new_tokens)
    (dest / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    return dest


def existing_complete(
    family: str,
    task: str,
    fixture_id: str,
    *,
    max_new_tokens: int,
    profile: str | None = None,
) -> bool:
    """True when a prior run already wrote a token-identical golden at this budget."""
    dest = golden_dir(family, task, fixture_id, profile)
    meta_path = dest / "meta.json"
    if not meta_path.is_file():
        return False
    try:
        meta = json.loads(meta_path.read_text())
    except json.JSONDecodeError:
        return False
    if not meta.get("token_identical"):
        return False
    recorded = meta.get("max_new_tokens")
    if recorded is None:
        return False
    return int(recorded) >= int(max_new_tokens)


def hf_cache_path(
    family: str,
    task: str,
    fixture_id: str,
    *,
    max_new_tokens: int,
    profile: str | None = None,
) -> Path:
    parts = [family, task]
    if profile:
        parts.append(profile)
    parts.append(fixture_id)
    return HF_CACHE_ROOT.joinpath(*parts) / f"hf-{max_new_tokens}.json"


def load_hf_cache(
    family: str,
    task: str,
    fixture_id: str,
    *,
    max_new_tokens: int,
    profile: str | None = None,
) -> dict[str, Any] | None:
    path = hf_cache_path(
        family, task, fixture_id, max_new_tokens=max_new_tokens, profile=profile
    )
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if int(payload.get("max_new_tokens", -1)) != int(max_new_tokens):
        return None
    return payload.get("hf")


def save_hf_cache(
    family: str,
    task: str,
    fixture_id: str,
    hf: dict[str, Any],
    *,
    max_new_tokens: int,
    profile: str | None = None,
) -> Path:
    path = hf_cache_path(
        family, task, fixture_id, max_new_tokens=max_new_tokens, profile=profile
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"max_new_tokens": int(max_new_tokens), "hf": hf}) + "\n"
    )
    return path


def _prefix_len(left: list[int], right: list[int]) -> int:
    n = 0
    for a, b in zip(left, right):
        if a != b:
            break
        n += 1
    return n
