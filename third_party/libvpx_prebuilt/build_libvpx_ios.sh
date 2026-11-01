#!/usr/bin/env bash
# Build libvpx (VP9 encoder) as static libraries for iOS (device + simulator).
# These archives are statically linked into FFmpeg (same pattern as shine/opus).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VPX_SRC="$REPO_ROOT/third_party/libvpx"
OUTPUT_BASE="$SCRIPT_DIR/ios"
IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
NCPU="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: iOS build must run on macOS (Xcode required)."
  exit 1
fi

if [ ! -x "$VPX_SRC/configure" ]; then
  echo "Error: libvpx source not found at: $VPX_SRC"
  echo "Run: git submodule update --init third_party/libvpx"
  exit 1
fi

build_slice() {
  local PLATFORM="$1"
  local ARCH="$2"
  local TARGET="$3"

  local PREFIX="$OUTPUT_BASE/$PLATFORM/$ARCH"
  local BUILD_DIR="$SCRIPT_DIR/build/ios/${PLATFORM}-${ARCH}"
  local SDK
  SDK="$(xcrun --sdk "$PLATFORM" --show-sdk-path)"
  local CC
  CC="$(xcrun --sdk "$PLATFORM" -find clang)"
  local CXX
  CXX="$(xcrun --sdk "$PLATFORM" -find clang++)"
  local AR
  AR="$(xcrun --sdk "$PLATFORM" -find ar)"
  local RANLIB
  RANLIB="$(xcrun --sdk "$PLATFORM" -find ranlib)"
  local STRIP
  STRIP="$(xcrun --sdk "$PLATFORM" -find strip)"

  if [ "$PLATFORM" = "iphoneos" ]; then
    MIN_FLAG="-miphoneos-version-min=$IOS_MIN_VERSION"
  else
    MIN_FLAG="-mios-simulator-version-min=$IOS_MIN_VERSION"
  fi

  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR" "$PREFIX"

  echo "===== Building libvpx for $PLATFORM / $ARCH ($TARGET) ====="

  local EXTRA_FLAGS=()
  local SLICE_CFLAGS=""
  local SLICE_LDFLAGS=""
  # Official libvpx has no arm64-iphonesimulator target; generic-gnu + SDK flags.
  if [ "$TARGET" = "generic-gnu" ]; then
    SLICE_CFLAGS="-arch $ARCH -isysroot $SDK $MIN_FLAG -fPIC -O3"
    SLICE_LDFLAGS="-arch $ARCH -isysroot $SDK $MIN_FLAG"
    EXTRA_FLAGS+=(
      --disable-runtime-cpu-detect
      --extra-cflags="$SLICE_CFLAGS"
    )
  fi

  (
    cd "$BUILD_DIR"
    export CC CXX AR RANLIB STRIP
    export AS="$CC"
    export LD="$CC"
    export CFLAGS="${SLICE_CFLAGS:-}"
    export LDFLAGS="${SLICE_LDFLAGS:-}"

    "$VPX_SRC/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --disable-shared \
      --enable-static \
      --enable-pic \
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
      "${EXTRA_FLAGS[@]}"

    make -j"$NCPU"
    make install
  )

  if [ ! -f "$PREFIX/lib/libvpx.a" ]; then
    echo "Error: libvpx.a missing at $PREFIX/lib/libvpx.a"
    exit 1
  fi
  if [ ! -f "$PREFIX/include/vpx/vp8cx.h" ]; then
    echo "Error: vpx headers missing under $PREFIX/include/vpx"
    exit 1
  fi

  echo "Built: $PREFIX/lib/libvpx.a"
}

echo "Building libvpx for iOS..."

build_slice iphoneos arm64 arm64-darwin-gcc
# No arm64-iphonesimulator-gcc target in libvpx; portable C for Apple Silicon sim.
build_slice iphonesimulator arm64 generic-gnu
build_slice iphonesimulator x86_64 x86_64-iphonesimulator-gcc

SIM_LIB_DIR="$OUTPUT_BASE/iphonesimulator/universal/lib"
mkdir -p "$SIM_LIB_DIR"
lipo -create \
  "$OUTPUT_BASE/iphonesimulator/arm64/lib/libvpx.a" \
  "$OUTPUT_BASE/iphonesimulator/x86_64/lib/libvpx.a" \
  -output "$SIM_LIB_DIR/libvpx.a"

echo ""
echo "libvpx iOS static libraries ready"
echo "  Device:    $OUTPUT_BASE/iphoneos/arm64/lib/libvpx.a"
echo "  Simulator: $SIM_LIB_DIR/libvpx.a"
