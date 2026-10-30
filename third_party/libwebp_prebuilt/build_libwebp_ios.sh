#!/usr/bin/env bash
# Build libwebp static XCFramework for iOS (device arm64 + simulator arm64/x86_64).
# Requires: Xcode, libwebp submodule at third_party/libwebp.
# Output: third_party/libwebp_prebuilt/libwebp.xcframework

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBWEBP_SRC="$REPO_ROOT/third_party/libwebp"

if [ ! -d "$LIBWEBP_SRC" ] || [ ! -f "$LIBWEBP_SRC/CMakeLists.txt" ]; then
    echo "Error: libwebp source not found at $LIBWEBP_SRC"
    echo "Run: git submodule update --init third_party/libwebp"
    exit 1
fi

export IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
export SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"
XCFRAMEWORK_OUT="$SCRIPT_DIR/libwebp.xcframework"

rm -rf "$BUILD_DIR" "$OUTPUT_DIR" "$XCFRAMEWORK_OUT"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

build_slice() {
  local platform=$1
  local arch=$2
  local os_type=$3

  echo "===== Building libwebp ($platform $arch) ====="

  local prefix="$OUTPUT_DIR/$platform/$arch"
  local tmp_build="$BUILD_DIR/$platform-$arch"
  mkdir -p "$prefix" "$tmp_build"

  local cmake_args=(
    "-DCMAKE_INSTALL_PREFIX=$prefix"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=$os_type"
    "-DCMAKE_OSX_ARCHITECTURES=$arch"
    "-DBUILD_SHARED_LIBS=OFF"
    "-DWEBP_LINK_STATIC=ON"
    "-DWEBP_BUILD_ANIM_UTILS=OFF"
    "-DWEBP_BUILD_CWEBP=OFF"
    "-DWEBP_BUILD_DWEBP=OFF"
    "-DWEBP_BUILD_GIF2WEBP=OFF"
    "-DWEBP_BUILD_IMG2WEBP=OFF"
    "-DWEBP_BUILD_VWEBP=OFF"
    "-DWEBP_BUILD_WEBPINFO=OFF"
    "-DWEBP_BUILD_LIBWEBPMUX=OFF"
    "-DWEBP_BUILD_WEBPMUX=OFF"
    "-DWEBP_BUILD_EXTRAS=OFF"
    "-DWEBP_ENABLE_SIMD=ON"
  )

  if [ "$platform" = "iphoneos" ]; then
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphoneos")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN_VERSION")
  else
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphonesimulator")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$SIM_MIN_VERSION")
  fi

  cd "$tmp_build"
  cmake "$LIBWEBP_SRC" "${cmake_args[@]}"
  cmake --build . -j"$(sysctl -n hw.ncpu)"
  cmake --install .

  # Merge libsharpyuv.a into libwebp.a so the XCFramework is self-contained
  local webp_lib="$prefix/lib/libwebp.a"
  local sharp_lib="$prefix/lib/libsharpyuv.a"
  if [ ! -f "$webp_lib" ]; then
    webp_lib=$(find "$prefix" -name 'libwebp.a' -type f | head -1)
  fi
  if [ ! -f "$sharp_lib" ]; then
    sharp_lib=$(find "$prefix" -name 'libsharpyuv.a' -type f | head -1)
  fi
  if [ -z "$webp_lib" ] || [ ! -f "$webp_lib" ]; then
    echo "Error: libwebp.a not found under $prefix"
    exit 1
  fi
  if [ -n "$sharp_lib" ] && [ -f "$sharp_lib" ]; then
    local merged="$prefix/lib/libwebp_merged.a"
    mkdir -p "$(dirname "$merged")"
    libtool -static -o "$merged" "$webp_lib" "$sharp_lib"
    mv "$merged" "$prefix/lib/libwebp.a"
  else
    mkdir -p "$prefix/lib"
    cp -f "$webp_lib" "$prefix/lib/libwebp.a"
  fi

  # Normalize headers
  if [ ! -d "$prefix/include/webp" ]; then
    mkdir -p "$prefix/include/webp"
    cp -v "$LIBWEBP_SRC"/src/webp/*.h "$prefix/include/webp/"
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
  "$OUTPUT_DIR/iphonesimulator/arm64/lib/libwebp.a" \
  "$OUTPUT_DIR/iphonesimulator/x86_64/lib/libwebp.a" \
  -output "$SIM_LIB/libwebp.a"

echo "===== Creating XCFramework ====="

xcodebuild -create-xcframework \
  -library "$OUTPUT_DIR/iphoneos/arm64/lib/libwebp.a" \
  -headers "$OUTPUT_DIR/iphoneos/arm64/include" \
  -library "$SIM_LIB/libwebp.a" \
  -headers "$SIM_INC" \
  -output "$XCFRAMEWORK_OUT"

echo "Build complete: $XCFRAMEWORK_OUT"
