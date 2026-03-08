#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OPUS_SRC="$REPO_ROOT/opus"
OUTPUT_BASE="$SCRIPT_DIR/ios"

IOS_MIN_VERSION=13.0

mkdir -p "$OUTPUT_BASE"

NCPU=$(sysctl -n hw.logicalcpu)

build_opus() {

    PLATFORM=$1
    ARCH=$2
    HOST=$3

    PREFIX="$OUTPUT_BASE/$PLATFORM/$ARCH"

    echo "===== Building opus for $PLATFORM $ARCH ====="

    cd "$OPUS_SRC"

    make distclean >/dev/null 2>&1 || true
    rm -f config.cache

    if [ "$PLATFORM" = "iphoneos" ]; then
        SDK=$(xcrun --sdk iphoneos --show-sdk-path)
        MINFLAG="-miphoneos-version-min=$IOS_MIN_VERSION"
    else
        SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
        MINFLAG="-mios-simulator-version-min=$IOS_MIN_VERSION"
    fi

    CC="$(xcrun --sdk $PLATFORM --find clang)"
    AR="$(xcrun --sdk $PLATFORM --find ar)"
    RANLIB="$(xcrun --sdk $PLATFORM --find ranlib)"
    STRIP="$(xcrun --sdk $PLATFORM --find strip)"

    CFLAGS="-O3 -fPIC -arch $ARCH -isysroot $SDK $MINFLAG"

    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes

    ./configure \
        --build=$(uname -m)-apple-darwin \
        --host=$HOST \
        --cache-file=/dev/null \
        --disable-shared \
        --enable-static \
        --disable-extra-programs \
        --disable-doc \
        --disable-asm \
        --prefix="$PREFIX" \
        CC="$CC" \
        AR="$AR" \
        RANLIB="$RANLIB" \
        STRIP="$STRIP" \
        CFLAGS="$CFLAGS"

    make -j$NCPU
    make install
}

build_opus iphoneos arm64 arm-apple-darwin
build_opus iphonesimulator arm64 arm-apple-darwin
build_opus iphonesimulator x86_64 x86_64-apple-darwin

echo "===== Creating fat simulator library ====="

SIM_LIB_DIR="$OUTPUT_BASE/iphonesimulator/universal/lib"
mkdir -p "$SIM_LIB_DIR"

lipo -create \
    "$OUTPUT_BASE/iphonesimulator/arm64/lib/libopus.a" \
    "$OUTPUT_BASE/iphonesimulator/x86_64/lib/libopus.a" \
    -output "$SIM_LIB_DIR/libopus.a"

echo ""
echo "======================================="
echo "Opus static libraries ready"
echo ""
echo "Device:"
echo "$OUTPUT_BASE/iphoneos/arm64/lib/libopus.a"
echo ""
echo "Simulator (universal):"
echo "$SIM_LIB_DIR/libopus.a"
echo "======================================="