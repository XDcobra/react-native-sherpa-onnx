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

</div>

> **⚠️ SDK 0.3.0 – Breaking changes from 0.2.0**  
> Since the last release I have restructured and improved the SDK significantly: full iOS support, smoother behaviour, fewer failure points, and a much smaller footprint (~95% size reduction). As a result, **logic and the public API have changed**. If you are upgrading from 0.2.x, please follow the [Breaking changes (upgrading to 0.3.0)](docs/migration.md#breaking-changes-upgrading-to-030) section and the updated API documentation 

A React Native TurboModule that provides offline and streaming speech processing capabilities using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The SDK aims to support all functionalities that sherpa-onnx offers, including offline and **online (streaming)** speech-to-text, text-to-speech (batch and streaming), speaker diarization, speech enhancement, source separation, and VAD (Voice Activity Detection).

## Table of contents

- [Feature Support](#feature-support)
- [Platform Support Status](#platform-support-status)
- [Supported Model Types](#supported-model-types)
  - [Speech-to-Text (STT) Models](#speech-to-text-stt-models)
  - [Text-to-Speech (TTS) Models](#text-to-speech-tts-models)
- [Installation](#installation)
  - [Android](#android)
  - [iOS](#ios)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Breaking changes (upgrading to 0.3.0)](#breaking-changes-upgrading-to-030)
  - [Instance-based API (TTS + STT)](#instance-based-api-tts--stt)
  - [Speech-to-Text (STT)](#speech-to-text-stt)
  - [Text-to-Speech (TTS)](#text-to-speech-tts)
- [Example Apps](#example-apps)
  - [Example App (Audio to Text)](#example-app-audio-to-text)
  - [Video to Text Comparison App](#video-to-text-comparison-app)
- [Contributing](#contributing)
- [License](#license)

## Feature Support

| Feature | Status | Notes |
|---------|--------|-------|
| Offline Speech-to-Text | ✅ **Supported** | No internet required; multiple model types (Zipformer, Paraformer, Whisper, etc.). See [Supported Model Types](#supported-model-types) and [STT documentation](./docs/stt.md). |
| Online (streaming) Speech-to-Text | ✅ **Supported** | Real-time recognition from microphone or stream; partial results, endpoint detection. Use streaming-capable models (e.g. transducer, paraformer). See [Streaming STT](./docs/stt_streaming.md). |
| Text-to-Speech | ✅ **Supported** | Multiple model types (VITS, Matcha, Kokoro, etc.). See [Supported Model Types](#supported-model-types) and [TTS documentation](./docs/tts.md). |
| Streaming Text-to-Speech | ✅ **Supported** | Incremental speech generation for low time-to-first-byte and playback while generating. See [Streaming TTS](./docs/tts_streaming.md). |
| Execution providers (CPU, NNAPI, XNNPACK, Core ML, QNN) | ✅ **Supported** | See [Execution provider support](./docs/execution-providers.md). |
| Play Asset Delivery (PAD) | ✅ **Supported** | Android only. See [Model Setup](./docs/MODEL_SETUP.md). |
| Automatic Model type detection | ✅ **Supported** | `detectSttModel()` and `detectTtsModel()` for a path. See [Model Setup: Model type detection](./docs/MODEL_SETUP.md#model-type-detection-without-initialization). |
| Model quantization | ✅ **Supported** | Automatic detection and preference for quantized (int8) models. |
| Flexible model loading | ✅ **Supported** | Asset models, file system models, or auto-detection. |
| TypeScript | ✅ **Supported** | Full type definitions included. |
| Speaker Diarization | ❌ Not yet supported | Scheduled for release 0.4.0 |
| Speech Enhancement | ❌ Not yet supported | Scheduled for release 0.5.0 |
| Source Separation | ❌ Not yet supported | Scheduled for release 0.6.0 |
| VAD (Voice Activity Detection) | ❌ Not yet supported | Scheduled for release 0.7.0 |

## Platform Support Status

| Platform | Status | Notes |
|----------|--------|-------|
| **Android** | ✅ **Production Ready** | CI/CD automated, multiple models supported |
| **iOS** | ✅ **Production Ready** | CI/CD automated, multiple models supported |

## Supported Model Types

### Speech-to-Text (STT) Models

| Model Type               | `modelType` Value | Description                                                                              | Download Links                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Zipformer/Transducer** | `'transducer'`    | Requires `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, and `tokens.txt`                 | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html) |
| **Paraformer**           | `'paraformer'`    | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html) |
| **NeMo CTC**             | `'nemo_ctc'`      | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)   |
| **Whisper**              | `'whisper'`       | Requires `encoder.onnx`, `decoder.onnx`, and `tokens.txt`                                | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)            |
| **WeNet CTC**            | `'wenet_ctc'`     | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)  |
| **SenseVoice**           | `'sense_voice'`   | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)        |
| **FunASR Nano**          | `'funasr_nano'`   | Requires `encoder_adaptor.onnx`, `llm.onnx`, `embedding.onnx`, and `tokenizer` directory | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)        |
| **Tone CTC (t-one)**     | `'tone_ctc'`      | Single `model.onnx` + `tokens.txt`. Folder name usually contains `t-one`, `t_one` or `tone` | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-ctc/index.html) |

For **real-time (streaming) recognition** from a microphone or audio stream, use streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, or `tone_ctc`. See [Streaming (Online) Speech-to-Text](./docs/stt_streaming.md).

### Text-to-Speech (TTS) Models

| Model Type       | `modelType` Value | Description                                                                                          | Download Links                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **VITS**         | `'vits'`          | Fast, high-quality TTS. Includes Piper, Coqui, MeloTTS, MMS variants. Requires `model.onnx`, `tokens.txt` | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Matcha**       | `'matcha'`        | High-quality acoustic model + vocoder. Requires `acoustic_model.onnx`, `vocoder.onnx`, `tokens.txt` | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html) |
| **Kokoro**       | `'kokoro'`        | Multi-speaker, multi-language. Requires `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/` | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **KittenTTS**    | `'kitten'`        | Lightweight, multi-speaker. Requires `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`    | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Zipvoice**     | `'zipvoice'`      | Voice cloning capable. Requires `encoder.onnx`, `decoder.onnx`, `vocoder.onnx`, `tokens.txt`        | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html) |
| **Pocket**       | `'pocket'`        | Flow-matching TTS. Requires `lm_flow.onnx`, `lm_main.onnx`, `encoder.onnx`, `decoder.onnx`, `text_conditioner.onnx`, `vocab.json`, `token_scores.json` | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |

For **streaming TTS** (incremental generation, low latency), use `createStreamingTTS()` with supported model types. See [Streaming Text-to-Speech](./docs/tts_streaming.md).

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

No additional setup required. The library automatically handles native dependencies via Gradle. For execution provider support (CPU, NNAPI, XNNPACK, QNN) and optional QNN setup, see [Execution provider support](./docs/execution-providers.md). For building Android native libs yourself, see [sherpa-onnx-prebuilt](third_party/sherpa-onnx-prebuilt/README.md).


### iOS

The sherpa-onnx **XCFramework is not shipped in the repo or npm** (size ~80MB). It is **downloaded automatically** when you run `pod install`; no manual steps are required. The version used is pinned in `third_party/sherpa-onnx-prebuilt/IOS_RELEASE_TAG` and the archive is fetched from [GitHub Releases](https://github.com/XDcobra/react-native-sherpa-onnx/releases?q=framework).

#### Setup

```sh
cd your-app/ios
bundle install
bundle exec pod install
```

The podspec runs `scripts/setup-ios-framework.sh`, which downloads the XCFramework (and, if needed, libarchive sources) so the Pod builds correctly. Libarchive is compiled from source as part of the Pod; its version is pinned in `third_party/libarchive_prebuilt/IOS_RELEASE_TAG`.

#### For Advanced Users: Building the Framework Locally
#### Advanced: Building the iOS framework yourself

If you need a custom sherpa-onnx build (e.g. different version or patches), you can build the XCFramework and place it in `ios/Frameworks/` before running `pod install`. The repo does not include an iOS build script; use one of:

- **This repo's CI:** The [build-sherpa-onnx-ios-framework](.github/workflows/build-sherpa-onnx-ios-framework.yml) workflow produces the XCFramework and publishes it as a GitHub Release. You can run equivalent steps locally or inspect the workflow for the exact build and merge steps (including `libsherpa-onnx-cxx-api.a` and libarchive).
- **Version and layout:** Pinned version and release layout are documented in [third_party/sherpa-onnx-prebuilt](third_party/sherpa-onnx-prebuilt/README.md) (Android focus; for iOS, see `IOS_RELEASE_TAG` and the [iOS framework workflow](.github/workflows/build-sherpa-onnx-ios-framework.yml)).

The XCFramework must include the C++ API (`libsherpa-onnx-cxx-api.a` merged or linked) so that the iOS Obj-C++ code can use `sherpa_onnx::cxx::*`. The workflow's build script ensures this; if you use upstream `build-ios.sh` from sherpa-onnx, you may need to merge the C++ API into the static library yourself.

## Documentation

- [Speech-to-Text (STT)](./docs/stt.md) – Offline transcription (file or samples)
- [Streaming (Online) Speech-to-Text](./docs/stt_streaming.md) – Real-time recognition, partial results, endpoint detection
- [Text-to-Speech (TTS)](./docs/tts.md) – Offline and streaming generation
- [Streaming Text-to-Speech](./docs/tts_streaming.md) – Incremental TTS (createStreamingTTS)
- [Execution provider support (QNN, NNAPI, XNNPACK, Core ML)](./docs/execution-providers.md) – Checking and using acceleration backends
- [Voice Activity Detection (VAD)](./docs/vad.md)
- [Speaker Diarization](./docs/diarization.md)
- [Speech Enhancement](./docs/enhancement.md)
- [Source Separation](./docs/separation.md)
- [Model Setup](./docs/MODEL_SETUP.md) – Bundled assets, Play Asset Delivery (PAD), model discovery APIs, and troubleshooting
- [Model Download Manager](./docs/download-manager.md)
- [Disable FFMPEG](./docs/disable-ffmpeg.md)
- [Disable LIBARCHIVE](./docs/disable-libarchive.md)

Note: For when to use `listAssetModels()` vs `listModelsAtPath()` and how to combine bundled and PAD/file-based models, see [Model Setup](./docs/MODEL_SETUP.md).

## Requirements

- React Native >= 0.70
- Android API 24+ (Android 7.0+)
- iOS 13.0+

## Example Apps

We provide example applications to help you get started with `react-native-sherpa-onnx`:

### Example App (Audio to Text)

The example app included in this repository demonstrates audio-to-text transcription, text-to-speech, and streaming features. It includes:

- Multiple model type support (Zipformer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, FunASR Nano)
- Model selection and configuration
- **Offline** audio file transcription
- **Online (streaming) STT** – live transcription from the microphone with partial results
- **Streaming TTS** – incremental speech generation and playback
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

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)

