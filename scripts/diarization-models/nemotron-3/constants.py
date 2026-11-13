"""Streaming Sortformer contract shared by export, quantize, and parity."""

from __future__ import annotations

NVIDIA_REPO = "nvidia/Nemotron-3-Diarization"
HF_ONNX_REPO = "XDcobra/Nemotron-3-Diarization-ONNX"
MODEL_ID = "diar_streaming_nemotron3_sortformer_8spk"

# Must match SortformerStreamingModel I/O in the RN SDK.
INPUT_NAMES = (
    "chunk",
    "chunk_lengths",
    "spkcache",
    "spkcache_lengths",
    "fifo",
    "fifo_lengths",
)
OUTPUT_NAMES = (
    "spkcache_fifo_chunk_preds",
    "chunk_pre_encode_embs",
    "chunk_pre_encode_lengths",
)

FEAT_DIM = 128
EMB_DIM = 512
SUBSAMPLING = 8
SAMPLE_RATE = 16000
MAX_SPEAKERS = 8
OPSET = 17

# NVIDIA card defaults (80 ms encoder frames). Export uses dynamic axes so
# one graph can run offline (30.4 s) and low-latency configs at runtime.
LATENCY_PRESETS = {
    "offline": {
        "latency_s": 30.4,
        "spkcache_len": 264,
        "fifo_len": 40,
        "chunk_len": 340,
        "right_context": 40,
        "spkcache_update_period": 300,
    },
    "low_latency": {
        "latency_s": 1.04,
        "spkcache_len": 264,
        "fifo_len": 264,
        "chunk_len": 9,
        "right_context": 4,
        "spkcache_update_period": 222,
    },
    "very_low_latency": {
        "latency_s": 0.64,
        "spkcache_len": 264,
        "fifo_len": 264,
        "chunk_len": 6,
        "right_context": 2,
        "spkcache_update_period": 222,
    },
    "ultra_low_latency": {
        "latency_s": 0.32,
        "spkcache_len": 264,
        "fifo_len": 264,
        "chunk_len": 3,
        "right_context": 1,
        "spkcache_update_period": 222,
    },
}

# Export trace uses the offline geometry (largest steady-state shapes).
DEFAULT_EXPORT_PRESET = "offline"

GRAPH_FILE = "model.onnx"
METADATA_FILE = "metadata.json"
MANIFEST_FILE = "diarization_manifest.json"
LICENSE_FILE = "LICENSE"
