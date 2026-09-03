# react-native-sherpa-onnx — Documentation Index

> For installation and a feature overview, start at the [root README](../README.md).  
> **New to models?** Follow the [How to start](../README.md#how-to-start) reading path under Feature Support in the root README.

This index maps every user-facing guide to its canonical file. Internal and migration docs live in separate sub-folders and are **not** listed here.

---

## Planning

| Guide | Description |
|-------|-------------|
| [memory-and-models.md](./memory-and-models.md) | OOM awareness, model sizing, concurrent engine budgets, buffer planning |
| [feature-pipelines.md](./feature-pipelines.md) | Named end-to-end pipeline recipes across offline/streaming features |
| [model-setup.md](./model-setup.md) | `FileSource`, bundled/PAD/downloaded paths, discovery APIs, expected folder layouts |
| [model-delivery-pad-odr.md](./model-delivery-pad-odr.md) | Ship models: PAD (install-time / fast-follow / on-demand) & iOS ODR / bundle |
| [model-detect.md](./model-detect.md) | Detection (cheap preflight), init modes (auto vs custom), validation, unified vs feature detect |
| [model-languages.md](./model-languages.md) | Language tables and hints for picker UI / `modelOptions` |
| [execution-providers.md](./execution-providers.md) | CPU, NNAPI, XNNPACK, Core ML, QNN |
| [streaming-pipelines-overview.md](./streaming-pipelines-overview.md) | Shared streaming pipeline lifecycle — handles (`stop` / `flush` / …), registry, buffer finalization |
| [native-diagnostics.md](./native-diagnostics.md) | Native crash ring buffer, signal-handler dumps (`SherpaNativeDiag`), snapshot API |

---

## Speech-to-Text (STT)

| Guide | Description |
|-------|-------------|
| [stt-offline.md](./stt-offline.md) | Offline (batch) transcription — file or raw samples |
| [stt-streaming.md](./stt-streaming.md) | Real-time streaming recognition — partial results, endpoint detection |

---

## Text-to-Speech (TTS)

| Guide | Description |
|-------|-------------|
| [tts-offline.md](./tts-offline.md) | Offline (batch) speech generation |
| [tts-streaming.md](./tts-streaming.md) | Live TTS entry point — links live overload (`TtsPipelineHandle`) |
| [android-system-tts.md](./android-system-tts.md) | Android system `TextToSpeechService` engine (Kotlin-only, opt-in) |

---

## Voice Activity Detection (VAD)

| Guide | Description |
|-------|-------------|
| [vad-streaming.md](./vad-streaming.md) | Streaming VAD — `createStreamingVAD`, Silero / Ten VAD models |

---

## Speech Enhancement

| Guide | Description |
|-------|-------------|
| [enhancement-offline.md](./enhancement-offline.md) | Offline batch enhancement |
| [enhancement-streaming.md](./enhancement-streaming.md) | Live streaming enhancement (native buffer pipeline) |

---

## Source Separation

| Guide | Description |
|-------|-------------|
| [separation-offline.md](./separation-offline.md) | Offline (batch) separation — Spleeter/UVR, Android & iOS |
| [separation-streaming.md](./separation-streaming.md) | Live separation entry point — links live overload (`SeparationPipelineHandle`) |

---

## Punctuation

| Guide | Description |
|-------|-------------|
| [punctuation-offline.md](./punctuation-offline.md) | Offline punctuation restoration |
| [punctuation-streaming.md](./punctuation-streaming.md) | Streaming punctuation pipeline (`createStreamingPunctuation`) |

---

## Alignment / Timestamps

| Guide | Description |
|-------|-------------|
| [alignment-offline.md](./alignment-offline.md) | `createAlignment` — `proportional`, `estimated`, `accurate` modes; `generateSpeechWithTimestamps()` |

> Streaming alignment is not yet available. `alignment-offline.md` is the sole alignment surface.

---

## Speaker Identification

| Guide | Description |
|-------|-------------|
| [speaker-identification-offline.md](./speaker-identification-offline.md) | Named-speaker enroll / identify / verify; segment-buffer label Out |
| [speaker-identification-live.md](./speaker-identification-live.md) | Live overload — `labelLiveSegments` on `LiveAudioBuffer` → labeled `LiveSegmentBuffer` |

> Diarization (anonymous clusters) remains planned — see [diarization.md](./diarization.md).

---

## Segmentation (cross-feature)

| Guide | Description |
|-------|-------------|
| [segmentation-engine.md](./segmentation-engine.md) | Engine, `SegmentLink`, `SegmentLinkMap`, modes, lifecycle — canonical cross-feature reference |

---

## Pipeline Buffers

| Guide | Description |
|-------|-------------|
| [audiobuffer-offline.md](./audiobuffer-offline.md) | Offline audio buffer — append, file-load, read slices |
| [audiobuffer-streaming.md](./audiobuffer-streaming.md) | Live audio buffer — mic capture, ring buffer, streaming |
| [textbuffer-offline.md](./textbuffer-offline.md) | Offline text buffer — segment writing and reading |
| [textbuffer-streaming.md](./textbuffer-streaming.md) | Live text buffer — streaming segment production/consumption |
| [segmentbuffer-offline.md](./segmentbuffer-offline.md) | Offline segment buffer — segment links, maps |
| [segmentbuffer-streaming.md](./segmentbuffer-streaming.md) | Live segment buffer — streaming segment linking |

---

## Audio I/O

| Guide | Description |
|-------|-------------|
| [audio-session.md](./audio-session.md) | Global audio session policy and route preference (mic + PCM) |
| [pcm-player.md](./pcm-player.md) | Built-in PCM player — play pipeline buffer output |
| [audio-conversion.md](./audio-conversion.md) | Save / encode and duration probe (`react-native-sherpa-onnx/audio`) |
| [audio-visualization.md](./audio-visualization.md) | Spectrum profiles — `levels` (2D) and timeline `frames` (`react-native-sherpa-onnx/visualization`) |

---

## File I/O & Model Management

| Guide | Description |
|-------|-------------|
| [fileio.md](./fileio.md) | `copyFile`, `saveText`, `shareFile` — file-based I/O |
| [extraction.md](./extraction.md) | Archive extraction API (compressed .tar.zst / .tar.bz2) |
| [download-manager.md](./download-manager.md) | Runtime model download, background downloads (iOS/Android) |
| [hotwords.md](./hotwords.md) | Hotword / boosted-phrase configuration |

---

## Feature Flags & Builds

| Guide | Description |
|-------|-------------|
| [disable-ffmpeg.md](./disable-ffmpeg.md) | Exclude FFmpeg from the build |
| [disable-libarchive.md](./disable-libarchive.md) | Exclude libarchive from the build |

---

## Advanced / Roadmap

| Guide | Description |
|-------|-------------|
| [diarization.md](./diarization.md) | Speaker diarization (planned; shares embedding foundation with SID) |
| [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) | SDK-facing known issues (e.g. Pocket TTS, platform drift) |
