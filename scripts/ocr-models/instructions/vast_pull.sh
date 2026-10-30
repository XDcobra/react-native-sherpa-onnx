#!/usr/bin/env bash
# Pull Phase 0 goldens and HF cache back from Vast. Does not destroy the instance.
# Usage: vast_pull.sh ssh://root@ssh2.vast.ai:30578
set -euo pipefail
KEY="${VAST_SSH_KEY:-$HOME/.ssh/id_ed25519_vast}"
RAW="${1:-}"
PORT="${2:-22}"
if [[ -z "$RAW" ]]; then
  echo "usage: vast_pull.sh user@host [port] | ssh://user@host:port" >&2
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
export COPYFILE_DISABLE=1
echo "pull goldens+cache from $HOST"
"${SSH[@]}" "$HOST" "tar --warning=no-unknown-keyword -cf - -C ~/react-native-sherpa-onnx test/fixtures/ocr/instructions build/ocr-models/phase0-cache build/ocr-models/phase0-master.log build/ocr-models/phase0-vast.log" \
  | tar xf - -C "$ROOT"
echo "pull done"
find "$ROOT/test/fixtures/ocr/instructions" -name meta.json | wc -l
