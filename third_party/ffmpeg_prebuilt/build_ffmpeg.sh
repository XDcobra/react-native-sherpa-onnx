#!/usr/bin/env bash
# Build minimal FFmpeg (audio-only) for Android using NDK.
# Used by: Linux/macOS directly, or from build_ffmpeg.ps1 on Windows via MSYS2 bash.
# Requires: NDK (ANDROID_NDK_HOME or ANDROID_NDK_ROOT), FFmpeg source in ../../third_party/ffmpeg (submodule).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FFMPEG_SRC="$REPO_ROOT/third_party/ffmpeg"
WORK_DIR="$SCRIPT_DIR"
OUTPUT_BASE="$WORK_DIR/android"
ANDROID_API="${ANDROID_API:-21}"
FFMPEG_BUILD_LOG="${SCRIPT_DIR}/ffmpeg_build.log"

# NDK path
if [ -n "$ANDROID_NDK_HOME" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "$ANDROID_NDK_ROOT" ]; then
    NDK="$ANDROID_NDK_ROOT"
else
    echo "Error: Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT to your Android NDK path."
    exit 1
fi

# Host tag for NDK prebuilt toolchain (linux-x86_64, darwin-x86_64, windows-x86_64)
if [[ "$(uname -s)" == "Linux" ]]; then
    HOST_TAG="linux-x86_64"
elif [[ "$(uname -s)" == "Darwin" ]]; then
    HOST_TAG="darwin-x86_64"
else
    HOST_TAG="windows-x86_64"
fi
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
if [ ! -d "$TOOLCHAIN" ]; then
    echo "Error: NDK toolchain not found at: $TOOLCHAIN"
    exit 1
fi

if [ ! -d "$FFMPEG_SRC" ] || [ ! -f "$FFMPEG_SRC/configure" ]; then
    echo "Error: FFmpeg source not found at: $FFMPEG_SRC"
    echo "Run: git submodule update --init third_party/ffmpeg"
    exit 1
fi

# Minimal audio-only: decoders/demuxers for common formats;
# --prefix is set per ABI below
COMMON_CONFIGURE=(
    --enable-shared
    --disable-static
    --disable-programs
    --disable-doc
    --disable-debug
    --disable-avdevice
    --disable-swscale
    --disable-everything
    --enable-decoder=aac,mp3,vorbis,flac,pcm_s16le,pcm_f32le,pcm_s32le,pcm_u8
    --enable-demuxer=mov,mp3,ogg,flac,wav,matroska
    --enable-muxer=wav,mp3,flac,mp4,ogg,matroska
    --enable-encoder=pcm_s16le,flac,libshine,aac,alac
    --enable-parser=aac,mpegaudio,vorbis,flac
    --enable-protocol=file
    --enable-swresample
    --enable-avcodec
    --enable-avformat
    --enable-avutil
    --cross-prefix=
    --target-os=android
    --extra-cflags="-O3 -fPIC"
    --extra-ldflags=""
)

build_abi() {
    local ABI=$1
    local ARCH="" CPU="" CC="" CXX="" CROSS_PREFIX=""

    case "$ABI" in
        armeabi-v7a)
            ARCH=arm
            CPU=armv7-a
            CROSS_PREFIX="$TOOLCHAIN/bin/armv7a-linux-androideabi-"
            CC="$TOOLCHAIN/bin/armv7a-linux-androideabi${ANDROID_API}-clang"
            CXX="$TOOLCHAIN/bin/armv7a-linux-androideabi${ANDROID_API}-clang++"
            ;;
        arm64-v8a)
            ARCH=aarch64
            CPU=armv8-a
            CROSS_PREFIX="$TOOLCHAIN/bin/aarch64-linux-android-"
            CC="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API}-clang"
            CXX="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API}-clang++"
            ;;
        x86)
            ARCH=x86
            CPU=atom
            CROSS_PREFIX="$TOOLCHAIN/bin/i686-linux-android-"
            CC="$TOOLCHAIN/bin/i686-linux-android${ANDROID_API}-clang"
            CXX="$TOOLCHAIN/bin/i686-linux-android${ANDROID_API}-clang++"
            ;;
        x86_64)
            ARCH=x86_64
            CPU=x86-64
            CROSS_PREFIX="$TOOLCHAIN/bin/x86_64-linux-android-"
            CC="$TOOLCHAIN/bin/x86_64-linux-android${ANDROID_API}-clang"
            CXX="$TOOLCHAIN/bin/x86_64-linux-android${ANDROID_API}-clang++"
            ;;
        *)
            echo "Unknown ABI: $ABI"
            return 1
            ;;
    esac

    local PREFIX_ABI="$OUTPUT_BASE/$ABI"
    mkdir -p "$PREFIX_ABI"
#
    # If libshine prebuilts exist for this ABI, add include and link flags
    SHINE_PREFIX="$SCRIPT_DIR/../shine_prebuilt/android/$ABI"
    if [ -d "$SHINE_PREFIX" ]; then
        echo "Found libshine prebuilts at $SHINE_PREFIX — enabling libshine"
        SHINE_CFLAGS="-I$SHINE_PREFIX/include"
        # libshine depends on math functions; add libm to link flags
        SHINE_LDFLAGS="-L$SHINE_PREFIX/lib -lshine -lm"
        # Create a minimal pkg-config file so FFmpeg's configure can find libshine
        PKGDIR="$SHINE_PREFIX/lib/pkgconfig"
        mkdir -p "$PKGDIR"
        # Ensure headers are available as include/shine for pkg-config and FFmpeg configure
        if [ -d "$SHINE_PREFIX/include/src/lib" ]; then
            mkdir -p "$SHINE_PREFIX/include/shine"
            cp -f "$SHINE_PREFIX/include/src/lib/"*.h "$SHINE_PREFIX/include/shine/" 2>/dev/null || true
        fi
        if [ -d "$SHINE_PREFIX/include/src/bin" ]; then
            mkdir -p "$SHINE_PREFIX/include/shine"
            cp -f "$SHINE_PREFIX/include/src/bin/"*.h "$SHINE_PREFIX/include/shine/" 2>/dev/null || true
        fi
        cat > "$PKGDIR/shine.pc" <<PC
    prefix=$SHINE_PREFIX
    exec_prefix=
    libdir=
    includedir=

    Name: shine
    Description: libshine MP3 encoder
    Version: 1.0
    Libs: -L\${prefix}/lib -lshine -lm
    Cflags: -I\${prefix}/include
PC
        export PKG_CONFIG_PATH="$PKGDIR:$PKG_CONFIG_PATH"
        # Diagnostic: ensure pkg-config can see shine (helpful on CI/host systems)
        if command -v pkg-config >/dev/null 2>&1; then
            echo "pkg-config present: $(pkg-config --version 2>/dev/null || echo '?')"
            echo "PKG_CONFIG_PATH=$PKG_CONFIG_PATH"
            if pkg-config --exists shine; then
                echo "pkg-config: found shine -> $(pkg-config --modversion shine 2>/dev/null || echo 'unknown')"
            else
                echo "pkg-config: cannot find 'shine' via PKG_CONFIG_PATH. Listing $PKGDIR:"
                ls -la "$PKGDIR" || true
                echo "Full PKG_CONFIG_PATH: $PKG_CONFIG_PATH"
                echo "Aborting; FFmpeg configure will not find libshine."
                exit 1
            fi
        else
            echo "Warning: pkg-config not found in PATH. Install pkg-config or set PKG_CONFIG_PATH appropriately."
            exit 1
        fi
        COMMON_CONFIGURE+=(--enable-libshine)
    else
        echo "Error: libshine prebuilts not found for ABI $ABI at: $SHINE_PREFIX"
        echo "Build libshine first using: third_party/shine_prebuilt/build_shine_msys2.sh"
        exit 1
    fi

    echo "===== Building FFmpeg for $ABI ====="
    cd "$FFMPEG_SRC"

    # NDK r23+ only has llvm-nm, llvm-ar, llvm-ranlib — pass them explicitly so configure does not use cross_prefix+nm
    CONFIG_LOG="$FFMPEG_SRC/ffbuild/config.log"

    # Install to ABI-specific prefix so we get per-ABI libs
    ./configure \
        --prefix="$PREFIX_ABI" \
        "${COMMON_CONFIGURE[@]}" \
        --arch="$ARCH" \
        --cpu="$CPU" \
        --cross-prefix="$CROSS_PREFIX" \
        --cc="$CC" \
        --cxx="$CXX" \
        --nm="${TOOLCHAIN}/bin/llvm-nm" \
        --ar="${TOOLCHAIN}/bin/llvm-ar" \
        --ranlib="${TOOLCHAIN}/bin/llvm-ranlib" \
        --sysroot="$TOOLCHAIN/sysroot" \
        --extra-cflags="-O3 -fPIC -I$TOOLCHAIN/sysroot/usr/include ${SHINE_CFLAGS:-}" \
        --extra-ldflags="${SHINE_LDFLAGS:-}" \
        2>&1 | tee -a "$FFMPEG_BUILD_LOG"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo "===== FFmpeg configure failed for $ABI — ffbuild/config.log ====="
        if [ -f "$CONFIG_LOG" ]; then cat "$CONFIG_LOG"; else echo "(config.log not found)"; fi
        exit 1
    fi

    make -j"$(nproc 2>/dev/null || echo 4)" 2>&1 | tee -a "$FFMPEG_BUILD_LOG"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo "===== FFmpeg make failed for $ABI — last 200 lines of build log ====="
        tail -200 "$FFMPEG_BUILD_LOG"
        exit 1
    fi
    make install
    make distclean 2>/dev/null || true

    echo "Successfully built FFmpeg for $ABI"
}

# Build all ABIs used by the SDK (match android defaultConfig.ndk.abiFilters)
: > "$FFMPEG_BUILD_LOG"
for ABI in armeabi-v7a arm64-v8a x86 x86_64; do
    build_abi "$ABI"
done

# Unify include: copy from first ABI so we have a single include/ for CMake
INCLUDE_UNIFIED="$OUTPUT_BASE/include"
mkdir -p "$INCLUDE_UNIFIED"
if [ -d "$OUTPUT_BASE/arm64-v8a/include" ]; then
    cp -R "$OUTPUT_BASE/arm64-v8a/include/"* "$INCLUDE_UNIFIED/" 2>/dev/null || true
fi

echo ""
echo "Build completed. Output: $OUTPUT_BASE"
echo "  - include/  (use this in CMake)"
echo "  - arm64-v8a/lib/*.so, armeabi-v7a/lib/*.so, x86/lib/*.so, x86_64/lib/*.so"
