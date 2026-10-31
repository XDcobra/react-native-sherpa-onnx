# Video preview test assets

Bundled clips for Video Preview and Video → OCR.

Runtime access: `createOfflineVideoBufferFromFile({ kind: 'app', base: 'appBundle', path: 'test_videos/<file>' })`.

The Xcode build phase copies this folder into `App.app/test_videos/` (README is skipped).
It also copies from Android `assets/test_videos/` when that folder is present.

| File | Format | Notes |
|------|--------|-------|
| `preview_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s, stereo 48 kHz. `testsrc2` pattern + 440 Hz tone. |
| `ocr_subtitles_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s. Burned-in captions (2 s each): HELLO WORLD, OPEN SOURCE, SPEECH TO TEXT, VIDEO TO OCR. 440 Hz tone. |
| `sample.mp4` | H.264 Baseline + AAC | File I/O: 1 s, 256×144, 15 fps. |
| `sample.mov` | H.264 Baseline + AAC | File I/O: 1 s, 256×144, 15 fps. |
| `sample.mkv` | H.264 Baseline + Opus | File I/O: 1 s, 256×144, 15 fps. |
| `sample.webm` | H.264 Baseline + Opus | File I/O: 1 s, 256×144. Matroska bytes with a `.webm` name (SDK WebM is H.264/HEVC, not VP9). |
