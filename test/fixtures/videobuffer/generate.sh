#!/usr/bin/env bash
# Generate committed VideoBuffer fixtures (< 2 MB). Requires ffmpeg + libx264 + libx265.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT"
EXP="$ROOT/expected"
mkdir -p "$OUT" "$EXP"

python3 - <<'PY'
import os, struct
root = os.environ.get("VB_FIXTURE_ROOT") or os.path.dirname(__file__) if False else os.getcwd()
PY

# Identity Y4M: luma 16 + (i*7)%220, 16x16, 15 frames, 30 fps.
python3 - "$OUT/identity.y4m" <<'PY'
import sys
w, h, n = 16, 16, 15
path = sys.argv[1]
with open(path, "wb") as f:
    f.write(f"YUV4MPEG2 W{w} H{h} F30:1 Ip A1:1 C420jpeg\n".encode())
    for i in range(n):
        y = 16 + (i * 7) % 220
        f.write(b"FRAME\n")
        f.write(bytes([y]) * (w * h))
        f.write(bytes([128]) * (w * h // 2))
print("wrote", path)
PY

FFMPEG=(ffmpeg -y -hide_banner -loglevel error)

# H.264 MP4 GOP 15 with B-frames
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -bf 2 -pix_fmt yuv420p -movflags +faststart \
  "$OUT/h264_gop15_b.mp4"

# Same with display rotation 90
"${FFMPEG[@]}" -display_rotation 90 -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -bf 2 -pix_fmt yuv420p \
  "$OUT/h264_rot90.mp4"

# VFR (variable fps via vsync)
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -pix_fmt yuv420p -fps_mode vfr \
  "$OUT/h264_vfr.mp4"

# Edit list: seteditlist via -avoid_negative_ts make_zero plus start offset
"${FFMPEG[@]}" -ss 0.1 -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -pix_fmt yuv420p \
  "$OUT/h264_editlist.mp4"

# Fragmented MP4
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -pix_fmt yuv420p -movflags frag_keyframe+empty_moov+default_base_moof \
  "$OUT/h264_frag.mp4"

# HEVC MOV hvc1
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx265 -tag:v hvc1 -g 15 -pix_fmt yuv420p -x265-params log-level=error \
  "$OUT/hevc_hvc1.mov"

# H.264 MKV
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libx264 -g 15 -pix_fmt yuv420p \
  "$OUT/h264.mkv"

# VP9 WebM (unsupported codec)
"${FFMPEG[@]}" -f yuv4mpegpipe -i "$OUT/identity.y4m" \
  -c:v libvpx-vp9 -b:v 50k -pix_fmt yuv420p \
  "$OUT/vp9.webm"

# Audio-only M4A
"${FFMPEG[@]}" -f lavfi -i "sine=frequency=440:duration=0.2" -c:a aac \
  "$OUT/audio_only.m4a"

# H.264 + AAC (48 kHz stereo), 5 s, GOP 30, clapper: white + 1 kHz beep each second
"${FFMPEG[@]}" -f lavfi -i "color=c=black:s=640x360:r=30:d=5" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=5" \
  -c:v libx264 -g 30 -pix_fmt yuv420p -c:a aac -ac 2 -ar 48000 -b:a 64k \
  -shortest "$OUT/av_h264_aac.mp4"

# H.264 + Opus in MKV
"${FFMPEG[@]}" -f lavfi -i "color=c=black:s=320x240:r=30:d=2" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
  -c:v libx264 -g 30 -pix_fmt yuv420p -c:a libopus -ac 2 -ar 48000 -b:a 32k \
  -shortest "$OUT/av_h264_opus.mkv" || true

# AAC with start offset (late audio)
"${FFMPEG[@]}" -f lavfi -i "color=c=black:s=320x240:r=30:d=2" \
  -itsoffset 0.5 -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=1.5" \
  -c:v libx264 -g 30 -pix_fmt yuv420p -c:a aac -ac 1 -ar 48000 \
  -shortest "$OUT/av_audio_late.mp4" || true

# Ramp AAC for sample-accurate trim tests
"${FFMPEG[@]}" -f lavfi -i "color=c=black:s=160x120:r=30:d=1" \
  -f lavfi -i "aevalsrc=t:s=48000:d=1" \
  -c:v libx264 -g 30 -pix_fmt yuv420p -c:a aac -ac 1 -ar 48000 \
  -shortest "$OUT/av_ramp_aac.mp4" || true

# AC-3 audio (unsupported in shipped FFmpeg) — skip if encoder missing
"${FFMPEG[@]}" -f lavfi -i "color=c=black:s=160x120:r=30:d=1" \
  -f lavfi -i "sine=frequency=440:duration=1" \
  -c:v libx264 -g 30 -pix_fmt yuv420p -c:a ac3 -ac 2 -ar 48000 \
  -shortest "$OUT/av_h264_ac3.mp4" || true

# Truncated MP4: copy then truncate
cp "$OUT/h264_gop15_b.mp4" "$OUT/truncated.mp4"
python3 - "$OUT/truncated.mp4" <<'PY'
import os, sys
p = sys.argv[1]
sz = os.path.getsize(p)
with open(p, "r+b") as f:
    f.truncate(max(64, sz // 3))
PY

# Garbage
python3 - "$OUT/garbage.bin" <<'PY'
import sys
open(sys.argv[1], "wb").write(b"not a video file\x00\x01\x02")
PY

probe() {
  local f="$1"
  local name="$2"
  ffprobe -v error -select_streams v:0 -show_entries \
    stream=codec_name,width,height,nb_frames:stream_tags=rotate \
    -of json "$f" > "$EXP/${name}.json" || true
}

probe "$OUT/h264_gop15_b.mp4" h264_gop15_b
probe "$OUT/h264_rot90.mp4" h264_rot90
probe "$OUT/hevc_hvc1.mov" hevc_hvc1
probe "$OUT/h264.mkv" h264_mkv
probe "$OUT/vp9.webm" vp9
probe "$OUT/audio_only.m4a" audio_only
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels \
  -of json "$OUT/av_h264_aac.mp4" > "$EXP/av_h264_aac.json" || true

rm -f "$OUT/identity.y4m"
echo "fixtures written under $OUT"
du -h "$OUT"/* | head
