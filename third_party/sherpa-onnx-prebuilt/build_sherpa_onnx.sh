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
#
# ONNX Runtime: Always tries to use this repo's GitHub Release (ort-android-qnn-v* tag)
# from third_party/onnxruntime_prebuilt/VERSIONS. If the release is found, sherpa-onnx
# uses that prebuilt instead of downloading from onnxruntime-libs. If not found, sherpa-onnx
# scripts fall back to their default download.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHERPA_SRC="$REPO_ROOT/third_party/sherpa-onnx"
OUTPUT_BASE="$SCRIPT_DIR/android"
ORT_PREBUILT_ROOT=""
ONNXRUNTIME_VERSION=""

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

# Always try to use this repo's ONNX Runtime Android+QNN release (no submodule change).
# Release tag: ANDROID_RELEASE_TAG (same pattern as FFmpeg/sherpa-onnx) or fallback from VERSIONS.
VERSIONS_FILE="$REPO_ROOT/third_party/onnxruntime_prebuilt/VERSIONS"
TAG_FILE="$REPO_ROOT/third_party/onnxruntime_prebuilt/ANDROID_RELEASE_TAG"
RELEASE_TAG=""
if [ -f "$TAG_FILE" ]; then
    RELEASE_TAG=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
fi
if [ -z "$RELEASE_TAG" ] && [ -f "$VERSIONS_FILE" ]; then
    set -a
    source "$VERSIONS_FILE"
    set +a
    RELEASE_TAG="ort-android-qnn-v${ONNXRUNTIME_VERSION}-qnn${QNN_SDK_VERSION}"
fi
if [ -n "$RELEASE_TAG" ]; then
    # VERSIONS is still needed for ONNXRUNTIME_VERSION (layout paths in build_abi)
    if [ -f "$VERSIONS_FILE" ]; then
        set -a
        source "$VERSIONS_FILE"
        set +a
    fi
    REPO_SLUG="${GITHUB_REPOSITORY:-}"
    if [ -z "$REPO_SLUG" ]; then
        REPO_SLUG=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/]+)(\.git)?$|\1|' || true)
    fi
    if [ -n "$REPO_SLUG" ]; then
        ORT_URL="https://github.com/${REPO_SLUG}/releases/download/${RELEASE_TAG}/onnxruntime-android-qnn.zip"
        ORT_EXTRACT="$SHERPA_SRC/ort-prebuilt-qnn-$$"
        if curl -sSfL -o "$SHERPA_SRC/ort-prebuilt-qnn.zip" "$ORT_URL"; then
            mkdir -p "$ORT_EXTRACT"
            if unzip -o -q "$SHERPA_SRC/ort-prebuilt-qnn.zip" -d "$ORT_EXTRACT"; then
                rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
                ORT_PREBUILT_ROOT="$ORT_EXTRACT"
                echo "Using ONNX Runtime from release $RELEASE_TAG"
            else
                rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
                rm -rf "$ORT_EXTRACT"
            fi
        else
            rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
            echo "Release $RELEASE_TAG not found or download failed; sherpa-onnx will use default onnxruntime-libs."
        fi
    fi
fi

# ABI -> build script name -> build dir (relative to sherpa-onnx)
# build script is run from SHERPA_SRC; install dir is SHERPA_SRC/<build_dir>/install/lib
build_abi() {
    local ABI=$1
    local SCRIPT=$2
    local BUILD_DIR=$3

    echo "===== Building sherpa-onnx for $ABI ====="

    # If we have our ORT+QNN release prebuilt, lay it out so sherpa-onnx finds it (no onnxruntime-libs download).
    if [ -n "$ORT_PREBUILT_ROOT" ] && [ -n "$ONNXRUNTIME_VERSION" ]; then
        mkdir -p "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/jni/$ABI"
        mkdir -p "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/headers"
        cp "$ORT_PREBUILT_ROOT/$ONNXRUNTIME_VERSION/jni/$ABI/libonnxruntime.so" "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/jni/$ABI/"
        cp -R "$ORT_PREBUILT_ROOT/$ONNXRUNTIME_VERSION/headers/"* "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/headers/"
    fi

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

[ -n "$ORT_PREBUILT_ROOT" ] && [ -d "$ORT_PREBUILT_ROOT" ] && rm -rf "$ORT_PREBUILT_ROOT"

echo "Done. Prebuilts are in $OUTPUT_BASE/<abi>/lib/"
echo "Run: node $SCRIPT_DIR/copy_prebuilts_to_sdk.js to copy into android/src/main/jniLibs/"
