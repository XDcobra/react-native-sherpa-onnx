# Nemotron-3-Diarization ONNX (Sortformer contract)

Local export of [nvidia/Nemotron-3-Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization)
into the **same streaming ONNX I/O** that `SortformerStreamingModel` already
runs for `diar_streaming_sortformer_4spk-v2.1`.

Target Hub repo (after parity): [XDcobra/Nemotron-3-Diarization-ONNX](https://huggingface.co/XDcobra/Nemotron-3-Diarization-ONNX).

Same workflow as [Nemotron-3.5-Parse-ONNX](https://huggingface.co/XDcobra/Nemotron-3.5-Parse-ONNX):
export FP32 → quantize candidates → **CPU parity gates** → tables/figures →
publish only cuts that pass.

## Layout

```text
build/diarization-models/nemotron-3/
  .venv/
  hf-src/                 # HF snapshot (.nemo + LICENSE)
  onnx/                   # FP32 model.onnx + metadata.json
  onnx-fp16/
  onnx-int8/
  onnx-q4f16/
  exp/                    # e1–e3 size-cut packs
  refs/                   # NeMo / ORT goldens + parity_*.json
  hf-stage/               # prepare_hf_repo.py output
```

## Contract

| | |
|---|---|
| Inputs | `chunk`, `chunk_lengths`, `spkcache`, `spkcache_lengths`, `fifo`, `fifo_lengths` |
| Outputs | `spkcache_fifo_chunk_preds`, `chunk_pre_encode_embs`, `chunk_pre_encode_lengths` |
| Speakers | 8 |
| Host | Mel (`SortformerFbank`) + AOSC/FIFO cache in C++ |

## Commands

```bash
# 1. Snapshot
hf download nvidia/Nemotron-3-Diarization --local-dir \
  build/diarization-models/nemotron-3/hf-src

# 2. venv (once)
python3.12 -m venv build/diarization-models/nemotron-3/.venv
build/diarization-models/nemotron-3/.venv/bin/pip install -U pip
# install torch for your platform, then:
build/diarization-models/nemotron-3/.venv/bin/pip install -r \
  scripts/diarization-models/nemotron-3/requirements.txt
# Nemotron-3 needs RoPE — PyPI nemo-toolkit 3.0.x is not enough:
git clone --depth 1 https://github.com/NVIDIA-NeMo/Speech.git \
  build/diarization-models/nemotron-3/Speech
build/diarization-models/nemotron-3/.venv/bin/pip install -e \
  'build/diarization-models/nemotron-3/Speech[asr]' --no-deps
build/diarization-models/nemotron-3/.venv/bin/pip install -U \
  'git+https://github.com/lhotse-speech/lhotse.git'

# 3. Export FP32 Sortformer-contract graph
# (patches encoder for_export=True — FlexAttention is not ONNX-traceable)
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/export_onnx.py

# 4. CPU parity vs NeMo (writes refs/ goldens) — this is the HF-card gate
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/test_parity.py \
  --profile fp32 --gates

# Optional local speed: CoreML only if decisions match CPU exactly.
# Never combine --prefer-coreml with --gates (gates force CPU).
# macOS ORT wheels already expose CoreMLExecutionProvider when available.
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/test_parity.py \
  --profile fp32 --prefer-coreml

# 5. Quantize + size-cut experiments (CPU --from-refs gates)
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/quantize_onnx.py --variant all

build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/run_size_experiments.py

# 6. Figures for the HF card
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/plot_figures.py

# 7. Stage Hub repo (no upload)
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/prepare_hf_repo.py

build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/upload_hf.py          # dry-run
# build/.../upload_hf.py --upload                            # push
```

## Measured cuts (2026-11-11, CPU)

| Pack | Size | Preds cos (cold) | Decision agree | Ship? |
|---|---:|---:|---:|:---:|
| FP32 | 401 MB | 1.000000 | 1.000000 | source |
| FP16 | 201 MB | 0.999999 | 1.000000 | **yes** (all latency presets) |
| INT8 | 107 MB | 0.991839 | 1.000000 | **yes** for offline / low_latency; softer at ≤0.64 s |
| Q4F16 | 60 MB | 0.660241 | 1.000000* | **no** |

\* Synthetic threshold agreement alone is not enough when preds cosine collapses.

Latency × pack matrix (Parse instruction-profile analog):

```bash
build/diarization-models/nemotron-3/.venv/bin/python \
  scripts/diarization-models/nemotron-3/run_latency_matrix.py
```

No DIHARD DER on the card: too heavy for this release artifact; the step
fixture + latency matrix is the published contract. SDK note: preds are
**10 ms high-res** — `pred_frames ≈ (spkcache + fifo) × 8 + mel_len`.
`SortformerStreamingModel` detects this via `pred_upsample` (metadata or
tensor shape) and post-processes at 10 ms; FIFO/spkcache bookkeeping stays
encoder-rate. Offline vs live is `latencyPreset` on
`createStreamingDiarization` — not a second ONNX or `createDiarization`.

## CoreML policy (macOS)

- **Parity / published tables:** always `CPUExecutionProvider`.
- **Local interactive runs:** `--prefer-coreml` tries CoreML first, then a
  smoke compare of thresholded speaker decisions vs CPU. If CoreML is missing,
  rejects the graph (common on INT8/Q4), or any decision differs → **CPU**.
- Rationale: same as Parse “instruction” gates — acceleration must not change
  which streaming/quant cuts we claim are safe.

## SDK pack ids (GitHub `diarization-models` release)

Separate archives. FP16/INT8 keep `model.onnx` + `model.onnx_data` (ORT
external-data basename; no rewrite). FP32 is a single embedded `model.onnx`.

| Archive id | Hub pack | Notes |
|---|---|---|
| `diar_streaming_nemotron3_sortformer_8spk` | `onnx/fp32/` | reference / full precision |
| `diar_streaming_nemotron3_sortformer_8spk-fp16` | `onnx/fp16/` | high-end |
| `diar_streaming_nemotron3_sortformer_8spk-int8` | `onnx/int8/` | mobile / smaller |

All keep `sortformer` in the name for existing model detection;
`metadata.json` sets `max_speakers: 8`. Rows live in
`scripts/diarization-models/sources.csv` (`onnx_data_url` for external weights). Publish with:

```bash
# dry-run locally, then workflow_dispatch Publish diarization model assets
node scripts/diarization-models/build_and_upload.js --dry-run
```
