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


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen exercises the runtime model delivery flow from [docs/download-manager.md](../docs/download-manager.md). It covers refresh, metadata lookup, download, extraction, pause/resume for both download and extraction phases, cleanup of incomplete state, and deletion of installed models. It is the main screen for testing real-world model lifecycle behavior before opening STT/TTS/VAD feature screens.

## Speech-to-Text (offline)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen initializes offline STT engines and runs file-based transcription through pipeline buffers. It can work with bundled assets and downloaded model folders, detects STT model type, and supports offline text buffer inspection (text/tokens/timestamps/durations and metadata fields). It also includes playback and route-selection hooks used during local verification of [docs/stt-offline.md](../docs/stt-offline.md).

## Text-to-Speech (offline)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen focuses on offline synthesis with [docs/tts-offline.md](../docs/tts-offline.md) APIs. It supports model detection/initialization, synthesis options, optional voice-cloning inputs for supported model families, playback through PCM, and saving generated audio with [docs/audio-conversion.md](../docs/audio-conversion.md). It also exposes segmented synthesis toggles used for memory-conscious runs.

## Speech-to-Text (streaming)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen streams long files through LiveAudioBuffer to LiveTextBuffer with a streaming STT engine, mainly for low-latency transcript updates and avoiding large offline decode peaks. It shows segment count, committed transcript, and partial transcript state while ingesting audio, matching [docs/stt-streaming.md](../docs/stt-streaming.md).

## Text-to-Speech (streaming)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen tests incremental TTS by pushing text chunks into a live text pipeline and synthesizing into a live audio buffer. It is used to validate low time-to-first-audio behavior, flush/cancel lifecycle, and final buffer playback, aligned with [docs/tts-streaming.md](../docs/tts-streaming.md).

## Pipeline showcase (STT -> TTS -> playback)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen demonstrates an end-to-end live pipeline: source input (mic/file) to streaming STT, then incremental TTS, then PCM playback, with metrics and finalize/save output flow. It is the most complete pipeline integration example for live buffer chaining and runtime orchestration.

## Alignment (subtitles/timestamps)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen generates subtitle/timestamp segments from audio and transcript inputs. It validates alignment modes (`proportional`, `estimated`, and `accurate`) and includes anchor/VAD-assisted workflows where applicable. See [docs/alignment-offline.md](../docs/alignment-offline.md), [docs/segmentation-engine.md](../docs/segmentation-engine.md), and [docs/vad-streaming.md](../docs/vad-streaming.md).

## Speech enhancement (offline)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen runs offline enhancement over prepared input buffers, supports segmented mode toggles, and allows saving/playback of enhanced output. It is used for validating GTCRN/DPDFNet model behavior via [docs/enhancement-offline.md](../docs/enhancement-offline.md).

## Speech enhancement (streaming)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen streams source audio through live enhancement pipelines, including ingest controls and output finalization. It is mainly used to test long-input handling and live pipeline lifecycle from [docs/enhancement-streaming.md](../docs/enhancement-streaming.md).

## Voice Activity Detection


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen supports both live and offline VAD flows, including file and microphone input for live mode, plus segment timeline inspection and status polling. It validates segment buffer behavior and VAD summaries against [docs/vad-streaming.md](../docs/vad-streaming.md).

## Punctuation (offline)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen tests offline CT-Transformer punctuation with text buffers, model detection, optional segmented processing, and copy/export flows for punctuated output. It maps to [docs/punctuation-offline.md](../docs/punctuation-offline.md).

## Punctuation (streaming)


|     |     |     |
| --- | --- | --- |
|     |     |     |


This screen runs online punctuation over live text buffers. It shows incremental input append, optional segmentation attach mode, pipeline completion, and final live output extraction, aligned with [docs/punctuation-streaming.md](../docs/punctuation-streaming.md).

## Speaker diarization (coming soon)


|     |     |     |
| --- | --- | --- |
|     |     |     |


The app includes a dedicated diarization placeholder screen that is marked as Coming Soon. It is prepared as a navigation entry and UI shell for future speaker-timeline workflows. Current SDK status is documented in [docs/diarization.md](../docs/diarization.md).

## Source separation (coming soon)


|     |     |     |
| --- | --- | --- |
|     |     |     |


The app includes a dedicated source-separation placeholder screen marked as Coming Soon. It is kept in the home feature list for planned integration and future testing flow. Current SDK status is documented in [docs/separation.md](../docs/separation.md).

## Settings and provider diagnostics


|     |     |     |
| --- | --- | --- |
|     |     |     |


The Settings screen (gear button on Home) provides runtime diagnostics for acceleration backends and provider availability. It exposes checks for QNN, NNAPI, XNNPACK, Core ML, and available providers, plus app/SDK version display. This is used for environment verification before running model-heavy screens. See [docs/execution-providers.md](../docs/execution-providers.md).