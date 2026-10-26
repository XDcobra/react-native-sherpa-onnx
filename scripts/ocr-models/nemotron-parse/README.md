# Nemotron-3.5-Parse ONNX (desktop)

Local export of [nvidia/Nemotron-3.5-Parse](https://huggingface.co/nvidia/Nemotron-3.5-Parse)
to ONNX Runtime. FP32 first, then FP16 / INT8 / Q4F16 on that pack. No Hub publish.

## Layout

```text
build/ocr-models/nemotron-3.5-parse/
  .venv/
  hf-src/                 # HF snapshot (weights + custom code)
  onnx/                   # FP32 graphs
  onnx-fp16/
  onnx-int8/
  onnx-q4f16/
  refs/                   # Transformers goldens
```

Graphs:

| File | Role |
|---|---|
| `patch_embed.onnx` | Linear `768 → 1152` |
| `pos_embed.npy` | RADIO 128×128 positional field |
| `vision_encoder.onnx` | 27-layer ViT + neck |
| `embed_tokens.onnx` | scaled mBART embeddings |
| `decoder_model_merged.onnx` | 10-layer GQA decoder with KV cache |

NaViT content-normalized interpolation stays in `navit_pos.py` so image size
stays dynamic. Preprocess uses the official `AutoProcessor`.

## Commands

```bash
# venv is created once under build/ocr-models/nemotron-3.5-parse/.venv
hf download nvidia/Nemotron-3.5-Parse --local-dir \
  build/ocr-models/nemotron-3.5-parse/hf-src

build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/export_onnx.py

build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/test_parity.py --max-new-tokens 16

# Real document page (OmniDocBench image is not in the NVIDIA repo)
build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/test_parity.py \
  --image build/ocr-models/nemotron-3.5-parse/pages/images/PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png \
  --stem omnidoc_meyer_ch2_p014 \
  --max-new-tokens 128

# Quantize the FP32 pack (writes onnx-fp16, onnx-int8, onnx-q4f16)
build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/quantize_onnx.py --variant all

# Re-check a quantized pack against the saved goldens
build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/test_parity.py \
  --onnx-dir build/ocr-models/nemotron-3.5-parse/onnx-fp16 \
  --profile fp16 --from-refs --fixture hello --stem hello_world

# Promote e5 → official onnx-int8 and stage the HF repo (does not upload)
build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/prepare_hf_repo.py

# Dry-run the Hub push (add --upload later)
build/ocr-models/nemotron-3.5-parse/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/upload_hf.py
```

`test_parity.py` must match encoder states, prefill logits, and greedy tokens
against Transformers on a synthetic "Hello World" page before this export is
treated as a quantization base. Quantized packs reuse those goldens (`--from-refs`).

Precision policy:

- embeddings, lm_head, neck Conv/Gemm stay FP16
- host `pos_embed.npy` stays FP32
- INT8: vision + decoder MatMul (constant B) via `quantize_dynamic`
- Q4F16: decoder MatMulNBits only. A 4-bit C-RADIO ViT dropped encoder
  cosine to ~0.87 and flipped bbox tokens; vision therefore stays FP16
- LayerNorm converts with the FP16 graph so ORT does not see mixed `T` bindings

Measured local packs (not published):

| Pack | Total | Vision | Decoder | Embed + pos |
|---|---|---|---|---|
| `onnx/` FP32 | 2.81 GB | 1.68 GB | 759 MB | 372 MB |
| `onnx-fp16/` | 1.44 GB | 838 MB | 379 MB | 224 MB |
| `onnx-int8/` (e5, official) | 753 MB | 437 MB | 199 MB | 112 MB |
| `onnx-q4f16/` | 1.28 GB | 838 MB (FP16) | 214 MB | 224 MB |

Official `onnx-int8` is experiment e5 (INT8 vision/decoder, INT8 embed,
8-bit `lm_head`, FP16 pos). The first-pass INT8 (1.08 GB, FP32 `lm_head`)
is superseded.

Verified on 2026-10-26 against Transformers 5.14.1 / ORT 1.31 CPU.

Synthetic Hello World (exact greedy tokens, including EOS):

| Pack | Vision cosine | Logits cosine | Tokens |
|---|---|---|---|
| FP32 | 1.0 | 1.0 | 9/9 |
| FP16 | 0.99997 | 1.0 | 9/9 |
| INT8 | 0.979 | 0.998 | 9/9 |
| Q4F16 | 0.99997 | 0.989 | 9/9 |

Real OmniDocBench page (`PPT_8076_MEYER_Chapter_2_..._page_014.png`,
max-side 1024, 128 tokens). Layout coverage = HF words recovered after
stripping `<x_*>` / `<y_*>` / `<class_*>` tags:

| Pack | Vision cosine | Logits cosine | Exact tokens | Layout coverage |
|---|---|---|---|---|
| FP32 | 1.0 | 1.0 | 128/128 | 1.0 |
| FP16 | 0.9998 | 1.0 | 127/128 (one bbox bin `0.21`→`0.209`) | 1.0 |
| INT8 | 0.957 | 0.999 | first bbox bin + extra `#` heading | 0.978 |
| Q4F16 | 0.9998 | 0.972 | skipped page header, extra `#` | 0.978 |

All four packs still emit the title, italic source line, footer, table
caption, and `\begin{tabular}{ccccc}` / Latin columns.

## Size-cut experiments (2026-10-26)

Isolated cuts on top of the packs above. Script:
`scripts/ocr-models/nemotron-parse/run_size_experiments.py`.
JSON: `build/ocr-models/nemotron-3.5-parse/refs/size-experiments.json`.

| ID | What changed | Size | Hello | OmniDoc layout | Page header |
|---|---|---|---|---|---|
| e1-pos-fp16 | `pos_embed.npy` FP16 | 1.24 GB | exact | 0.978 | no (same as Q4) |
| e2-embed-int8 | per-row INT8 Gather | 1.20 GB | exact | 0.978 | no (same as Q4) |
| e3-lmhead-int8 | 8-bit MatMulNBits `lm_head` | 1.21 GB | exact | 0.978 | no (same as Q4) |
| e4-hybrid | INT8 vision + Q4 decoder + e1–e3 | **697 MB** | exact | 0.978 | no |
| e5-int8-compact | INT8 vision/decoder + e1–e3 | **753 MB** | exact | 0.978 | **yes** |

`pos_embed` FP16, INT8 embed, and 8-bit `lm_head` did not add visible
quality loss beyond the parent decoder. Q4 decoder is what drops the
`CAMBRIDGE` page header. INT8 decoder keeps it (plus a `#` heading).

### Recommended HF set (not published yet)

| Role | Pack | Size | Why |
|---|---|---|---|
| Desktop default | `onnx-fp16` | 1.44 GB | Near-lossless (127/128 tokens, layout 1.0) |
| High-end mobile / compact desktop | `e5-int8-compact` | 753 MB | Smallest pack that still recovers the page header |
| Optional smaller | `e4-hybrid` | 697 MB | −56 MB vs e5, same body, loses page header |
| Do not publish | FP32, current `int8`, current `q4f16` | 2.8 / 1.08 / 1.28 GB | Dominated by fp16 (quality) or e5 (size+header) |

FP32 stays the local export source. 4-bit vision is still rejected.

NVIDIA does not ship quick20 images. The page is from
`opendatalab/OmniDocBench`. Native 2000×1500 is too slow on 16 GB CPU; `--max-side 1024`
keeps the same slide.

`generation_config.json` sets `forced_eos_token_id`. Parity disables that so the
last generated slot is a real greedy token, not a serving-time EOS force.
