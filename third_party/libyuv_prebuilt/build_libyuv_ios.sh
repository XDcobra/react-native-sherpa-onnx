#!/usr/bin/env bash
# Build libyuv static XCFramework for iOS (device arm64 + simulator arm64/x86_64).
# Requires: Xcode, libyuv submodule at third_party/libyuv.
# Output: third_party/libyuv_prebuilt/libyuv.xcframework

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBYUV_SRC="$REPO_ROOT/third_party/libyuv"

if [ ! -d "$LIBYUV_SRC" ] || [ ! -f "$LIBYUV_SRC/include/libyuv.h" ]; then
    echo "Error: libyuv source not found at $LIBYUV_SRC"
    echo "Run: git submodule update --init third_party/libyuv"
    exit 1
fi

export IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
export SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"
XCFRAMEWORK_OUT="$SCRIPT_DIR/libyuv.xcframework"

rm -rf "$BUILD_DIR" "$OUTPUT_DIR" "$XCFRAMEWORK_OUT"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

build_slice() {
  local platform=$1
  local arch=$2
  local os_type=$3

  echo "===== Building libyuv ($platform $arch) ====="

  local prefix="$OUTPUT_DIR/$platform/$arch"
  local tmp_build="$BUILD_DIR/$platform-$arch"
  mkdir -p "$prefix" "$tmp_build"

  local cmake_args=(
    "-DCMAKE_INSTALL_PREFIX=$prefix"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=$os_type"
    "-DCMAKE_OSX_ARCHITECTURES=$arch"
    "-DLIBYUV_BUILD_SHARED=OFF"
  )

  if [ "$platform" = "iphoneos" ]; then
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphoneos")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN_VERSION")
  else
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphonesimulator")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$SIM_MIN_VERSION")
  fi

  cd "$tmp_build"
  cmake "$SCRIPT_DIR" "${cmake_args[@]}"
  cmake --build . -j"$(sysctl -n hw.ncpu)"
  cmake --install .

  local yuv_lib="$prefix/lib/libyuv.a"
  if [ ! -f "$yuv_lib" ]; then
    yuv_lib=$(find "$prefix" -name 'libyuv.a' -type f | head -1)
  fi
  if [ -z "$yuv_lib" ] || [ ! -f "$yuv_lib" ]; then
    echo "Error: libyuv.a not found under $prefix"
    exit 1
  fi
  mkdir -p "$prefix/lib"
  cp -f "$yuv_lib" "$prefix/lib/libyuv.a"

  if [ ! -d "$prefix/include/libyuv" ]; then
    mkdir -p "$prefix/include"
    cp -R "$LIBYUV_SRC/include/." "$prefix/include/"
  fi
  cd "$SCRIPT_DIR"
}

build_slice iphoneos arm64 iOS
build_slice iphonesimulator arm64 iOS
build_slice iphonesimulator x86_64 iOS

echo "===== Creating universal simulator lib ====="

SIM_LIB="$OUTPUT_DIR/iphonesimulator/universal/lib"
SIM_INC="$OUTPUT_DIR/iphonesimulator/arm64/include"
mkdir -p "$SIM_LIB"

lipo -create \
  "$OUTPUT_DIR/iphonesimulator/arm64/lib/libyuv.a" \
  "$OUTPUT_DIR/iphonesimulator/x86_64/lib/libyuv.a" \
  -output "$SIM_LIB/libyuv.a"

echo "===== Creating XCFramework ====="

xcodebuild -create-xcframework \
  -library "$OUTPUT_DIR/iphoneos/arm64/lib/libyuv.a" \
  -headers "$OUTPUT_DIR/iphoneos/arm64/include" \
  -library "$SIM_LIB/libyuv.a" \
  -headers "$SIM_INC" \
  -output "$XCFRAMEWORK_OUT"

echo "Build complete: $XCFRAMEWORK_OUT"
