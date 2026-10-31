#!/usr/bin/env bash
# Fetch PDFium Android binaries (pdfium-binaries) and rearrange into our prebuilt layout.
# Usage: ./fetch_pdfium_android.sh [version]
# Version is the pdfium-binaries chromium/ tag suffix (e.g. 8100 for chromium/8100).
# Default reads ANDROID_RELEASE_TAG (pdfium-android-v8100-1 → chromium/8100).
# Trailing -N is our rebuild counter and is stripped for the upstream fetch.
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
VERSION="${VERSION:-8100}"
OUT="$ROOT/android"
TMP="$ROOT/.fetch-tmp"
BASE_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${VERSION}"

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
