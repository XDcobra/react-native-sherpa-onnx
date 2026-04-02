#!/usr/bin/env bash
# Run collect_one_sherpa_release_stream.sh for every entry in a streams JSON config.
#
# Usage:
#   collect_all_sherpa_model_streams.sh [--config <file>]
#   collect_all_sherpa_model_streams.sh [--config <file>] --print-git-paths
#
# Default config: scripts/ci/sherpa_asr_model_release_streams.json (ASR + QNN).
# TTS: --config sherpa_tts_model_release_streams.json
# Speech enhancement: --config sherpa_speech_enhancement_model_release_streams.json
# (paths relative to this dir or repo root, or absolute).
#
# --print-git-paths prints newline-separated paths to git-add (deduped), then exits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_REL="sherpa_asr_model_release_streams.json"
PRINT_PATHS=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --config)
      CONFIG_REL="${2:-}"
      [[ -n "$CONFIG_REL" ]] || { echo "--config requires a file path" >&2; exit 1; }
      shift 2
      ;;
    --print-git-paths)
      PRINT_PATHS=1
      shift
      ;;
    *)
      echo "Unknown option: $1 (use --config FILE and/or --print-git-paths)" >&2
      exit 1
      ;;
  esac
done

resolve_config_path() {
  local rel="$1"
  if [[ "$rel" = /* ]]; then
    echo "$rel"
    return
  fi
  if [[ -f "$SCRIPT_DIR/$rel" ]]; then
    echo "$SCRIPT_DIR/$rel"
    return
  fi
  if [[ -f "$REPO_ROOT/$rel" ]]; then
    echo "$REPO_ROOT/$rel"
    return
  fi
  echo ""
}

CONFIG="$(resolve_config_path "$CONFIG_REL")"
[[ -n "$CONFIG" && -f "$CONFIG" ]] || { echo "Config not found: $CONFIG_REL" >&2; exit 1; }

if [[ "$PRINT_PATHS" -eq 1 ]]; then
  {
    jq -r '.streams[] | .structure_file, .expected_csv' "$CONFIG"
    jq -r '.streams[] | .license_csv | strings' "$CONFIG"
    jq -r '.streams[] | .license_csv | strings | select(startswith("android/src/main/assets/model_licenses/")) | ("ios/Resources/model_licenses/" + (split("/") | .[-1]))' "$CONFIG"
  } | sort -u
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (install jq or use CI)." >&2
  exit 1
fi

GITHUB_REPO="$(jq -r '.repo // "k2-fsa/sherpa-onnx"' "$CONFIG")"

n="$(jq '.streams | length' "$CONFIG")"
for ((i = 0; i < n; i++)); do
  row="$(jq -c ".streams[$i]" "$CONFIG")"
  tag="$(echo "$row" | jq -r '.release_tag')"
  tree="$(echo "$row" | jq -r '.tree_cache_dir')"
  struct="$(echo "$row" | jq -r '.structure_file')"
  expected="$(echo "$row" | jq -r '.expected_csv')"
  lic="$(echo "$row" | jq -r '.license_csv | strings')"
  sid="$(echo "$row" | jq -r '.id // empty')"

  args=(
    "$SCRIPT_DIR/collect_one_sherpa_release_stream.sh"
    --repo-root "$REPO_ROOT"
    --github-repo "$GITHUB_REPO"
    --release-tag "$tag"
    --structure-file "$struct"
    --expected-csv "$expected"
    --tree-cache-dir "$tree"
  )
  if [[ -n "$lic" ]]; then
    args+=(--license-csv "$lic")
  fi
  if [[ -n "$sid" ]]; then
    args+=(--stream-id "$sid")
  fi
  bash "${args[@]}"
done

echo "=== All streams processed ($n) config=$(basename "$CONFIG") ==="
