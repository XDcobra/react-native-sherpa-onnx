# Sherpa ONNX Example App

This app is the integration playground for [react-native-sherpa-onnx](../README.md) inside the monorepo `example/` folder. It is used to validate model setup, runtime behavior, and UI flows against the current SDK APIs on Android and iOS.

The screens cover both offline and streaming pipelines, including STT, TTS, enhancement, source separation, punctuation, VAD, keyword spotting (KWS), timestamp/alignment generation, spoken language identification, OCR (ppocr / doctr / doc_vlm / nemotron_parse / paddleocr_vl), e-document read-aloud (EPUB / FB2 / CBZ / PDF), and model lifecycle workflows such as runtime downloads and extraction. The app also includes pipeline buffer flows (audio/text/segment/image buffers), live ingestion paths, and execution-provider diagnostics in Settings.

For SDK-level feature docs, start from [docs/README.md](../docs/README.md) and then open the feature guides linked in each section below.

## Run and setup

Run all commands from `example/`:

```sh
yarn install
yarn start
```

Android:

```sh
yarn android
```

iOS:

```sh
bundle install
yarn ios
```

## Bundling models & test assets (offline / without download manager)

If you do not want to download models at runtime via the **Download Manager Showcase**, you can bundle model folders and test assets directly into the application before building.

### Folder locations

| Asset type                 | Android location                                 | iOS location                           |
| -------------------------- | ------------------------------------------------ | -------------------------------------- |
| **Models**                 | `android/app/src/main/assets/models/<model-id>/` | `ios/sherpa_models/models/<model-id>/` |
| **Test audio WAVs**        | `android/app/src/main/assets/test_wavs/`         | `ios/sherpa_models/test_wavs/`         |
| **Codec samples**          | `android/app/src/main/assets/test_codec/`        | `ios/sherpa_models/test_codec/`        |
| **Test images (OCR)**      | `android/app/src/main/assets/test_images/`       | `ios/sherpa_models/test_images/`       |
| **Test PDFs (text layer)** | `android/app/src/main/assets/test_pdfs/`         | `ios/sherpa_models/test_pdfs/`         |
| **Test e-docs (Read aloud)** | `android/app/src/main/assets/test_edocs/`      | `ios/sherpa_models/test_edocs/`        |

> **Cross-Platform Sharing:** You do not need to duplicate large model files into both platform folders manually:
>
> - **iOS Build (`Xcode`):** The Xcode build phase automatically pulls models and test audios from both `android/app/src/main/assets/models/` and `ios/sherpa_models/models/` into the iOS app bundle (`App.app/models/`).
> - **Android Build (`Gradle`):** `downloadSherpaModels` fills the PAD pack; `syncPackModelsToAppAssets` mirrors those folders into `android/app/src/main/assets/models/` so plain `yarn android` can discover them via `listAssetModels()` without PAD or adb. `syncModelsFromIos` also copies any models from `ios/sherpa_models/models/` into Android assets. Optional: `yarn android:pad` exercises the PAD path (`getAssetPackPath`).
>
> Placing a model in either location (or both) makes it discoverable via `listAssetModels()` and immediately usable offline across all feature screens.

## Download manager showcase

| ![Download manager 1](../docs/images/example/download_1.png) | ![Download manager 2](../docs/images/example/download_2.png) | ![Download manager 3](../docs/images/example/download_3.png) |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
|                                                              |                                                              |                                                              |

This screen exercises the runtime model delivery flow from [docs/download-manager.md](../docs/download-manager.md). It covers refresh, metadata lookup, download, extraction, pause/resume for both download and extraction phases, cleanup of incomplete state, and deletion of installed models. It is the main screen for testing real-world model lifecycle behavior before opening STT/TTS/VAD/OCR feature screens.

## Speech-to-Text (offline)

| ![STT offline 1](../docs/images/example/stt_1.png) | ![STT offline 2](../docs/images/example/stt_2.png) | ![STT offline 3](../docs/images/example/stt_3.png) |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
|                                                    |                                                    |                                                    |

This screen initializes offline STT engines and runs file-based transcription through pipeline buffers. It can work with bundled assets and downloaded model folders, detects STT model type, and supports offline text buffer inspection (text/tokens/timestamps/durations and metadata fields). It also includes playback and route-selection hooks used during local verification of [docs/stt-offline.md](../docs/stt-offline.md).

## Text-to-Speech (offline)

| ![TTS offline 1](../docs/images/example/tts_1.png) | ![TTS offline 2](../docs/images/example/tts_2.png) | ![TTS offline 3](../docs/images/example/tts_3.png) |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
|                                                    |                                                    |                                                    |

This screen focuses on offline synthesis with [docs/tts-offline.md](../docs/tts-offline.md) APIs. It supports model detection/initialization, synthesis options, optional voice-cloning inputs for supported model families, playback through PCM, and saving generated audio with [docs/audio-conversion.md](../docs/audio-conversion.md). It also exposes segmented synthesis toggles used for memory-conscious runs.

## Speech-to-Text (streaming)

| ![STT streaming 1](../docs/images/example/stt_streaming_1.png) | ![STT streaming 2](../docs/images/example/stt_streaming_2.png) | ![STT streaming 3](../docs/images/example/stt_streaming_3.png) |
| -------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
|                                                                |                                                                |                                                                |

This screen streams long files through LiveAudioBuffer to LiveTextBuffer with a streaming STT engine, mainly for low-latency transcript updates and avoiding large offline decode peaks. It shows segment count, committed transcript, and partial transcript state while ingesting audio, matching [docs/stt-streaming.md](../docs/stt-streaming.md).

## Text-to-Speech (streaming)

| ![TTS streaming 1](../docs/images/example/tts_streaming_1.png) | ![TTS streaming 2](../docs/images/example/tts_streaming_2.png) | ![TTS streaming 3](../docs/images/example/tts_streaming_3.png) |
| -------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
|                                                                |                                                                |                                                                |

This screen tests live TTS by pushing text chunks into a live text pipeline and synthesizing into a live audio buffer. It is used to validate low time-to-first-audio behavior, flush/cancel lifecycle, and final buffer playback, aligned with the live-overload guidance in [docs/tts-offline.md](../docs/tts-offline.md).

## Offline Pipeline Showcase (File -> STT -> TTS -> playback)

| ![Pipeline offline 1](../docs/images/example/pipeline_offline_1.png) | ![Pipeline offline 2](../docs/images/example/pipeline_offline_2.png) | ![Pipeline offline 3](../docs/images/example/pipeline_offline_3.png) |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
|                                                                      |                                                                      |                                                                      |

This screen demonstrates an end-to-end offline chain from file input to offline STT, then offline TTS, followed by playback/final output handling. It is the reference for batch-style orchestration and segmented offline processing flows in a single pipeline scenario.

## Live Pipeline Showcase (Mic/File -> STT -> TTS -> playback)

| ![Pipeline streaming 1](../docs/images/example/pipeline_streaming_1.png) | ![Pipeline streaming 2](../docs/images/example/pipeline_streaming_2.png) | ![Pipeline streaming 3](../docs/images/example/pipeline_streaming_3.png) |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
|                                                                          |                                                                          |                                                                          |

This screen demonstrates an end-to-end live pipeline: source input (mic/file) to streaming STT, then incremental TTS, then PCM playback with runtime metrics and finalize/save output flow. It is the main integration example for live buffer chaining and low-latency pipeline orchestration.

## Alignment (subtitles/timestamps)

| ![Alignment 1](../docs/images/example/alignment_1.png) | ![Alignment 2](../docs/images/example/alignment_2.png) | ![Alignment 3](../docs/images/example/alignment_3.png) |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
|                                                        |                                                        |                                                        |

This screen generates subtitle/timestamp segments from audio and transcript inputs. It validates alignment modes (`proportional`, `estimated`, and `accurate`) and includes anchor/VAD-assisted workflows where applicable. See [docs/alignment-offline.md](../docs/alignment-offline.md), [docs/segmentation-engine.md](../docs/segmentation-engine.md), and [docs/vad-streaming.md](../docs/vad-streaming.md).

## Speech enhancement (offline)

| ![Enhancement offline 1](../docs/images/example/enhancement_offline_1.png) | ![Enhancement offline 2](../docs/images/example/enhancement_offline_2.png) | ![Enhancement offline 3](../docs/images/example/enhancement_offline_3.png) |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
|                                                                            |                                                                            |                                                                            |

This screen runs offline enhancement over prepared input buffers, supports segmented mode toggles, and allows saving/playback of enhanced output. It is used for validating GTCRN/DPDFNet model behavior via [docs/enhancement-offline.md](../docs/enhancement-offline.md).

## Speech enhancement (streaming)

| ![Enhancement streaming 1](../docs/images/example/enhancement_streaming_1.png) | ![Enhancement streaming 2](../docs/images/example/enhancement_streaming_2.png) | ![Enhancement streaming 3](../docs/images/example/enhancement_streaming_3.png) |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
|                                                                                |                                                                                |                                                                                |

This screen streams source audio through live enhancement pipelines, including ingest controls and output finalization. It is mainly used to test long-input handling and live pipeline lifecycle from [docs/enhancement-streaming.md](../docs/enhancement-streaming.md).

## Voice Activity Detection

| ![VAD 1](../docs/images/example/vad_1.png) | ![VAD 2](../docs/images/example/vad_2.png) | ![VAD 3](../docs/images/example/vad_3.png) |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
|                                            |                                            |                                            |

This screen supports both live and offline VAD flows, including file and microphone input for live mode, plus segment timeline inspection and status polling. It validates segment buffer behavior and VAD summaries against [docs/vad-streaming.md](../docs/vad-streaming.md).

## Keyword spotting (streaming)

| ![Keyword spotting 1](../docs/images/example/kws_1.png) | ![Keyword spotting 2](../docs/images/example/kws_2.png) | ![Keyword spotting 3](../docs/images/example/kws_3.png) |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
|                                                         |                                                         |                                                         |

This screen runs real streaming keyword spotting (`createKeywordSpotting` → `engine.spot`) over a `LiveAudioBuffer` into a `LiveTextBuffer`. It covers pack-aware model init (`ModelCategory.Kws`), optional keyword overrides (`spot({ keywords })`), file or mic ingest, hit HUD / timeline, and pipeline lifecycle (start, flush, stop). Use tokens that match the loaded pack vocabulary (BPE vs ppinyin). See [docs/kws-streaming.md](../docs/kws-streaming.md).

## Audio tagging (offline)

| ![Audio tagging offline 1](../docs/images/example/audio_tagging_offline_1.png) | ![Audio tagging offline 2](../docs/images/example/audio_tagging_offline_2.png) | ![Audio tagging offline 3](../docs/images/example/audio_tagging_offline_3.png) |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |

Home → **Audio Tagging** → **Offline batch**. Initializes dedicated AudioSet packs (`createAudioTagging` / `ModelCategory.AudioTagging`, e.g. ced-mini or zipformer-small). Segmentation **Off** = oneshot `tag(offline)` with primary label + top-K probability bars; **Auto** = segmented `speech_energy_silence` windows with a span timeline and per-span top-K (`continuous_frames` is live-only). Example audio includes upstream sound-event clips (`test_wavs/audio-tagging/1.wav`…`13.wav`) plus a short speech subset. See [docs/audio-tagging-offline.md](../docs/audio-tagging-offline.md).

## Audio tagging (live overload)

| ![Audio tagging live 1](../docs/images/example/audio_tagging_live_1.png) | ![Audio tagging live 2](../docs/images/example/audio_tagging_live_2.png) | ![Audio tagging live 3](../docs/images/example/audio_tagging_live_3.png) |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |

Same screen, toggle **Live overload**. `tag(liveAudio, liveText, { topK, segmentation, onSegment })` with mandatory Auto segmentation (`speech_energy_silence` or `continuous_frames`). File or mic ingest; last-primary HUD plus a per-span timeline (tap row → that window’s top-K bars). LiveText commits use `source: 'audio_tagging'`. See [docs/audio-tagging-live.md](../docs/audio-tagging-live.md) and [docs/streaming-pipelines-overview.md](../docs/streaming-pipelines-overview.md).

## Punctuation (offline)

| ![Punctuation offline 1](../docs/images/example/punctuation_offline_1.png) | ![Punctuation offline 2](../docs/images/example/punctuation_offline_2.png) | ![Punctuation offline 3](../docs/images/example/punctuation_offline_3.png) |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
|                                                                            |                                                                            |                                                                            |

This screen tests offline CT-Transformer punctuation with text buffers, model detection, optional segmented processing, and copy/export flows for punctuated output. It maps to [docs/punctuation-offline.md](../docs/punctuation-offline.md).

## Punctuation (streaming)

| ![Punctuation streaming 1](../docs/images/example/punctuation_streaming_1.png) | ![Punctuation streaming 2](../docs/images/example/punctuation_streaming_2.png) | ![Punctuation streaming 3](../docs/images/example/punctuation_streaming_3.png) |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
|                                                                                |                                                                                |                                                                                |

This screen runs online punctuation over live text buffers. It shows incremental input append, optional segmentation attach mode, pipeline completion, and final live output extraction, aligned with [docs/punctuation-streaming.md](../docs/punctuation-streaming.md).

## File I/O showcase

| ![File I/O 1](../docs/images/example/fileio_1.png) | ![File I/O 2](../docs/images/example/fileio_2.png) | ![File I/O 3](../docs/images/example/fileio_3.png) |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
|                                                    |                                                    |                                                    |

This screen validates file and conversion workflows, including loading local assets/files and exporting generated or transformed audio outputs. It is the UI reference for [docs/fileio.md](../docs/fileio.md) and [docs/audio-conversion.md](../docs/audio-conversion.md).

**Codec sandbox (`test_codec/`):** bundled samples for probe/decode/encode round-trips. Add files listed in `example/android/app/src/main/assets/test_codec/README.md` (Android) and `example/ios/sherpa_models/test_codec/README.md` (iOS), then rebuild. Android FileSource: `{ kind: 'app', base: 'apkAsset', path: 'test_codec/sample.<ext>' }` (APK `assets/`, not sandbox `files/`).

## Audio visualization showcase

| ![Audio visualization — static bars](../docs/images/example/vis_static.png) | ![Audio visualization — heatmap](../docs/images/example/vis_heatmap.png) | ![Audio visualization — pseudo-3D](../docs/images/example/vis_3d.png) |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Static (`levels`)                                                           | Heatmap (`frames`)                                                       | Pseudo-3D (`frames`, Skia)                                            |

Open **Audio visualization** from Home. The screen runs one `computeAudioVisualizationProfile` call (timeline enabled), then renders SDK data in four tabs: **Static**, **Animated**, **Heatmap**, and **3D**.

- **Static** — mirrored bar chart from global `levels`.
- **Animated** — same bars driven by timeline frame index (playback scrub).
- **Heatmap** — time × frequency grid from `frames`.
- **3D** — example UI only: isometric bars in Skia from per-frame levels; not a native SDK 3D feature.

Implementation: `example/src/screens/audio-visualization/AudioVisualizationScreen.tsx` and `example/src/components/SpectrumBarsView.tsx`, `SpectrumHeatmapView.tsx`, `Spectrum3DView.tsx`. API reference: [docs/audio-visualization.md](../docs/audio-visualization.md).

## Segmentation showcase

| ![Segmentation audio 1](../docs/images/example/segmentation_audio_1.png) | ![Segmentation audio 2](../docs/images/example/segmentation_audio_2.png) | ![Segmentation audio 3](../docs/images/example/segmentation_audio_3.png) |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| ![Segmentation text 1](../docs/images/example/segmentation_text_1.png)   | ![Segmentation text 2](../docs/images/example/segmentation_text_2.png)   | ![Segmentation text 3](../docs/images/example/segmentation_text_3.png)   |

This screen demonstrates segmentation policies for audio and text pipelines to keep processing bounded and memory usage predictable on long inputs. It maps to [docs/segmentation-engine.md](../docs/segmentation-engine.md).

## Settings and provider diagnostics

| ![Settings 1](../docs/images/example/settings_1.png) | ![Settings 2](../docs/images/example/settings_2.png) | ![Settings 3](../docs/images/example/settings_3.png) |
| ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
|                                                      |                                                      |                                                      |

The Settings screen (gear button on Home) provides runtime diagnostics for acceleration backends and provider availability. It exposes checks for QNN, NNAPI, XNNPACK, Core ML, and available providers, plus app/SDK version display. This is used for environment verification before running model-heavy screens. See [docs/execution-providers.md](../docs/execution-providers.md).

## Source separation (offline)

| ![Separation offline 1](../docs/images/example/separation_offline_1.png) | ![Separation offline 2](../docs/images/example/separation_offline_2.png) | ![Separation offline 3](../docs/images/example/separation_offline_3.png) |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |

This screen initializes offline separation engines (Spleeter or UVR) with auto or custom init, ingests a mixed audio file into an offline input buffer, and runs batch separation into N empty stem output buffers (vocals + accompaniment by default). It supports optional offline segmentation (`mode: 'auto'`) for long mixes, per-stem playback and save, and progress display during segmented runs. Models can come from bundled assets, the download manager (`ModelCategory.Separation`), or local folders — see [docs/separation-offline.md](../docs/separation-offline.md), [docs/model-detect.md](../docs/model-detect.md), and [ios/sherpa_models/README.md](./ios/sherpa_models/README.md) for iOS bundle layout.

## Source separation (live overload)

| ![Separation live overload 1](../docs/images/example/separation_streaming_1.png) | ![Separation live overload 2](../docs/images/example/separation_streaming_2.png) | ![Separation live overload 3](../docs/images/example/separation_streaming_3.png) |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |

This screen streams mixed audio from a file or microphone into live input buffers, runs separation via live overload into N live stem output buffers, and shows phased progress (decode → separation). Segmentation uses mandatory `continuous_frames` policy (configurable checkpoint interval). It validates stop/restart lifecycle, finalize/flush ordering, and stem playback from live buffers. See [docs/separation-live.md](../docs/separation-live.md), [docs/segmentation-engine.md](../docs/segmentation-engine.md), and [docs/memory-and-models.md](../docs/memory-and-models.md).

## Speaker identification

| ![Speaker identification 1](../docs/images/example/speaker_identification_1.png) | ![Speaker identification 2](../docs/images/example/speaker_identification_2.png) | ![Speaker identification 3](../docs/images/example/speaker_identification_3.png) |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |

This screen enrolls named speakers from offline audio, then identify / verify / label speech segments. Toggle **Offline batch** vs **Live overload** (same embedding weights). Auto or custom model init (`ModelCategory.SpeakerEmbedding`). Offline segmentation can be Off (whole-buffer) or Auto (`segmentOfflineBuffer` → `enrollOfflineSegments` / `labelOfflineSegments`). Live labeling requires mandatory speech segmentation (`speech_energy_silence` / `speech_vad_model`) over file ingest or mic. Includes export/import of the enrollment JSON bundle. See [docs/speaker-identification-offline.md](../docs/speaker-identification-offline.md) and [docs/speaker-identification-live.md](../docs/speaker-identification-live.md).

## Spoken language identification (offline)

| ![Language identification offline 1](../docs/images/example/language_identification_offline_1.png) | ![Language identification offline 2](../docs/images/example/language_identification_offline_2.png) | ![Language identification offline 3](../docs/images/example/language_identification_offline_3.png) |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |

Home → **Language identification (SLID)** → **Offline batch**. Initializes multilingual Whisper (`createLanguageIdentification` / `ModelCategory.LanguageId`, reusing STT Whisper packs). Segmentation **Off** = oneshot `identify(audio)` (★ English Sample 1); **Auto** = segmented code-switching with distribution bars, switch timeline, and per-segment list (★ ZH↔EN meeting / `2-zh-en.wav`). See [docs/language-identification-offline.md](../docs/language-identification-offline.md).

## Spoken language identification (live overload)

| ![Language identification live 1](../docs/images/example/language_identification_live_1.png) | ![Language identification live 2](../docs/images/example/language_identification_live_2.png) | ![Language identification live 3](../docs/images/example/language_identification_live_3.png) |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |

Same screen, toggle **Live overload**. `identify(liveAudio, liveText, { segmentation })` with mandatory speech segmentation (seeded `minSegmentMs: 1500`). File (★ ZH↔EN) or mic ingest; current-language chip + `onLanguageChanged` event log. See [docs/language-identification-live.md](../docs/language-identification-live.md) and [docs/streaming-pipelines-overview.md](../docs/streaming-pipelines-overview.md).

## Speaker diarization (offline)

| ![Diarization offline 1](../docs/images/example/diarization_offline_1.png) | ![Diarization offline 2](../docs/images/example/diarization_offline_2.png) | ![Diarization offline 3](../docs/images/example/diarization_offline_3.png) |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |

This screen evaluates multi-speaker audio recordings with offline diarization engines (Pyannote segmentation or Reverb models). It ingests full audio into offline buffers, runs speaker clustering, and extracts timestamps and speaker labels into an offline segment buffer (`kind: 'diarization'`). It also demonstrates integration with Speaker Identification (SID) via `mapDiarizationToNames` to resolve anonymous speaker clusters into enrolled names. See [docs/diarization-offline.md](../docs/diarization-offline.md) and [docs/diarization-named-timeline.md](../docs/diarization-named-timeline.md).

## Speaker diarization (streaming)

| ![Diarization streaming 1](../docs/images/example/diarization_streaming_1.png) | ![Diarization streaming 2](../docs/images/example/diarization_streaming_2.png) | ![Diarization streaming 3](../docs/images/example/diarization_streaming_3.png) |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |

This screen demonstrates true real-time streaming speaker diarization powered by Sortformer ONNX models. It streams live audio from a microphone or test audio files directly into the native streaming engine, outputting speaker segments to a `LiveSegmentBuffer` in real time. Features include an active speaker HUD with customizable speaker aliases, meeting analytics (speaking percentages, talk times, turn counts), runtime parameter tuning (onset/offset thresholds, min durations), and full pipeline lifecycle controls (start, flush, reset, stop). See [docs/diarization-streaming.md](../docs/diarization-streaming.md).

## OCR (offline)

| ![OCR offline 1](../docs/images/example/ocr_offline_1.png) | ![OCR offline 2](../docs/images/example/ocr_offline_2.png) | ![OCR offline 3](../docs/images/example/ocr_offline_3.png) |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |

Offline image-to-text for the `ppocr`, `doctr`, `doc_vlm`, `nemotron_parse`, and `paddleocr_vl` families (`createOCR` / `recognize`). Images go through an `OfflineImageBuffer`; results land in an offline text buffer with optional spatial spans. Models can come from bundled assets, PAD packs, or the download manager (`ModelCategory.Ocr`). See [docs/ocr-offline.md](../docs/ocr-offline.md).

The same screen also picks bundled PDFs from `test_pdfs/` (`digital_hello.pdf` / `digital_multipage.pdf` / `scan_only_page.pdf` / `scan_only_multipage.pdf`) or a custom PDF. The example **shows the app-dev switch** (no SDK auto):

1. `extractPdfTextLayer` — digital PDFs → TextBuffer (`origin: textLayer`); **no OCR**.
2. On `ERR_PDF_NO_TEXT_LAYER` — unlock `rasterizePdfPages` → `OfflineImageBuffer` → `recognize` like an image.

PDF pick still rasterizes for `OfflineImageBufferFrameView` preview (`lazy-lru`). Results keep the text buffer and draw boxes with [`OfflineImageBufferAnnotatedView`](../docs/imagebuffer-offline.md#offlineimagebufferannotatedview) for both `origin: ocr` (frame pixels) and `origin: textLayer` (PDF user-space mapped onto the frame). A path legend on the screen lists coords and overlay rules. The example opts in PDFium (`sherpaOnnxEnablePdfium=true` / `SHERPA_ONNX_ENABLE_PDFIUM=1`) and libwebp (`sherpaOnnxEnableLibwebp=true` / `SHERPA_ONNX_ENABLE_LIBWEBP=1`); consumer apps keep both SDK defaults off. See [docs/pdf-offline.md](../docs/pdf-offline.md) and [docs/imagebuffer-offline.md](../docs/imagebuffer-offline.md).

## Documents (read aloud)

| ![Read aloud 1](../docs/images/example/read_aloud_1.png) | ![Read aloud 2](../docs/images/example/read_aloud_2.png) | ![Read aloud 3](../docs/images/example/read_aloud_3.png) |
| -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |

Home section **Documents (EPUB, MOBI, PDF, …)** → **Read aloud**. Extract EPUB/FB2/MOBI/AZW3/PDF text (or OCR mixed EPUB / CBZ pages) into an `OfflineTextBuffer`, then speak with the same TTS detect/init panel as Text-to-Speech (Offline): catalog, auto/custom, `detectTtsModel`, speaker/speed, and the shared TTS engine cache. See [docs/document-offline.md](../docs/document-offline.md).

Bundled fixtures: `test_edocs/hello.epub`, `test_edocs/hello.fb2`, `test_edocs/hello.mobi`, `test_edocs/hello.azw3`, `test_edocs/drm.mobi`, `test_edocs/mixed.epub`, `test_edocs/manga.cbz`, plus the digital and scan-only PDFs from `test_pdfs/`.

1. Text EPUB / FB2 / DRM-free MOBI / AZW3 → `extractDocumentText` → OfflineTextBuffer (`origin: markup`) → `tts.synthesize` → playback. The current block span is highlighted from playback position.
2. PDF with a text layer → `extractPdfTextLayer` → same TTS path (`origin: textLayer`).
3. Scan-only PDF → `ERR_PDF_NO_TEXT_LAYER`. This screen does not rasterize, extract images, or run OCR; use Vision → OCR.
4. DRM MOBI (`drm.mobi`) → `ERR_DOC_DRM`. The SDK does not decrypt. This screen does not extract images or run OCR.
5. Mixed EPUB (`mixed.epub`) → two markup chapters plus `imageOnlySections.length === 1` → `extractDocumentImages` → FramePager → optional OCR Recognize. Extracted text shows **markup** / **ocr** origin chips, interleaved by `sectionIndex` in JS (no SDK merge API). Speak uses the concatenated string.
6. CBZ manga (`manga.cbz`) → `ERR_DOC_NO_TEXT` unlocks the same image + OCR path (no generic extract-failed panel). After Recognize, TTS is OCR-only. The archive is three JPEG pages (cover + two panels) from University of Tsukuba’s CC0 manga [ヒトはそれを『発達障害』と名づけました](https://dac.tsukuba.ac.jp/radd/joint-base/manga/).

OCR detect/init on this screen is the same panel and engine cache as Vision → OCR. Recognize is a separate button, not automatic.

See [docs/document-offline.md](../docs/document-offline.md) and [docs/pdf-offline.md](../docs/pdf-offline.md). Android bundled assets use `app:apkAsset` (the SDK copies them into app cache on first open).
