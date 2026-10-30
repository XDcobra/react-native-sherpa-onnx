#!/usr/bin/env bash
# On the Vast instance: smoke GPU HF vs CPU ORT, then run every family.
set -euo pipefail
ROOT="${1:-$HOME/react-native-sherpa-onnx}"
cd "$ROOT"
export PYTHONUNBUFFERED=1
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-14}"
export ORT_NUM_THREADS="${ORT_NUM_THREADS:-14}"
LOG="${2:-$ROOT/build/ocr-models/phase0-vast.log}"
mkdir -p "$(dirname "$LOG")"
TF4=build/ocr-models/.venv-tf4/bin/python
TF5=build/ocr-models/.venv/bin/python
T0=$(date +%s)
STEP=0
TOTAL=7

banner() {
  STEP=$((STEP + 1))
  local name="$1"
  local eta="$2"
  local now
  now=$(date +%s)
  local elapsed=$((now - T0))
  echo
  echo "======== PHASE 0  step ${STEP}/${TOTAL}  ${name}  elapsed=${elapsed}s  eta_this=${eta} ========"
  echo "[phase0] step=${STEP}/${TOTAL} name=${name} elapsed_s=${elapsed} eta=${eta}"
}

run_logged() {
  set +e
  "$@" 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

PADDLE_DEV=cpu
GRANITE_DEV=cpu
NEMO_DEV=cpu

banner "smoke paddle table_01 cuda vs ORT" "5-15m"
if run_logged "$TF4" -u scripts/ocr-models/paddleocr-vl/probe_instructions.py \
    --task table --fixture table_01 --max-new-tokens 64 --device cuda --ignore-hf-cache; then
  PADDLE_DEV=cuda
  echo "[vast] smoke paddle identical=true -> cuda"
else
  echo "[vast] smoke paddle identical=false -> cpu"
fi

banner "smoke granite page_01 cuda vs ORT" "2-8m"
if run_logged "$TF4" -u scripts/ocr-models/doc-vlm/probe_instructions.py \
    --task page --fixture page_01 --max-new-tokens 32 --device cuda --ignore-hf-cache; then
  GRANITE_DEV=cuda
  echo "[vast] smoke granite identical=true -> cuda"
else
  echo "[vast] smoke granite identical=false -> cpu"
fi

banner "smoke nemotron page_01 cuda vs ORT" "3-12m"
if run_logged "$TF5" -u scripts/ocr-models/nemotron-parse/probe_instructions.py \
    --fixture page_01 --max-new-tokens 32 --device cuda --ignore-hf-cache; then
  NEMO_DEV=cuda
  echo "[vast] smoke nemotron identical=true -> cuda"
else
  echo "[vast] smoke nemotron identical=false -> cpu"
fi

echo "[vast] devices paddle=$PADDLE_DEV granite=$GRANITE_DEV nemotron=$NEMO_DEV"

banner "paddle all 18 jobs device=$PADDLE_DEV" "15-40m"
run_logged "$TF4" -u scripts/ocr-models/paddleocr-vl/probe_instructions.py \
  --task all --max-new-tokens 128 --device "$PADDLE_DEV" || echo "[vast] paddle finished with rc=$?"

banner "granite all 21 jobs device=$GRANITE_DEV" "10-30m"
run_logged "$TF4" -u scripts/ocr-models/doc-vlm/probe_instructions.py \
  --task all --max-new-tokens 128 --device "$GRANITE_DEV" || echo "[vast] granite finished with rc=$?"

banner "nemotron all 42 jobs device=$NEMO_DEV" "20-90m"
run_logged "$TF5" -u scripts/ocr-models/nemotron-parse/probe_instructions.py \
  --output-profile all --max-new-tokens 128 --device "$NEMO_DEV" || echo "[vast] nemotron finished with rc=$?"

banner "phase0 generate complete" "0"
echo "[vast] done elapsed_s=$(( $(date +%s) - T0 ))"
echo "[vast] devices paddle=$PADDLE_DEV granite=$GRANITE_DEV nemotron=$NEMO_DEV"
