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
| Source separation | Yes (`OfflineSourceSeparationConfig`) | No | Yes (`createSeparation`) | Yes, live overload on offline engine (`createSeparation().separate(Live, Live[], …)`) |
| Speaker Embedding / Identification | Yes (`SpeakerEmbeddingExtractorConfig`) | No | Yes (`createSpeakerIdentification`) | Yes, live overload (`labelLiveSegments`) |
| Speaker Diarization | Yes (`OfflineSpeakerDiarizationConfig`) | No | Yes (`createDiarization`) | Yes, **real streaming** (`createStreamingDiarization` via NeMo Sortformer) |
| Spoken Language Identification (SLID) | Yes (`SpokenLanguageIdentificationConfig`) | No | Yes (`createLanguageIdentification`) | Yes, **live overload** (`identify(liveAudio, liveText, …)` — offline Whisper per speech span) |
| Keyword Spotting (KWS) | No | Yes (`KeywordSpotterConfig`) | No | Yes, **real streaming** (`createKeywordSpotting` / `spot(LiveAudio, LiveText)`) |
| Audio Tagging | Yes (`AudioTaggingConfig`) | No | No | No |
| Diacritization | Yes (`OfflineDiacritizationConfig`) | No | No | No |

## Short notes

- **TTS live in the SDK** is currently pipeline-based and used as streaming even though sherpa does not expose a separate online TTS config like it does for online ASR.
- **VAD** is implemented in the SDK as a single engine entry point (`createStreamingVAD`) that can cover both the live pipeline and offline processing.
- **Alignment** exists in the SDK but not as a true streaming engine; ongoing/segmented processing is only orchestrated as fake streaming.
- **Punctuation** is its own module (`src/punctuation/`) in the SDK and supports both offline and streaming models.
- **Source separation** uses `createSeparation` for offline batch (`separate` into N offline buffers, optional offline segmentation) and live overload (`separate` into N live buffers with mandatory `continuous_frames` segmentation). There is no separate streaming separation factory.
- **Speaker Diarization** offers offline batch clustering (`createDiarization` using Pyannote/Reverb + embedding) and true online streaming (`createStreamingDiarization` using NeMo Sortformer). Live overload was intentionally excluded.
- **Spoken Language Identification (SLID)** uses Whisper multilingual offline weights only. The SDK exposes oneshot, segmented long-form (code-switching), and live overload via speech segmentation + per-span offline identify. There is no true streaming SLID model in sherpa-onnx.
- **Keyword Spotting (KWS)** is streaming-only: `createKeywordSpotting` (alias `createStreamingKWS`) initializes a native KeywordSpotter, and `spot(LiveAudio, LiveText)` runs a real streaming pipeline with keyword commits to `LiveTextBuffer` (and optional `onKeyword`). Mic and file paths share the same API via live ingest. There is no offline/batch KWS API in MVP. `textOut` keeps normal LiveTextBuffer spooling defaults; use `spooling: { mode: 'off' }` when only hit callbacks/segments are needed and spool replay is not. App guide: [kws-streaming.md](../kws-streaming.md).
