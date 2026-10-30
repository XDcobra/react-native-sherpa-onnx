# PaddleOCR-VL-1.6 ONNX (desktop)

Local export of [PaddlePaddle/PaddleOCR-VL-1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
to ONNX Runtime. FP32 first, then FP16 / INT8 / Q4F16. Variants ship only when
the parity suite still holds.

Published Hub (after upload): [XDcobra/PaddleOCR-VL-1.6-ONNX](https://huggingface.co/XDcobra/PaddleOCR-VL-1.6-ONNX)

## Layout

```text
build/ocr-models/paddleocr-vl-1.6/
  .venv/
  hf-src/                 # HF snapshot
  onnx/                   # FP32 graphs
  onnx-fp16/
  onnx-int8/
  onnx-q4f16/
  refs/                   # Transformers goldens
  pages/                  # OmniDoc + camera fixtures
```

Graphs (community 1.5 layout; 1.6 is the same architecture):

| File | Role |
|---|---|
| `vision_encoder.onnx` | NaViT tower + projector (`pixel_values`, `image_grid_thw`) |
| `embedding.onnx` | token table (kept FP32 when quantizing) |
| `decoder.onnx` | 18-layer ERNIE-4.5 decoder with KV cache |

Image tokens splice at id `100295`. Export uses `torch.onnx.export(..., dynamo=True)`, opset 21.

## Commands

```bash
hf download PaddlePaddle/PaddleOCR-VL-1.6 --local-dir \
  build/ocr-models/paddleocr-vl-1.6/hf-src

build/ocr-models/paddleocr-vl-1.6/.venv/bin/python \
  scripts/ocr-models/paddleocr-vl/export_onnx.py

build/ocr-models/paddleocr-vl-1.6/.venv/bin/python \
  scripts/ocr-models/paddleocr-vl/test_parity.py --fixture hello --max-new-tokens 16

build/ocr-models/paddleocr-vl-1.6/.venv/bin/python \
  scripts/ocr-models/paddleocr-vl/quantize_onnx.py --variant all

build/ocr-models/paddleocr-vl-1.6/.venv/bin/python \
  scripts/ocr-models/paddleocr-vl/prepare_hf_repo.py

build/ocr-models/paddleocr-vl-1.6/.venv/bin/python \
  scripts/ocr-models/paddleocr-vl/upload_hf.py
```
