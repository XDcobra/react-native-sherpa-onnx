# Codec test assets (File I/O example)

Place short audio samples here for the File I/O codec sandbox. Paths match `TEST_CODEC_FILES` in `example/src/audioConfig.ts`.

Runtime access: `{ kind: 'app', base: 'files', path: 'test_codec/<filename>' }`.

The Xcode build phase copies this folder into `App.app/test_codec/` (README is skipped).

## Required files

| File | Format | Notes |
|------|--------|-------|
| `sample.wav` | WAV | PCM WAV, ~3–10 s |
| `sample.mp3` | MP3 | |
| `sample.flac` | FLAC | |
| `sample.m4a` | M4A | |
| `sample.aac` | AAC | Container or raw AAC (FFmpeg-dependent) |
| `sample.opus` | Opus | |
| `sample.ogg` | OGG | |
| `sample.webm` | WebM | Audio in WebM container |
| `sample.mkv` | MKV | Audio in MKV container |

After adding files, rebuild the iOS app.
