#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBARCHIVE_SRC="$REPO_ROOT/third_party/libarchive"

if [ ! -d "$LIBARCHIVE_SRC/libarchive" ]; then
    echo "Error: libarchive source not found at $LIBARCHIVE_SRC/libarchive"
    echo "Run: git submodule update --init third_party/libarchive"
    exit 1
fi

ZSTD_PREBUILT="$REPO_ROOT/third_party/zstd_prebuilt/ios"

export IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
export SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"
XCFRAMEWORK_OUT="$SCRIPT_DIR/libarchive.xcframework"

rm -rf "$BUILD_DIR" "$OUTPUT_DIR" "$XCFRAMEWORK_OUT"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

build_slice() {
  local platform=$1
  local arch=$2
  local os_type=$3

  local zstd_prefix="$ZSTD_PREBUILT/$platform/$arch"
  if [ ! -f "$zstd_prefix/lib/libzstd.a" ] || [ ! -f "$zstd_prefix/include/zstd.h" ]; then
    echo "Error: zstd prebuilt not found at $zstd_prefix"
    echo "Run: (cd third_party/zstd_prebuilt && ./build_zstd_ios.sh)"
    exit 1
  fi

  echo "===== Building libarchive ($platform $arch) ====="

  local prefix="$OUTPUT_DIR/$platform/$arch"
  local tmp_build="$BUILD_DIR/$platform-$arch"
  mkdir -p "$prefix" "$tmp_build"

  local cmake_args=(
    "-DCMAKE_INSTALL_PREFIX=$prefix"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=$os_type"
    "-DCMAKE_OSX_ARCHITECTURES=$arch"
    "-DENABLE_TEST=OFF"
    "-DENABLE_TAR=OFF"
    "-DENABLE_CPIO=OFF"
    "-DENABLE_CAT=OFF"
    "-DENABLE_UNZIP=OFF"
    "-DENABLE_CNG=OFF"
    "-DBUILD_SHARED_LIBS=OFF"
    "-DENABLE_OPENSSL=OFF"
    "-DENABLE_ZLIB=OFF"
    "-DENABLE_BZip2=ON"
    "-DENABLE_LIBXML2=OFF"
    "-DENABLE_EXPAT=OFF"
    "-DENABLE_LZMA=OFF"
    "-DENABLE_LZ4=OFF"
    "-DENABLE_ZSTD=ON"
    "-DZSTD_INCLUDE_DIR=$zstd_prefix/include"
    "-DZSTD_LIBRARY=$zstd_prefix/lib/libzstd.a"
    "-DENABLE_LZO=OFF"
    "-DENABLE_MBEDTLS=OFF"
    "-DENABLE_NETTLE=OFF"
    "-DENABLE_XATTR=OFF"
    "-DENABLE_ACL=OFF"
    "-DENABLE_MAC_OSX_APPLE_DOUBLE=OFF"
    "-DHAVE_LIBXML_XMLREADER_H=OFF"
  )

  if [ "$platform" = "iphoneos" ]; then
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphoneos")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN_VERSION")
  else
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphonesimulator")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$SIM_MIN_VERSION")
  fi

  cd "$tmp_build"
  cmake "$LIBARCHIVE_SRC" "${cmake_args[@]}"
  make -j"$(sysctl -n hw.ncpu)"
  make install

  # Merge libzstd.a into libarchive.a so the XCFramework is self-contained
  local archive_lib="$prefix/lib/libarchive.a"
  local merged="$prefix/lib/libarchive_merged.a"
  libtool -static -o "$merged" "$archive_lib" "$zstd_prefix/lib/libzstd.a"
  mv "$merged" "$archive_lib"
  cd "$SCRIPT_DIR"
}

build_slice iphoneos arm64 iOS
build_slice iphonesimulator arm64 iOS
build_slice iphonesimulator x86_64 iOS

echo "===== Creating universal simulator lib ====="

SIM_LIB="$OUTPUT_DIR/iphonesimulator/universal/lib"
mkdir -p "$SIM_LIB"

lipo -create \
  "$OUTPUT_DIR/iphonesimulator/arm64/lib/libarchive.a" \
  "$OUTPUT_DIR/iphonesimulator/x86_64/lib/libarchive.a" \
  -output "$SIM_LIB/libarchive.a"

echo "===== Creating XCFramework ====="

xcodebuild -create-xcframework \
  -library "$OUTPUT_DIR/iphoneos/arm64/lib/libarchive.a" \
  -headers "$OUTPUT_DIR/iphoneos/arm64/include" \
  -library "$SIM_LIB/libarchive.a" \
  -headers "$OUTPUT_DIR/iphonesimulator/arm64/include" \
  -output "$XCFRAMEWORK_OUT"

echo "Build complete: $XCFRAMEWORK_OUT"
