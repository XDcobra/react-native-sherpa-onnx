#!/usr/bin/env bash
# Build libyuv for Android (all ABIs) using NDK and the wrapper CMake in this folder.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), libyuv submodule at ../../third_party/libyuv.
# Output:
#   android/<abi>/lib/libyuv.so
#   android/jni/<abi>/ (same .so — Gradle THIRD_PARTY layout)
#   android/include/libyuv/ (public headers)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBYUV_SRC="$REPO_ROOT/third_party/libyuv"
WORK_DIR="$SCRIPT_DIR"
OUTPUT_BASE="$WORK_DIR/android"
ANDROID_API="${ANDROID_API:-21}"

if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "${ANDROID_NDK_ROOT:-}" ]; then
    NDK="$ANDROID_NDK_ROOT"
else
    echo "Error: Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT to your Android NDK path."
    exit 1
fi

TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake"
if [ ! -f "$TOOLCHAIN_FILE" ]; then
    echo "Error: Android CMake toolchain not found: $TOOLCHAIN_FILE"
    exit 1
fi

if [ ! -d "$LIBYUV_SRC" ] || [ ! -f "$LIBYUV_SRC/include/libyuv.h" ]; then
    echo "Error: libyuv source not found at $LIBYUV_SRC"
    echo "Run: git submodule update --init third_party/libyuv"
    exit 1
fi

ISA_CHECK="$REPO_ROOT/scripts/check-libyuv-isa.sh"
NDK_OBJDUMP="$(find "$NDK" -name 'llvm-objdump' -type f 2>/dev/null | head -1 || true)"

CMAKE_OPTS=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE"
    -DANDROID_ABI=ABI_PLACEHOLDER
    -DANDROID_PLATFORM="android-${ANDROID_API}"
    -DCMAKE_BUILD_TYPE=Release
    -DLIBYUV_BUILD_SHARED=ON
    -DCMAKE_INSTALL_PREFIX=PREFIX_PLACEHOLDER
    -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384"
)

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    echo "Building libyuv for $ABI..."
    BUILD_DIR="$WORK_DIR/build-$ABI"
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    PREFIX="$OUTPUT_BASE/$ABI"
    mkdir -p "$PREFIX"
    cd "$BUILD_DIR"
    opts=()
    for o in "${CMAKE_OPTS[@]}"; do
        if [ "$o" = "-DANDROID_ABI=ABI_PLACEHOLDER" ]; then
            opts+=(-DANDROID_ABI="$ABI")
        elif [ "$o" = "-DCMAKE_INSTALL_PREFIX=PREFIX_PLACEHOLDER" ]; then
            opts+=(-DCMAKE_INSTALL_PREFIX="$PREFIX")
        else
            opts+=("$o")
        fi
    done
    cmake "${opts[@]}" "$WORK_DIR"
    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"

    if [ "$ABI" = "arm64-v8a" ] && [ -x "$ISA_CHECK" ]; then
        echo "  ISA check (udot/usdot/smmla only in *_neon64 objects)..."
        # shellcheck disable=SC2046
        if [ -n "$NDK_OBJDUMP" ]; then
            OBJDUMP="$NDK_OBJDUMP" "$ISA_CHECK" $(find "$BUILD_DIR" -name '*.o' -type f)
        else
            "$ISA_CHECK" $(find "$BUILD_DIR" -name '*.o' -type f)
        fi
    fi

    cmake --install .
    cd "$SCRIPT_DIR"

    DEST_LIB="$OUTPUT_BASE/$ABI/lib"
    DEST_JNI="$OUTPUT_BASE/jni/$ABI"
    mkdir -p "$DEST_LIB" "$DEST_JNI"
    FOUND=$(find "$PREFIX" -name 'libyuv.so' -type f 2>/dev/null | head -1)
    if [ -z "$FOUND" ]; then
        FOUND=$(find "$BUILD_DIR" -name 'libyuv.so' -type f 2>/dev/null | head -1)
    fi
    if [ -z "$FOUND" ] || [ ! -f "$FOUND" ]; then
        echo "Error: libyuv.so not found after build for $ABI"
        exit 1
    fi
    DEST_SO="$DEST_LIB/libyuv.so"
    if [ "$(cd "$(dirname "$FOUND")" && pwd)/$(basename "$FOUND")" != \
         "$(cd "$DEST_LIB" && pwd)/libyuv.so" ]; then
        cp -f "$FOUND" "$DEST_SO"
    fi
    cp -f "$DEST_SO" "$DEST_JNI/libyuv.so"
    echo "  $ABI: libyuv.so -> $DEST_JNI/libyuv.so"
done

INCLUDE_DEST="$OUTPUT_BASE/include"
rm -rf "$INCLUDE_DEST"
mkdir -p "$INCLUDE_DEST"
HDR_SRC=""
for ABI in $ABIS; do
    if [ -d "$OUTPUT_BASE/$ABI/include/libyuv" ]; then
        HDR_SRC="$OUTPUT_BASE/$ABI/include"
        break
    fi
done
if [ -n "$HDR_SRC" ]; then
    cp -R "$HDR_SRC/." "$INCLUDE_DEST/"
else
    cp -R "$LIBYUV_SRC/include/." "$INCLUDE_DEST/"
fi

if [ ! -f "$INCLUDE_DEST/libyuv/convert.h" ]; then
    echo "Error: libyuv/convert.h missing under $INCLUDE_DEST"
    exit 1
fi

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/libyuv.so"
echo "  jni:  $OUTPUT_BASE/jni/<abi>/"
echo "  include: $OUTPUT_BASE/include/libyuv/"
