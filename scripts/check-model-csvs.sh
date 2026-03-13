#!/usr/bin/env bash
# Compare GitHub release assets (asr-models, tts-models) with local CSV fixtures.
# If any asset exists on GitHub but is not listed in the corresponding CSV,
# print a warning (non-fatal) with the list and a hint to run the collect workflows.
# Exit code is always 0 so this can be used as an informational step.

set -e

REPO="${SHERPA_ONNX_REPO:-k2-fsa/sherpa-onnx}"
ASR_CSV="${ASR_CSV:-test/fixtures/asr-models-expected.csv}"
TTS_CSV="${TTS_CSV:-test/fixtures/tts-models-expected.csv}"

if [ ! -f "$ASR_CSV" ]; then
  echo "::warning::Missing $ASR_CSV (run from repo root or set ASR_CSV)"
  exit 0
fi
if [ ! -f "$TTS_CSV" ]; then
  echo "::warning::Missing $TTS_CSV (run from repo root or set TTS_CSV)"
  exit 0
fi

# Fetch ASR release assets (.tar.bz2, .onnx)
ASR_ASSETS=""
ASR_RESP="${ASR_RESP:-$(curl -sL "https://api.github.com/repos/${REPO}/releases/tags/asr-models")}"
if echo "$ASR_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  ASR_ASSETS=$(echo "$ASR_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch asr-models release or it has no assets"
fi

# Fetch TTS release assets
TTS_ASSETS=""
TTS_RESP="${TTS_RESP:-$(curl -sL "https://api.github.com/repos/${REPO}/releases/tags/tts-models")}"
if echo "$TTS_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  TTS_ASSETS=$(echo "$TTS_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch tts-models release or it has no assets"
fi

# First column of CSV (asset_name); strip optional quotes and whitespace; skip header
csv_asset_names() { awk -F',' '{ gsub(/^ *"|" *$/, "", $1); gsub(/^ | $/, "", $1); if (NR>1 && $1 != "") print $1 }' "$1"; }

ASR_CSV_NAMES=$(csv_asset_names "$ASR_CSV")
TTS_CSV_NAMES=$(csv_asset_names "$TTS_CSV")

ASR_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$ASR_CSV_NAMES"; then
    ASR_MISSING="${ASR_MISSING}  - ${asset}\n"
  fi
done <<< "$ASR_ASSETS"

TTS_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$TTS_CSV_NAMES"; then
    TTS_MISSING="${TTS_MISSING}  - ${asset}\n"
  fi
done <<< "$TTS_ASSETS"

if [ -n "$ASR_MISSING" ] || [ -n "$TTS_MISSING" ]; then
  echo "::warning::New assets are available on GitHub but not yet listed in the expected CSV files."
  [ -n "$ASR_MISSING" ] && echo -e "ASR (asr-models) assets missing from $ASR_CSV:\n$ASR_MISSING"
  [ -n "$TTS_MISSING" ] && echo -e "TTS (tts-models) assets missing from $TTS_CSV:\n$TTS_MISSING"
  echo "Please run the collect workflows to update fixtures:"
  echo "  - Testdata - Collect ASR model structures (workflow_dispatch)"
  echo "  - Testdata - Collect TTS model structures (workflow_dispatch)"
  exit 0
fi

echo "All GitHub release assets are listed in the expected CSV files."
