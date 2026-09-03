#!/usr/bin/env bash
# Compare GitHub release assets (asr-models, tts-models, speech-enhancement-models,
# source-separation-models, speaker-recongition-models, speaker-segmentation-models)
# with local CSV fixtures.
# If any asset exists on GitHub but is not listed in the corresponding CSV,
# print a warning (non-fatal) with the list and a hint to run the collect workflows.
# Exit code is always 0 so this can be used as an informational step.

set -e

REPO="${SHERPA_ONNX_REPO:-k2-fsa/sherpa-onnx}"
ASR_CSV="${ASR_CSV:-test/fixtures/asr-models-expected.csv}"
TTS_CSV="${TTS_CSV:-test/fixtures/tts-models-expected.csv}"
SPEECH_ENH_CSV="${SPEECH_ENH_CSV:-test/fixtures/speech-enhancement-models-expected.csv}"
VAD_CSV="${VAD_CSV:-test/fixtures/vad-models-expected.csv}"
SEPARATION_CSV="${SEPARATION_CSV:-test/fixtures/source-separation-models-expected.csv}"
SPEAKER_EMB_CSV="${SPEAKER_EMB_CSV:-test/fixtures/speaker-recongition-models-expected.csv}"
DIARIZATION_CSV="${DIARIZATION_CSV:-test/fixtures/speaker-segmentation-models-expected.csv}"

# Optional: GITHUB_TOKEN or GH_TOKEN for api.github.com rate limits / private forks
CURL_GH_API=(-sL)
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  _t="${GITHUB_TOKEN:-$GH_TOKEN}"
  CURL_GH_API+=(-H "Authorization: Bearer ${_t}" -H "Accept: application/vnd.github+json")
fi

if [ ! -f "$ASR_CSV" ]; then
  echo "::warning::Missing $ASR_CSV (run from repo root or set ASR_CSV)"
  exit 0
fi
if [ ! -f "$TTS_CSV" ]; then
  echo "::warning::Missing $TTS_CSV (run from repo root or set TTS_CSV)"
  exit 0
fi
if [ ! -f "$SPEECH_ENH_CSV" ]; then
  echo "::warning::Missing $SPEECH_ENH_CSV (run from repo root or set SPEECH_ENH_CSV)"
  exit 0
fi
if [ ! -f "$VAD_CSV" ]; then
  echo "::warning::Missing $VAD_CSV (run from repo root or set VAD_CSV)"
  exit 0
fi
if [ ! -f "$SEPARATION_CSV" ]; then
  echo "::warning::Missing $SEPARATION_CSV (run from repo root or set SEPARATION_CSV)"
  exit 0
fi
if [ ! -f "$SPEAKER_EMB_CSV" ]; then
  echo "::warning::Missing $SPEAKER_EMB_CSV (run from repo root or set SPEAKER_EMB_CSV)"
  exit 0
fi
if [ ! -f "$DIARIZATION_CSV" ]; then
  echo "::warning::Missing $DIARIZATION_CSV (run from repo root or set DIARIZATION_CSV)"
  exit 0
fi

# Fetch ASR release assets (.tar.bz2, .onnx)
ASR_ASSETS=""
ASR_RESP="${ASR_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/asr-models")}"
if echo "$ASR_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  ASR_ASSETS=$(echo "$ASR_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch asr-models release or it has no assets"
fi

# Fetch TTS release assets
TTS_ASSETS=""
TTS_RESP="${TTS_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/tts-models")}"
if echo "$TTS_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  TTS_ASSETS=$(echo "$TTS_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch tts-models release or it has no assets"
fi

# Fetch speech-enhancement-models release assets (.tar.bz2, .onnx)
SPEECH_ASSETS=""
SPEECH_RESP="${SPEECH_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/speech-enhancement-models")}"
if echo "$SPEECH_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  SPEECH_ASSETS=$(echo "$SPEECH_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch speech-enhancement-models release or it has no assets"
fi

# Fetch source-separation-models release assets (.tar.bz2, .onnx)
SEPARATION_ASSETS=""
SEPARATION_RESP="${SEPARATION_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/source-separation-models")}"
if echo "$SEPARATION_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  SEPARATION_ASSETS=$(echo "$SEPARATION_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch source-separation-models release or it has no assets"
fi

# Fetch speaker-recongition-models release assets (.onnx; upstream tag typo intentional)
SPEAKER_EMB_ASSETS=""
SPEAKER_EMB_RESP="${SPEAKER_EMB_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/speaker-recongition-models")}"
if echo "$SPEAKER_EMB_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  SPEAKER_EMB_ASSETS=$(echo "$SPEAKER_EMB_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch speaker-recongition-models release or it has no assets"
fi

# Fetch speaker-segmentation-models release assets (.tar.bz2)
DIARIZATION_ASSETS=""
DIARIZATION_RESP="${DIARIZATION_RESP:-$(curl "${CURL_GH_API[@]}" "https://api.github.com/repos/${REPO}/releases/tags/speaker-segmentation-models")}"
if echo "$DIARIZATION_RESP" | jq -e '.assets' >/dev/null 2>&1; then
  DIARIZATION_ASSETS=$(echo "$DIARIZATION_RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | .name')
else
  echo "::warning::Could not fetch speaker-segmentation-models release or it has no assets"
fi

# First column of CSV (asset_name); strip optional quotes and whitespace; skip header
csv_asset_names() { awk -F',' '{ gsub(/^ *"|" *$/, "", $1); gsub(/^ | $/, "", $1); if (NR>1 && $1 != "") print $1 }' "$1"; }

ASR_CSV_NAMES=$(csv_asset_names "$ASR_CSV")
TTS_CSV_NAMES=$(csv_asset_names "$TTS_CSV")
SPEECH_CSV_NAMES=$(csv_asset_names "$SPEECH_ENH_CSV")
VAD_CSV_NAMES=$(csv_asset_names "$VAD_CSV")
SEPARATION_CSV_NAMES=$(csv_asset_names "$SEPARATION_CSV")
SPEAKER_EMB_CSV_NAMES=$(csv_asset_names "$SPEAKER_EMB_CSV")
DIARIZATION_CSV_NAMES=$(csv_asset_names "$DIARIZATION_CSV")

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

SPEECH_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$SPEECH_CSV_NAMES"; then
    SPEECH_MISSING="${SPEECH_MISSING}  - ${asset}\n"
  fi
done <<< "$SPEECH_ASSETS"

VAD_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$VAD_CSV_NAMES"; then
    VAD_MISSING="${VAD_MISSING}  - ${asset}\n"
  fi
done <<< "$ASR_ASSETS"

SEPARATION_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$SEPARATION_CSV_NAMES"; then
    SEPARATION_MISSING="${SEPARATION_MISSING}  - ${asset}\n"
  fi
done <<< "$SEPARATION_ASSETS"

SPEAKER_EMB_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$SPEAKER_EMB_CSV_NAMES"; then
    SPEAKER_EMB_MISSING="${SPEAKER_EMB_MISSING}  - ${asset}\n"
  fi
done <<< "$SPEAKER_EMB_ASSETS"

DIARIZATION_MISSING=""
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  if ! grep -qFx -- "$asset" <<< "$DIARIZATION_CSV_NAMES"; then
    DIARIZATION_MISSING="${DIARIZATION_MISSING}  - ${asset}\n"
  fi
done <<< "$DIARIZATION_ASSETS"

if [ -n "$ASR_MISSING" ] || [ -n "$TTS_MISSING" ] || [ -n "$SPEECH_MISSING" ] || [ -n "$VAD_MISSING" ] || [ -n "$SEPARATION_MISSING" ] || [ -n "$SPEAKER_EMB_MISSING" ] || [ -n "$DIARIZATION_MISSING" ]; then
  echo "::warning::New assets are available on GitHub but not yet listed in the expected CSV files."
  [ -n "$ASR_MISSING" ] && echo -e "ASR (asr-models) assets missing from $ASR_CSV:\n$ASR_MISSING"
  [ -n "$TTS_MISSING" ] && echo -e "TTS (tts-models) assets missing from $TTS_CSV:\n$TTS_MISSING"
  [ -n "$SPEECH_MISSING" ] && echo -e "Speech enhancement (speech-enhancement-models) assets missing from $SPEECH_ENH_CSV:\n$SPEECH_MISSING"
  [ -n "$VAD_MISSING" ] && echo -e "ASR release assets missing from VAD expected CSV ($VAD_CSV):\n$VAD_MISSING"
  [ -n "$SEPARATION_MISSING" ] && echo -e "Source separation (source-separation-models) assets missing from $SEPARATION_CSV:\n$SEPARATION_MISSING"
  [ -n "$SPEAKER_EMB_MISSING" ] && echo -e "Speaker embedding (speaker-recongition-models) assets missing from $SPEAKER_EMB_CSV:\n$SPEAKER_EMB_MISSING"
  [ -n "$DIARIZATION_MISSING" ] && echo -e "Diarization (speaker-segmentation-models) assets missing from $DIARIZATION_CSV:\n$DIARIZATION_MISSING"
  echo "Please run the collect workflows to update fixtures:"
  echo "  - Testdata - Collect model structures (workflow_dispatch; stream=all, asr, tts, punctuation, enhancement, separation, speaker-embedding, or diarization)"
  exit 0
fi

echo "All GitHub release assets are listed in the expected CSV files."
