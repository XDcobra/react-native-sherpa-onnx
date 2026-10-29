#!/bin/bash
# Copy pdfium.framework into the app bundle. Runs as an autolinked script phase
# on the *app* target (React Native static pods do not embed a dynamic
# XCFramework via [CP] Embed Pods Frameworks).
#
# No-ops when PDFium is not installed (SDK default is off).
set -euo pipefail

if [ -z "${FRAMEWORKS_FOLDER_PATH:-}" ]; then
  exit 0
fi

find_pdfium_xcframework() {
  local candidate
  for candidate in \
    "${PODS_ROOT:-}/../../node_modules/react-native-sherpa-onnx/ios/Frameworks/pdfium.xcframework" \
    "${PODS_ROOT:-}/../../../node_modules/react-native-sherpa-onnx/ios/Frameworks/pdfium.xcframework" \
    "${PODS_ROOT:-}/../../../ios/Frameworks/pdfium.xcframework" \
    "${SRCROOT:-}/../node_modules/react-native-sherpa-onnx/ios/Frameworks/pdfium.xcframework"
  do
    if [ -d "$candidate/ios-arm64/pdfium.framework" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

XCFW="$(find_pdfium_xcframework || true)"
if [ -z "$XCFW" ]; then
  exit 0
fi

SLICE="ios-arm64"
if [[ "${PLATFORM_NAME:-}" == *simulator* ]]; then
  SLICE="ios-arm64_x86_64-simulator"
fi

SRC="${XCFW}/${SLICE}/pdfium.framework"
if [ ! -d "$SRC" ]; then
  echo "error: pdfium.framework missing at $SRC" >&2
  exit 1
fi

DEST="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"
mkdir -p "$DEST"
rsync -a --delete "$SRC" "$DEST/"

if [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ] \
  && [ "${CODE_SIGNING_REQUIRED:-}" != "NO" ] \
  && [ "${CODE_SIGNING_ALLOWED:-}" != "NO" ]; then
  /usr/bin/codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" \
    ${OTHER_CODE_SIGN_FLAGS:-} \
    --preserve-metadata=identifier,entitlements \
    "${DEST}/pdfium.framework"
fi
