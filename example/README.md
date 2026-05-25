# Sherpa ONNX Example App

This app is the integration playground for [react-native-sherpa-onnx](../README.md) inside the monorepo `example/` folder. It is used to validate model setup, runtime behavior, and UI flows against the current SDK APIs on Android and iOS.

The screens cover both offline and streaming pipelines, including STT, TTS, enhancement, punctuation, VAD, timestamp/alignment generation, and model lifecycle workflows such as runtime downloads and extraction. The app also includes pipeline buffer flows (audio/text/segment buffers), live ingestion paths, and execution-provider diagnostics in Settings.

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

## Download manager showcase


| ![Download manager 1](../docs/images/example/download_1.png) | ![Download manager 2](../docs/images/example/download_2.png) | ![Download manager 3](../docs/images/example/download_3.png) |
| --- | --- | --- |
|     |     |     |


This screen exercises the runtime model delivery flow from [docs/download-manager.md](../docs/download-manager.md). It covers refresh, metadata lookup, download, extraction, pause/resume for both download and extraction phases, cleanup of incomplete state, and deletion of installed models. It is the main screen for testing real-world model lifecycle behavior before opening STT/TTS/VAD feature screens.

## Speech-to-Text (offline)


| ![STT offline 1](../docs/images/example/stt_1.png) | ![STT offline 2](../docs/images/example/stt_2.png) | ![STT offline 3](../docs/images/example/stt_3.png) |
| --- | --- | --- |
|     |     |     |


This screen initializes offline STT engines and runs file-based transcription through pipeline buffers. It can work with bundled assets and downloaded model folders, detects STT model type, and supports offline text buffer inspection (text/tokens/timestamps/durations and metadata fields). It also includes playback and route-selection hooks used during local verification of [docs/stt-offline.md](../docs/stt-offline.md).

## Text-to-Speech (offline)


| ![TTS offline 1](../docs/images/example/tts_1.png) | ![TTS offline 2](../docs/images/example/tts_2.png) | ![TTS offline 3](../docs/images/example/tts_3.png) |
| --- | --- | --- |
|     |     |     |


This screen focuses on offline synthesis with [docs/tts-offline.md](../docs/tts-offline.md) APIs. It supports model detection/initialization, synthesis options, optional voice-cloning inputs for supported model families, playback through PCM, and saving generated audio with [docs/audio-conversion.md](../docs/audio-conversion.md). It also exposes segmented synthesis toggles used for memory-conscious runs.

## Speech-to-Text (streaming)


| ![STT streaming 1](../docs/images/example/stt_streaming_1.png) | ![STT streaming 2](../docs/images/example/stt_streaming_2.png) | ![STT streaming 3](../docs/images/example/stt_streaming_3.png) |
| --- | --- | --- |
|     |     |     |


This screen streams long files through LiveAudioBuffer to LiveTextBuffer with a streaming STT engine, mainly for low-latency transcript updates and avoiding large offline decode peaks. It shows segment count, committed transcript, and partial transcript state while ingesting audio, matching [docs/stt-streaming.md](../docs/stt-streaming.md).

## Text-to-Speech (streaming)


| ![TTS streaming 1](../docs/images/example/tts_streaming_1.png) | ![TTS streaming 2](../docs/images/example/tts_streaming_2.png) | ![TTS streaming 3](../docs/images/example/tts_streaming_3.png) |
| --- | --- | --- |
|     |     |     |


This screen tests live TTS by pushing text chunks into a live text pipeline and synthesizing into a live audio buffer. It is used to validate low time-to-first-audio behavior, flush/cancel lifecycle, and final buffer playback, aligned with the live-overload guidance in [docs/tts-offline.md](../docs/tts-offline.md).

## Offline Pipeline Showcase (File -> STT -> TTS -> playback)


| ![Pipeline offline 1](../docs/images/example/pipeline_offline_1.png) | ![Pipeline offline 2](../docs/images/example/pipeline_offline_2.png) | ![Pipeline offline 3](../docs/images/example/pipeline_offline_3.png) |
| --- | --- | --- |
|     |     |     |


This screen demonstrates an end-to-end offline chain from file input to offline STT, then offline TTS, followed by playback/final output handling. It is the reference for batch-style orchestration and segmented offline processing flows in a single pipeline scenario.

## Live Pipeline Showcase (Mic/File -> STT -> TTS -> playback)


| ![Pipeline streaming 1](../docs/images/example/pipeline_streaming_1.png) | ![Pipeline streaming 2](../docs/images/example/pipeline_streaming_2.png) | ![Pipeline streaming 3](../docs/images/example/pipeline_streaming_3.png) |
| --- | --- | --- |
|     |     |     |


This screen demonstrates an end-to-end live pipeline: source input (mic/file) to streaming STT, then incremental TTS, then PCM playback with runtime metrics and finalize/save output flow. It is the main integration example for live buffer chaining and low-latency pipeline orchestration.

## Alignment (subtitles/timestamps)


| ![Alignment 1](../docs/images/example/alignment_1.png) | ![Alignment 2](../docs/images/example/alignment_2.png) | ![Alignment 3](../docs/images/example/alignment_3.png) |
| --- | --- | --- |
|     |     |     |


This screen generates subtitle/timestamp segments from audio and transcript inputs. It validates alignment modes (`proportional`, `estimated`, and `accurate`) and includes anchor/VAD-assisted workflows where applicable. See [docs/alignment-offline.md](../docs/alignment-offline.md), [docs/segmentation-engine.md](../docs/segmentation-engine.md), and [docs/vad-streaming.md](../docs/vad-streaming.md).

## Speech enhancement (offline)


| ![Enhancement offline 1](../docs/images/example/enhancement_offline_1.png) | ![Enhancement offline 2](../docs/images/example/enhancement_offline_2.png) | ![Enhancement offline 3](../docs/images/example/enhancement_offline_3.png) |
| --- | --- | --- |
|     |     |     |


This screen runs offline enhancement over prepared input buffers, supports segmented mode toggles, and allows saving/playback of enhanced output. It is used for validating GTCRN/DPDFNet model behavior via [docs/enhancement-offline.md](../docs/enhancement-offline.md).

## Speech enhancement (streaming)


| ![Enhancement streaming 1](../docs/images/example/enhancement_streaming_1.png) | ![Enhancement streaming 2](../docs/images/example/enhancement_streaming_2.png) | ![Enhancement streaming 3](../docs/images/example/enhancement_streaming_3.png) |
| --- | --- | --- |
|     |     |     |


This screen streams source audio through live enhancement pipelines, including ingest controls and output finalization. It is mainly used to test long-input handling and live pipeline lifecycle from [docs/enhancement-streaming.md](../docs/enhancement-streaming.md).

## Voice Activity Detection


| ![VAD 1](../docs/images/example/vad_1.png) | ![VAD 2](../docs/images/example/vad_2.png) | ![VAD 3](../docs/images/example/vad_3.png) |
| --- | --- | --- |
|     |     |     |


This screen supports both live and offline VAD flows, including file and microphone input for live mode, plus segment timeline inspection and status polling. It validates segment buffer behavior and VAD summaries against [docs/vad-streaming.md](../docs/vad-streaming.md).

## Punctuation (offline)


| ![Punctuation offline 1](../docs/images/example/punctuation_offline_1.png) | ![Punctuation offline 2](../docs/images/example/punctuation_offline_2.png) | ![Punctuation offline 3](../docs/images/example/punctuation_offline_3.png) |
| --- | --- | --- |
|     |     |     |


This screen tests offline CT-Transformer punctuation with text buffers, model detection, optional segmented processing, and copy/export flows for punctuated output. It maps to [docs/punctuation-offline.md](../docs/punctuation-offline.md).

## Punctuation (streaming)


| ![Punctuation streaming 1](../docs/images/example/punctuation_streaming_1.png) | ![Punctuation streaming 2](../docs/images/example/punctuation_streaming_2.png) | ![Punctuation streaming 3](../docs/images/example/punctuation_streaming_3.png) |
| --- | --- | --- |
|     |     |     |


This screen runs online punctuation over live text buffers. It shows incremental input append, optional segmentation attach mode, pipeline completion, and final live output extraction, aligned with [docs/punctuation-streaming.md](../docs/punctuation-streaming.md).

## File I/O showcase


| ![File I/O 1](../docs/images/example/fileio_1.png) | ![File I/O 2](../docs/images/example/fileio_2.png) | ![File I/O 3](../docs/images/example/fileio_3.png) |
| --- | --- | --- |
|     |     |     |


This screen validates file and conversion workflows, including loading local assets/files and exporting generated or transformed audio outputs. It is the UI reference for [docs/fileio.md](../docs/fileio.md) and [docs/audio-conversion.md](../docs/audio-conversion.md).

**Codec sandbox (`test_codec/`):** bundled samples for probe/decode/encode round-trips. Add files listed in `example/android/app/src/main/assets/test_codec/README.md` (Android) and `example/ios/sherpa_models/test_codec/README.md` (iOS), then rebuild. Android FileSource: `{ kind: 'app', base: 'apkAsset', path: 'test_codec/sample.<ext>' }` (APK `assets/`, not sandbox `files/`).

## Audio visualization showcase


| ![Audio visualization — static bars](../docs/images/example/vis_static.png) | ![Audio visualization — heatmap](../docs/images/example/vis_heatmap.png) | ![Audio visualization — pseudo-3D](../docs/images/example/vis_3d.png) |
| --- | --- | --- |
| Static (`levels`) | Heatmap (`frames`) | Pseudo-3D (`frames`, Skia) |


Open **Audio visualization** from Home. The screen runs one `computeAudioVisualizationProfile` call (timeline enabled), then renders SDK data in four tabs: **Static**, **Animated**, **Heatmap**, and **3D**.

- **Static** — mirrored bar chart from global `levels`.
- **Animated** — same bars driven by timeline frame index (playback scrub).
- **Heatmap** — time × frequency grid from `frames`.
- **3D** — example UI only: isometric bars in Skia from per-frame levels; not a native SDK 3D feature.

Implementation: `example/src/screens/audio-visualization/AudioVisualizationScreen.tsx` and `example/src/components/SpectrumBarsView.tsx`, `SpectrumHeatmapView.tsx`, `Spectrum3DView.tsx`. API reference: [docs/audio-visualization.md](../docs/audio-visualization.md).

## Segmentation showcase


| ![Segmentation audio 1](../docs/images/example/segmentation_audio_1.png) | ![Segmentation audio 2](../docs/images/example/segmentation_audio_2.png) | ![Segmentation audio 3](../docs/images/example/segmentation_audio_3.png) |
| --- | --- | --- |
| ![Segmentation text 1](../docs/images/example/segmentation_text_1.png) | ![Segmentation text 2](../docs/images/example/segmentation_text_2.png) | ![Segmentation text 3](../docs/images/example/segmentation_text_3.png) |


This screen demonstrates segmentation policies for audio and text pipelines to keep processing bounded and memory usage predictable on long inputs. It maps to [docs/segmentation-engine.md](../docs/segmentation-engine.md).

## Settings and provider diagnostics


| ![Settings 1](../docs/images/example/settings_1.png) | ![Settings 2](../docs/images/example/settings_2.png) | ![Settings 3](../docs/images/example/settings_3.png) |
| --- | --- | --- |
|     |     |     |


The Settings screen (gear button on Home) provides runtime diagnostics for acceleration backends and provider availability. It exposes checks for QNN, NNAPI, XNNPACK, Core ML, and available providers, plus app/SDK version display. This is used for environment verification before running model-heavy screens. See [docs/execution-providers.md](../docs/execution-providers.md).

## Speaker diarization (coming soon)


## Source separation (coming soon)