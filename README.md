# react-native-sherpa-onnx

React Native SDK for sherpa-onnx - providing offline speech processing capabilities

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

A React Native TurboModule that provides offline speech processing capabilities using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The SDK aims to support all functionalities that sherpa-onnx offers, including offline speech-to-text, text-to-speech, speaker diarization, speech enhancement, source separation, and VAD (Voice Activity Detection).

## Feature Support

| Feature | Status |
|---------|--------|
| Offline Speech-to-Text | ✅ **Supported** |
| Text-to-Speech | ✅ **Supported** |
| Speaker Diarization | ❌ Not yet supported |
| Speech Enhancement | ❌ Not yet supported |
| Source Separation | ❌ Not yet supported |
| VAD (Voice Activity Detection) | ❌ Not yet supported |

## Platform Support Status

| Platform | Status | Notes |
|----------|--------|-------|
| **Android** | ✅ **Production Ready** | Fully tested, CI/CD automated, multiple models supported |
| **iOS** | 🟡 **Beta / Experimental** | XCFramework + Podspec ready<br/>✅ GitHub Actions builds pass<br/>❌ **No local Xcode testing** *(Windows-only dev)* |

**Full iOS support is a priority!** Help bring sherpa-onnx to iOS devices.
**What's needed:**
- **Local Xcode testing** (Simulator + Device)
- **iOS example app** (beyond CI)
- **TurboModule iOS testing** 
- **Edge case testing**

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

### Text-to-Speech (TTS) Models

| Model Type       | `modelType` Value | Description                                                                                          | Download Links                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **VITS**         | `'vits'`          | Fast, high-quality TTS. Includes Piper, Coqui, MeloTTS, MMS variants. Requires `model.onnx`, `tokens.txt` | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Matcha**       | `'matcha'`        | High-quality acoustic model + vocoder. Requires `acoustic_model.onnx`, `vocoder.onnx`, `tokens.txt` | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html) |
| **Kokoro**       | `'kokoro'`        | Multi-speaker, multi-language. Requires `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/` | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **KittenTTS**    | `'kitten'`        | Lightweight, multi-speaker. Requires `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`    | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Zipvoice**     | `'zipvoice'`      | Voice cloning capable. Requires `encoder.onnx`, `decoder.onnx`, `vocoder.onnx`, `tokens.txt`        | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html) |

## Features

- ✅ **Offline Speech-to-Text** - No internet connection required for speech recognition
- ✅ **Multiple Model Types** - Supports Zipformer/Transducer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, and FunASR Nano models
- ✅ **Model Quantization** - Automatic detection and preference for quantized (int8) models
- ✅ **Flexible Model Loading** - Asset models, file system models, or auto-detection
- ✅ **Android Support** - Fully supported on Android
- ✅ **iOS Support** - Fully supported on iOS (requires sherpa-onnx XCFramework)
- ✅ **TypeScript Support** - Full TypeScript definitions included

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

No additional setup required. The library automatically handles native dependencies via Gradle.

### iOS

The sherpa-onnx XCFramework is **not included in the repository or npm package** due to its size (~80MB), but **no manual action is required**! The framework is automatically downloaded during `pod install`.

#### Quick Setup

```sh
cd example
bundle install
bundle exec pod install --project-directory=ios
```

That's it! The `Podfile` automatically:
1. Copies required header files from the git submodule
2. Downloads the latest XCFramework from [GitHub Releases](https://github.com/XDcobra/react-native-sherpa-onnx/releases?q=framework)
3. Verifies everything is in place before building

#### For Advanced Users: Building the Framework Locally

If you want to build the XCFramework yourself instead of using the prebuilt release:

```sh
# Clone sherpa-onnx repository
git clone https://github.com/k2-fsa/sherpa-onnx.git
cd sherpa-onnx
git checkout v1.12.24

# Build the iOS XCFramework (requires macOS, Xcode, CMake, and ONNX Runtime)
./build-ios.sh

# Copy to your project
cp -r build-ios/sherpa_onnx.xcframework /path/to/react-native-sherpa-onnx/ios/Frameworks/
```

Then run `pod install` as usual.

**Note:** The iOS implementation uses the same C++ wrapper as Android, ensuring consistent behavior across platforms.

## Documentation

- [Speech-to-Text (STT)](./docs/stt.md)
- [Text-to-Speech (TTS)](./docs/tts.md)
- [Model Download Manager](./docs/download-manager.md)
- [Voice Activity Detection (VAD)](./docs/vad.md)
- [Speaker Diarization](./docs/diarization.md)
- [Speech Enhancement](./docs/enhancement.md)
- [Source Separation](./docs/separation.md)
- [General STT Model Setup](./docs/STT_MODEL_SETUP.md)
- [General TTS Model Setup](./docs/TTS_MODEL_SETUP.md)

### Example Model READMEs

Model READMEs in the example app live in the Play Asset Delivery pack at `example/android/sherpa_models/src/main/assets/models/`:

- [kokoro (US) README](./example/android/sherpa_models/src/main/assets/models/kokoro-us/README.md)
- [kokoro (ZH) README](./example/android/sherpa_models/src/main/assets/models/kokoro-zh/README.md)
- [funasr-nano README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-funasr-nano-int8/README.md)
- [kitten-nano README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-kitten-nano-en-v0_1-fp16/README.md)
- [matcha README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-matcha-icefall-en_US-ljspeech/README.md)
- [nemo-ctc README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-nemo-parakeet-tdt-ctc-en/README.md)
- [paraformer README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-paraformer-zh-small/README.md)
- [sense-voice README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8/README.md)
- [vits README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-vits-piper-en_US-libritts_r-medium/README.md)
- [wenet-ctc README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-wenetspeech-ctc-zh-en-cantonese/README.md)
- [whisper-tiny README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-whisper-tiny-en/README.md)
- [zipformer README](./example/android/sherpa_models/src/main/assets/models/sherpa-onnx-zipformer-small-en/README.md)

## Requirements

- React Native >= 0.70
- Android API 24+ (Android 7.0+)
- iOS 13.0+ (requires sherpa-onnx XCFramework - see iOS Setup below)

## Example Apps

We provide example applications to help you get started with `react-native-sherpa-onnx`:

### Example App (Audio to Text)

The example app included in this repository demonstrates basic audio-to-text transcription capabilities. It includes:

- Multiple model type support (Zipformer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, FunASR Nano)
- Model selection and configuration
- Audio file transcription
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
<td><img src="./docs/images/example_tts_1.png" alt="Text to speech settings" width="240" /></td>
<td><img src="./docs/images/example_tts_2.png" alt="Text to speech generation" width="240" /></td>
<td></td>
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
