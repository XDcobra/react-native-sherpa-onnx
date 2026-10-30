#!/usr/bin/env bash
# Run on the Vast instance after vast_sync.sh.
# Reuse the image's CUDA torch; do not pip-install torch (that pulls a CPU wheel).
set -euo pipefail
ROOT="${1:-$HOME/react-native-sherpa-onnx}"
cd "$ROOT"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fonts-dejavu-core rsync >/dev/null
python3 -m venv --system-site-packages build/ocr-models/.venv-tf4
python3 -m venv --system-site-packages build/ocr-models/.venv
build/ocr-models/.venv-tf4/bin/pip install -U pip
build/ocr-models/.venv/bin/pip install -U pip
# Paddle + Granite: transformers 4.57, keep image torch.
build/ocr-models/.venv-tf4/bin/pip install \
  'transformers>=4.57.0,<5.0' \
  onnxruntime>=1.20 \
  pillow huggingface-hub numpy tokenizers sentencepiece einops
# Nemotron: transformers 5.14, keep image torch.
build/ocr-models/.venv/bin/pip install \
  transformers==5.14.1 \
  timm==1.0.22 \
  onnxruntime>=1.20 \
  pillow 'huggingface-hub>=1.24' numpy
build/ocr-models/.venv-tf4/bin/python -c "import torch; print('tf4', torch.__version__, 'cuda', torch.cuda.is_available())"
build/ocr-models/.venv/bin/python -c "import torch; print('tf5', torch.__version__, 'cuda', torch.cuda.is_available())"
build/ocr-models/.venv-tf4/bin/python scripts/ocr-models/instructions/test_tasks.py
echo "setup ok"
