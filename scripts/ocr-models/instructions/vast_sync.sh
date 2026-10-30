#!/usr/bin/env bash
# Copy the Phase 0 tree to a Vast instance. Does not start probes.
# Usage: vast_sync.sh [user@host] [ssh_port]
#        vast_sync.sh ssh://root@ssh2.vast.ai:30578
set -euo pipefail
KEY="${VAST_SSH_KEY:-$HOME/.ssh/id_ed25519_vast}"
RAW="${1:-}"
PORT="${2:-22}"
if [[ -z "$RAW" ]]; then
  echo "usage: vast_sync.sh user@host [port] | ssh://user@host:port" >&2
  exit 2
fi
if [[ "$RAW" == ssh://* ]]; then
  rest="${RAW#ssh://}"
  HOST="${rest%%:*}"
  PORT="${rest##*:}"
else
  HOST="$RAW"
fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -p "$PORT")

echo "tar|ssh -> ${HOST}:~/react-native-sherpa-onnx port=$PORT"
"${SSH[@]}" "$HOST" "mkdir -p ~/react-native-sherpa-onnx"
# macOS openrsync has no --info/--relative-dot; stream a tar instead.
cd "$ROOT"
export COPYFILE_DISABLE=1
tar cf - \
  scripts/ocr-models \
  test/fixtures/ocr/instructions \
  build/ocr-models/paddleocr-vl-1.6/hf-src \
  build/ocr-models/nemotron-3.5-parse/hf-src \
  build/ocr-models/docvlm-granite-258m/hf-src \
  build/ocr-models/phase0-cache \
  example/.model-cache/paddleocr-vl-1.6-fp16 \
  example/.model-cache/nemotron-3.5-parse-int8 \
  example/.model-cache/docvlm-granite-258m-fp32 \
  | "${SSH[@]}" "$HOST" "tar --warning=no-unknown-keyword -xf - -C ~/react-native-sherpa-onnx"
echo "sync done"
"${SSH[@]}" "$HOST" 'du -sh ~/react-native-sherpa-onnx ~/react-native-sherpa-onnx/build/ocr-models ~/react-native-sherpa-onnx/example/.model-cache'
