#!/usr/bin/env bash
# Build sherpa-onnx XCFramework for iOS (device + simulator).
# Uses the sherpa-onnx submodule at third_party/sherpa-onnx if present; otherwise clones
# from k2-fsa/sherpa-onnx. Applies espeak-ng path-length patch, runs upstream build-ios.sh
# (SherpaOnnxC.framework per slice), merges cxx-api + ONNX Runtime into the framework binary,
# and outputs sherpa_onnx.xcframework.
#
# Usage: build_sherpa_onnx_ios.sh <GIT_REF>
#   GIT_REF: branch or tag to use (e.g. v1.13.7, main). Required.
#
# Environment:
#   SHERPA_ONNX_ONNXRUNTIME_VERSION or ONNXRUNTIME_VERSION — ORT version (default 1.28.1)
#
# Output: third_party/sherpa-onnx-prebuilt/sherpa_onnx.xcframework
# Requires: macOS, Xcode, CMake. Run from repo root or from third_party/sherpa-onnx-prebuilt.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <GIT_REF>" >&2
  echo "  GIT_REF: branch or tag for k2-fsa/sherpa-onnx (e.g. v1.13.7, main)" >&2
  exit 1
fi
GIT_REF="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_TOP="$SCRIPT_DIR/build_ios_work"
SHERPA_SRC="$BUILD_TOP/sherpa-onnx-source"
OUTPUT_XCFRAMEWORK="$SCRIPT_DIR/sherpa_onnx.xcframework"

ORT_VERSION="${SHERPA_ONNX_ONNXRUNTIME_VERSION:-${ONNXRUNTIME_VERSION:-1.28.1}}"

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
    if ! grep -q "N_PATH_HOME=512" "$CMAKE_FILE" 2>/dev/null; then
      echo "Error: Failed to apply N_PATH_HOME=512 patch to $CMAKE_FILE." >&2
      echo "The upstream CMake file may have changed. Without this patch, espeak-ng may fail to" >&2
      echo "initialize on long paths (N_PATH_HOME_DEF 255 truncation). Aborting build." >&2
      exit 1
    fi
  fi
fi

echo "===== Building sherpa-onnx XCFramework (upstream build-ios.sh) ====="
echo "ONNX Runtime version: $ORT_VERSION"
cd "$SHERPA_SRC"
chmod +x build-ios.sh
export SHERPA_ONNX_ONNXRUNTIME_VERSION="$ORT_VERSION"
./build-ios.sh

BUILD_IOS_DIR="$SHERPA_SRC/build-ios"
FRAMEWORK_NAME=""
if [ -d "$BUILD_IOS_DIR/sherpa-onnx.xcframework" ]; then
  FRAMEWORK_NAME="sherpa-onnx.xcframework"
elif [ -d "$BUILD_IOS_DIR/sherpa_onnx.xcframework" ]; then
  FRAMEWORK_NAME="sherpa_onnx.xcframework"
else
  echo "Error: XCFramework not found after build" >&2
  ls -la "$BUILD_IOS_DIR/" 2>/dev/null || true
  exit 1
fi
echo "XCFramework built: $FRAMEWORK_NAME"

CXX_API_HEADER="$BUILD_IOS_DIR/install/include/sherpa-onnx/c-api/cxx-api.h"
if [ ! -f "$CXX_API_HEADER" ]; then
  echo "Error: cxx-api.h not found at $CXX_API_HEADER (cmake install step may have failed)" >&2
  exit 1
fi

ONNXRUNTIME_DIR="$BUILD_IOS_DIR/ios-onnxruntime/onnxruntime.xcframework"
if [ ! -d "$ONNXRUNTIME_DIR" ]; then
  echo "Error: ONNX Runtime XCFramework not found at $ONNXRUNTIME_DIR" >&2
  exit 1
fi

# ORT 1.17.x: $SLICE/onnxruntime.a. ORT 1.24+ static xcframework: $SLICE/onnxruntime.framework/onnxruntime
resolve_onnx_static_lib() {
  local root="$1"
  local slice="$2"
  local base="${root}/${slice}"
  if [ -f "${base}/onnxruntime.framework/libonnxruntime.a" ]; then
    echo "${base}/onnxruntime.framework/libonnxruntime.a"
  elif [ -f "${base}/onnxruntime.framework/onnxruntime" ]; then
    echo "${base}/onnxruntime.framework/onnxruntime"
  elif [ -f "${base}/onnxruntime.a" ]; then
    echo "${base}/onnxruntime.a"
  elif [ -f "${base}/libonnxruntime.a" ]; then
    echo "${base}/libonnxruntime.a"
  else
    echo ""
  fi
}

echo "===== Merging cxx-api + ONNX Runtime into SherpaOnnxC.framework ====="
cd "$BUILD_IOS_DIR"

merge_slice() {
  local slice="$1"
  local build_dir="$2"
  local sherpa_bin="$FRAMEWORK_NAME/$slice/SherpaOnnxC.framework/SherpaOnnxC"
  local cxx_api_lib="$build_dir/lib/libsherpa-onnx-cxx-api.a"
  local onnx_lib
  local hdr_dir="$FRAMEWORK_NAME/$slice/SherpaOnnxC.framework/Headers/sherpa-onnx/c-api"

  onnx_lib="$(resolve_onnx_static_lib "$ONNXRUNTIME_DIR" "$slice")"

  if [ ! -f "$sherpa_bin" ]; then
    echo "Error: SherpaOnnxC binary not found: $sherpa_bin" >&2
    exit 1
  fi
  if [ ! -f "$cxx_api_lib" ]; then
    echo "Error: cxx-api archive not found: $cxx_api_lib" >&2
    exit 1
  fi
  if [ -z "$onnx_lib" ] || [ ! -f "$onnx_lib" ]; then
    echo "Error: ONNX Runtime static lib not found for $slice under $ONNXRUNTIME_DIR" >&2
    exit 1
  fi

  mv "$sherpa_bin" "${sherpa_bin}.original"
  libtool -static -o "$sherpa_bin" "${sherpa_bin}.original" "$cxx_api_lib" "$onnx_lib"
  rm "${sherpa_bin}.original"

  mkdir -p "$hdr_dir"
  cp "$CXX_API_HEADER" "$hdr_dir/cxx-api.h"
  echo "  $slice: merged cxx-api + ORT into SherpaOnnxC, installed cxx-api.h"
}

merge_slice ios-arm64 build/os64
merge_slice ios-arm64_x86_64-simulator build/simulator

echo "===== Copying XCFramework to output (sherpa_onnx.xcframework) ====="
rm -rf "$OUTPUT_XCFRAMEWORK"
cp -R "$BUILD_IOS_DIR/$FRAMEWORK_NAME" "$OUTPUT_XCFRAMEWORK"

echo "Build complete: $OUTPUT_XCFRAMEWORK"
du -sh "$OUTPUT_XCFRAMEWORK" 2>/dev/null || true
