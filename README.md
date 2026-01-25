# react-native-sherpa-onnx

React Native SDK for sherpa-onnx - providing offline speech processing capabilities

[![npm version](https://img.shields.io/npm/v/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm downloads](https://img.shields.io/npm/dm/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm license](https://img.shields.io/npm/l/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![Android](https://img.shields.io/badge/Android-Supported-green)](https://www.android.com/)
[![iOS](https://img.shields.io/badge/iOS-Supported-blue)](https://www.apple.com/ios/)

A React Native TurboModule that provides offline speech processing capabilities using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The SDK aims to support all functionalities that sherpa-onnx offers, including offline speech-to-text, text-to-speech, speaker diarization, speech enhancement, source separation, and VAD (Voice Activity Detection).

## Feature Support

| Feature | Status |
|---------|--------|
| Offline Speech-to-Text | ✅ Supported |
| Text-to-Speech | ❌ Not yet supported |
| Speaker Diarization | ❌ Not yet supported |
| Speech Enhancement | ❌ Not yet supported |
| Source Separation | ❌ Not yet supported |
| VAD (Voice Activity Detection) | ❌ Not yet supported |

## Platform Support Status

| Platform | Status | Notes |
|----------|--------|-------|
| **Android** | ✅ **Production Ready** | Fully tested, CI/CD automated, multiple models supported |
| **iOS** | 🟡 **Beta / Experimental** | XCFramework + Podspec ready<br/>✅ GitHub Actions builds pass<br/>❌ **No local Xcode testing** *(Windows-only dev)* |

### 🔧 **iOS Contributors WANTED!** 🙌

**Full iOS support is a priority!** Help bring sherpa-onnx to iOS devices.

**What's ready:**
- ✅ XCFramework integration
- ✅ Podspec configuration  
- ✅ GitHub Actions CI (macOS runner) 
- ✅ TypeScript bindings

**What's needed:**
- **Local Xcode testing** (Simulator + Device)
- **iOS example app** (beyond CI)
- **TurboModule iOS testing** 
- **Edge case testing**

## Supported Model Types

| Model Type               | `modelType` Value | Description                                                                              | Download Links                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Zipformer/Transducer** | `'transducer'`    | Requires `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, and `tokens.txt`                 | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html) |
| **Paraformer**           | `'paraformer'`    | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html) |
| **NeMo CTC**             | `'nemo_ctc'`      | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)   |
| **Whisper**              | `'whisper'`       | Requires `encoder.onnx`, `decoder.onnx`, and `tokens.txt`                                | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)            |
| **WeNet CTC**            | `'wenet_ctc'`     | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)  |
| **SenseVoice**           | `'sense_voice'`   | Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`                            | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)        |
| **FunASR Nano**          | `'funasr_nano'`   | Requires `encoder_adaptor.onnx`, `llm.onnx`, `embedding.onnx`, and `tokenizer` directory | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)        |

## Features

- ✅ **Offline Speech-to-Text** - No internet connection required for speech recognition
- ✅ **Multiple Model Types** - Supports Zipformer/Transducer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, and FunASR Nano models
- ✅ **Model Quantization** - Automatic detection and preference for quantized (int8) models
- ✅ **Flexible Model Loading** - Asset models, file system models, or auto-detection
- ✅ **Android Support** - Fully supported on Android
- ✅ **iOS Support** - Fully supported on iOS (requires sherpa-onnx XCFramework)
- ✅ **TypeScript Support** - Full TypeScript definitions included
- 🚧 **Additional Features Coming Soon** - Text-to-Speech, Speaker Diarization, Speech Enhancement, Source Separation, and VAD support are planned for future releases

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
git checkout v1.12.23

# Build the iOS XCFramework (requires macOS, Xcode, CMake, and ONNX Runtime)
./build-ios.sh

# Copy to your project
cp -r build-ios/sherpa_onnx.xcframework /path/to/react-native-sherpa-onnx/ios/Frameworks/
```

Then run `pod install` as usual.

**Note:** The iOS implementation uses the same C++ wrapper as Android, ensuring consistent behavior across platforms.

## Quick Start

```typescript
import { resolveModelPath } from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  transcribeFile,
  unloadSTT,
} from 'react-native-sherpa-onnx/stt';

// Initialize with a model
const modelPath = await resolveModelPath({
  type: 'asset',
  path: 'models/sherpa-onnx-model',
});

await initializeSTT({
  modelPath: modelPath,
  preferInt8: true, // Optional: prefer quantized models
});

// Transcribe an audio file
const transcription = await transcribeFile('path/to/audio.wav');
console.log('Transcription:', transcription);

// Release resources when done
await unloadSTT();
```

## Usage

### Initialization

```typescript
import {
  initializeSherpaOnnx,
  assetModelPath,
  autoModelPath,
} from 'react-native-sherpa-onnx';

// Option 1: Asset model (bundled in app)
await initializeSherpaOnnx({
  modelPath: assetModelPath('models/sherpa-onnx-model'),
  preferInt8: true, // Prefer quantized models
});

// Option 2: Auto-detect (tries asset, then file system)
await initializeSherpaOnnx({
  modelPath: autoModelPath('models/sherpa-onnx-model'),
});

// Option 3: Simple string (backward compatible)
await initializeSherpaOnnx('models/sherpa-onnx-model');
```

### Transcription (Speech-to-Text)

```typescript
import { transcribeFile } from 'react-native-sherpa-onnx/stt';

// Transcribe a WAV file (16kHz, mono, 16-bit PCM)
const result = await transcribeFile('path/to/audio.wav');
console.log('Transcription:', result);
```

### Model Quantization

Control whether to prefer quantized (int8) or regular models:

```typescript
import { initializeSTT } from 'react-native-sherpa-onnx/stt';
import { resolveModelPath } from 'react-native-sherpa-onnx';

const modelPath = await resolveModelPath({
  type: 'asset',
  path: 'models/my-model',
});

// Default: try int8 first, then regular
await initializeSTT({ modelPath });

// Explicitly prefer int8 models (smaller, faster)
await initializeSTT({
  modelPath,
  preferInt8: true,
});

// Explicitly prefer regular models (higher accuracy)
await initializeSTT({
  modelPath,
  preferInt8: false,
});
```

### Explicit Model Type

For robustness, you can explicitly specify the model type to avoid auto-detection issues:

```typescript
import { initializeSTT } from 'react-native-sherpa-onnx/stt';
import { resolveModelPath } from 'react-native-sherpa-onnx';

const modelPath = await resolveModelPath({
  type: 'asset',
  path: 'models/sherpa-onnx-nemo-parakeet-tdt-ctc-en',
});

// Explicitly specify model type
await initializeSTT({
  modelPath,
  modelType: 'nemo_ctc', // 'transducer', 'paraformer', 'nemo_ctc', 'whisper', 'wenet_ctc', 'sense_voice', 'funasr_nano'
});

// Auto-detection (default behavior)
await initializeSTT({
  modelPath,
  // modelType defaults to 'auto'
});
```

### Cleanup (Speech-to-Text)

```typescript
import { unloadSTT } from 'react-native-sherpa-onnx/stt';

// Release resources when done
await unloadSTT();
```

## Model Setup

The library does **not** bundle models. You must provide your own models. See [MODEL_SETUP.md](./MODEL_SETUP.md) for detailed setup instructions.

### Model File Requirements

- **Zipformer/Transducer**: Requires `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, and `tokens.txt`
- **Paraformer**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **NeMo CTC**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **Whisper**: Requires `encoder.onnx`, `decoder.onnx`, and `tokens.txt`
- **WeNet CTC**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **SenseVoice**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`

### Model Files

Place models in:

- **Android**: `android/app/src/main/assets/models/`
- **iOS**: Add to Xcode project as folder reference

## API Reference

### Speech-to-Text (STT) Module

Import from `react-native-sherpa-onnx/stt`:

#### `initializeSTT(options)`

Initialize the speech-to-text engine with a model.

**Parameters:**

- `options.modelPath`: Absolute path to the model directory
- `options.preferInt8` (optional): Prefer quantized models (`true`), regular models (`false`), or auto-detect (`undefined`, default)
- `options.modelType` (optional): Explicit model type (`'transducer'`, `'paraformer'`, `'nemo_ctc'`, `'whisper'`, `'wenet_ctc'`, `'sense_voice'`, `'funasr_nano'`), or auto-detect (`'auto'`, default)

**Returns:** `Promise<void>`

#### `transcribeFile(filePath)`

Transcribe an audio file.

**Parameters:**

- `filePath`: Path to WAV file (16kHz, mono, 16-bit PCM)

**Returns:** `Promise<string>` - Transcribed text

#### `unloadSTT()`

Release resources and unload the speech-to-text model.

**Returns:** `Promise<void>`

### Utility Functions

Import from `react-native-sherpa-onnx`:

#### `resolveModelPath(config)`

Resolve a model path configuration to an absolute path.

**Parameters:**

- `config.type`: Path type (`'asset'`, `'file'`, or `'auto'`)
- `config.path`: Path to resolve (relative for assets, absolute for files)

**Returns:** `Promise<string>` - Absolute path to model directory

#### `testSherpaInit()`

Test that the sherpa-onnx native module is properly loaded.

**Returns:** `Promise<string>` - Test message confirming module is loaded

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
  <img src="./docs/images/example_home_screen.png" alt="Model selection home screen" width="30%" />
  <img src="./docs/images/example_english.png" alt="Transcribe english audio" width="30%" />
  <img src="./docs/images/example_multilanguage.png" alt="Transcribe english and chinese audio" width="30%" />
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
