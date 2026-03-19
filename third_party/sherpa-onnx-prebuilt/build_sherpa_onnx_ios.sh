#!/usr/bin/env bash
# Build sherpa-onnx XCFramework for iOS (device + simulator).
# Uses the sherpa-onnx submodule at third_party/sherpa-onnx if present; otherwise clones
# from k2-fsa/sherpa-onnx. Applies C++ API and espeak-ng path-length patches, builds,
# merges ONNX Runtime, adds nlohmann headers, and outputs sherpa_onnx.xcframework.
#
# Usage: build_sherpa_onnx_ios.sh <GIT_REF>
#   GIT_REF: branch or tag to use (e.g. v1.12.28, main). Required.
#
# Output: third_party/sherpa-onnx-prebuilt/sherpa_onnx.xcframework
# Requires: macOS, Xcode, CMake. Run from repo root or from third_party/sherpa-onnx-prebuilt.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <GIT_REF>" >&2
  echo "  GIT_REF: branch or tag for k2-fsa/sherpa-onnx (e.g. v1.12.28, main)" >&2
  exit 1
fi
GIT_REF="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_TOP="$SCRIPT_DIR/build_ios_work"
SHERPA_SRC="$BUILD_TOP/sherpa-onnx-source"
OUTPUT_XCFRAMEWORK="$SCRIPT_DIR/sherpa_onnx.xcframework"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS builds require macOS" >&2
  exit 1
fi

SUBMODULE_DIR="$REPO_ROOT/third_party/sherpa-onnx"
if [ -f "$SUBMODULE_DIR/build-ios.sh" ]; then
  echo "===== Using sherpa-onnx submodule ====="
  SHERPA_SRC="$SUBMODULE_DIR"
else
  echo "===== Cloning sherpa-onnx ($GIT_REF) ====="
  rm -rf "$BUILD_TOP"
  mkdir -p "$BUILD_TOP"
  cd "$BUILD_TOP"
  git clone --depth 1 --branch "$GIT_REF" https://github.com/k2-fsa/sherpa-onnx.git sherpa-onnx-source || \
    git clone --depth 1 https://github.com/k2-fsa/sherpa-onnx.git sherpa-onnx-source
  cd sherpa-onnx-source
  git checkout "$GIT_REF" || git checkout main
  git log -1 --oneline
  SHERPA_SRC="$BUILD_TOP/sherpa-onnx-source"
fi

cd "$SHERPA_SRC"
echo "===== Patching build-ios.sh (C++ API) ====="
sed -i.bak 's/libsherpa-onnx-c-api.a libsherpa-onnx-core.a/libsherpa-onnx-c-api.a libsherpa-onnx-cxx-api.a libsherpa-onnx-core.a/g' build-ios.sh
sed -i.bak 's|build/simulator/lib/libsherpa-onnx-c-api.a|build/simulator/lib/libsherpa-onnx-c-api.a build/simulator/lib/libsherpa-onnx-cxx-api.a|' build-ios.sh
sed -i.bak 's|build/os64/lib/libsherpa-onnx-c-api.a|build/os64/lib/libsherpa-onnx-c-api.a build/os64/lib/libsherpa-onnx-cxx-api.a|' build-ios.sh
rm -f build-ios.sh.bak

# espeak-ng (Piper/Vits TTS) uses a fixed path buffer (N_PATH_HOME_DEF 255 on Posix). Long iOS paths get
# truncated and cause fallback to /usr/share/espeak-ng-data and init failure. Patch sherpa-onnx's CMake
# so the espeak-ng target is built with N_PATH_HOME=512. See issue-tts-espeak-ng-path-length.md (in this directory).
echo "===== Patching espeak-ng N_PATH_HOME (CMake) ====="
CMAKE_FILE="${SHERPA_SRC}/cmake/espeak-ng-for-piper.cmake"
if [ ! -f "$CMAKE_FILE" ]; then
  echo "Note: $CMAKE_FILE not found, skipping N_PATH_HOME patch."
else
  if grep -q "N_PATH_HOME=512" "$CMAKE_FILE" 2>/dev/null; then
    echo "N_PATH_HOME=512 already present in $CMAKE_FILE, skipping."
  else
    case "$(uname -s)" in
      Darwin)
        sed -i.bak '/add_subdirectory.*espeak_ng_SOURCE_DIR.*espeak_ng_BINARY_DIR/a\
  target_compile_definitions(espeak-ng PRIVATE N_PATH_HOME=512)
' "$CMAKE_FILE"
        rm -f "${CMAKE_FILE}.bak"
        ;;
      *)
        sed -i '/add_subdirectory.*espeak_ng_SOURCE_DIR.*espeak_ng_BINARY_DIR/a\  target_compile_definitions(espeak-ng PRIVATE N_PATH_HOME=512)' "$CMAKE_FILE"
        ;;
    esac
    echo "Patched $CMAKE_FILE: added target_compile_definitions(espeak-ng PRIVATE N_PATH_HOME=512)"
  fi
fi

# Upstream build-ios.sh configures and builds three slices, then creates the xcframework.
# The CMake patch above ensures espeak-ng is compiled with N_PATH_HOME=512 for long data_dir paths.
echo "===== Building sherpa-onnx XCFramework ====="
cd "$SHERPA_SRC"
chmod +x build-ios.sh
# Ensure Xcode license is accepted once (run manually if needed: sudo xcodebuild -license accept)
# Run without filtering so build failures show the real error.
./build-ios.sh

FRAMEWORK_NAME=""
if [ -d "$SHERPA_SRC/build-ios/sherpa-onnx.xcframework" ]; then
  FRAMEWORK_NAME="sherpa-onnx.xcframework"
elif [ -d "$SHERPA_SRC/build-ios/sherpa_onnx.xcframework" ]; then
  FRAMEWORK_NAME="sherpa_onnx.xcframework"
else
  echo "Error: XCFramework not found after build" >&2
  ls -la "$SHERPA_SRC/build-ios/" 2>/dev/null || true
  exit 1
fi
echo "XCFramework built: $FRAMEWORK_NAME"

echo "===== Adding ONNX Runtime to XCFramework ====="
cd "$SHERPA_SRC/build-ios"
ONNXRUNTIME_DIR="ios-onnxruntime/onnxruntime.xcframework"
if [ ! -d "$ONNXRUNTIME_DIR" ]; then
  echo "Error: ONNX Runtime XCFramework not found at $ONNXRUNTIME_DIR" >&2
  exit 1
fi

for SLICE in ios-arm64 ios-arm64_x86_64-simulator; do
  SHERPA_LIB="$FRAMEWORK_NAME/$SLICE/libsherpa-onnx.a"
  ONNX_LIB="$ONNXRUNTIME_DIR/$SLICE/onnxruntime.a"
  if [ -f "$SHERPA_LIB" ] && [ -f "$ONNX_LIB" ]; then
    mv "$SHERPA_LIB" "${SHERPA_LIB}.original"
    libtool -static -o "$SHERPA_LIB" "${SHERPA_LIB}.original" "$ONNX_LIB"
    rm "${SHERPA_LIB}.original"
  else
    echo "Error: Missing libs for $SLICE" >&2
    exit 1
  fi
done
echo "ONNX Runtime merged into XCFramework"

echo "===== Including nlohmann headers ====="
NLOHMANN_DIR=""
for d in $(cd "$SHERPA_SRC" && find . -type d -name 'nlohmann' -print 2>/dev/null); do
  case "$d" in
    */include/*|*/single_include/*|./include/*|./single_include/*)
      NLOHMANN_DIR="$SHERPA_SRC/${d#./}"
      break
      ;;
  esac
done
if [ -z "$NLOHMANN_DIR" ]; then
  D=$(cd "$SHERPA_SRC" && find . -type d \( -path './**/include/nlohmann' -o -path './**/single_include/nlohmann' \) 2>/dev/null | head -n1 || true)
  [ -n "$D" ] && NLOHMANN_DIR="$SHERPA_SRC/${D#./}"
fi
if [ -n "$NLOHMANN_DIR" ]; then
  FRAMEWORK_DIR="$SHERPA_SRC/build-ios/$FRAMEWORK_NAME"
  for HDR_DIR in "$FRAMEWORK_DIR"/*/Headers; do
    [ -d "$HDR_DIR" ] || continue
    mkdir -p "$HDR_DIR/nlohmann"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --include='*/' --include='*.hpp' --include='*.h' --exclude='*' "$NLOHMANN_DIR/" "$HDR_DIR/nlohmann/"
    else
      (cd "$NLOHMANN_DIR" && find . -type f \( -name '*.hpp' -o -name '*.h' \) -print0) | while IFS= read -r -d '' f; do
        mkdir -p "$HDR_DIR/nlohmann/$(dirname "$f")"
        cp "$NLOHMANN_DIR/$f" "$HDR_DIR/nlohmann/$f" 2>/dev/null || true
      done
    fi
  done
  echo "nlohmann headers installed"
fi

echo "===== Copying XCFramework to output ====="
rm -rf "$OUTPUT_XCFRAMEWORK"
cp -R "$SHERPA_SRC/build-ios/$FRAMEWORK_NAME" "$OUTPUT_XCFRAMEWORK"

echo "Build complete: $OUTPUT_XCFRAMEWORK"
du -sh "$OUTPUT_XCFRAMEWORK" 2>/dev/null || true
