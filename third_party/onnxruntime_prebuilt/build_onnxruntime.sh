#!/usr/bin/env bash
# Build ONNX Runtime for Android (all ABIs). Optional QNN (arm64-v8a only) and NNAPI.
#
# Usage:
#   ./build_onnxruntime.sh                    # Build without QNN, with NNAPI (default)
#   ./build_onnxruntime.sh --qnn              # Build with QNN for arm64-v8a (requires QNN_SDK_ROOT)
#   ./build_onnxruntime.sh --no-nnapi         # Build without NNAPI
#
# Requires: ANDROID_NDK, ANDROID_SDK (or ANDROID_HOME). For --qnn: QNN_SDK_ROOT.
# ONNX Runtime source: third_party/onnxruntime (submodule).
# See: https://onnxruntime.ai/docs/build/android.html#qnn-execution-provider

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ORT_SRC="$REPO_ROOT/third_party/onnxruntime"
OUTPUT_BASE="$SCRIPT_DIR/android"
ANDROID_API="${ANDROID_API:-27}"

# Defaults: no QNN, NNAPI on
ENABLE_QNN=OFF
ENABLE_NNAPI=ON
for arg in "$@"; do
    case "$arg" in
        --qnn|--enable-qnn) ENABLE_QNN=ON ;;
        --no-nnapi) ENABLE_NNAPI=OFF ;;
        -h|--help)
            echo "Usage: $0 [--qnn] [--no-nnapi]"
            echo "  Build ONNX Runtime Android prebuilts (all ABIs)."
            echo "  --qnn       Enable Qualcomm NPU (QNN) for arm64-v8a. Requires QNN_SDK_ROOT."
            echo "  --no-nnapi  Disable NNAPI Execution Provider."
            echo "  Default: build without QNN, with NNAPI."
            exit 0
            ;;
    esac
done

if [ ! -d "$ORT_SRC" ] || [ ! -f "$ORT_SRC/build.sh" ]; then
    echo "Error: ONNX Runtime source not found at: $ORT_SRC"
    echo "Run: git submodule update --init third_party/onnxruntime"
    exit 1
fi

# Android NDK
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

# Android SDK (required by ORT build.py)
if [ -n "$ANDROID_SDK_PATH" ]; then
    ANDROID_SDK="$ANDROID_SDK_PATH"
elif [ -n "$ANDROID_HOME" ]; then
    ANDROID_SDK="$ANDROID_HOME"
elif [ -n "$ANDROID_SDK_ROOT" ]; then
    ANDROID_SDK="$ANDROID_SDK_ROOT"
else
    echo "Error: Set ANDROID_HOME (or ANDROID_SDK_ROOT / ANDROID_SDK_PATH) to your Android SDK path."
    exit 1
fi

if [ "$ENABLE_QNN" = ON ]; then
    if [ -z "${QNN_SDK_ROOT}" ] || [ ! -d "${QNN_SDK_ROOT}" ]; then
        echo "Error: --qnn requires QNN_SDK_ROOT to be set and point to the Qualcomm QNN SDK directory."
        echo "Example: export QNN_SDK_ROOT=/path/to/qnn-sdk"
        echo "See: https://onnxruntime.ai/docs/build/eps.html#qnn"
        exit 1
    fi
    export QNN_SDK_ROOT
fi

echo "ANDROID_NDK: $ANDROID_NDK"
echo "ANDROID_SDK: $ANDROID_SDK"
echo "ONNX Runtime source: $ORT_SRC"
echo "Output base: $OUTPUT_BASE"
echo "QNN: $ENABLE_QNN"
echo "NNAPI: $ENABLE_NNAPI"
if [ "$ENABLE_QNN" = ON ]; then
    echo "QNN_SDK_ROOT: $QNN_SDK_ROOT"
fi
echo ""

build_abi() {
    local ABI=$1
    local BUILD_DIR="$ORT_SRC/build/android-$ABI"

    echo "===== Building ONNX Runtime for $ABI ====="

    local EXTRA_ARGS=()
    # NNAPI: skip for arm64-v8a to avoid duplicate symbols (NodeAttrHelper); affects both --qnn and non-qnn builds
    if [ "$ENABLE_NNAPI" = ON ]; then
        if [ "$ABI" != "arm64-v8a" ]; then
            EXTRA_ARGS+=(--use_nnapi)
        else
            echo "Note: arm64-v8a built without NNAPI to avoid duplicate symbol errors."
        fi
    fi
    # QNN only for arm64-v8a (ORT Android + QNN requires static_lib)
    if [ "$ABI" = "arm64-v8a" ] && [ "$ENABLE_QNN" = ON ]; then
        EXTRA_ARGS+=(--use_qnn "static_lib" --qnn_home "$QNN_SDK_ROOT")
    fi

    (cd "$ORT_SRC" && ./build.sh \
        --build_dir "$BUILD_DIR" \
        --android \
        --android_sdk_path "$ANDROID_SDK" \
        --android_ndk_path "$ANDROID_NDK" \
        --android_abi "$ABI" \
        --android_api "$ANDROID_API" \
        --config Release \
        --build_shared_lib \
        "${EXTRA_ARGS[@]}") || { echo "Build failed for $ABI"; return 1; }

    local ORT_LIB="$BUILD_DIR/Release/libonnxruntime.so"
    local ORT_INCLUDE="$ORT_SRC/include"
    local DST_LIB="$OUTPUT_BASE/$ABI/lib"
    local DST_HEADERS="$OUTPUT_BASE/$ABI/headers"

    if [ ! -f "$ORT_LIB" ]; then
        echo "Error: $ORT_LIB not found after build"
        return 1
    fi

    mkdir -p "$DST_LIB" "$DST_HEADERS"
    cp -v "$ORT_LIB" "$DST_LIB/"
    # Headers so that SHERPA_ONNXRUNTIME_INCLUDE_DIR=<abi>/headers and #include "onnxruntime/core/session/..." work
    cp -R "$ORT_INCLUDE"/* "$DST_HEADERS/"
    echo "Copied lib and headers to $OUTPUT_BASE/$ABI/"
    echo ""
}

# Build each ABI
for ABI in arm64-v8a armeabi-v7a x86 x86_64; do
    build_abi "$ABI"
done

echo "Done. Prebuilts are in $OUTPUT_BASE/<abi>/lib and .../headers/"
echo "Use these paths as SHERPA_ONNXRUNTIME_LIB_DIR / SHERPA_ONNXRUNTIME_INCLUDE_DIR when building sherpa-onnx for each ABI."
