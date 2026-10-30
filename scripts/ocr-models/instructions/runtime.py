"""Process helpers for Phase 0 probes (memory, skip, RSS)."""

from __future__ import annotations

import fcntl
import gc
import os
import resource
import sys
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def family_lock(family: str):
    """Serialize probe processes of the same family (parallel tmux vs sequential runner)."""
    from gate_paths import BUILD_ROOT

    path = Path(BUILD_ROOT) / f"phase0-{family}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+")
    print(f"[probe] lock wait family={family} path={path}", flush=True)
    fcntl.flock(handle, fcntl.LOCK_EX)
    print(f"[probe] lock held family={family}", flush=True)
    try:
        yield
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def cpu_thread_count() -> int:
    raw = os.environ.get("OMP_NUM_THREADS") or os.environ.get("ORT_NUM_THREADS") or "14"
    return max(1, int(raw))


def configure_cpu_threads() -> int:
    threads = cpu_thread_count()
    try:
        import torch

        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
    except Exception:
        pass
    print(f"[probe] cpu_threads={threads}", flush=True)
    return threads


def peak_rss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return rss / (1024 * 1024)
    return rss / 1024


def resolve_device(name: str):
    import torch

    if name == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("cuda requested but torch.cuda.is_available() is false")
        device = torch.device("cuda")
        print(
            f"[probe] cuda={torch.cuda.get_device_name(0)} "
            f"vram_mb={torch.cuda.get_device_properties(0).total_memory / (1024 * 1024):.0f}",
            flush=True,
        )
        return device
    if name != "cpu":
        raise SystemExit(f"unknown device {name!r}; use cpu or cuda")
    configure_cpu_threads()
    return torch.device("cpu")


def batch_to_device(inputs, device):
    if hasattr(inputs, "to"):
        return inputs.to(device)
    return {
        key: value.to(device) if hasattr(value, "to") else value
        for key, value in inputs.items()
    }


def release_models() -> float:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return peak_rss_mb()


def log_progress(stage: str, done: int, total: int, t0: float, extra: str = "") -> None:
    elapsed = max(time.time() - t0, 0.001)
    remaining = max(total - done, 0)
    eta_s = (elapsed / done) * remaining if done else 0.0
    suffix = f" {extra}" if extra else ""
    print(
        f"[phase0] progress stage={stage} step={done}/{total} "
        f"elapsed_s={elapsed:.0f} eta_s={eta_s:.0f}{suffix}",
        flush=True,
    )


def token_heartbeat(label: str, every: int = 8):
    """transformers StoppingCriteria that logs every N new tokens."""
    from transformers import StoppingCriteria

    class TokenHeartbeat(StoppingCriteria):
        def __init__(self):
            super().__init__()
            self.n = 0
            self.t0 = time.time()

        def __call__(self, input_ids, scores, **kwargs):
            self.n += 1
            if self.n == 1 or self.n % every == 0:
                print(
                    f"[probe] hf_token {label} n={self.n} "
                    f"elapsed_s={time.time() - self.t0:.0f} rss_mb={peak_rss_mb():.0f}",
                    flush=True,
                )
            return False

    return TokenHeartbeat()
