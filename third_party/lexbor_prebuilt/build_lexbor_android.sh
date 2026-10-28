#!/usr/bin/env bash
# Build lexbor for Android (all ABIs) using NDK and CMake.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), lexbor source in ../../third_party/lexbor (submodule).
# Output:
#   android/<abi>/lib/liblexbor.so
#   android/jni/<abi>/ (same .so — Gradle THIRD_PARTY layout)
#   android/include/lexbor/ (public headers)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LEXBOR_SRC="$REPO_ROOT/third_party/lexbor"
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

if [ ! -d "$LEXBOR_SRC" ] || [ ! -f "$LEXBOR_SRC/CMakeLists.txt" ]; then
    echo "Error: lexbor source not found at $LEXBOR_SRC"
    echo "Run: git submodule update --init third_party/lexbor"
    exit 1
fi

CMAKE_OPTS=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE"
    -DANDROID_ABI=ABI_PLACEHOLDER
    -DANDROID_PLATFORM="android-${ANDROID_API}"
    -DCMAKE_BUILD_TYPE=Release
    -DLEXBOR_BUILD_SHARED=ON
    -DLEXBOR_BUILD_STATIC=OFF
    -DLEXBOR_BUILD_TESTS=OFF
    -DLEXBOR_BUILD_TESTS_CPP=OFF
    -DLEXBOR_BUILD_EXAMPLES=OFF
    -DLEXBOR_BUILD_UTILS=OFF
    -DLEXBOR_INSTALL_HEADERS=ON
    -DCMAKE_INSTALL_PREFIX=PREFIX_PLACEHOLDER
    -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384"
)

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    echo "Building lexbor for $ABI..."
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
    cmake "${opts[@]}" "$LEXBOR_SRC"
    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"
    cmake --install .
    cd "$SCRIPT_DIR"

    DEST_LIB="$OUTPUT_BASE/$ABI/lib"
    DEST_JNI="$OUTPUT_BASE/jni/$ABI"
    mkdir -p "$DEST_LIB" "$DEST_JNI"
    FOUND=$(find "$PREFIX" -name 'liblexbor.so' -type f 2>/dev/null | head -1)
    if [ -z "$FOUND" ]; then
        FOUND=$(find "$BUILD_DIR" -name 'liblexbor.so' -type f 2>/dev/null | head -1)
    fi
    if [ -z "$FOUND" ] || [ ! -f "$FOUND" ]; then
        echo "Error: liblexbor.so not found after build for $ABI"
        exit 1
    fi
    DEST_SO="$DEST_LIB/liblexbor.so"
    if [ "$(cd "$(dirname "$FOUND")" && pwd)/$(basename "$FOUND")" != \
         "$(cd "$DEST_LIB" && pwd)/liblexbor.so" ]; then
        cp -f "$FOUND" "$DEST_SO"
    fi
    cp -f "$DEST_SO" "$DEST_JNI/liblexbor.so"
    echo "  $ABI: liblexbor.so -> $DEST_JNI/liblexbor.so"
done

INCLUDE_DEST="$OUTPUT_BASE/include"
rm -rf "$INCLUDE_DEST"
mkdir -p "$INCLUDE_DEST/lexbor"
HDR_SRC=""
for ABI in $ABIS; do
    if [ -d "$OUTPUT_BASE/$ABI/include/lexbor" ]; then
        HDR_SRC="$OUTPUT_BASE/$ABI/include/lexbor"
        break
    fi
done
if [ -n "$HDR_SRC" ]; then
    cp -R "$HDR_SRC/." "$INCLUDE_DEST/lexbor/"
else
    cp -R "$LEXBOR_SRC/source/lexbor/." "$INCLUDE_DEST/lexbor/"
fi

if [ ! -f "$INCLUDE_DEST/lexbor/html/parser.h" ]; then
    echo "Error: lexbor/html/parser.h missing under $INCLUDE_DEST"
    exit 1
fi

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/liblexbor.so"
echo "  jni:  $OUTPUT_BASE/jni/<abi>/"
echo "  include: $OUTPUT_BASE/include/lexbor/"
