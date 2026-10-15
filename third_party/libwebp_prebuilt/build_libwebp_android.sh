#!/usr/bin/env bash
# Build libwebp for Android (all ABIs) using NDK and CMake.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), libwebp source in ../../third_party/libwebp (submodule).
# Output:
#   android/<abi>/lib/libwebp.so + libsharpyuv.so
#   android/jni/<abi>/ (same .so — Gradle THIRD_PARTY layout)
#   android/include/webp/ (public headers)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBWEBP_SRC="$REPO_ROOT/third_party/libwebp"
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

if [ ! -d "$LIBWEBP_SRC" ] || [ ! -f "$LIBWEBP_SRC/CMakeLists.txt" ]; then
    echo "Error: libwebp source not found at $LIBWEBP_SRC"
    echo "Run: git submodule update --init third_party/libwebp"
    exit 1
fi

# Tools off; shared libs on. 16 KB page-size for Android 15+ arm64.
CMAKE_OPTS=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE"
    -DANDROID_ABI=ABI_PLACEHOLDER
    -DANDROID_PLATFORM="android-${ANDROID_API}"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=ON
    -DWEBP_LINK_STATIC=OFF
    -DWEBP_BUILD_ANIM_UTILS=OFF
    -DWEBP_BUILD_CWEBP=OFF
    -DWEBP_BUILD_DWEBP=OFF
    -DWEBP_BUILD_GIF2WEBP=OFF
    -DWEBP_BUILD_IMG2WEBP=OFF
    -DWEBP_BUILD_VWEBP=OFF
    -DWEBP_BUILD_WEBPINFO=OFF
    -DWEBP_BUILD_LIBWEBPMUX=OFF
    -DWEBP_BUILD_WEBPMUX=OFF
    -DWEBP_BUILD_EXTRAS=OFF
    -DWEBP_ENABLE_SIMD=ON
    -DCMAKE_INSTALL_PREFIX=PREFIX_PLACEHOLDER
    -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384"
)

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    echo "Building libwebp for $ABI..."
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
    cmake "${opts[@]}" "$LIBWEBP_SRC"
    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"
    cmake --install .
    cd "$SCRIPT_DIR"

    DEST_LIB="$OUTPUT_BASE/$ABI/lib"
    DEST_JNI="$OUTPUT_BASE/jni/$ABI"
    mkdir -p "$DEST_LIB" "$DEST_JNI"
    # Install may put libs under lib/ or lib64/; normalize into DEST_LIB then jni/.
    for so in libwebp.so libsharpyuv.so; do
        FOUND=$(find "$PREFIX" -name "$so" -type f 2>/dev/null | head -1)
        if [ -z "$FOUND" ]; then
            FOUND=$(find "$BUILD_DIR" -name "$so" -type f 2>/dev/null | head -1)
        fi
        if [ -z "$FOUND" ] || [ ! -f "$FOUND" ]; then
            echo "Error: $so not found after build for $ABI"
            exit 1
        fi
        DEST_SO="$DEST_LIB/$so"
        if [ "$(cd "$(dirname "$FOUND")" && pwd)/$(basename "$FOUND")" != \
             "$(cd "$DEST_LIB" && pwd)/$so" ]; then
            cp -f "$FOUND" "$DEST_SO"
        fi
        cp -f "$DEST_SO" "$DEST_JNI/$so"
        echo "  $ABI: $so -> $DEST_JNI/$so"
    done
done

# Shared public headers (from first ABI install or source tree)
INCLUDE_DEST="$OUTPUT_BASE/include"
rm -rf "$INCLUDE_DEST"
mkdir -p "$INCLUDE_DEST/webp"
HDR_SRC=""
for ABI in $ABIS; do
    if [ -f "$OUTPUT_BASE/$ABI/include/webp/decode.h" ]; then
        HDR_SRC="$OUTPUT_BASE/$ABI/include/webp"
        break
    fi
done
if [ -n "$HDR_SRC" ]; then
    cp -R "$HDR_SRC/." "$INCLUDE_DEST/webp/"
else
    cp -f "$LIBWEBP_SRC"/src/webp/*.h "$INCLUDE_DEST/webp/"
fi

if [ ! -f "$INCLUDE_DEST/webp/decode.h" ]; then
    echo "Error: webp/decode.h missing under $INCLUDE_DEST"
    exit 1
fi

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/libwebp.so (+ libsharpyuv.so)"
echo "  jni:  $OUTPUT_BASE/jni/<abi>/"
echo "  include: $OUTPUT_BASE/include/webp/"
