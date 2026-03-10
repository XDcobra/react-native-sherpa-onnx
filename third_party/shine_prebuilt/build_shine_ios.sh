#!/usr/bin/env bash
# Build libshine as static libraries for iOS (device + simulator).
# These libraries are intended to be statically linked into FFmpeg,
# so no separate XCFramework is created.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHINE_SRC="$REPO_ROOT/third_party/shine"
OUTPUT_BASE="$SCRIPT_DIR/ios"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: iOS build must run on macOS (Xcode required)."
  exit 1
fi

if [ ! -d "$SHINE_SRC" ]; then
  echo "Error: shine source not found at: $SHINE_SRC"
  echo "Run: git submodule update --init third_party/shine"
  exit 1
fi

src_files=$(find "$SHINE_SRC/src/lib" -name '*.c' -print 2>/dev/null || true)
if [ -z "$src_files" ]; then
  echo "Error: No .c sources in $SHINE_SRC/src/lib"
  exit 1
fi

MIN_VER_OS="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
MIN_VER_SIM="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-12.0}"

build_slice() {
  local sdk="$1"
  local arch="$2"
  local min_ver="$3"

  local PREFIX="$OUTPUT_BASE/$sdk/$arch"
  local OBJDIR="$SCRIPT_DIR/build/ios/${sdk}-${arch}/obj"

  mkdir -p "$PREFIX/lib" "$PREFIX/include/shine" "$OBJDIR"

  local SYSROOT
  SYSROOT="$(xcrun --sdk "$sdk" --show-sdk-path)"

  local CC
  CC="$(xcrun --sdk "$sdk" -find clang)"

  if [ "$sdk" = "iphoneos" ]; then
    MIN_FLAG="-miphoneos-version-min=$min_ver"
  else
    MIN_FLAG="-mios-simulator-version-min=$min_ver"
  fi

  local CFLAGS="-arch $arch -isysroot $SYSROOT -O3 -fPIC -std=gnu99 $MIN_FLAG"
  local INCLUDES="-I$SHINE_SRC -I$SHINE_SRC/src -I$SHINE_SRC/src/lib"

  echo "===== Building libshine for $sdk / $arch ====="

  for src in $src_files; do
    obj="$OBJDIR/$(basename "$src" .c).o"
    "$CC" $CFLAGS $INCLUDES -c "$src" -o "$obj"
  done

  echo "Creating static library"
  libtool -static -o "$PREFIX/lib/libshine.a" "$OBJDIR"/*.o

  echo "Installing headers"
  if [ -d "$SHINE_SRC/src/lib" ]; then
    cp -f "$SHINE_SRC/src/lib/"*.h "$PREFIX/include/shine/" 2>/dev/null || true
  fi
  if [ -d "$SHINE_SRC/src/bin" ]; then
    cp -f "$SHINE_SRC/src/bin/"*.h "$PREFIX/include/shine/" 2>/dev/null || true
  fi

  if [ ! -f "$PREFIX/include/shine/layer3.h" ]; then
    echo "Error: layer3.h missing in $PREFIX/include/shine"
    exit 1
  fi

  echo "Built: $PREFIX/lib/libshine.a"
}

echo "Building libshine for iOS..."

build_slice iphoneos arm64 "$MIN_VER_OS"
build_slice iphonesimulator arm64 "$MIN_VER_SIM"
build_slice iphonesimulator x86_64 "$MIN_VER_SIM"

echo ""
echo "Build complete."
echo "Output structure:"
echo "  $OUTPUT_BASE/"
echo "    iphoneos/arm64/lib/libshine.a"
echo "    iphonesimulator/arm64/lib/libshine.a"
echo "    iphonesimulator/x86_64/lib/libshine.a"
echo ""
echo "Use these paths when building FFmpeg:"
echo "  --extra-cflags=-I$OUTPUT_BASE/<sdk>/<arch>/include"
echo "  --extra-ldflags=-L$OUTPUT_BASE/<sdk>/<arch>/lib -lshine"