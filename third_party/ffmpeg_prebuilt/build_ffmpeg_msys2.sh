#!/usr/bin/env bash
# Build minimal FFmpeg (audio-only) for Android.
# Run this script from the MSYS2 MinGW64 shell (not from PowerShell).
# See BUILD_MSYS2.md for required environment variables.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FFMPEG_SRC="$REPO_ROOT/third_party/ffmpeg"
OUTPUT_BASE="$SCRIPT_DIR/android"

# NDK: use ANDROID_NDK_ROOT or ANDROID_NDK_HOME (Windows or MSYS2 path both work)
if [ -n "$ANDROID_NDK_ROOT" ]; then
    NDK_ROOT="$ANDROID_NDK_ROOT"
elif [ -n "$ANDROID_NDK_HOME" ]; then
    NDK_ROOT="$ANDROID_NDK_HOME"
else
    echo "Error: Set ANDROID_NDK_ROOT or ANDROID_NDK_HOME to your Android NDK path."
    exit 1
fi
# Trim CR/LF and surrounding whitespace (e.g. from export or copy-paste)
NDK_ROOT="${NDK_ROOT//$'\r'/}"
NDK_ROOT="${NDK_ROOT//$'\n'/}"
NDK_ROOT="${NDK_ROOT#"${NDK_ROOT%%[![:space:]]*}"}"
NDK_ROOT="${NDK_ROOT%"${NDK_ROOT##*[![:space:]]}"}"

# Convert Windows path to MSYS2 if necessary (e.g. C:/foo -> /c/foo)
case "$NDK_ROOT" in
    [A-Za-z]:*)
        _drive="${NDK_ROOT%%:*}"
        _rest="${NDK_ROOT#*:}"
        NDK_ROOT="/${_drive,,}${_rest//\\/\/}"
        ;;
esac

API="${ANDROID_API:-24}"
NPROC="${NPROC:-$(nproc 2>/dev/null || echo 4)}"
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/windows-x86_64"
SYSROOT="$TOOLCHAIN/sysroot"

if [ ! -f "$FFMPEG_SRC/configure" ]; then
    echo "FFmpeg source not found. Run from repo root: git submodule update --init third_party/ffmpeg"
    exit 1
fi

# Normalize configure line endings (CRLF -> LF)
if [ -x "$FFMPEG_SRC/configure" ]; then
    sed -i 's/\r$//' "$FFMPEG_SRC/configure" 2>/dev/null || true
fi

echo "Build configuration:"
echo "  NDK:    $NDK_ROOT"
echo "  API:    $API"
echo "  Output: $OUTPUT_BASE"
echo ""

build_abi() {
    local ABI="$1" ARCH="$2" TOOLCHAIN_ARCH="$3" CPU="$4"
    local PREFIX="$OUTPUT_BASE/$ABI"
    local CC="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang"
    local CXX="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang++"
    mkdir -p "$PREFIX"
    echo "===== Building FFmpeg for $ABI ====="
    cd "$FFMPEG_SRC"
    export CFLAGS="-O3 -fPIC -std=c17 -I$SYSROOT/usr/include"
    export LDFLAGS="-Wl,-z,max-page-size=16384"
    # x86/x86_64 assembly uses R_386_32 relocations; disable it for shared libs (PIC).
    local DISABLE_ASM=""
    case "$ARCH" in i686|x86_64) DISABLE_ASM="--disable-x86asm" ;; esac
    echo "Running ./configure... (this can take 15-30 min on MSYS2/Windows)"
    echo "  CC:  $CC"
    echo "  CXX: $CXX"
    ./configure --prefix="$PREFIX" \
        --enable-shared --disable-static --disable-programs --disable-doc --disable-debug \
        --enable-pic \
        $DISABLE_ASM \
        --extra-cflags="$CFLAGS" \
        --extra-ldflags="$LDFLAGS" \
        --disable-avdevice --disable-swscale --disable-everything \
        --enable-decoder=aac,mp3,mpeg4aac,vorbis,flac,pcm_s16le,pcm_f32le,pcm_s32le,pcm_u8 \
        --enable-demuxer=mov,mp3,ogg,flac,wav,matroska --enable-muxer=wav --enable-encoder=pcm_s16le \
        --enable-parser=aac,mpegaudio,vorbis,flac --enable-protocol=file --enable-swresample \
        --enable-avcodec --enable-avformat --enable-avutil \
        --target-os=android --enable-cross-compile \
        --stdc=c17 \
        --strip="$TOOLCHAIN/bin/llvm-strip" \
        --arch="$ARCH" --cpu="$CPU" \
        --sysroot="$SYSROOT" --sysinclude="$SYSROOT/usr/include/" \
        --cc="$CC" --cxx="$CXX" || exit 1
    echo "Running make..."
    make -j"$NPROC" || exit 1
    echo "Running make install..."
    make install || exit 1
    make distclean 2>/dev/null || make clean 2>/dev/null || true
    echo "Successfully built FFmpeg for $ABI"
}

build_abi armeabi-v7a  arm    armv7a-linux-androideabi  armv7-a
build_abi arm64-v8a    aarch64 aarch64-linux-android    armv8-a
build_abi x86          i686   i686-linux-android        i686
build_abi x86_64       x86_64 x86_64-linux-android      x86-64

mkdir -p "$OUTPUT_BASE/include"
cp -R "$OUTPUT_BASE/arm64-v8a/include/"* "$OUTPUT_BASE/include/" 2>/dev/null || true
echo ""
echo "Build completed. Output: $OUTPUT_BASE"
