#!/usr/bin/env bash
# Build libopus for Android (shared)
# Repo layout:
# third_party/
#    opus/
#    opus_prebuilt/
#        build_opus_android.sh

# Prerequisites: Make sure you have installed: autoconf automake libtool
# Linux: sudo apt install autoconf automake libtool
# macOS: brew install autoconf automake libtool 

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OPUS_SRC="$REPO_ROOT/opus"
OUTPUT_BASE="$SCRIPT_DIR/android"

ANDROID_API="${ANDROID_API:-21}"

# detect NDK
if [ -n "$ANDROID_NDK_HOME" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "$ANDROID_NDK_ROOT" ]; then
    NDK="$ANDROID_NDK_ROOT"
else
    echo "Error: Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT"
    exit 1
fi

# detect host tag
case "$(uname -s)" in
    Linux*) HOST_TAG="linux-x86_64" ;;
    Darwin*)
        # Prefer Apple Silicon toolchain on arm64 macOS when available, fallback to x86_64
        if [ "$(uname -m)" = "arm64" ] && [ -d "$NDK/toolchains/llvm/prebuilt/darwin-arm64" ]; then
            HOST_TAG="darwin-arm64"
        else
            HOST_TAG="darwin-x86_64"
        fi
        ;;
    *) HOST_TAG="windows-x86_64" ;;
esac

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"

if [ ! -d "$TOOLCHAIN" ]; then
    echo "Error: toolchain not found: $TOOLCHAIN"
    exit 1
fi

if [ ! -d "$OPUS_SRC" ]; then
    echo "Error: opus source not found: $OPUS_SRC"
    exit 1
fi

build_abi() {

    ABI=$1

    ARCH=""
    HOST=""
    CC=""

    case "$ABI" in

        armeabi-v7a)
            ARCH=arm
            HOST=armv7a-linux-androideabi
            CC="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang"
            ;;

        arm64-v8a)
            ARCH=arm64
            HOST=aarch64-linux-android
            CC="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang"
            ;;

        x86)
            ARCH=x86
            HOST=i686-linux-android
            CC="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang"
            ;;

        x86_64)
            ARCH=x86_64
            HOST=x86_64-linux-android
            CC="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang"
            ;;

        *)
            echo "Unknown ABI: $ABI"
            exit 1
            ;;

    esac

    PREFIX="$OUTPUT_BASE/$ABI"

    mkdir -p "$PREFIX"

    echo ""
    echo "===== Building Opus for $ABI ====="

    cd "$OPUS_SRC"

    ./autogen.sh || true

    ./configure \
        --host="$HOST" \
        --prefix="$PREFIX" \
        --enable-shared \
        --disable-static \
        --disable-extra-programs \
        --disable-doc \
        --disable-maintainer-mode \
        --disable-tests \
        CC="$CC" \
        CFLAGS="-O3 -fPIC"

    make -j$(nproc 2>/dev/null || echo 4)

    make install

    make distclean || true

    echo "Finished Opus build for $ABI"
}

for ABI in armeabi-v7a arm64-v8a x86 x86_64; do
    build_abi "$ABI"
done

# unify headers
INCLUDE_UNIFIED="$OUTPUT_BASE/include"
mkdir -p "$INCLUDE_UNIFIED"

if [ -d "$OUTPUT_BASE/arm64-v8a/include" ]; then
    cp -R "$OUTPUT_BASE/arm64-v8a/include/"* "$INCLUDE_UNIFIED/" 2>/dev/null || true
fi

echo ""
echo "Opus build completed."
echo ""
echo "Output:"
echo "$OUTPUT_BASE"
echo "  include/"
echo "  arm64-v8a/lib/libopus.so"
echo "  armeabi-v7a/lib/libopus.so"
echo "  x86/lib/libopus.so"
echo "  x86_64/lib/libopus.so"