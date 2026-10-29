#!/usr/bin/env bash
# Host FFmpeg with the same --disable-everything / demuxer flags as the Android
# prebuilts (third_party/ffmpeg_prebuilt/build_ffmpeg.sh). Used by
# -DVIDEOBUFFER_FFMPEG=minimal for videobuffer_demux_host_test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/third_party/ffmpeg"
OUT="$ROOT/third_party/ffmpeg_host_minimal"
if [ ! -f "$SRC/configure" ]; then
  echo "FFmpeg source missing at $SRC" >&2
  exit 1
fi
mkdir -p "$OUT/build"
cd "$OUT/build"
"$SRC/configure" \
  --prefix="$OUT" \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-avdevice \
  --disable-swscale \
  --disable-everything \
  --enable-demuxer=mov,mp3,ogg,flac,wav,matroska,aac \
  --enable-muxer=wav,mp3,flac,mp4,ogg,matroska \
  --enable-protocol=file \
  --enable-avcodec \
  --enable-avformat \
  --enable-avutil \
  --enable-parser=aac,mpegaudio,vorbis,flac,opus,h264,hevc
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make install
echo "minimal host FFmpeg installed at $OUT"
