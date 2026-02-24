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
# ONNX Runtime: Resolved in order (1) SHERPA_ONNXRUNTIME_LIB_DIR + INCLUDE_DIR if set,
# (2) third_party/onnxruntime_prebuilt/android/ if present, (3) GitHub Release (ort-android-qnn-v*).
# See third_party/onnxruntime_prebuilt/build_onnxruntime.sh for LIB_DIR/INCLUDE_DIR layout.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHERPA_SRC="$REPO_ROOT/third_party/sherpa-onnx"
OUTPUT_BASE="$SCRIPT_DIR/android"
ORT_PREBUILT_ROOT=""
ORT_PREBUILT_ANDROID_BASE=""
ORT_PREBUILT_ANDROID_HEADERS=""
ONNXRUNTIME_VERSION=""
REQUIRED_ABIS="arm64-v8a armeabi-v7a x86 x86_64"

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

# Load VERSIONS for ONNXRUNTIME_VERSION (needed for staging paths and release tag).
VERSIONS_FILE="$REPO_ROOT/third_party/onnxruntime_prebuilt/VERSIONS"
TAG_FILE="$REPO_ROOT/third_party/onnxruntime_prebuilt/ANDROID_RELEASE_TAG"
if [ -f "$VERSIONS_FILE" ]; then
    set -a
    source "$VERSIONS_FILE"
    set +a
fi

# Helper: check if "android" layout is complete (per-abi lib + headers). Sets ORT_PREBUILT_ANDROID_BASE and ORT_PREBUILT_ANDROID_HEADERS if valid.
check_android_layout() {
    local base="$1"
    local headers_dir="$2"
    if [ -z "$base" ] || [ ! -d "$base" ]; then return 1; fi
    if [ -z "$headers_dir" ] || [ ! -d "$headers_dir" ]; then return 1; fi
    for abi in $REQUIRED_ABIS; do
        if [ ! -f "$base/$abi/lib/libonnxruntime.so" ]; then return 1; fi
    done
    ORT_PREBUILT_ANDROID_BASE="$base"
    ORT_PREBUILT_ANDROID_HEADERS="$headers_dir"
    return 0
}

# Tier 1: Use SHERPA_ONNXRUNTIME_LIB_DIR / SHERPA_ONNXRUNTIME_INCLUDE_DIR if both are set (layout as in build_onnxruntime.sh: <LIB_DIR>/<abi>/lib, <INCLUDE_DIR> = headers).
if [ -n "$SHERPA_ONNXRUNTIME_LIB_DIR" ] || [ -n "$SHERPA_ONNXRUNTIME_INCLUDE_DIR" ]; then
    if [ -z "$SHERPA_ONNXRUNTIME_LIB_DIR" ] || [ -z "$SHERPA_ONNXRUNTIME_INCLUDE_DIR" ]; then
        echo "Error: Set both SHERPA_ONNXRUNTIME_LIB_DIR and SHERPA_ONNXRUNTIME_INCLUDE_DIR (see third_party/onnxruntime_prebuilt/build_onnxruntime.sh)."
        exit 1
    fi
    if [ -z "$ONNXRUNTIME_VERSION" ]; then
        echo "Error: VERSIONS file (ONNXRUNTIME_VERSION) required when using SHERPA_ONNXRUNTIME_LIB_DIR / SHERPA_ONNXRUNTIME_INCLUDE_DIR."
        exit 1
    fi
    if check_android_layout "$SHERPA_ONNXRUNTIME_LIB_DIR" "$SHERPA_ONNXRUNTIME_INCLUDE_DIR"; then
        echo "Using ONNX Runtime from SHERPA_ONNXRUNTIME_LIB_DIR / SHERPA_ONNXRUNTIME_INCLUDE_DIR"
    else
        echo "Error: SHERPA_ONNXRUNTIME_LIB_DIR must contain <abi>/lib/libonnxruntime.so for each ABI ($REQUIRED_ABIS); SHERPA_ONNXRUNTIME_INCLUDE_DIR must be the headers directory."
        exit 1
    fi
fi

# Tier 2: If no env layout, use third_party/onnxruntime_prebuilt/android/ if present and complete.
if [ -z "$ORT_PREBUILT_ANDROID_BASE" ]; then
    ORT_ANDROID_LOCAL="$REPO_ROOT/third_party/onnxruntime_prebuilt/android"
    if [ -d "$ORT_ANDROID_LOCAL" ]; then
        HEADERS_CANDIDATE="$ORT_ANDROID_LOCAL/arm64-v8a/headers"
        if [ ! -d "$HEADERS_CANDIDATE" ]; then
            HEADERS_CANDIDATE="$ORT_ANDROID_LOCAL/armeabi-v7a/headers"
        fi
        if check_android_layout "$ORT_ANDROID_LOCAL" "$HEADERS_CANDIDATE"; then
            if [ -z "$ONNXRUNTIME_VERSION" ]; then
                echo "Error: VERSIONS file (ONNXRUNTIME_VERSION) required when using third_party/onnxruntime_prebuilt/android/."
                exit 1
            fi
            echo "Using ONNX Runtime from third_party/onnxruntime_prebuilt/android/"
        fi
    fi
fi

# Tier 3: Fallback to this repo's GitHub Release (ort-android-qnn-v*).
if [ -z "$ORT_PREBUILT_ANDROID_BASE" ] && [ -z "$ORT_PREBUILT_ROOT" ]; then
    RELEASE_TAG=""
    if [ -f "$TAG_FILE" ]; then
        RELEASE_TAG=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
    fi
    if [ -z "$RELEASE_TAG" ] && [ -f "$VERSIONS_FILE" ]; then
        RELEASE_TAG="ort-android-qnn-v${ONNXRUNTIME_VERSION}-qnn${QNN_SDK_VERSION}"
    fi
    if [ -n "$RELEASE_TAG" ]; then
        REPO_SLUG="${GITHUB_REPOSITORY:-}"
        if [ -z "$REPO_SLUG" ]; then
            REPO_SLUG=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/]+)(\.git)?$|\1|' || true)
        fi
        if [ -z "$REPO_SLUG" ]; then
            echo "Error: Cannot determine GitHub repo (set GITHUB_REPOSITORY or run from a git clone with remote origin). Required to download ONNX Runtime release $RELEASE_TAG."
            exit 1
        fi
        ORT_URL="https://github.com/${REPO_SLUG}/releases/download/${RELEASE_TAG}/onnxruntime-android-qnn.zip"
        ORT_EXTRACT="$SHERPA_SRC/ort-prebuilt-qnn-$$"
        if ! curl -sSfL -o "$SHERPA_SRC/ort-prebuilt-qnn.zip" "$ORT_URL"; then
            rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
            echo "Error: Failed to download ONNX Runtime Android+QNN release from GitHub."
            echo "  Tag: $RELEASE_TAG"
            echo "  URL: $ORT_URL"
            echo "  Build and publish the release (e.g. run the Build ONNX Runtime (Android + QNN) workflow) or use local prebuilts: set SHERPA_ONNXRUNTIME_LIB_DIR/INCLUDE_DIR or run third_party/onnxruntime_prebuilt/build_onnxruntime.sh and copy_prebuilts layout to third_party/onnxruntime_prebuilt/android/."
            exit 1
        fi
        mkdir -p "$ORT_EXTRACT"
        if ! unzip -o -q "$SHERPA_SRC/ort-prebuilt-qnn.zip" -d "$ORT_EXTRACT"; then
            rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
            rm -rf "$ORT_EXTRACT"
            echo "Error: Failed to extract onnxruntime-android-qnn.zip (corrupt or unexpected layout)."
            exit 1
        fi
        rm -f "$SHERPA_SRC/ort-prebuilt-qnn.zip"
        ORT_PREBUILT_ROOT="$ORT_EXTRACT"
        echo "Using ONNX Runtime from release $RELEASE_TAG"
    fi
fi

# With --qnn we must have ORT prebuilts (from env, local android/, or GitHub).
if [ "$ENABLE_QNN" = ON ] && [ -z "$ORT_PREBUILT_ROOT" ] && [ -z "$ORT_PREBUILT_ANDROID_BASE" ]; then
    echo "Error: QNN build requires ONNX Runtime Android+QNN. Set SHERPA_ONNXRUNTIME_LIB_DIR and SHERPA_ONNXRUNTIME_INCLUDE_DIR, or ensure third_party/onnxruntime_prebuilt/android/ is populated (run build_onnxruntime.sh), or publish the GitHub Release (ANDROID_RELEASE_TAG / VERSIONS) and retry."
    exit 1
fi

# ABI -> build script name -> build dir (relative to sherpa-onnx)
# build script is run from SHERPA_SRC; install dir is SHERPA_SRC/<build_dir>/install/lib
build_abi() {
    local ABI=$1
    local SCRIPT=$2
    local BUILD_DIR=$3

    echo "===== Building sherpa-onnx for $ABI ====="

    # Lay out ONNX Runtime so sherpa-onnx finds it (no onnxruntime-libs download).
    if [ -n "$ONNXRUNTIME_VERSION" ]; then
        mkdir -p "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/jni/$ABI"
        mkdir -p "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/headers"
        if [ -n "$ORT_PREBUILT_ANDROID_BASE" ]; then
            cp "$ORT_PREBUILT_ANDROID_BASE/$ABI/lib/libonnxruntime.so" "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/jni/$ABI/"
            cp -R "$ORT_PREBUILT_ANDROID_HEADERS/"* "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/headers/"
        elif [ -n "$ORT_PREBUILT_ROOT" ]; then
            cp "$ORT_PREBUILT_ROOT/$ONNXRUNTIME_VERSION/jni/$ABI/libonnxruntime.so" "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/jni/$ABI/"
            cp -R "$ORT_PREBUILT_ROOT/$ONNXRUNTIME_VERSION/headers/"* "$SHERPA_SRC/$BUILD_DIR/$ONNXRUNTIME_VERSION/headers/"
        fi
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
