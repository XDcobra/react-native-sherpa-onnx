#!/usr/bin/env bash
# Collect sherpa-onnx model structures and optionally commit/push.
#
# Usage:
#   run_model_collect.sh [--stream ID] [--manifest PATH] [--skip-commit]
#
# Stream IDs (also listed in .github/workflows/collect-model-structures.yml):
#   all          — every stream in the manifest (in CI, each stream is its own job)
#   asr          — ASR + QNN
#   tts          — TTS
#   punctuation  — Punctuation
#   enhancement  — Speech enhancement
#   separation   — Source separation
#
# Env: ASSET_LIMIT (0 = no limit), COLLECT_JOBS (parallel download+tar-list workers, default 4),
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "This script requires Bash version 4+." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="$SCRIPT_DIR/sherpa_model_collect_manifest.json"
STREAM="all"
SKIP_COMMIT=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --stream)
      STREAM="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    --skip-commit)
      SKIP_COMMIT=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

[[ -f "$MANIFEST" ]] || { echo "Manifest not found: $MANIFEST" >&2; exit 1; }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

STREAM="$(echo -n "$STREAM" | xargs | tr '[:upper:]' '[:lower:]')"
[[ -z "$STREAM" ]] && STREAM="all"

mapfile -t ALLOWED_IDS < <(jq -r '.streams[].id' "$MANIFEST")
ALLOWED_IDS+=("all")

stream_is_allowed() {
  local want="$1"
  local id
  for id in "${ALLOWED_IDS[@]}"; do
    [[ "$id" == "$want" ]] && return 0
  done
  return 1
}

if ! stream_is_allowed "$STREAM"; then
  echo "Invalid stream: '$STREAM'" >&2
  echo "Allowed values: all ${ALLOWED_IDS[@]//all /}" >&2
  exit 1
fi

COLLECT_SCRIPT="$SCRIPT_DIR/collect_all_sherpa_model_streams.sh"
COMMIT_SCRIPT="$SCRIPT_DIR/git_commit_collect_changes.sh"
chmod +x "$COLLECT_SCRIPT" "$SCRIPT_DIR/collect_one_sherpa_release_stream.sh" "$COMMIT_SCRIPT"

cd "$REPO_ROOT"

collect_config() {
  local cfg="$1"
  echo "=== Collecting $cfg ==="
  bash "$COLLECT_SCRIPT" --config "$cfg"
}

if [[ "$STREAM" == "all" ]]; then
  mapfile -t CONFIGS < <(jq -r '.streams[].config' "$MANIFEST")
  for cfg in "${CONFIGS[@]}"; do
    collect_config "$cfg"
  done
else
  cfg="$(jq -r --arg id "$STREAM" '.streams[] | select(.id == $id) | .config' "$MANIFEST")"
  [[ -n "$cfg" && "$cfg" != "null" ]] || { echo "No config for stream '$STREAM'" >&2; exit 1; }
  collect_config "$cfg"
fi

if [[ "$SKIP_COMMIT" -eq 1 ]]; then
  echo "Skip commit (--skip-commit)."
  exit 0
fi

if [[ "$STREAM" == "all" ]]; then
  msg="$(jq -r '.all_commit_message' "$MANIFEST")"
  bash "$COMMIT_SCRIPT" --message "$msg" --manifest "$MANIFEST"
else
  msg="$(jq -r --arg id "$STREAM" '.streams[] | select(.id == $id) | .commit_message' "$MANIFEST")"
  cfg="$(jq -r --arg id "$STREAM" '.streams[] | select(.id == $id) | .config' "$MANIFEST")"
  bash "$COMMIT_SCRIPT" --message "$msg" --config "$cfg"
fi
