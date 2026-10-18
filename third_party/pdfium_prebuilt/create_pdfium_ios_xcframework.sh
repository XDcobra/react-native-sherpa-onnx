#!/usr/bin/env bash
# Fetch pdfium-binaries iOS dylibs and assemble a real pdfium.xcframework
# (device arm64 + universal simulator arm64/x86_64).
#
# Usage: ./create_pdfium_ios_xcframework.sh [chromium-version]
# Default version matches IOS_RELEASE_TAG suffix (pdfium-ios-v8100 → 8100).
#
# Output: third_party/pdfium_prebuilt/pdfium.xcframework
# Requires: macOS with Xcode (lipo, install_name_tool, xcodebuild).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  TAG_FILE="$ROOT/IOS_RELEASE_TAG"
  if [[ -f "$TAG_FILE" ]]; then
    RELEASE_TAG=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
    VERSION="${RELEASE_TAG#pdfium-ios-v}"
  fi
fi
VERSION="${VERSION:-8100}"

BASE_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${VERSION}"
WORK="$ROOT/.ios-xc-build"
OUT_XCFW="$ROOT/pdfium.xcframework"

rm -rf "$WORK" "$OUT_XCFW"
mkdir -p "$WORK"

fetch_slice() {
  local asset="$1"
  local dest="$2"
  local tgz="$WORK/${asset}.tgz"
  echo "Fetching pdfium-ios-${asset}.tgz"
  curl -fsSL -o "$tgz" "${BASE_URL}/pdfium-ios-${asset}.tgz"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest"
  if [[ ! -f "$dest/lib/libpdfium.dylib" ]]; then
    echo "ERROR: lib/libpdfium.dylib missing in ${asset}" >&2
    find "$dest" -type f | head -40 >&2
    exit 1
  fi
  if [[ ! -d "$dest/include" ]]; then
    echo "ERROR: include/ missing in ${asset}" >&2
    exit 1
  fi
}

fetch_slice "device-arm64" "$WORK/device-arm64"
fetch_slice "simulator-arm64" "$WORK/simulator-arm64"
fetch_slice "simulator-x64" "$WORK/simulator-x64"

mkdir -p "$WORK/device" "$WORK/sim/lib" "$WORK/device/include" "$WORK/sim/include"

cp "$WORK/device-arm64/lib/libpdfium.dylib" "$WORK/device/libpdfium.dylib"
cp -R "$WORK/device-arm64/include/." "$WORK/device/include/"

echo "Creating universal simulator dylib (arm64 + x86_64)"
lipo -create \
  "$WORK/simulator-arm64/lib/libpdfium.dylib" \
  "$WORK/simulator-x64/lib/libpdfium.dylib" \
  -output "$WORK/sim/lib/libpdfium.dylib"
cp -R "$WORK/simulator-arm64/include/." "$WORK/sim/include/"

# Runtime-friendly install names for embedding via @rpath
install_name_tool -id '@rpath/libpdfium.dylib' "$WORK/device/libpdfium.dylib"
install_name_tool -id '@rpath/libpdfium.dylib' "$WORK/sim/lib/libpdfium.dylib"

echo "Creating pdfium.xcframework"
if ! xcodebuild -create-xcframework \
  -library "$WORK/device/libpdfium.dylib" -headers "$WORK/device/include" \
  -library "$WORK/sim/lib/libpdfium.dylib" -headers "$WORK/sim/include" \
  -output "$OUT_XCFW"
then
  echo "ERROR: xcodebuild -create-xcframework failed" >&2
  exit 1
fi

# Sanity: expected slice layout for SherpaOnnx.podspec / setup-ios-framework.sh
if [[ ! -f "$OUT_XCFW/ios-arm64/libpdfium.dylib" ]] \
  || [[ ! -d "$OUT_XCFW/ios-arm64/Headers" ]] \
  || [[ ! -f "$OUT_XCFW/ios-arm64_x86_64-simulator/libpdfium.dylib" ]] \
  || [[ ! -d "$OUT_XCFW/ios-arm64_x86_64-simulator/Headers" ]] \
  || [[ ! -f "$OUT_XCFW/ios-arm64/Headers/fpdfview.h" ]]; then
  echo "ERROR: pdfium.xcframework missing expected device/simulator slices" >&2
  find "$OUT_XCFW" -maxdepth 3 2>/dev/null || true
  exit 1
fi

rm -rf "$WORK"
echo "Done: $OUT_XCFW"
ls -la "$OUT_XCFW"
