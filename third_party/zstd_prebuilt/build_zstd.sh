#!/usr/bin/env bash
# Build zstd for Android (all ABIs) using system CMake and NDK target compilers.
# Same approach as opus_prebuilt/build_opus.sh and ffmpeg_prebuilt/build_ffmpeg.sh:
# no Android CMake toolchain file; use NDK clang wrappers (e.g. aarch64-linux-android21-clang) from PATH or NDK.
# Requires: NDK on PATH (e.g. via nttld/setup-ndk add-to-path) or ANDROID_NDK_HOME/ANDROID_NDK_ROOT.
# Output: android/<abi>/lib/libzstd.so and android/<abi>/include/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZSTD_SRC="$REPO_ROOT/third_party/zstd"
WORK_DIR="$SCRIPT_DIR"
OUTPUT_BASE="$WORK_DIR/android"
ANDROID_API="${ANDROID_API:-21}"

# Optional: allow NDK path for fallback compiler lookup (when not on PATH)
if [ -n "$ANDROID_NDK_HOME" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "$ANDROID_NDK_ROOT" ]; then
    NDK="$ANDROID_NDK_ROOT"
else
    NDK=""
fi

# Resolve compiler for the given ABI. Prefer PATH (setup-ndk add-to-path), then NDK/toolchains/llvm/prebuilt.
resolve_compiler() {
    local ABI=$1
    local host="" compiler_name=""
    case "$ABI" in
        arm64-v8a)   host="aarch64-linux-android" ;;
        armeabi-v7a) host="armv7a-linux-androideabi" ;;
        x86)         host="i686-linux-android" ;;
        x86_64)      host="x86_64-linux-android" ;;
        *) echo "Unknown ABI: $ABI" >&2; return 1 ;;
    esac
    compiler_name="${host}${ANDROID_API}-clang"
    # Prefer compiler from PATH (e.g. nttld/setup-ndk add-to-path)
    if command -v "$compiler_name" >/dev/null 2>&1; then
        echo "$(command -v "$compiler_name")"
        return
    fi
    # Fallback: NDK toolchain layout (same as opus/ffmpeg)
    if [ -n "$NDK" ]; then
        case "$(uname -s)" in
            Linux*)   HOST_TAG="linux-x86_64" ;;
            Darwin*)
                if [ "$(uname -m)" = "arm64" ] && [ -d "$NDK/toolchains/llvm/prebuilt/darwin-arm64" ]; then
                    HOST_TAG="darwin-arm64"
                else
                    HOST_TAG="darwin-x86_64"
                fi
                ;;
            *)        HOST_TAG="windows-x86_64" ;;
        esac
        local cc="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin/$compiler_name"
        if [ -f "$cc" ]; then
            echo "$cc"
            return
        fi
    fi
    echo ""
}

if [ ! -d "$ZSTD_SRC" ] || [ ! -f "$ZSTD_SRC/build/cmake/CMakeLists.txt" ]; then
    echo "Error: zstd source not found at $ZSTD_SRC"
    echo "Run: git submodule update --init third_party/zstd"
    exit 1
fi

ABIS="arm64-v8a armeabi-v7a x86 x86_64"

for ABI in $ABIS; do
    CC=$(resolve_compiler "$ABI")
    if [ -z "$CC" ]; then
        echo "Error: could not find NDK compiler for $ABI (set ANDROID_NDK_HOME or ensure NDK is on PATH, e.g. nttld/setup-ndk add-to-path: true)"
        exit 1
    fi
    # NDK C++ compiler: same path with -clang++ (e.g. aarch64-linux-android21-clang++)
    CXX="${CC%clang}clang++"
    [ -f "$CXX" ] || CXX="$CC"

    echo "Building zstd for $ABI (CC=$CC)..."
    BUILD_DIR="$WORK_DIR/build-$ABI"
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    PREFIX="$OUTPUT_BASE/$ABI"
    mkdir -p "$PREFIX"
    cd "$BUILD_DIR"

    cmake "$ZSTD_SRC/build/cmake" \
        -DCMAKE_SYSTEM_NAME=Linux \
        -DCMAKE_C_COMPILER="$CC" \
        -DCMAKE_CXX_COMPILER="$CXX" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DZSTD_BUILD_PROGRAMS=OFF \
        -DZSTD_BUILD_TESTS=OFF \
        -DZSTD_BUILD_CONTRIB=OFF \
        -DZSTD_BUILD_SHARED=ON \
        -DZSTD_BUILD_STATIC=OFF

    cmake --build . -j"$(nproc 2>/dev/null || echo 4)"
    cmake --install .
    cd "$SCRIPT_DIR"
done

echo "Done. Output: $OUTPUT_BASE"
echo "  libs: $OUTPUT_BASE/<abi>/lib/libzstd.so"
echo "  include: $OUTPUT_BASE/<abi>/include/"
