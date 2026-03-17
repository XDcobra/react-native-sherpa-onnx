#!/usr/bin/env bash
# Build zstd for Android (all ABIs) using NDK and CMake.
# Same pattern as libarchive_prebuilt/build_libarchive_android.sh: only CMAKE_TOOLCHAIN_FILE + ANDROID_ABI/ANDROID_PLATFORM.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), zstd source in ../../third_party/zstd (submodule).
# Output: android/<abi>/lib/libzstd.so and android/<abi>/include/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZSTD_SRC="$REPO_ROOT/third_party/zstd"
WORK_DIR="$SCRIPT_DIR"
OUTPUT_BASE="$WORK_DIR/android"
ANDROID_API="${ANDROID_API:-21}"

if [ -n "$ANDROID_NDK_HOME" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "$ANDROID_NDK_ROOT" ]; then
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

if [ ! -d "$ZSTD_SRC" ] || [ ! -f "$ZSTD_SRC/build/cmake/CMakeLists.txt" ]; then
    echo "Error: zstd source not found at $ZSTD_SRC"
    echo "Run: git submodule update --init third_party/zstd"
    exit 1
fi

# Same CMake pattern as build_libarchive_android.sh: toolchain file only, no explicit compiler.
CMAKE_OPTS=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE"
    -DANDROID_ABI=ABI_PLACEHOLDER
    -DANDROID_PLATFORM="android-${ANDROID_API}"
    -DCMAKE_BUILD_TYPE=Release
    -DZSTD_BUILD_PROGRAMS=OFF
    -DZSTD_BUILD_TESTS=OFF
    -DZSTD_BUILD_CONTRIB=OFF
    -DZSTD_BUILD_SHARED=ON
    -DZSTD_BUILD_STATIC=OFF
    -DCMAKE_INSTALL_PREFIX=PREFIX_PLACEHOLDER
)

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    echo "Building zstd for $ABI..."
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
    cmake "${opts[@]}" "$ZSTD_SRC/build/cmake"
    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"
    cmake --install .
    cd "$SCRIPT_DIR"
done

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/libzstd.so"
echo "  include: $OUTPUT_BASE/<abi>/include/"
