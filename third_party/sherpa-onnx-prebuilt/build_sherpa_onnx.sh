#!/usr/bin/env bash
# Build sherpa-onnx for Android (all ABIs). Optional QNN (Qualcomm NPU) for arm64-v8a.
#
# Usage:
#   ./build_sherpa_onnx.sh              # Build without QNN (default; no QNN SDK required)
#   ./build_sherpa_onnx.sh --qnn        # Build with QNN for arm64-v8a (requires QNN_SDK_ROOT)
#
# Requires: ANDROID_NDK (or ANDROID_NDK_HOME / ANDROID_NDK_ROOT).
# For --qnn: QNN_SDK_ROOT must point to the Qualcomm QNN SDK installation.
# Sherpa-onnx source: third_party/sherpa-onnx (submodule).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHERPA_SRC="$REPO_ROOT/third_party/sherpa-onnx"
OUTPUT_BASE="$SCRIPT_DIR/android"

# Default: no QNN (build works without QNN SDK)
ENABLE_QNN=OFF
for arg in "$@"; do
    case "$arg" in
        --qnn|--enable-qnn) ENABLE_QNN=ON ;;
        -h|--help)
            echo "Usage: $0 [--qnn]"
            echo "  Build sherpa-onnx Android prebuilts (all ABIs)."
            echo "  --qnn    Enable Qualcomm NPU (QNN) for arm64-v8a. Requires QNN_SDK_ROOT to be set."
            echo "  Default: build without QNN (no Qualcomm SDK needed)."
            exit 0
            ;;
    esac
done

if [ ! -d "$SHERPA_SRC" ] || [ ! -f "$SHERPA_SRC/build-android-arm64-v8a.sh" ]; then
    echo "Error: sherpa-onnx source not found at: $SHERPA_SRC"
    echo "Run: git submodule update --init third_party/sherpa-onnx"
    exit 1
fi

# NDK: sherpa-onnx scripts use ANDROID_NDK; accept ANDROID_NDK_HOME/ANDROID_NDK_ROOT too
if [ -n "$ANDROID_NDK" ]; then
    export ANDROID_NDK
elif [ -n "$ANDROID_NDK_HOME" ]; then
    export ANDROID_NDK="$ANDROID_NDK_HOME"
elif [ -n "$ANDROID_NDK_ROOT" ]; then
    export ANDROID_NDK="$ANDROID_NDK_ROOT"
else
    echo "Error: Set ANDROID_NDK (or ANDROID_NDK_HOME / ANDROID_NDK_ROOT) to your Android NDK path."
    exit 1
fi

# If QNN requested, require QNN_SDK_ROOT so CMake does not fail later with a vague error
if [ "$ENABLE_QNN" = ON ]; then
    if [ -z "${QNN_SDK_ROOT}" ] || [ ! -d "${QNN_SDK_ROOT}" ]; then
        echo "Error: --qnn requires QNN_SDK_ROOT to be set and point to the Qualcomm QNN SDK directory."
        echo "Example: export QNN_SDK_ROOT=/path/to/qnn-sdk"
        echo "See: https://k2-fsa.github.io/sherpa/onnx/qnn/build.html"
        exit 1
    fi
    export QNN_SDK_ROOT
fi

echo "ANDROID_NDK: $ANDROID_NDK"
echo "sherpa-onnx source: $SHERPA_SRC"
echo "Output base: $OUTPUT_BASE"
echo "QNN: $ENABLE_QNN"
if [ "$ENABLE_QNN" = ON ]; then
    echo "QNN_SDK_ROOT: $QNN_SDK_ROOT"
fi
echo ""

# ABI -> build script name -> build dir (relative to sherpa-onnx)
# build script is run from SHERPA_SRC; install dir is SHERPA_SRC/<build_dir>/install/lib
build_abi() {
    local ABI=$1
    local SCRIPT=$2
    local BUILD_DIR=$3

    echo "===== Building sherpa-onnx for $ABI ====="

    export BUILD_SHARED_LIBS=ON
    export SHERPA_ONNX_ENABLE_JNI=ON
    export SHERPA_ONNX_ENABLE_C_API=ON
    export SHERPA_ONNX_ENABLE_TTS=ON
    # OFF: we only need shared libs for the RN SDK; ON would build CLI executables (sherpa-onnx-offline etc.) which we do not use. See https://k2-fsa.github.io/sherpa/onnx/qnn/build.html
    export SHERPA_ONNX_ENABLE_BINARY=OFF
    export SHERPA_ONNX_ENABLE_RKNN=OFF
    if [ "$ABI" = "arm64-v8a" ]; then
        export SHERPA_ONNX_ENABLE_QNN="$ENABLE_QNN"
    else
        export SHERPA_ONNX_ENABLE_QNN=OFF
    fi

    (cd "$SHERPA_SRC" && ./"$SCRIPT") || { echo "Build failed for $ABI"; return 1; }

    local INSTALL_LIB="$SHERPA_SRC/$BUILD_DIR/install/lib"
    local DST_LIB="$OUTPUT_BASE/$ABI/lib"
    mkdir -p "$DST_LIB"
    for so in libsherpa-onnx-jni.so libsherpa-onnx-c-api.so libsherpa-onnx-cxx-api.so libonnxruntime.so; do
        if [ -f "$INSTALL_LIB/$so" ]; then
            cp -v "$INSTALL_LIB/$so" "$DST_LIB/"
        fi
    done
    echo "Copied .so files to $DST_LIB"
    echo ""
}

cd "$SHERPA_SRC"

build_abi "arm64-v8a"   "build-android-arm64-v8a.sh"   "build-android-arm64-v8a"
build_abi "armeabi-v7a" "build-android-armv7-eabi.sh"  "build-android-armv7-eabi"
build_abi "x86"         "build-android-x86.sh"        "build-android-x86"
build_abi "x86_64"      "build-android-x86-64.sh"      "build-android-x86-64"

echo "Done. Prebuilts are in $OUTPUT_BASE/<abi>/lib/"
echo "Run: node $SCRIPT_DIR/copy_prebuilts_to_sdk.js to copy into android/src/main/jniLibs/"
