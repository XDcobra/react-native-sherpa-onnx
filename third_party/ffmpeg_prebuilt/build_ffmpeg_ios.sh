#!/usr/bin/env bash
# Build minimal FFmpeg (audio only) for iOS and create FFmpeg.xcframework
# make sure you have installed: brew install nasm yasm pkg-config

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FFMPEG_SRC="$REPO_ROOT/third_party/ffmpeg"
SHINE_BASE="$REPO_ROOT/third_party/shine_prebuilt/ios"

BUILD_DIR="$SCRIPT_DIR/build_ios"
OUTPUT_DIR="$SCRIPT_DIR/ios"
XCFRAMEWORK_OUT="$SCRIPT_DIR/FFmpeg.xcframework"

IOS_MIN_VERSION="${IPHONEOS_DEPLOYMENT_TARGET:-12.0}"
SIM_MIN_VERSION="${IPHONESIMULATOR_DEPLOYMENT_TARGET:-$IOS_MIN_VERSION}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS builds require macOS"
  exit 1
fi

if [ ! -f "$FFMPEG_SRC/configure" ]; then
  echo "FFmpeg source missing"
  exit 1
fi

HOST_PKG_CONFIG="pkg-config"
if ! command -v "$HOST_PKG_CONFIG" >/dev/null 2>&1; then
  echo "Error: pkg-config not found. Install it (e.g. brew install pkg-config)."
  exit 1
fi

COMMON_CONFIGURE=(
--disable-programs
--disable-doc
--disable-debug
--disable-avdevice
--disable-swscale
--disable-network
--disable-everything

--enable-static
--disable-shared

--enable-avcodec
--enable-avformat
--enable-avutil
--enable-swresample

--enable-decoder=aac,mp3,vorbis,flac,pcm_s16le,pcm_f32le,pcm_s32le,pcm_u8
--enable-demuxer=mov,mp3,ogg,flac,wav,matroska
--enable-muxer=wav,mp3,flac,mp4,ogg,matroska
--enable-parser=aac,mpegaudio,vorbis,flac
--enable-encoder=pcm_s16le,flac,aac,alac,libshine

--enable-protocol=file
--enable-libshine
)

build_slice() {

PLATFORM=$1
ARCH=$2

PREFIX="$OUTPUT_DIR/$PLATFORM/$ARCH"
TMP_BUILD="$BUILD_DIR/$PLATFORM-$ARCH"

mkdir -p "$PREFIX" "$TMP_BUILD"

echo "===== Building FFmpeg ($PLATFORM $ARCH) ====="

SDK=$(xcrun --sdk "$PLATFORM" --show-sdk-path)
CC=$(xcrun --sdk "$PLATFORM" -find clang)

if [ "$PLATFORM" = "iphoneos" ]; then
  MIN_FLAG="-miphoneos-version-min=$IOS_MIN_VERSION"
else
  MIN_FLAG="-mios-simulator-version-min=$SIM_MIN_VERSION"
fi

CFLAGS="-arch $ARCH -isysroot $SDK -O3 -fPIC $MIN_FLAG"
LDFLAGS="$CFLAGS"

SHINE_PREFIX="$SHINE_BASE/$PLATFORM/$ARCH"

if [ ! -f "$SHINE_PREFIX/lib/libshine.a" ]; then
  echo "Missing libshine for $PLATFORM/$ARCH"
  exit 1
fi

SHINE_CFLAGS="-I$SHINE_PREFIX/include"
SHINE_LDFLAGS="-L$SHINE_PREFIX/lib -lshine"

if [ ! -f "$SHINE_PREFIX/include/shine/layer3.h" ]; then
  echo "Missing shine header: $SHINE_PREFIX/include/shine/layer3.h"
  exit 1
fi

PKGDIR="$TMP_BUILD/pkgconfig"
mkdir -p "$PKGDIR"
cat > "$PKGDIR/shine.pc" <<PC
prefix=$SHINE_PREFIX
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: shine
Description: libshine MP3 encoder
Version: 1.0
Libs: -L\${libdir} -lshine
Cflags: -I\${includedir}
PC
export PKG_CONFIG_PATH="$PKGDIR${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

if ! "$HOST_PKG_CONFIG" --exists shine; then
  echo "pkg-config cannot find shine for $PLATFORM/$ARCH"
  echo "PKG_CONFIG_PATH=$PKG_CONFIG_PATH"
  ls -la "$PKGDIR" || true
  exit 1
fi

#DISABLE_ASM=""
#if [ "$ARCH" = "x86_64" ]; then
#  DISABLE_ASM="--disable-x86asm"
#fi

cd "$FFMPEG_SRC"

make distclean >/dev/null 2>&1 || true

export CC="$CC"
export CXX="$CC"

./configure \
--prefix="$PREFIX" \
"${COMMON_CONFIGURE[@]}" \
--target-os=darwin \
--arch="$ARCH" \
--cc="$CC" \
--enable-cross-compile \
--sysroot="$SDK" \
--pkg-config="$HOST_PKG_CONFIG" \
--extra-cflags="$CFLAGS $SHINE_CFLAGS" \
--extra-ldflags="$LDFLAGS $SHINE_LDFLAGS"
#$DISABLE_ASM \

make -j"$(sysctl -n hw.ncpu)"

make install

echo "Finished $PLATFORM $ARCH"
}

build_slice iphoneos arm64
build_slice iphonesimulator arm64
build_slice iphonesimulator x86_64

echo "===== Creating universal simulator libs ====="

SIM_LIB="$OUTPUT_DIR/iphonesimulator/universal/lib"
mkdir -p "$SIM_LIB"

for lib in libavcodec libavformat libavutil libswresample; do
lipo -create \
"$OUTPUT_DIR/iphonesimulator/arm64/lib/$lib.a" \
"$OUTPUT_DIR/iphonesimulator/x86_64/lib/$lib.a" \
-output "$SIM_LIB/$lib.a"
done

lipo -create \
"$SHINE_BASE/iphonesimulator/arm64/lib/libshine.a" \
"$SHINE_BASE/iphonesimulator/x86_64/lib/libshine.a" \
-output "$SIM_LIB/libshine.a"

echo "===== Creating single ffmpeg static lib (same name for device and simulator) ====="

mkdir -p "$BUILD_DIR/unified/device" "$BUILD_DIR/unified/simulator"

libtool -static \
"$OUTPUT_DIR/iphoneos/arm64/lib/libavcodec.a" \
"$OUTPUT_DIR/iphoneos/arm64/lib/libavformat.a" \
"$OUTPUT_DIR/iphoneos/arm64/lib/libavutil.a" \
"$OUTPUT_DIR/iphoneos/arm64/lib/libswresample.a" \
"$SHINE_BASE/iphoneos/arm64/lib/libshine.a" \
-o "$BUILD_DIR/unified/device/libffmpeg.a"

libtool -static \
"$SIM_LIB/libavcodec.a" \
"$SIM_LIB/libavformat.a" \
"$SIM_LIB/libavutil.a" \
"$SIM_LIB/libswresample.a" \
"$SIM_LIB/libshine.a" \
-o "$BUILD_DIR/unified/simulator/libffmpeg.a"

echo "===== Creating XCFramework ====="

rm -rf "$XCFRAMEWORK_OUT"

xcodebuild -create-xcframework \
-library "$BUILD_DIR/unified/device/libffmpeg.a" \
-headers "$OUTPUT_DIR/iphoneos/arm64/include" \
-library "$BUILD_DIR/unified/simulator/libffmpeg.a" \
-headers "$OUTPUT_DIR/iphonesimulator/arm64/include" \
-output "$XCFRAMEWORK_OUT"

echo ""
echo "Cleaning up conflicting headers (time.h) to prevent CocoaPods flattening issues..."
find "$XCFRAMEWORK_OUT" -name "time.h" -path "*/libavutil/time.h" -delete 2>/dev/null || true

echo "Build complete:"
echo "$XCFRAMEWORK_OUT"
