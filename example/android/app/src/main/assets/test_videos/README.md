# Video preview test assets

Bundled clip for the Video Preview example screen.

Runtime access: `createOfflineVideoBufferFromFile({ kind: 'app', base: 'apkAsset', path: 'test_videos/preview_h264_aac.mp4' })`.

| File | Format | Notes |
|------|--------|-------|
| `preview_h264_aac.mp4` | H.264 Baseline + AAC | 640×360, 30 fps, 8 s, stereo 48 kHz. `testsrc2` pattern + 440 Hz tone. |

Android: `assets/test_videos/`. iOS: `sherpa_models/test_videos/` (copied into the app bundle at build time).
