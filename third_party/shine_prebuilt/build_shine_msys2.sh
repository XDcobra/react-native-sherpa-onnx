#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHINE_SRC="$REPO_ROOT/third_party/shine"
OUTPUT_BASE="$SCRIPT_DIR/android"

# NDK root must be set in environment
if [ -n "$ANDROID_NDK_ROOT" ]; then
  NDK_ROOT="$ANDROID_NDK_ROOT"
elif [ -n "$ANDROID_NDK_HOME" ]; then
  NDK_ROOT="$ANDROID_NDK_HOME"
else
  echo "Error: Set ANDROID_NDK_ROOT or ANDROID_NDK_HOME to your Android NDK path."
  exit 1
fi

# Normalize possible CRLF from env vars
NDK_ROOT="${NDK_ROOT//$'\r'/}"
NDK_ROOT="${NDK_ROOT//$'\n'/}"

API="${ANDROID_API:-24}"
NPROC="${NPROC:-$(nproc 2>/dev/null || echo 4)}"
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/windows-x86_64"
SYSROOT="$TOOLCHAIN/sysroot"

if [ ! -d "$SHINE_SRC" ]; then
  echo "Error: shine source not found at: $SHINE_SRC"
  echo "Run: git submodule update --init third_party/shine"
  exit 1
fi

echo "Building libshine for Android"
echo "NDK: $NDK_ROOT"
echo "API: $API"

build_abi() {
  local ABI="$1" ARCH="" TOOLCHAIN_ARCH="" CC="" CFLAGS="" LDFLAGS=""
  case "$ABI" in
    armeabi-v7a)
      ARCH=arm
      TOOLCHAIN_ARCH=armv7a-linux-androideabi
      CC="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang"
      ;;
    arm64-v8a)
      ARCH=aarch64
      TOOLCHAIN_ARCH=aarch64-linux-android
      CC="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang"
      ;;
    x86)
      ARCH=x86
      TOOLCHAIN_ARCH=i686-linux-android
      CC="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang"
      ;;
    x86_64)
      ARCH=x86_64
      TOOLCHAIN_ARCH=x86_64-linux-android
      CC="$TOOLCHAIN/bin/${TOOLCHAIN_ARCH}${API}-clang"
      ;;
    *)
      echo "Unknown ABI: $ABI"
      return 1
      ;;
  esac

  local PREFIX="$OUTPUT_BASE/$ABI"
  local OBJDIR="$SCRIPT_DIR/build/$ABI/obj"
  mkdir -p "$PREFIX/lib" "$PREFIX/include" "$OBJDIR"

  echo "--- Building for $ABI ---"

  # Find .c sources inside the shine submodule (only core lib sources, exclude JS wrappers)
  src_files=$(find "$SHINE_SRC/src/lib" -name '*.c' -print)
  if [ -z "$src_files" ]; then
    echo "No C sources found in $SHINE_SRC"
    return 1
  fi

  # Basic flags — include shine sources and its lib directory so headers like layer3.h are found
  CFLAGS_BASE="-O3 -fPIC -std=gnu99 -I$SYSROOT/usr/include -I$SHINE_SRC -I$SHINE_SRC/src -I$SHINE_SRC/src/lib"

  # ABI-specific tuning to enable inline ARM assembly and correct target features
  case "$ABI" in
    armeabi-v7a)
      # Enable ARMv7-A and VFP (common for armeabi-v7a NDK builds)
      ABI_CFLAGS="-march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=softfp -D__ARM_ARCH_7A__ -D__ARM_ARCH=7"
      ;;
    arm64-v8a)
      # aarch64 typically doesn't need extra march flags for NDK clang
      ABI_CFLAGS="-D__aarch64__"
      ;;
    x86)
      ABI_CFLAGS="-m32"
      ;;
    x86_64)
      ABI_CFLAGS="-m64"
      ;;
    *)
      ABI_CFLAGS=""
      ;;
  esac

  CFLAGS="$CFLAGS_BASE $ABI_CFLAGS"
  LDFLAGS="-Wl,-z,max-page-size=16384"

  # Compile each C file to object
  for src in $src_files; do
    obj="$OBJDIR/$(basename "$src" .c).o"
    echo "CC $src -> $obj"
    "$CC" $CFLAGS -c "$src" -o "$obj"
  done

  # Link shared lib
  echo "Linking libshine.so"
  "$CC" -shared -o "$PREFIX/lib/libshine.so" $OBJDIR/*.o $LDFLAGS

  # Install public headers so consumers can `#include <shine/...>`
  mkdir -p "$PREFIX/include/shine"
  # Copy core public headers from the library source
  if [ -d "$SHINE_SRC/src/lib" ]; then
    cp -f "$SHINE_SRC/src/lib/"*.h "$PREFIX/include/shine/" 2>/dev/null || true
  fi
  # Copy any helper/public headers from src/bin
  if [ -d "$SHINE_SRC/src/bin" ]; then
    cp -f "$SHINE_SRC/src/bin/"*.h "$PREFIX/include/shine/" 2>/dev/null || true
  fi
  # Also copy any top-level include/ headers (preserve conventional layout)
  if [ -d "$SHINE_SRC/include" ]; then
    cp -Rf "$SHINE_SRC/include/"* "$PREFIX/include/" 2>/dev/null || true
  fi

  echo "Built libshine -> $PREFIX/lib/libshine.so"
}

for ABI in armeabi-v7a arm64-v8a x86 x86_64; do
  build_abi "$ABI"
done

echo "Build complete. Output: $OUTPUT_BASE"
