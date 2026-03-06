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

> **⚠️ SDK 0.3.0 – Breaking changes from 0.2.0**  
> Since the last release I have restructured and improved the SDK significantly: full iOS support, smoother behaviour, fewer failure points, and a much smaller footprint (~95% size reduction). As a result, **logic and the public API have changed**. If you are upgrading from 0.2.x, please follow the [Breaking changes (upgrading to 0.3.0)](docs/migration.md#breaking-changes-upgrading-to-030) section and the updated API documentation 

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

#### Building the iOS framework

To build the sherpa-onnx iOS XCFramework yourself (e.g. custom version or patches), see [third_party/sherpa-onnx-prebuilt/README.md](third_party/sherpa-onnx-prebuilt/README.md) and the [build-sherpa-onnx-ios-framework](.github/workflows/build-sherpa-onnx-ios-framework.yml) workflow.

## Table of contents

- [Installation](#installation)
  - [Android](#android)
  - [iOS](#ios)
- [Feature Support](#feature-support)
- [Platform Support Status](#platform-support-status)
- [Supported Model Types](#supported-model-types)
  - [Speech-to-Text (STT) Models](#speech-to-text-stt-models)
  - [Text-to-Speech (TTS) Models](#text-to-speech-tts-models)
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
| Online (streaming) Speech-to-Text | ✅ **Supported** | Real-time recognition from microphone or stream; partial results, endpoint detection. Use streaming-capable models (e.g. transducer, paraformer). See [Streaming STT](./docs/stt-streaming.md). |
| Live capture API | ✅ **Supported** | Native microphone capture with resampling for live transcription (use with streaming STT). See [PCM Live Stream](./docs/pcm-live-stream.md). |
| Text-to-Speech | ✅ **Supported** | Multiple model types (VITS, Matcha, Kokoro, etc.). See [Supported Model Types](#supported-model-types) and [TTS documentation](./docs/tts.md). |
| Streaming Text-to-Speech | ✅ **Supported** | Incremental speech generation for low time-to-first-byte and playback while generating. See [Streaming TTS](./docs/tts-streaming.md). |
| Execution providers (CPU, NNAPI, XNNPACK, Core ML, QNN) | ✅ **Supported** | See [Execution provider support](./docs/execution-providers.md). |
| Play Asset Delivery (PAD) | ✅ **Supported** | Android only. See [Model Setup](./docs/model-setup.md). |
| Automatic Model type detection | ✅ **Supported** | `detectSttModel()` and `detectTtsModel()` for a path. See [Model Setup: Model type detection](./docs/model-setup.md#model-detection). |
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
| **Zipformer/Transducer** | `'transducer'`    | Encoder–decoder–joiner (e.g. icefall). Good balance of speed and accuracy. Folder name should contain **zipformer** or **transducer** for auto-detection. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html) |
| **LSTM Transducer**      | `'transducer'`    | Same layout as Zipformer (encoder–decoder–joiner). LSTM-based streaming ASR; detected as transducer. Folder name may contain **lstm**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/lstm-transducer-models.html) |
| **Paraformer**           | `'paraformer'`    | Single-model non-autoregressive ASR; fast and accurate. Detected by `model.onnx`; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html) |
| **NeMo CTC**             | `'nemo_ctc'`      | NeMo CTC; good for English and streaming. Folder name should contain **nemo** or **parakeet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)   |
| **Whisper**              | `'whisper'`       | Multilingual, encoder–decoder; strong zero-shot. Detected by encoder+decoder (no joiner); folder token optional. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)            |
| **WeNet CTC**            | `'wenet_ctc'`     | CTC from WeNet; compact. Folder name should contain **wenet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)  |
| **SenseVoice**           | `'sense_voice'`   | Multilingual with emotion/punctuation. Folder name should contain **sense** or **sensevoice**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)        |
| **FunASR Nano**          | `'funasr_nano'`   | Lightweight LLM-based ASR. Folder name should contain **funasr** or **funasr-nano**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)        |
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

### Text-to-Speech (TTS) Models

| Model Type       | `modelType` Value | Description                                                                                          | Download Links                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **VITS**         | `'vits'`          | Fast, high-quality TTS (Piper, Coqui, MeloTTS, MMS). Folder name should contain **vits** if used with other voice models. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Matcha**       | `'matcha'`        | High-quality acoustic model + vocoder. Detected by acoustic_model + vocoder; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html) |
| **Kokoro**       | `'kokoro'`        | Multi-speaker, multi-language. Folder name should contain **kokoro** (not kitten) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **KittenTTS**    | `'kitten'`        | Lightweight, multi-speaker. Folder name should contain **kitten** (not kokoro) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Zipvoice**     | `'zipvoice'`      | Voice cloning (encoder + decoder + vocoder). Detected by file layout; folder token optional. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html) |
| **Pocket**       | `'pocket'`        | Flow-matching TTS. Detected by lm_flow, lm_main, text_conditioner, vocab/token_scores; no folder token required. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |

For **streaming TTS** (incremental generation, low latency), use `createStreamingTTS()` with supported model types. See [Streaming Text-to-Speech](./docs/tts-streaming.md).

## Documentation

- [Speech-to-Text (STT)](./docs/stt.md) – Offline transcription (file or samples)
- [Streaming (Online) Speech-to-Text](./docs/stt-streaming.md) – Real-time recognition, partial results, endpoint detection
- [PCM Live Stream](./docs/pcm-live-stream.md) – Native microphone capture with resampling for live transcription (use with streaming STT)
- [Text-to-Speech (TTS)](./docs/tts.md) – Offline and streaming generation
- [Streaming Text-to-Speech](./docs/tts-streaming.md) – Incremental TTS (createStreamingTTS)
- [Execution provider support (QNN, NNAPI, XNNPACK, Core ML)](./docs/execution-providers.md) – Checking and using acceleration backends
- [Voice Activity Detection (VAD)](./docs/vad.md)
- [Speaker Diarization](./docs/diarization.md)
- [Speech Enhancement](./docs/enhancement.md)
- [Source Separation](./docs/separation.md)
- [Model Setup](./docs/model-setup.md) – Bundled assets, Play Asset Delivery (PAD), model discovery APIs, and troubleshooting
- [Model Download Manager](./docs/download-manager.md)
- [Disable FFMPEG](./docs/disable-ffmpeg.md)
- [Disable LIBARCHIVE](./docs/disable-libarchive.md)

Note: For when to use `listAssetModels()` vs `listModelsAtPath()` and how to combine bundled and PAD/file-based models, see [Model Setup](./docs/model-setup.md).

## Requirements

- React Native >= 0.70
- Android API 24+ (Android 7.0+)
- iOS 13.0+

## Example Apps

We provide example applications to help you get started with `react-native-sherpa-onnx`:

### Example App (Audio to Text)

The example app included in this repository demonstrates audio-to-text transcription, text-to-speech, and streaming features. It includes:

- Multiple model type support (Zipformer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, FunASR Nano, Moonshine, and more)
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

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)

