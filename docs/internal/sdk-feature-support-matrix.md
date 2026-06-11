# SDK Feature Support Matrix

As of: codebase in `react-native-sherpa-onnx` + `third_party/sherpa-onnx` (Kotlin/C API).

| Feature | sherpa-onnx: offline config (Kotlin/C API) | sherpa-onnx: live/streaming config (Kotlin/C API) | This SDK: offline engine | This SDK: live engine (real vs. fake) |
|---|---|---|---|---|
| STT (Speech-to-Text) | Yes | Yes | Yes (`createSTT`) | Yes, **real streaming** (`createStreamingSTT` / `createLiveSTT`) |
| TTS (Text-to-Speech) | Yes | No | Yes (`createTTS`) | Yes, live pipeline via `createTTS().synthesize(LiveText, LiveAudio, { segmentation })` |
| VAD (Voice Activity Detection) | No (no separate offline config model in sherpa) | Yes (`VadModelConfig`) | Yes (offline run via `createStreamingVAD(...).process()` with offline audio) | Yes, **real streaming** (`createStreamingVAD` with live audio pipeline) |
| Speech enhancement / denoiser | Yes (`OfflineSpeechDenoiserConfig`) | Yes (`OnlineSpeechDenoiserConfig`) | Yes (`createEnhancement`) | Yes, **real streaming** (`createStreamingEnhancement`) |
| Alignment (audio/text alignment) | No (no dedicated sherpa alignment config in Kotlin/C API) | No | Yes (`AlignmentEngine`) | Not as a dedicated live engine; **fake streaming possible manually** (chunk/segment-wise orchestration) |
| Punctuation | Yes (`OfflinePunctuationConfig`) | Yes (`OnlinePunctuationConfig`) | Yes (`createOfflinePunctuation`) | Yes (`createStreamingPunctuation`) |
| Source separation | Yes (`OfflineSourceSeparationConfig`) | No | Yes (`createSeparation`) | Not in MVP (live overload planned; same engine entry point) |

## Short notes

- **TTS live in the SDK** is currently pipeline-based and used as streaming even though sherpa does not expose a separate online TTS config like it does for online ASR.
- **VAD** is implemented in the SDK as a single engine entry point (`createStreamingVAD`) that can cover both the live pipeline and offline processing.
- **Alignment** exists in the SDK but not as a true streaming engine; ongoing/segmented processing is only orchestrated as fake streaming.
- **Punctuation** is its own module (`src/punctuation/`) in the SDK and supports both offline and streaming models.
- **Source separation** is offline-only in the MVP (`createSeparation` + `separate` into N offline buffers). Segmentation orchestration and live overload reuse the same public API later.
