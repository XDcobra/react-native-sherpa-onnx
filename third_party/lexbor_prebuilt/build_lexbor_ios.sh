#!/usr/bin/env bash
# Build lexbor static XCFramework for iOS (device arm64 + simulator arm64/x86_64).
# Requires: Xcode, lexbor submodule at third_party/lexbor.
# Output: third_party/lexbor_prebuilt/lexbor.xcframework

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LEXBOR_SRC="$REPO_ROOT/third_party/lexbor"

if [ ! -d "$LEXBOR_SRC" ] || [ ! -f "$LEXBOR_SRC/CMakeLists.txt" ]; then
    echo "Error: lexbor source not found at $LEXBOR_SRC"
    echo "Run: git submodule update --init third_party/lexbor"
    exit 1
fi

export IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
export SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"
XCFRAMEWORK_OUT="$SCRIPT_DIR/lexbor.xcframework"

rm -rf "$BUILD_DIR" "$OUTPUT_DIR" "$XCFRAMEWORK_OUT"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

build_slice() {
  local platform=$1
  local arch=$2
  local os_type=$3

  echo "===== Building lexbor ($platform $arch) ====="

  local prefix="$OUTPUT_DIR/$platform/$arch"
  local tmp_build="$BUILD_DIR/$platform-$arch"
  mkdir -p "$prefix" "$tmp_build"

  local cmake_args=(
    "-DCMAKE_INSTALL_PREFIX=$prefix"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=$os_type"
    "-DCMAKE_OSX_ARCHITECTURES=$arch"
    "-DLEXBOR_BUILD_SHARED=OFF"
    "-DLEXBOR_BUILD_STATIC=ON"
    "-DLEXBOR_BUILD_TESTS=OFF"
    "-DLEXBOR_BUILD_TESTS_CPP=OFF"
    "-DLEXBOR_BUILD_EXAMPLES=OFF"
    "-DLEXBOR_BUILD_UTILS=OFF"
    "-DLEXBOR_INSTALL_HEADERS=ON"
  )

  if [ "$platform" = "iphoneos" ]; then
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphoneos")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN_VERSION")
  else
    cmake_args+=("-DCMAKE_OSX_SYSROOT=iphonesimulator")
    cmake_args+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$SIM_MIN_VERSION")
  fi

  cd "$tmp_build"
  cmake "$LEXBOR_SRC" "${cmake_args[@]}"
  cmake --build . -j"$(sysctl -n hw.ncpu)"
  cmake --install .

  local lexbor_lib="$prefix/lib/liblexbor_static.a"
  if [ ! -f "$lexbor_lib" ]; then
    lexbor_lib=$(find "$prefix" -name 'liblexbor_static.a' -type f | head -1)
  fi
  if [ -z "$lexbor_lib" ] || [ ! -f "$lexbor_lib" ]; then
    lexbor_lib=$(find "$prefix" -name 'liblexbor.a' -type f | head -1)
  fi
  if [ -z "$lexbor_lib" ] || [ ! -f "$lexbor_lib" ]; then
    echo "Error: liblexbor_static.a / liblexbor.a not found under $prefix"
    exit 1
  fi
  mkdir -p "$prefix/lib"
  cp -f "$lexbor_lib" "$prefix/lib/liblexbor.a"

  if [ ! -d "$prefix/include/lexbor" ]; then
    mkdir -p "$prefix/include/lexbor"
    cp -R "$LEXBOR_SRC/source/lexbor/." "$prefix/include/lexbor/"
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
  "$OUTPUT_DIR/iphonesimulator/arm64/lib/liblexbor.a" \
  "$OUTPUT_DIR/iphonesimulator/x86_64/lib/liblexbor.a" \
  -output "$SIM_LIB/liblexbor.a"

echo "===== Creating XCFramework ====="

xcodebuild -create-xcframework \
  -library "$OUTPUT_DIR/iphoneos/arm64/lib/liblexbor.a" \
  -headers "$OUTPUT_DIR/iphoneos/arm64/include" \
  -library "$SIM_LIB/liblexbor.a" \
  -headers "$SIM_INC" \
  -output "$XCFRAMEWORK_OUT"

echo "Build complete: $XCFRAMEWORK_OUT"
