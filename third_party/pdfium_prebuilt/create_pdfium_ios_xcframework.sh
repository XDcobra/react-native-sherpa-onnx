#!/usr/bin/env bash
# Fetch pdfium-binaries iOS slices and assemble pdfium.xcframework
# (device arm64 + universal simulator arm64/x86_64) as pdfium.framework.
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

write_framework_plist() {
  local plist="$1"
  local platform="$2"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>pdfium</string>
  <key>CFBundleIdentifier</key>
  <string>org.chromium.pdfium</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>pdfium</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>13.0</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>${platform}</string>
  </array>
</dict>
</plist>
EOF
}

assemble_pdfium_framework() {
  local binary="$1"
  local headers="$2"
  local out_fw="$3"
  local platform="$4"

  if [[ ! -f "$binary" ]]; then
    echo "ERROR: pdfium binary not found: $binary" >&2
    return 1
  fi
  if [[ ! -d "$headers" ]]; then
    echo "ERROR: headers dir not found: $headers" >&2
    return 1
  fi
  if [[ "$platform" != "iPhoneOS" && "$platform" != "iPhoneSimulator" ]]; then
    echo "ERROR: platform must be iPhoneOS or iPhoneSimulator, got: $platform" >&2
    return 1
  fi

  rm -rf "$out_fw"
  mkdir -p "$out_fw/Headers"
  cp "$binary" "$out_fw/pdfium"
  cp -R "$headers"/. "$out_fw/Headers/"
  write_framework_plist "$out_fw/Info.plist" "$platform"
  install_name_tool -id '@rpath/pdfium.framework/pdfium' "$out_fw/pdfium"
  codesign --force --sign - --timestamp=none "$out_fw/pdfium" >/dev/null 2>&1 || true
}

fetch_slice() {
  local asset="$1"
  local dest="$2"
  local tgz="$WORK/${asset}.tgz"
  echo "Fetching pdfium-ios-${asset}.tgz"
  curl -fsSL -o "$tgz" "${BASE_URL}/pdfium-ios-${asset}.tgz"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest"
  if [[ ! -d "$dest/include" ]]; then
    echo "ERROR: include/ missing in ${asset}" >&2
    exit 1
  fi
  if ! archive_binary "$dest" >/dev/null; then
    echo "ERROR: no binary under ${asset}/lib" >&2
    find "$dest" -type f | head -40 >&2
    exit 1
  fi
}

archive_binary() {
  local dest="$1"
  local binary
  binary=$(find "$dest/lib" -maxdepth 1 -type f 2>/dev/null | head -1)
  if [[ -z "$binary" || ! -f "$binary" ]]; then
    return 1
  fi
  printf '%s\n' "$binary"
}

fetch_slice "device-arm64" "$WORK/device-arm64"
fetch_slice "simulator-arm64" "$WORK/simulator-arm64"
fetch_slice "simulator-x64" "$WORK/simulator-x64"

mkdir -p "$WORK/sim"

echo "Creating universal simulator binary (arm64 + x86_64)"
lipo -create \
  "$(archive_binary "$WORK/simulator-arm64")" \
  "$(archive_binary "$WORK/simulator-x64")" \
  -output "$WORK/sim/pdfium"

echo "Assembling pdfium.framework slices"
assemble_pdfium_framework \
  "$(archive_binary "$WORK/device-arm64")" "$WORK/device-arm64/include" \
  "$WORK/device/pdfium.framework" "iPhoneOS"
assemble_pdfium_framework \
  "$WORK/sim/pdfium" "$WORK/simulator-arm64/include" \
  "$WORK/sim/pdfium.framework" "iPhoneSimulator"

echo "Creating pdfium.xcframework"
if ! xcodebuild -create-xcframework \
  -framework "$WORK/device/pdfium.framework" \
  -framework "$WORK/sim/pdfium.framework" \
  -output "$OUT_XCFW"
then
  echo "ERROR: xcodebuild -create-xcframework failed" >&2
  exit 1
fi

if [[ ! -f "$OUT_XCFW/ios-arm64/pdfium.framework/pdfium" ]] \
  || [[ ! -f "$OUT_XCFW/ios-arm64/pdfium.framework/Headers/fpdfview.h" ]] \
  || [[ ! -f "$OUT_XCFW/ios-arm64_x86_64-simulator/pdfium.framework/pdfium" ]] \
  || [[ ! -f "$OUT_XCFW/ios-arm64_x86_64-simulator/pdfium.framework/Headers/fpdfview.h" ]]; then
  echo "ERROR: pdfium.xcframework missing expected device/simulator pdfium.framework slices" >&2
  find "$OUT_XCFW" -maxdepth 4 2>/dev/null || true
  exit 1
fi

rm -rf "$WORK"
echo "Done: $OUT_XCFW"
ls -la "$OUT_XCFW"
