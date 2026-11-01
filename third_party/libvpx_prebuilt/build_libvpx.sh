#!/usr/bin/env bash
# Build libvpx (VP9 encoder) for Android as a static library.
# libvpx configure does not support --enable-shared on the android-gcc targets
# (not treated as ELF). FFmpeg links libvpx.a into libavcodec.so.
# Source: third_party/libvpx (submodule, pinned).
# Usage: ANDROID_NDK_ROOT=/path/to/ndk ./build_libvpx.sh
# Optional: ABIS="arm64-v8a" ANDROID_API=21

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VPX_SRC="$REPO_ROOT/third_party/libvpx"
OUTPUT_BASE="$SCRIPT_DIR/android"
ANDROID_API="${ANDROID_API:-21}"
NPROC="${NPROC:-$(nproc 2>/dev/null || echo 4)}"
ABIS="${ABIS:-armeabi-v7a arm64-v8a x86 x86_64}"

if [ -n "${ANDROID_NDK_HOME:-}" ]; then
  NDK="$ANDROID_NDK_HOME"
elif [ -n "${ANDROID_NDK_ROOT:-}" ]; then
  NDK="$ANDROID_NDK_ROOT"
else
  echo "Error: Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT"
  exit 1
fi

case "$(uname -s)" in
  Linux*) HOST_TAG="linux-x86_64" ;;
  Darwin*)
    if [ "$(uname -m)" = "arm64" ] && [ -d "$NDK/toolchains/llvm/prebuilt/darwin-arm64" ]; then
      HOST_TAG="darwin-arm64"
    else
      HOST_TAG="darwin-x86_64"
    fi
    ;;
  *) HOST_TAG="windows-x86_64" ;;
esac

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
SYSROOT="$TOOLCHAIN/sysroot"

if [ ! -d "$TOOLCHAIN" ]; then
  echo "Error: NDK toolchain not found at: $TOOLCHAIN"
  exit 1
fi

if [ ! -x "$VPX_SRC/configure" ]; then
  echo "Error: libvpx source not found at: $VPX_SRC"
  echo "Run: git submodule update --init third_party/libvpx"
  exit 1
fi

echo "Building libvpx for Android"
echo "NDK: $NDK"
echo "Host: $HOST_TAG"
echo "API: $ANDROID_API"
echo "ABIs: $ABIS"

build_abi() {
  local ABI="$1"
  local TARGET="" HOST="" EXTRA_DISABLE_ASM=""

  case "$ABI" in
    armeabi-v7a)
      TARGET="armv7-android-gcc"
      HOST="armv7a-linux-androideabi"
      ;;
    arm64-v8a)
      TARGET="arm64-android-gcc"
      HOST="aarch64-linux-android"
      ;;
    x86)
      TARGET="x86-android-gcc"
      HOST="i686-linux-android"
      # No yasm/nasm in the Android NDK CI image.
      EXTRA_DISABLE_ASM="--disable-mmx --disable-sse --disable-sse2 --disable-sse3 --disable-ssse3 --disable-sse4_1 --disable-avx --disable-avx2 --disable-avx512 --disable-runtime-cpu-detect"
      ;;
    x86_64)
      TARGET="x86_64-android-gcc"
      HOST="x86_64-linux-android"
      EXTRA_DISABLE_ASM="--disable-mmx --disable-sse --disable-sse2 --disable-sse3 --disable-ssse3 --disable-sse4_1 --disable-avx --disable-avx2 --disable-avx512 --disable-runtime-cpu-detect"
      ;;
    *)
      echo "Unknown ABI: $ABI"
      return 1
      ;;
  esac

  local CC="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang"
  local CXX="$TOOLCHAIN/bin/${HOST}${ANDROID_API}-clang++"
  local PREFIX="$OUTPUT_BASE/$ABI"
  local BUILD_DIR="$SCRIPT_DIR/build/$ABI"

  if [ ! -x "$CC" ]; then
    echo "Error: clang not found: $CC"
    return 1
  fi

  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR" "$PREFIX"

  echo ""
  echo "===== Building libvpx for $ABI ($TARGET) ====="

  (
    cd "$BUILD_DIR"
    export CC CXX
    export AR="$TOOLCHAIN/bin/llvm-ar"
    export AS="$CC"
    export LD="$CC"
    export STRIP="$TOOLCHAIN/bin/llvm-strip"
    export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
    export NM="$TOOLCHAIN/bin/llvm-nm"
    export PATH="$TOOLCHAIN/bin:$PATH"
    export LDFLAGS="-Wl,-z,max-page-size=16384 --sysroot=$SYSROOT"

    # Encoder-only: FFmpeg's native vp9 decoder stays LGPL and does not need libvpx.
    # VP8 is out of scope for this pin.
    "$VPX_SRC/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --libc="$SYSROOT" \
      --enable-pic \
      --enable-static \
      --disable-shared \
      --disable-examples \
      --disable-tools \
      --disable-docs \
      --disable-unit-tests \
      --disable-install-bins \
      --disable-install-srcs \
      --disable-vp8 \
      --disable-vp9-decoder \
      --enable-vp9-encoder \
      --disable-libyuv \
      --disable-webm-io \
      --extra-cflags="-fPIC --sysroot=$SYSROOT --target=${HOST}${ANDROID_API}" \
      $EXTRA_DISABLE_ASM

    make -j"$NPROC"
    make install
  )

  if [ ! -f "$PREFIX/lib/libvpx.a" ]; then
    echo "Error: libvpx.a missing under $PREFIX/lib"
    return 1
  fi
  if [ ! -f "$PREFIX/include/vpx/vp8cx.h" ]; then
    echo "Error: vpx headers missing under $PREFIX/include/vpx"
    return 1
  fi

  echo "Built libvpx -> $PREFIX/lib"
}

for ABI in $ABIS; do
  build_abi "$ABI"
done

INCLUDE_UNIFIED="$OUTPUT_BASE/include"
mkdir -p "$INCLUDE_UNIFIED"
if [ -d "$OUTPUT_BASE/arm64-v8a/include" ]; then
  cp -R "$OUTPUT_BASE/arm64-v8a/include/"* "$INCLUDE_UNIFIED/" 2>/dev/null || true
fi

echo ""
echo "libvpx Android build complete. Output: $OUTPUT_BASE"
echo "  arm64-v8a/lib/libvpx.a"
echo "  include/vpx/"
