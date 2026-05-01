# react-native-sherpa-onnx

React Native SDK for sherpa-onnx – offline and streaming speech processing

<div align="center">
  <img src="./docs/images/banner.png" alt="Banner" width="560" />
</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm downloads](https://img.shields.io/npm/dm/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm license](https://img.shields.io/npm/l/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![Android](https://img.shields.io/badge/Android-Supported-green)](https://www.android.com/)
[![iOS](https://img.shields.io/badge/iOS-Supported-blue)](https://www.apple.com/ios/)

<a href="https://www.buymeacoffee.com/xdcobra" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="150" /></a>

</div>

> **⚠️ SDK 1.0.0 – Breaking changes from 0.4.0**  
> This project started as a side hobby project. After seeing the value it provides and that many people already use it, I decided to rebuild it with a more professional foundation. Because of that, I had to redesign the SDK structure and internal architecture from the ground up, which caused a large breaking change. The result is a more stable SDK with significantly better performance and speed, plus a cleaner, more consistent, and easier public API. For an overview of all breaking changes and the migration path, read [docs/migration.md](docs/migration.md).

A React Native TurboModule that provides offline and streaming speech processing capabilities using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The SDK aims to support all functionalities that sherpa-onnx offers, including offline and **online (streaming)** speech-to-text, text-to-speech (batch and streaming), speaker diarization, speech enhancement, source separation, and VAD (Voice Activity Detection).

## Installation

```sh
npm install react-native-sherpa-onnx
```

If your project uses Yarn (v3+) or Plug'n'Play, configure Yarn to use the Node Modules linker to avoid postinstall issues:

```yaml
# .yarnrc.yml
nodeLinker: node-modules
```

Alternatively, set the environment variable during install:

```sh
YARN_NODE_LINKER=node-modules yarn install
```

### Android

No additional setup required.

Optional: if you want Qualcomm acceleration, see QNN setup in [Execution provider support](./docs/execution-providers.md).

### iOS

```sh
cd your-app/ios
bundle install
bundle exec pod install
```

#### Model download (optional)

If you use the [download manager](docs/download-manager.md) to fetch models at runtime, add the following to your **AppDelegate** so background downloads can finish when the app is in the background or after it was terminated. Without it, downloads only work reliably while the app is in the foreground.

- **Swift (RN 0.77+):** In your bridging header add `#import <RNBackgroundDownloader.h>`. In `AppDelegate.swift`, implement:
  ```swift
  func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    RNBackgroundDownloader.setCompletionHandlerWithIdentifier(identifier, completionHandler: completionHandler)
  }
  ```
- **Objective-C:** In `AppDelegate.m` add `#import <RNBackgroundDownloader.h>` and the `application:handleEventsForBackgroundURLSession:completionHandler:` implementation that calls `[RNBackgroundDownloader setCompletionHandlerWithIdentifier:identifier completionHandler:completionHandler]`.

Full step-by-step: [Download manager – Setup (iOS & Android)](docs/download-manager.md#setup-ios--android). Expo users can use the library’s config plugin to apply this automatically.

**Android:** Foreground service permissions (Play Console), visible download notifications, and **`POST_NOTIFICATIONS` (API 33+)** are covered in [Download manager – Android: foreground service & notifications](docs/download-manager.md#android-foreground-service--notifications).

## Table of contents

- [Bundled sherpa-onnx version](#bundled-sherpa-onnx-version)
- [Installation](#installation)
  - [Android](#android)
  - [iOS](#ios)
- [SDK pipeline logic](#sdk-pipeline-logic)
  - [Offline pipeline (batch)](#offline-pipeline-batch)
  - [Streaming pipeline (live)](#streaming-pipeline-live)
  - [Decision guide: offline vs streaming](#decision-guide-offline-vs-streaming)
- [Feature Support](#feature-support)
- [Platform Support Status](#platform-support-status)
- [Known issues](#known-issues)
- [Supported Model Types](#supported-model-types)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Breaking changes (upgrading to 1.0.0)](docs/migration.md)
  - [Instance-based API (TTS + STT)](#instance-based-api-tts--stt)
  - [Speech-to-Text (STT)](#speech-to-text-stt)
  - [Text-to-Speech (TTS)](#text-to-speech-tts)
- [Example Apps](#example-apps)
  - [Example App (Audio to Text)](#example-app-audio-to-text)
  - [Video to Text Comparison App](#video-to-text-comparison-app)
- [Contributing](#contributing)
- [License](#license)

## Platform Support Status

| Platform | Status | Notes |
|----------|--------|-------|
| **Android** | ✅ **Production Ready** | CI/CD automated, multiple models supported |
| **iOS** | ✅ **Production Ready** | CI/CD automated, multiple models supported |

## Feature Support

| Feature | Status | Docs | Notes |
|---------|--------|------|-------|
| Offline Speech-to-Text | ✅ **Supported** | [STT](./docs/stt-offline.md) | No internet required; multiple model types (Zipformer, Paraformer, Whisper, Qwen3 ASR, Cohere Transcribe, etc.). See [Supported Model Types](#supported-model-types). |
| Online (streaming) Speech-to-Text | ✅ **Supported** | [Streaming STT](./docs/stt-streaming.md) | Real-time recognition from microphone or stream; partial results, endpoint detection. Use streaming-capable models (e.g. transducer, paraformer). |
| Live capture API | ✅ **Supported** | [Pipeline buffers (`audiobuffer`)](./docs/audiobuffer.md) ([live](./docs/audiobuffer-streaming.md)) · [Pipeline Audio Session](./docs/audio-session.md) | Native microphone → live audio buffer; optional JS chunks for streaming STT. Global route/session policy for mic + PCM to set input/output device manually. |
| Text-to-Speech | ✅ **Supported** | [TTS](./docs/tts.md) | Multiple model types (VITS, Matcha, Kokoro, etc.). See [Supported Model Types](#supported-model-types). |
| Streaming Text-to-Speech | ✅ **Supported** | [Streaming TTS](./docs/tts-streaming.md) | Incremental speech generation for low time-to-first-byte and playback while generating. |
| TTS Alignment / Timestamps | ✅ **Supported** | [Alignment](./docs/alignment.md) | **`proportional`**, **`estimated`** (chunk timeline), and **`accurate`** (wav2vec2 CTC). Canonical API: **`createAlignment`** + **`engine.alignTextToAudio`**. |
| Speech Enhancement | ✅ **Supported** | [Overview](./docs/speech-enhancement.md) — [Offline](./docs/enhancement-offline.md), [Streaming](./docs/enhancement-streaming.md) | Batch offline buffers; streaming via native live-buffer pipeline only (`createStreamingEnhancement` → `enhance`). |
| Build-in Audio Player | ✅ **Supported** | [PCM Player](./docs/pcm-player.md) | Play any generated speech (offline/streaming) directly by using the built in pcm player. Easy use and higher performance. |
| Execution providers (CPU, NNAPI, XNNPACK, Core ML, QNN) | ✅ **Supported** | [Execution providers](./docs/execution-providers.md) | CPU default; optional accelerators per platform. |
| Flexible model loading | ✅ **Supported** | [Model setup](./docs/model-setup.md) | Asset models, file system models, or auto-detection. |
| Play Asset Delivery (PAD) | ✅ **Supported** | [Model setup](./docs/model-setup.md) | Android only. Archives: [Extraction API](./docs/extraction.md). |
| Automatic Model type detection | ✅ **Supported** | [Model detection](./docs/model-setup.md#model-detection) | `detectSttModel()` and `detectTtsModel()` for a path. |
| Model quantization | ✅ **Supported** | [Model setup](./docs/model-setup.md) | Automatic detection and preference for quantized (int8) models. |
| TypeScript | ✅ **Supported** | — | Full type definitions included. |
| Punctuation | ✅ **Supported** | [Punctuation](./docs/punctuation.md) | Offline and streaming punctuation models. |
| VAD (Voice Activity Detection) | ✅ **Supported** | [VAD (streaming)](./docs/vad-streaming.md) | Pipeline-first streaming API (`createStreamingVAD`); import `react-native-sherpa-onnx/vad`. Models: e.g. Silero VAD, Ten VAD — see doc. |
| Speaker Diarization | ❌ Not yet supported | [Diarization](./docs/diarization.md) | Scheduled for release 1.1.0 |
| Source Separation | ❌ Not yet supported | [Separation](./docs/separation.md) | Scheduled for release 1.2.0 |

## SDK pipeline logic

The SDK uses one consistent pipeline idea with two execution styles:

- **Offline (batch):** fully populated input buffers are processed to completion before downstream steps read results.
- **Streaming (live):** workers run continuously and exchange data through live buffers while upstream and downstream stages execute in parallel.

### Offline pipeline (batch)

Best when you already have complete input (file or full in-memory data) and want deterministic, one-shot output.

```mermaid
flowchart LR
  A[OfflineAudioBuffer input] --> B[Offline STT/TTS/Enhancement engine]
  B --> C[OfflineTextBuffer or OfflineAudioBuffer output]
  C --> D[Read slices / save file / post-process]
```

**Characteristics**
- Simple lifecycle (`create` -> `run` -> `read` -> `release`)
- Predictable completion semantics (`Promise<void>` when job is done)
- Great for file transcription, subtitle generation, export jobs

### Streaming pipeline (live)

Best when data arrives over time (mic/live feed) or when low-latency chaining is needed.

```mermaid
flowchart LR
  A[Live source<br/>mic or append] --> B[Streaming STT]
  B --> C[LiveTextBuffer]
  C --> D[Streaming TTS]
  D --> E[LiveAudioBuffer]
  E --> F[Downstream consumer<br/>player/enhancement/STT]
```

In streaming mode, multiple pipeline parts can run **at the same time**:
- upstream appends to live buffer
- current worker drains and processes
- downstream worker/consumer reads new units immediately

**Advantages**
- Lower end-to-end latency (first results before full input is finished)
- Native-native chaining with less JS bridge traffic for steady-state data flow
- Better fit for real-time UX (partial STT, incremental TTS, live enhancement)

**Trade-offs**
- More lifecycle orchestration (`start/flush/reset/stop`, finalization order)
- Buffer/sample-rate compatibility must be managed carefully across stages
- Debugging timing/state issues can be more complex than batch mode

### Decision guide: offline vs streaming

Prefer **offline** when:
- input is already complete (audio file, full text)
- you need simple control flow and deterministic completion
- latency is less important than straightforward processing

Prefer **streaming** when:
- input arrives continuously (microphone/live feed)
- you need low time-to-first-result / low perceived latency
- you want concurrent stage execution (e.g. STT -> text buffer -> TTS -> audio buffer)

## Supported Model Types

<details>
<summary>Speech-to-Text (STT) models</summary>

| Model Type               | `modelType` Value | Description                                                                              | Download Links                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Auto Detect**          | `'auto'`          | Automatically detects model layout/type from files in the model folder and picks the best supported STT type. | n/a |
| **Zipformer/Transducer** | `'transducer'`    | Encoder–decoder–joiner (e.g. icefall). Good balance of speed and accuracy. Folder name should contain **zipformer** or **transducer** for auto-detection. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html) |
| **LSTM Transducer**      | `'transducer'`    | Same layout as Zipformer (encoder–decoder–joiner). LSTM-based streaming ASR; detected as transducer. Folder name may contain **lstm**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/lstm-transducer-models.html) |
| **Paraformer**           | `'paraformer'`    | Single-model non-autoregressive ASR; fast and accurate. Detected by `model.onnx`; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html) |
| **NeMo CTC**             | `'nemo_ctc'`      | NeMo CTC; good for English and streaming. Folder name should contain **nemo** or **parakeet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)   |
| **Whisper**              | `'whisper'`       | Multilingual, encoder–decoder; strong zero-shot. Detected by encoder+decoder (no joiner); folder token optional. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)            |
| **WeNet CTC**            | `'wenet_ctc'`     | CTC from WeNet; compact. Folder name should contain **wenet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)  |
| **SenseVoice**           | `'sense_voice'`   | Multilingual with emotion/punctuation. Folder name should contain **sense** or **sensevoice**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)        |
| **FunASR Nano**          | `'funasr_nano'`   | Lightweight LLM-based ASR. Folder name should contain **funasr** or **funasr-nano**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)        |
| **Qwen3 ASR**            | `'qwen3_asr'`     | Encoder–decoder ASR (Qwen3-ASR ONNX: conv frontend, encoder, decoder, tokenizer). Folder name should contain **qwen3**. Optional `modelOptions.qwen3Asr` (e.g. comma-separated hotwords). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| **Cohere Transcribe**    | `'cohere_transcribe'` | Cohere Transcribe ONNX (encoder, decoder, `tokens.txt`). Folder name should contain **cohere**. Optional `modelOptions.cohereTranscribe` (language, punctuation, ITN). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| **Moonshine (v1)**        | `'moonshine'`     | Four-part streaming-capable ASR (preprocess, encode, uncached/cached decode). Folder name should contain **moonshine**. | [Download](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html) |
| **Moonshine (v2)**        | `'moonshine_v2'`   | Two-part Moonshine (encoder + merged decoder); `.onnx` or `.ort`. Folder name should contain **moonshine** (v2 preferred if both layouts present). | [Download](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html) |
| **Fire Red ASR**         | `'fire_red_asr'`  | Fire Red encoder–decoder ASR. Folder name should contain **fire_red** or **fire-red**. | [Download](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html) |
| **Dolphin**              | `'dolphin'`       | Single-model CTC. Folder name should contain **dolphin**. | [Download](https://k2-fsa.github.io/sherpa/onnx/Dolphin/index.html) |
| **Canary**               | `'canary'`        | NeMo Canary multilingual. Folder name should contain **canary**. | [Download](https://k2-fsa.github.io/sherpa/onnx/nemo/canary.html) |
| **Omnilingual**          | `'omnilingual'`   | Omnilingual CTC. Folder name should contain **omnilingual**. | [Download](https://k2-fsa.github.io/sherpa/onnx/omnilingual-asr/index.html) |
| **MedASR**               | `'medasr'`        | Medical ASR CTC. Folder name should contain **medasr**. | [Download](https://github.com/k2-fsa/sherpa-onnx) |
| **Telespeech CTC**       | `'telespeech_ctc'`| Telespeech CTC. Folder name should contain **telespeech**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/telespeech/index.html) |
| **Tone CTC (t-one)**     | `'tone_ctc'`      | Lightweight streaming CTC (e.g. t-one). Folder name should contain **t-one**, **t_one**, or **tone** (as word). | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-ctc/index.html) |

For **real-time (streaming) recognition** from a microphone or audio stream, use streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, or `tone_ctc`. See [Streaming (Online) Speech-to-Text](./docs/stt-streaming.md).

</details>

<details>
<summary>Text-to-Speech (TTS) models</summary>

| Model Type       | `modelType` Value | Description                                                                                          | Download Links                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Auto Detect**   | `'auto'`              | Automatically detects the TTS model layout from files in the model folder and selects the matching supported type. | n/a |
| **VITS**         | `'vits'`          | Fast, high-quality TTS (Piper, Coqui, MeloTTS, MMS). Folder name should contain **vits** if used with other voice models. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Matcha**       | `'matcha'`        | High-quality acoustic model + vocoder. Detected by acoustic_model + vocoder; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html) |
| **Kokoro**       | `'kokoro'`        | Multi-speaker, multi-language. Folder name should contain **kokoro** (not kitten) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **KittenTTS**    | `'kitten'`        | Lightweight, multi-speaker. Folder name should contain **kitten** (not kokoro) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Zipvoice**     | `'zipvoice'`      | Standard TTS with **`sid`**. **Voice cloning** (reference audio + `referenceText`): batch via **`generateSpeech`** only—streaming TTS does not support reference audio for Zipvoice. Default **`numSteps`** when omitted is **5** on **Android and iOS** (matches sherpa-onnx `GenerationConfig` / Kotlin helper). Cloning is **supported on Android & iOS**. Encoder + decoder + vocoder. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html) |
| **Pocket**       | `'pocket'`        | Flow-matching TTS. **Voice cloning** on **Android:** batch and streaming TTS. **iOS:** cloning is experimental. Detected by lm_flow, lm_main, text_conditioner, vocab/token_scores. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |
| **Supertonic**    | `'supertonic'`        | Lightning-fast, on-device text-to-speech system designed for extreme performance with minimal computational overhead. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |

For **streaming TTS** (incremental generation, low latency), use `createStreamingTTS()` with supported model types. See [Streaming Text-to-Speech](./docs/tts-streaming.md).

</details>

<details>
<summary>Speech Enhancement models</summary>

Speech enhancement improves noisy or degraded speech using ONNX models from the sherpa-onnx **speech-enhancement-models** release. Detection looks for **`.onnx`** filenames containing **`gtcrn`** or **`dpdfnet`** (case-insensitive). With **`'auto'`**, **GTCRN** is preferred when both are present in the same folder.

| Model Type   | `modelType` Value | Description                                                                 | Download Links                                                                 |
| ------------ | ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Auto Detect** | `'auto'`       | Picks **GTCRN** if a matching `.onnx` exists, otherwise **DPDFNet** if found. | n/a                                                                              |
| **GTCRN**    | `'gtcrn'`         | Lightweight speech enhancement (e.g. `gtcrn_simple.onnx`).                  | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models) |
| **DPDFNet**  | `'dpdfnet'`       | Deep speech enhancement variants (e.g. `dpdfnet2.onnx`, `dpdfnet4.onnx`, `dpdfnet8.onnx`, `dpdfnet_baseline.onnx`, `dpdfnet2_48khz_hr.onnx`). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models) |

APIs and initialization: [Speech enhancement overview](./docs/speech-enhancement.md), [offline batch](./docs/enhancement-offline.md), [streaming (live buffers)](./docs/enhancement-streaming.md).

</details>

<details>
<summary>Alignment models</summary>

Alignment uses timing modes with different model requirements:

| Mode | Needs model download? | Model | Download |
| --- | --- | --- | --- |
| `proportional` | No | n/a | n/a |
| `estimated` | No | n/a | n/a |
| `accurate` | Yes | wav2vec2 forced-alignment ONNX | [Download](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models) |

For accurate alignment model setup and detection, see [Alignment / subtitles](./docs/alignment.md) and [Model setup](./docs/model-setup.md).

</details>

## Documentation

- [Known issues](./docs/KNOWN_ISSUES.md) – SDK-facing notes (e.g. Pocket TTS cloning / cross-platform behavior)
- [Speech-to-Text (STT)](./docs/stt-offline.md) – Offline transcription (file or samples)
- [Streaming (Online) Speech-to-Text](./docs/stt-streaming.md) – Real-time recognition, partial results, endpoint detection
- [Pipeline audio buffers (`audiobuffer`)](./docs/audiobuffer.md) – Overview; [offline](./docs/audiobuffer-offline.md), [live / streaming](./docs/audiobuffer-streaming.md)
- [Pipeline Audio Session](./docs/audio-session.md) – Global audio session policy and route preference for mic + PCM
- [PCM Player](./docs/pcm-player.md) – Play audio from pipeline buffers
- [Text-to-Speech (TTS)](./docs/tts.md) – Offline and streaming generation
- [Alignment / subtitles](./docs/alignment.md) – `createAlignment`, `proportional` / `estimated` / `accurate`, alignment model download, `generateSpeechWithTimestamps()`
- [Streaming Text-to-Speech](./docs/tts-streaming.md) – Incremental TTS (createStreamingTTS)
- [Execution provider support (QNN, NNAPI, XNNPACK, Core ML)](./docs/execution-providers.md) – Checking and using acceleration backends
- [Voice Activity Detection (VAD)](./docs/vad-streaming.md)
- [Speaker Diarization](./docs/diarization.md)
- [Speech enhancement](./docs/speech-enhancement.md) — [Offline](./docs/enhancement-offline.md) · [Streaming](./docs/enhancement-streaming.md)
- [Source Separation](./docs/separation.md)
- [Model Setup](./docs/model-setup.md) – Bundled assets, Play Asset Delivery (PAD), model discovery APIs, and troubleshooting
- [Model Download Manager](./docs/download-manager.md)
- [Extraction API](./docs/extraction.md)
- [Disable FFMPEG](./docs/disable-ffmpeg.md)
- [Disable LIBARCHIVE](./docs/disable-libarchive.md)

Note: For when to use `listAssetModels()` vs `listModelsAtPath()` and how to combine bundled and PAD/file-based models, see [Model Setup](./docs/model-setup.md).

## Requirements

- React Native >= 0.70
- Android API 24+ (Android 7.0+)
- iOS 13.0+

## Bundled sherpa-onnx version

| Platform | Version |
|----------|---------|
| Android | 1.12.35 |
| iOS | 1.12.35 |

## Known issues

- **[Pocket TTS (voice cloning)](docs/KNOWN_ISSUES.md)** — voice cloning: **Android** supported; **iOS** experimental. Heuristic EOS and **iOS vs Android drift** (length/quality); not a React Native–only issue. Full notes: [investigation doc](docs/github-issue-pocket-tts-eos-frame-zero.md).

## Example Apps

We provide example applications to help you get started with `react-native-sherpa-onnx`:

### Example App (Audio to Text)

The example app included in this repository demonstrates audio-to-text transcription, text-to-speech, and streaming features. It includes:

- Multiple model type support (Zipformer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, FunASR Nano, Qwen3 ASR, Cohere Transcribe, Moonshine, and more)
- Model selection and configuration
- **Offline** audio file transcription
- **Online (streaming) STT** – live transcription from the microphone with partial results
- **Streaming TTS** – incremental speech generation and playback
- **Generate timestamp** – subtitle/timestamp generation from audio (`proportional` / `accurate` with optional alignment model download)
- Test audio files for different languages

**Getting started:**

```sh
cd example
yarn install
yarn android  # or yarn ios
```

<div align="center">
<table>
<tr>
<td><img src="./docs/images/example_home_screen.png" alt="Model selection home screen" width="240" /></td>
<td><img src="./docs/images/example_stt_1.png" alt="Transcribe english audio" width="240" /></td>
<td><img src="./docs/images/example_stt_2.png" alt="Transcribe cantonese audio" width="240" /></td>
</tr>
<tr>
<td><img src="./docs/images/example_streaming.png" alt="Text to speech generation" width="240" /></td>
<td><img src="./docs/images/example_tts.png" alt="Text to speech generation" width="240" /></td>
<td><img src="./docs/images/example_provider.png" alt="Text to speech generation" width="240" /></td>
</tr>
</table>
</div>

### Video to Text Comparison App

A comprehensive comparison app that demonstrates video-to-text transcription using `react-native-sherpa-onnx` alongside other speech-to-text solutions:

**Repository:** [mobile-videototext-comparison](https://github.com/XDcobra/mobile-videototext-comparison)

**Features:**

- Video to audio conversion (using native APIs)
- Audio to text transcription
- Video to text (video --> WAV --> text)
- Comparison between different STT providers
- Performance benchmarking

This app showcases how to integrate `react-native-sherpa-onnx` into a real-world application that processes video files and converts them to text.

<div align="center">
  <img src="./docs/images/vtt_model_overview.png" alt="Video-to-Text Model Overview" width="30%" />
  <img src="./docs/images/vtt_result_file_picker.png" alt="Video-to-Text file picker" width="30%" />
  <img src="./docs/images/vtt_result_test_audio.png" alt="Video-to-Text test audio" width="30%" />
</div>

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

## Third-Party Libraries

This SDK includes the following open source components:

- [sherpa-onnx (Apache License 2.0)](/THIRD_PARTY_LICENSES/sherpa-onnx.txt): https://github.com/k2-fsa/sherpa-onnx

- [ONNX Runtime (MIT License)](/THIRD_PARTY_LICENSES/onnxruntime.txt): https://github.com/microsoft/onnxruntime

- [FFmpeg (LGPL v2.1)](/THIRD_PARTY_LICENSES/ffmpeg.txt): https://ffmpeg.org

- [Shine MP3 Encoder (LGPL)](/THIRD_PARTY_LICENSES/shine.txt): https://github.com/toots/shine

- [Opus Codec (BSD License)](/THIRD_PARTY_LICENSES/opus.txt): https://opus-codec.org

- [Zstandard (zstd) (BSD License)](/THIRD_PARTY_LICENSES/zstd.txt): https://github.com/facebook/zstd

- [libarchive (BSD License)](/THIRD_PARTY_LICENSES/libarchive.txt): https://github.com/libarchive/libarchive

Full license texts are available in the [THIRD_PARTY_LICENSES](/THIRD_PARTY_LICENSES/) directory.

### LGPL Notice

This SDK includes LGPL-licensed components such as FFmpeg and Shine.  
Applications using this SDK must ensure compliance with LGPL requirements when distributing binaries.

FFmpeg source code can be obtained at: https://ffmpeg.org

### Qualcomm QNN Support

This SDK supports optional integration with Qualcomm AI Runtime (QNN).

QNN is proprietary software provided by Qualcomm and is not included in this SDK.  
To use QNN acceleration, users must obtain and include the required QNN libraries separately and comply with Qualcomm's license terms:

https://softwarecenter.qualcomm.com/

### Responsibility

By using this SDK, you are responsible for complying with all third-party licenses included in this project.

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)

