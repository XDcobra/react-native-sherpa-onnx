# Audiobuffer sample-rate fixtures

Small mono PCM WAV tones for JVM unit tests of the buffer rate-conversion
matrix (offline↔offline, live→offline, offline→live). No FFmpeg / mic / RN E2E.

| File | Rate | Format | Duration |
| --- | --- | --- | --- |
| `tone-16k-mono.wav` | 16000 Hz | pcm_s16le mono | 0.25 s |
| `tone-48k-mono.wav` | 48000 Hz | pcm_s16le mono | 0.25 s |

## Regenerate

```bash
ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=0.25" \
  -ac 1 -c:a pcm_s16le test/fixtures/audiobuffer/tone-16k-mono.wav
ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.25" \
  -ac 1 -c:a pcm_s16le test/fixtures/audiobuffer/tone-48k-mono.wav
```

Android unit tests load these via `android/src/test/resources` wiring from this
directory (see `android/build.gradle` `sourceSets.test.resources`).
