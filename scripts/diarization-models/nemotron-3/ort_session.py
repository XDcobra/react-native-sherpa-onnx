"""ONNX Runtime session helpers for local Mac speed vs CPU parity gates.

Parity / HF-card gates always use CPUExecutionProvider so CoreML EP quirks
cannot silently change thresholded speaker decisions (the diarization analog
of Parse "instruction" profiles).

For local interactive runs you may pass ``prefer_coreml=True``: we try
CoreMLExecutionProvider first, then fall back to CPU if CoreML rejects the
graph (unsupported ops after quant) or if a quick smoke compare vs CPU shows
decision drift beyond ``coreml_max_decision_delta``.
"""

from __future__ import annotations

from pathlib import Path

from constants import GRAPH_FILE


def _log(msg: str) -> None:
    print(f"[ort] {msg}", flush=True)


def available_providers() -> list[str]:
    import onnxruntime as ort

    return list(ort.get_available_providers())


def build_providers(*, prefer_coreml: bool) -> list[str]:
    """Ordered ORT providers. Gates should call with prefer_coreml=False."""
    available = available_providers()
    providers: list[str] = []
    if prefer_coreml and "CoreMLExecutionProvider" in available:
        providers.append("CoreMLExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


def load_ort_session(
    onnx_dir: Path,
    *,
    prefer_coreml: bool = False,
    intra_op_threads: int = 2,
):
    import onnxruntime as ort

    path = onnx_dir / GRAPH_FILE
    if not path.is_file():
        raise FileNotFoundError(path)

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = intra_op_threads
    providers = build_providers(prefer_coreml=prefer_coreml)

    try:
        session = ort.InferenceSession(
            str(path),
            sess_options=opts,
            providers=providers,
        )
    except Exception as exc:  # noqa: BLE001 — CoreML often fails on INT8/Q4 graphs
        if not prefer_coreml:
            raise
        _log(f"CoreML session failed ({exc}); falling back to CPU")
        session = ort.InferenceSession(
            str(path),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )

    active = session.get_providers()
    _log(f"session providers={active} (requested={providers})")
    return session


def coreml_safe_for_parity(
    onnx_dir: Path,
    feeds: dict,
    input_names: tuple[str, ...],
    output_names: tuple[str, ...],
    *,
    max_decision_delta: float = 0.0,
) -> bool:
    """Return True only if CoreML binary decisions match CPU on ``feeds``.

    Used as an optional local check before accelerating long loops with CoreML.
    HF-card tables must still be produced with CPU sessions.
    """
    import numpy as np

    if "CoreMLExecutionProvider" not in available_providers():
        _log("CoreML EP not available")
        return False

    try:
        coreml = load_ort_session(onnx_dir, prefer_coreml=True)
        cpu = load_ort_session(onnx_dir, prefer_coreml=False)
    except Exception as exc:  # noqa: BLE001
        _log(f"CoreML safety check could not create sessions: {exc}")
        return False

    if coreml.get_providers()[0] != "CoreMLExecutionProvider":
        _log("CoreML not active after prefer_coreml=True")
        return False

    feed = {k: feeds[k] for k in input_names}
    c_out = coreml.run(list(output_names), feed)[0]
    u_out = cpu.run(list(output_names), feed)[0]

    def decisions(x: np.ndarray) -> np.ndarray:
        y = x.astype(np.float64)
        if y.min() < 0.0 or y.max() > 1.0:
            y = 1.0 / (1.0 + np.exp(-y))
        return y > 0.5

    c = decisions(c_out)
    u = decisions(u_out)
    t = min(c.shape[1], u.shape[1])
    s = min(c.shape[-1], u.shape[-1])
    c = c[:, :t, :s]
    u = u[:, :t, :s]
    total = c.size
    disagree = int(np.sum(c != u))
    delta = disagree / total if total else 0.0
    ok = delta <= max_decision_delta
    _log(
        f"CoreML vs CPU decision delta={delta:.6f} "
        f"(disagree={disagree}/{total}) ok={ok}"
    )
    return ok
