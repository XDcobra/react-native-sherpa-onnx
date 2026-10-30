# Video preview test assets

Bundled clips for Video Preview and Video → OCR.

Runtime access: `createOfflineVideoBufferFromFile({ kind: 'app', base: 'apkAsset', path: 'test_videos/<file>' })`.

| File | Format | Notes |
|------|--------|-------|
| `preview_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s, stereo 48 kHz. `testsrc2` pattern + 440 Hz tone. |
| `ocr_subtitles_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s. Burned-in captions (2 s each): HELLO WORLD, OPEN SOURCE, SPEECH TO TEXT, VIDEO TO OCR. 440 Hz tone. |
| `sample.mp4` | H.264 Baseline + AAC | File I/O: 1 s, 256×144, 15 fps. |
| `sample.mov` | H.264 Baseline + AAC | File I/O: 1 s, 256×144, 15 fps. |
| `sample.mkv` | H.264 Baseline + Opus | File I/O: 1 s, 256×144, 15 fps. |
| `sample.webm` | H.264 Baseline + Opus | File I/O: 1 s, 256×144. Matroska bytes with a `.webm` name (SDK WebM is H.264/HEVC, not VP9). |

Regenerate the OCR clip (Homebrew `ffmpeg` without `drawtext`; stills via Pillow):

```bash
python3 -c 'from PIL import Image, ImageDraw, ImageFont; ...'  # 640×360 RGB stills
ffmpeg -loop 1 -t 2 -i 01.png ... -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,fps=30,format=yuv420p[v]" \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -c:a aac -ac 2 -ar 48000
```

Android: `assets/test_videos/`. iOS: `sherpa_models/test_videos/` (copied into the app bundle at build time).
