#!/usr/bin/env bash
# Build zstd for iOS (static lib): iphoneos/arm64, iphonesimulator/arm64, iphonesimulator/x86_64, and universal simulator.
# Requires: zstd source in ../../third_party/zstd (submodule).
# Output: ios/<platform>/<arch>/lib/libzstd.a and include/; ios/iphonesimulator/universal/lib/libzstd.a

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZSTD_SRC="$REPO_ROOT/third_party/zstd"

if [ ! -d "$ZSTD_SRC" ] || [ ! -f "$ZSTD_SRC/build/cmake/CMakeLists.txt" ]; then
    echo "Error: zstd source not found at $ZSTD_SRC"
    echo "Run: git submodule update --init third_party/zstd"
    exit 1
fi

export IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
export SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"

rm -rf "$BUILD_DIR" "$OUTPUT_DIR"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

build_slice() {
  local platform=$1
  local arch=$2
  local os_type=$3

  echo "===== Building zstd ($platform $arch) ====="

  local prefix="$OUTPUT_DIR/$platform/$arch"
  local tmp_build="$BUILD_DIR/$platform-$arch"
  mkdir -p "$prefix" "$tmp_build"

  local cmake_args=(
    "-DCMAKE_INSTALL_PREFIX=$prefix"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=$os_type"
    "-DCMAKE_OSX_ARCHITECTURES=$arch"
    "-DZSTD_BUILD_PROGRAMS=OFF"
    "-DZSTD_BUILD_TESTS=OFF"
    "-DZSTD_BUILD_CONTRIB=OFF"
    "-DZSTD_BUILD_SHARED=OFF"
    "-DZSTD_BUILD_STATIC=ON"
  )

  if [ "$platform" = "iphoneos" ]; then
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphoneos")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN_VERSION")
  else
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphonesimulator")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$SIM_MIN_VERSION")
  fi

  cd "$tmp_build"
  cmake "$ZSTD_SRC/build/cmake" "${cmake_args[@]}"
  make -j"$(sysctl -n hw.ncpu)"
  make install
  cd "$SCRIPT_DIR"
}

build_slice iphoneos arm64 iOS
build_slice iphonesimulator arm64 iOS
build_slice iphonesimulator x86_64 iOS

echo "===== Creating universal simulator lib ====="

SIM_LIB="$OUTPUT_DIR/iphonesimulator/universal/lib"
mkdir -p "$SIM_LIB"

lipo -create \
  "$OUTPUT_DIR/iphonesimulator/arm64/lib/libzstd.a" \
  "$OUTPUT_DIR/iphonesimulator/x86_64/lib/libzstd.a" \
  -output "$SIM_LIB/libzstd.a"

echo "Done. Output: $OUTPUT_DIR"
echo "  ios/iphoneos/arm64/lib/libzstd.a"
echo "  ios/iphonesimulator/arm64 lib/x86_64 lib/ and universal/lib/libzstd.a"
