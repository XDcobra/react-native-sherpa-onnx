#!/usr/bin/env bash
# Fetch PDFium Android binaries and rearrange into our prebuilt layout.
# Usage: ./fetch_pdfium_android.sh [version]
# Binaries come from https://github.com/XDcobra/pdfium-binaries (release sdk-<version>), a
# fork of bblanchon/pdfium-binaries; override the base with PDFIUM_BINARIES_URL.
# Version is the PDFium branch number (8152 for chromium/8152).
# Default reads ANDROID_RELEASE_TAG (pdfium-android-v8152-1 → 8152).
# Trailing -N is our rebuild counter and is stripped for the fetch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
strip_rebuild() { echo "$1" | sed 's/-[0-9][0-9]*$//'; }
if [[ -n "${1:-}" ]]; then
  VERSION="$(strip_rebuild "$1")"
else
  TAG_FILE="$ROOT/ANDROID_RELEASE_TAG"
  if [[ -f "$TAG_FILE" ]]; then
    RELEASE_TAG=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
    VERSION="$(strip_rebuild "${RELEASE_TAG#pdfium-android-v}")"
  fi
fi
VERSION="${VERSION:-8152}"
OUT="$ROOT/android"
TMP="$ROOT/.fetch-tmp"
BASE_URL="${PDFIUM_BINARIES_URL:-https://github.com/XDcobra/pdfium-binaries/releases/download}/sdk-${VERSION}"

rm -rf "$TMP"
mkdir -p "$TMP" "$OUT/include"

# pdfium-binaries asset stem → Android ABI directory name
fetch_abi() {
  local pdfium_stem="$1"
  local abi="$2"
  local zip="$TMP/${pdfium_stem}.tgz"
  echo "Fetching pdfium-android-${pdfium_stem}.tgz → ${abi}"
  curl -sSL -o "$zip" "${BASE_URL}/pdfium-android-${pdfium_stem}.tgz"
  mkdir -p "$TMP/${abi}"
  tar -xzf "$zip" -C "$TMP/${abi}"
  mkdir -p "$OUT/jni/${abi}"
  # pdfium-binaries layout: lib/libpdfium.so and include/
  if [[ -f "$TMP/${abi}/lib/libpdfium.so" ]]; then
    cp "$TMP/${abi}/lib/libpdfium.so" "$OUT/jni/${abi}/"
  elif [[ -f "$TMP/${abi}/libpdfium.so" ]]; then
    cp "$TMP/${abi}/libpdfium.so" "$OUT/jni/${abi}/"
  else
    echo "ERROR: libpdfium.so not found in ${pdfium_stem} archive" >&2
    find "$TMP/${abi}" -type f | head -40 >&2
    exit 1
  fi
  if [[ -d "$TMP/${abi}/include" ]]; then
    cp -R "$TMP/${abi}/include/." "$OUT/include/"
  fi
}

# Asset names as of chromium/8100 (arm64/arm/x86/x64, not NDK ABI strings).
fetch_abi "arm64" "arm64-v8a"
fetch_abi "arm" "armeabi-v7a"
fetch_abi "x86" "x86"
fetch_abi "x64" "x86_64"

rm -rf "$TMP"
echo "Done. Layout at $OUT"
echo "Headers: $OUT/include/fpdfview.h"
ls -la "$OUT/include/fpdfview.h" "$OUT/jni/arm64-v8a/libpdfium.so"
