#!/usr/bin/env bash
# Build libarchive for Android (all ABIs) using NDK and CMake.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), libarchive source in ../../third_party/libarchive (submodule).
# Output: android/<abi>/lib/libarchive.so and android/include/ (public headers).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBARCHIVE_SRC="$REPO_ROOT/third_party/libarchive"
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

if [ ! -d "$LIBARCHIVE_SRC" ] || [ ! -f "$LIBARCHIVE_SRC/CMakeLists.txt" ]; then
    echo "Error: libarchive source not found at $LIBARCHIVE_SRC"
    echo "Run: git submodule update --init third_party/libarchive"
    exit 1
fi

# Disable programs and tests; only build shared library. Disable optional deps not in NDK.
CMAKE_OPTS=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE"
    -DANDROID_ABI=ABI_PLACEHOLDER
    -DANDROID_PLATFORM="android-${ANDROID_API}"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=ON
    -DENABLE_TAR=OFF
    -DENABLE_CPIO=OFF
    -DENABLE_CAT=OFF
    -DENABLE_UNZIP=OFF
    -DENABLE_TEST=OFF
    -DENABLE_OPENSSL=OFF
    -DENABLE_LIBXML2=OFF
    -DENABLE_EXPAT=OFF
    -DENABLE_LZMA=OFF
    -DENABLE_ZSTD=OFF
    -DENABLE_LIBB2=OFF
    -DENABLE_BZip2=OFF
    -DENABLE_LZ4=OFF
    -DENABLE_LZO=OFF
    -DENABLE_NETTLE=OFF
    -DENABLE_MBEDTLS=OFF
    -DENABLE_WERROR=OFF
)

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    echo "Building libarchive for $ABI..."
    BUILD_DIR="$WORK_DIR/build-$ABI"
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    opts=()
    for o in "${CMAKE_OPTS[@]}"; do
        if [ "$o" = "-DANDROID_ABI=ABI_PLACEHOLDER" ]; then
            opts+=(-DANDROID_ABI="$ABI")
        else
            opts+=("$o")
        fi
    done
    cmake "${opts[@]}" "$LIBARCHIVE_SRC"
    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"
    cd "$SCRIPT_DIR"

    DEST_LIB="$OUTPUT_BASE/$ABI/lib"
    mkdir -p "$DEST_LIB"
    if [ -f "$BUILD_DIR/libarchive/libarchive.so" ]; then
        cp -v "$BUILD_DIR/libarchive/libarchive.so" "$DEST_LIB/"
    else
        SO_FILE=$(find "$BUILD_DIR" -name "libarchive.so" -type f 2>/dev/null | head -1)
        if [ -n "$SO_FILE" ]; then
            cp -v "$SO_FILE" "$DEST_LIB/"
        else
            echo "Error: libarchive.so not found in $BUILD_DIR"
            exit 1
        fi
    fi
done

# Headers: public API from libarchive/libarchive/
mkdir -p "$OUTPUT_BASE/include"
cp -v "$LIBARCHIVE_SRC/libarchive/archive.h" "$OUTPUT_BASE/include/" 2>/dev/null || true
cp -v "$LIBARCHIVE_SRC/libarchive/archive_entry.h" "$OUTPUT_BASE/include/" 2>/dev/null || true
if [ -d "$LIBARCHIVE_SRC/contrib/android/include" ]; then
    mkdir -p "$OUTPUT_BASE/include/contrib/android"
    cp -R "$LIBARCHIVE_SRC/contrib/android/include/"* "$OUTPUT_BASE/include/contrib/android/" 2>/dev/null || true
fi

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/libarchive.so"
echo "  include: $OUTPUT_BASE/include/"
