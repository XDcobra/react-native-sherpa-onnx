# Video preview test assets

Bundled clip for the Video Preview example screen.

Runtime access: `createOfflineVideoBufferFromFile({ kind: 'app', base: 'appBundle', path: 'test_videos/preview_h264_aac.mp4' })`.

The Xcode build phase copies this folder into `App.app/test_videos/` (README is skipped).
It also copies from Android `assets/test_videos/` when that folder is present.

| File | Format | Notes |
|------|--------|-------|
| `preview_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s, stereo 48 kHz. `testsrc2` pattern + 440 Hz tone. |
