#!/usr/bin/env bash
# Build ONNX Runtime for all Android ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) with CPU, NNAPI, XNNPACK,
# optional QNN (arm64-v8a only), and Java bridge; then package as a single .aar.
#
# Usage:
#   ./build_onnxruntime_android_aar.sh              # Build all ABIs with QNN + NNAPI + XNNPACK + Java -> .aar
#   ./build_onnxruntime_android_aar.sh --no-nnapi   # Build with QNN + XNNPACK + Java (no NNAPI)
#   ./build_onnxruntime_android_aar.sh --no-qnn     # Build with NNAPI + XNNPACK + Java (no QNN_SDK_ROOT)
#   ./build_onnxruntime_android_aar.sh --no-aar     # Skip Gradle step; only native libs + headers
#
# Requires: ANDROID_NDK, ANDROID_SDK (or ANDROID_HOME). For QNN: QNN_SDK_ROOT. For .aar: JAVA_HOME (use JDK 17; AGP 7.4.2 fails with Java 21).
# Output: android-arm64-qnn-nnapi-xnnpack/<abi>/lib and .../headers per ABI; and .../aar_out/ with the .aar (all ABIs).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ORT_SRC="$REPO_ROOT/third_party/onnxruntime"
OUTPUT_BASE="$SCRIPT_DIR/android-arm64-qnn-nnapi-xnnpack"
ABIS=(arm64-v8a armeabi-v7a x86 x86_64)
ANDROID_API="${ANDROID_API:-27}"

# Defaults: full build (QNN, NNAPI, XNNPACK, Java) and produce .aar
ENABLE_QNN=ON
ENABLE_NNAPI=ON
BUILD_AAR=ON
for arg in "$@"; do
    case "$arg" in
        --qnn|--enable-qnn)   ENABLE_QNN=ON ;;
        --no-qnn)            ENABLE_QNN=OFF ;;
        --no-nnapi)          ENABLE_NNAPI=OFF ;;
        --no-aar)            BUILD_AAR=OFF ;;
        -h|--help)
            echo "Usage: $0 [--qnn] [--no-qnn] [--no-nnapi] [--no-aar]"
            echo "  Build ONNX Runtime for all ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) with CPU, NNAPI, XNNPACK, QNN (arm64 only), Java; then .aar."
            echo "  --qnn       Enable QNN for arm64-v8a. Requires QNN_SDK_ROOT. (default: on)"
            echo "  --no-qnn    Disable QNN."
            echo "  --no-nnapi  Disable NNAPI."
            echo "  --no-aar    Skip Gradle step; only build native libs and headers."
            echo "  Output: $OUTPUT_BASE/<abi>/lib, .../headers; and (if not --no-aar) .../aar_out/"
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
        echo "Error: QNN requires QNN_SDK_ROOT to be set and point to the Qualcomm QNN SDK directory."
        echo "Example: export QNN_SDK_ROOT=/path/to/qnn-sdk"
        echo "Or run with --no-qnn to build without QNN."
        exit 1
    fi
    export QNN_SDK_ROOT
fi

echo "===== Building ONNX Runtime for all ABIs (CPU + NNAPI + XNNPACK + QNN on arm64 + Java) ====="
echo "ABIs: ${ABIS[*]}"
echo "ANDROID_NDK: $ANDROID_NDK"
echo "ANDROID_SDK: $ANDROID_SDK"
echo "ONNX Runtime source: $ORT_SRC"
echo "Output base: $OUTPUT_BASE"
echo "QNN: $ENABLE_QNN (arm64-v8a only)  NNAPI: $ENABLE_NNAPI  XNNPACK: ON  Java: ON"
echo "Build AAR: $BUILD_AAR"
if [ "$ENABLE_QNN" = ON ]; then
    echo "QNN_SDK_ROOT: $QNN_SDK_ROOT"
fi
echo ""

build_abi() {
    local ABI=$1
    local BUILD_DIR="$ORT_SRC/build/android-$ABI"

    echo "===== Building ONNX Runtime for $ABI ====="

    local EXTRA_ARGS=()
    if [ "$ENABLE_NNAPI" = ON ]; then
        EXTRA_ARGS+=(--use_nnapi)
    fi
    # QNN only for arm64-v8a (Qualcomm SDK)
    if [ "$ABI" = "arm64-v8a" ] && [ "$ENABLE_QNN" = ON ]; then
        EXTRA_ARGS+=(--use_qnn "static_lib" --qnn_home "$QNN_SDK_ROOT")
    fi
    EXTRA_ARGS+=(--use_xnnpack)
    EXTRA_ARGS+=(--build_java)
    EXTRA_ARGS+=(--cmake_extra_defines "onnxruntime_BUILD_UNIT_TESTS=OFF")
    EXTRA_ARGS+=(--cmake_extra_defines "CMAKE_CXX_FLAGS=-Wno-array-bounds")

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
    local ORT_JNI_LIB="$BUILD_DIR/Release/libonnxruntime4j_jni.so"
    local ORT_INCLUDE="$ORT_SRC/include"
    local DST_LIB="$OUTPUT_BASE/$ABI/lib"
    local DST_HEADERS="$OUTPUT_BASE/$ABI/headers"

    if [ ! -f "$ORT_LIB" ]; then
        echo "Error: $ORT_LIB not found after build"
        return 1
    fi
    if [ ! -f "$ORT_JNI_LIB" ]; then
        echo "Error: $ORT_JNI_LIB not found after build (required for AAR)"
        return 1
    fi

    mkdir -p "$DST_LIB" "$DST_HEADERS"
    cp -v "$ORT_LIB" "$ORT_JNI_LIB" "$DST_LIB/"
    cp -R "$ORT_INCLUDE"/* "$DST_HEADERS/"
    echo "Copied lib and headers to $OUTPUT_BASE/$ABI/"
    echo ""
}

for ABI in "${ABIS[@]}"; do
    build_abi "$ABI" || exit 1
done

# Build .aar via Gradle when requested (one AAR with all ABIs)
if [ "$BUILD_AAR" = ON ]; then
    JNILIBS_DIR="$OUTPUT_BASE/jnilibs"
    AAR_BUILD_DIR="$OUTPUT_BASE/aar_build"
    AAR_PUBLISH_DIR="$OUTPUT_BASE/aar_out"
    MIN_SDK_VER="${ANDROID_MIN_SDK_VER:-24}"
    TARGET_SDK_VER="${ANDROID_TARGET_SDK_VER:-34}"
    mkdir -p "$JNILIBS_DIR"
    for ABI in "${ABIS[@]}"; do
        SRC_LIB="$OUTPUT_BASE/$ABI/lib"
        JNILIBS_ABI="$JNILIBS_DIR/$ABI"
        if [ ! -f "$SRC_LIB/libonnxruntime.so" ] || [ ! -f "$SRC_LIB/libonnxruntime4j_jni.so" ]; then
            echo "Error: $SRC_LIB missing .so files; cannot build AAR."
            exit 1
        fi
        mkdir -p "$JNILIBS_ABI"
        cp -v "$SRC_LIB"/libonnxruntime.so "$SRC_LIB"/libonnxruntime4j_jni.so "$JNILIBS_ABI/"
    done
    # Headers (same for all ABIs)
    DST_HEADERS="$OUTPUT_BASE/arm64-v8a/headers"

    GRADLE_OPTS=(
        "--no-daemon"
        "-b=build-android.gradle"
        "-c=settings-android.gradle"
        "-DjniLibsDir=$JNILIBS_DIR"
        "-DbuildDir=$AAR_BUILD_DIR"
        "-DheadersDir=$DST_HEADERS"
        "-DpublishDir=$AAR_PUBLISH_DIR"
        "-DminSdkVer=$MIN_SDK_VER"
        "-DtargetSdkVer=$TARGET_SDK_VER"
        "-DreleaseVersionSuffix=${RELEASE_VERSION_SUFFIX:-}"
    )
    if [ "$ENABLE_QNN" = ON ] && [ -f "${QNN_SDK_ROOT}/sdk.yaml" ]; then
        QNN_VERSION=$(grep -E '^[[:space:]]*version:' "${QNN_SDK_ROOT}/sdk.yaml" | sed 's/.*version:[[:space:]]*//;s/[[:space:]]*$//' | cut -d. -f1-3)
        if [ -n "$QNN_VERSION" ]; then
            GRADLE_OPTS+=("-DqnnVersion=$QNN_VERSION")
        fi
    fi

    export ANDROID_HOME="$ANDROID_SDK"
    GRADLE_WRAPPER="$ORT_SRC/java/gradlew"
    if [ ! -x "$GRADLE_WRAPPER" ]; then
        echo "Error: Gradle wrapper not found or not executable: $GRADLE_WRAPPER"
        exit 1
    fi
    echo "===== Building AAR (Gradle) with all ABIs ====="
    (cd "$ORT_SRC/java" && "$GRADLE_WRAPPER" "${GRADLE_OPTS[@]}" clean bundleReleaseAar) || { echo "Gradle AAR build failed."; exit 1; }
    AAR_SRC="$AAR_BUILD_DIR/outputs/aar"
    mkdir -p "$AAR_PUBLISH_DIR"
    if [ -d "$AAR_SRC" ]; then
        cp -v "$AAR_SRC"/*.aar "$AAR_PUBLISH_DIR/" 2>/dev/null || true
    fi
    echo ""
    echo "AAR in $AAR_PUBLISH_DIR"
    AAR_PATH=$(find "$AAR_PUBLISH_DIR" -name "*.aar" 2>/dev/null | head -1)
    if [ -n "$AAR_PATH" ]; then
        echo "  -> $AAR_PATH"
    fi
fi

echo "Done. Prebuilts: $OUTPUT_BASE/<abi>/lib and .../headers for each of ${ABIS[*]}"
[ "$BUILD_AAR" = ON ] && echo "AAR: $AAR_PUBLISH_DIR"
echo "Use SHERPA_ONNXRUNTIME_LIB_DIR / SHERPA_ONNXRUNTIME_INCLUDE_DIR when building sherpa-onnx for each ABI."
