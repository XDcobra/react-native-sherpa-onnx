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

### 🔧 **iOS Contributors WANTED!**

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
- 🚧 **Additional Features Coming Soon** - Speaker Diarization, Speech Enhancement, Source Separation, and VAD support are planned for future releases

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

### Manual Setup

Use this approach when you know the exact model name and type:

```typescript
import { resolveModelPath } from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  transcribeFile,
  unloadSTT,
} from 'react-native-sherpa-onnx/stt';

// Resolve model path from assets (explicit model name)
const modelPath = await resolveModelPath({
  type: 'asset',
  path: 'models/sherpa-onnx-whisper-tiny.en',
});

// Initialize STT with explicit model type and quantization preference
const result = await initializeSTT({
  modelPath: modelPath,
  modelType: 'whisper', // Explicitly specify model type (no auto-detection)
  preferInt8: true,     // Prefer quantized models
});

if (result.success) {
  console.log('Detected models:', result.detectedModels);
  // [{ type: 'whisper', modelDir: '/data/.../sherpa-onnx-whisper-tiny.en' }]
}

// Transcribe an audio file
const transcription = await transcribeFile('/path/to/audio.wav');
console.log('Transcription:', transcription);

// Release resources when done
await unloadSTT();
```

### Automated Discovery

Use this approach to automatically discover and use available models:

```typescript
import { listAssetModels, resolveModelPath } from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  transcribeFile,
  unloadSTT,
} from 'react-native-sherpa-onnx/stt';

// Discover all available models in assets
const availableModels = await listAssetModels();
console.log('Available models:', availableModels);
// [{ folder: 'sherpa-onnx-whisper-tiny.en', hint: 'stt' }, { folder: 'vits-piper-en_US-lessac-medium', hint: 'tts' }, ...]

const sttModels = availableModels.filter((model) => model.hint === 'stt');

if (sttModels.length === 0) {
  throw new Error('No STT models found in assets/models/');
}

// Automatically use the first available STT model
const modelPath = await resolveModelPath({
  type: 'asset',
  path: `models/${sttModels[0].folder}`,
});

// Initialize and use
const result = await initializeSTT({ modelPath });

if (result.success) {
  console.log(`Using model: ${sttModels[0].folder}`);
  console.log('Detected types:', result.detectedModels);
  
  const transcription = await transcribeFile('/path/to/audio.wav');
  console.log('Transcription:', transcription);
  
  await unloadSTT();
}
```

## Usage

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

### Text-to-Speech (TTS)

```typescript
import { 
  initializeTTS, 
  generateSpeech, 
  generateSpeechStream,
  cancelSpeechStream,
  startTtsPcmPlayer,
  writeTtsPcmChunk,
  stopTtsPcmPlayer,
  getModelInfo,
  unloadTTS 
} from 'react-native-sherpa-onnx/tts';

// Initialize TTS with a model
await initializeTTS({
  modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' },
  numThreads: 2
});

// Get model information
const info = await getModelInfo();
console.log(`Sample rate: ${info.sampleRate} Hz`);
console.log(`Available voices: ${info.numSpeakers}`);

// Generate speech
const audio = await generateSpeech('Hello, world!');
console.log(`Generated ${audio.samples.length} samples`);
// audio.samples: float array in range [-1.0, 1.0]
// audio.sampleRate: sample rate in Hz

// With options
const audio2 = await generateSpeech('Faster speech!', {
  speed: 1.5,  // 1.5x faster
  sid: 0       // Speaker ID for multi-speaker models
});

// Release TTS resources
await unloadTTS();
```

#### Streaming TTS (chunk events + live PCM playback)

```typescript
import { generateSpeechStream, cancelSpeechStream } from 'react-native-sherpa-onnx/tts';

// Start a streaming generation
const unsubscribe = await generateSpeechStream('Hello streaming world!', {
  sid: 0,
  speed: 1.0,
}, {
  onChunk: (chunk) => {
    // chunk.samples: Float32 samples
    // chunk.sampleRate: number
    // chunk.progress: 0..1
  },
  onEnd: () => {
    // Stream finished
  },
  onError: ({ message }) => {
    console.warn('Stream error:', message);
  },
});

// Stop streaming
await cancelSpeechStream();

// Unsubscribe from events when done
unsubscribe();
```

```typescript
import {
  startTtsPcmPlayer,
  writeTtsPcmChunk,
  stopTtsPcmPlayer,
} from 'react-native-sherpa-onnx/tts';

// Start PCM playback before or on first chunk
await startTtsPcmPlayer(sampleRate, 1);

// Write chunks as they arrive
await writeTtsPcmChunk(chunk.samples);

// Stop and release the player
await stopTtsPcmPlayer();
```

See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for detailed TTS model setup instructions and download links.

## Model Setup

The library does **not** bundle models. You must provide your own models.

- **Speech-to-Text (STT)**: See [STT_MODEL_SETUP.md](./STT_MODEL_SETUP.md) for detailed setup guide
- **Text-to-Speech (TTS)**: See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for detailed setup guide

### STT Model File Requirements

- **Zipformer/Transducer**: Requires `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, and `tokens.txt`
- **Paraformer**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **NeMo CTC**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **Whisper**: Requires `encoder.onnx`, `decoder.onnx`, and `tokens.txt`
- **WeNet CTC**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`
- **SenseVoice**: Requires `model.onnx` (or `model.int8.onnx`) and `tokens.txt`

### TTS Model File Requirements

See [TTS_MODEL_SETUP.md](./TTS_MODEL_SETUP.md) for complete guide with download links.

- **VITS**: `model.onnx`, `tokens.txt`, optional: `lexicon.txt`, `espeak-ng-data/`
- **Matcha**: `acoustic_model.onnx`, `vocoder.onnx`, `tokens.txt`
- **Kokoro**: `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`
- **KittenTTS**: `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`
- **Zipvoice**: `encoder.onnx`, `decoder.onnx`, `vocoder.onnx`, `tokens.txt`

### Model Files Location

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

**Returns:** `Promise<STTInitializeResult>`
- `STTInitializeResult.success`: Whether initialization succeeded
- `STTInitializeResult.detectedModels`: Array of detected models with `type` and `modelDir` properties

#### `transcribeFile(filePath)`

Transcribe an audio file.

**Parameters:**

- `filePath`: Path to WAV file (16kHz, mono, 16-bit PCM)

**Returns:** `Promise<string>` - Transcribed text

#### `unloadSTT()`

Release resources and unload the speech-to-text model.

**Returns:** `Promise<void>`

### Text-to-Speech (TTS) Module

Import from `react-native-sherpa-onnx/tts`:

#### `initializeTTS(options)`

Initialize the text-to-speech engine with a model.

**Parameters:**

- `options.modelPath`: Model path configuration (same as STT)
- `options.modelType` (optional): Explicit model type (`'vits'`, `'matcha'`, `'kokoro'`, `'kitten'`, `'zipvoice'`, `'auto'`), default: `'auto'`
- `options.numThreads` (optional): Number of inference threads, default: `2`
- `options.debug` (optional): Enable debug logging, default: `false`

**Returns:** `Promise<TTSInitializeResult>`
- `TTSInitializeResult.success`: Whether initialization succeeded
- `TTSInitializeResult.detectedModels`: Array of detected models with `type` and `modelDir` properties

#### `generateSpeech(text, options?)`

Generate speech audio from text.

**Parameters:**

- `text`: Text to convert to speech
- `options.sid` (optional): Speaker ID for multi-speaker models, default: `0`
- `options.speed` (optional): Speech speed multiplier (0.5-2.0), default: `1.0`

**Returns:** `Promise<GeneratedAudio>`
- `GeneratedAudio.samples`: Audio samples as float array in range [-1.0, 1.0]
- `GeneratedAudio.sampleRate`: Sample rate in Hz

#### `generateSpeechStream(text, options?, handlers)`

Generate speech audio in streaming mode with chunk callbacks.

**Parameters:**

- `text`: Text to convert to speech
- `options.sid` (optional): Speaker ID for multi-speaker models, default: `0`
- `options.speed` (optional): Speech speed multiplier (0.5-2.0), default: `1.0`
- `handlers.onChunk`: Called with `{ samples, sampleRate, progress }`
- `handlers.onEnd`: Called when the stream finishes
- `handlers.onError`: Called with `{ message }`

**Returns:** `Promise<() => void>` - Unsubscribe function

#### `cancelSpeechStream()`

Cancel the current streaming generation.

**Returns:** `Promise<void>`

#### `getModelInfo()`

Get TTS model information (sample rate and number of speakers).

**Returns:** `Promise<TTSModelInfo>`
- `TTSModelInfo.sampleRate`: Sample rate in Hz
- `TTSModelInfo.numSpeakers`: Number of available speakers/voices

#### `getSampleRate()`

Get the sample rate of the initialized TTS model.

**Returns:** `Promise<number>` - Sample rate in Hz

#### `getNumSpeakers()`

Get the number of speakers/voices available in the model.

**Returns:** `Promise<number>` - Number of speakers (0 or 1 for single-speaker)

#### `unloadTTS()`

Release TTS resources and unload the model.

**Returns:** `Promise<void>`

#### `startTtsPcmPlayer(sampleRate, channels)`

Start a native PCM player for streaming audio.

**Parameters:**

- `sampleRate`: Sample rate in Hz
- `channels`: Number of channels (currently mono is recommended)

**Returns:** `Promise<void>`

#### `writeTtsPcmChunk(samples)`

Write a chunk of float PCM samples to the native PCM player.

**Parameters:**

- `samples`: Float array of PCM samples in range [-1.0, 1.0]

**Returns:** `Promise<void>`

#### `stopTtsPcmPlayer()`

Stop and release the native PCM player.

**Returns:** `Promise<void>`

#### `saveAudioToFile(audio, filePath)`

Save generated TTS audio to a WAV file.

**Parameters:**

- `audio`: Generated audio from `generateSpeech()`
- `filePath`: Absolute file path where to save the WAV file

**Returns:** `Promise<string>` - The file path where audio was saved

**Example:**

```typescript
import { generateSpeech, saveAudioToFile } from 'react-native-sherpa-onnx/tts';
import RNFS from 'react-native-fs';
import { Platform } from 'react-native';

// Generate speech
const audio = await generateSpeech('Hello, world!');

// Save to file
const directory = Platform.OS === 'ios' 
  ? RNFS.DocumentDirectoryPath 
  : RNFS.ExternalDirectoryPath;
const filePath = `${directory}/speech_${Date.now()}.wav`;

const savedPath = await saveAudioToFile(audio, filePath);
console.log('Audio saved to:', savedPath);

// Play with react-native-sound or other audio player
import Sound from 'react-native-sound';
const sound = new Sound(savedPath, '', (error) => {
  if (error) {
    console.error('Failed to load sound', error);
    return;
  }
  sound.play(() => sound.release());
});
```

### Utility Functions

Import from `react-native-sherpa-onnx`:

#### `resolveModelPath(config)`

Resolve a model path configuration to an absolute path.

**Parameters:**

- `config.type`: Path type (`'asset'`, `'file'`, or `'auto'`)
- `config.path`: Path to resolve (relative for assets, absolute for files)

**Returns:** `Promise<string>` - Absolute path to model directory

#### `listAssetModels()`

List all available model folders in the assets directory.

**Returns:** `Promise<Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>>` - Array of model info objects found in `assets/models/` (Android) or app bundle `models/` (iOS)

**Example:**

```typescript
import { listAssetModels } from 'react-native-sherpa-onnx';

const models = await listAssetModels();
console.log('Available models:', models);
// [{ folder: 'vits-piper-en_US-lessac-medium', hint: 'tts' }, { folder: 'sherpa-onnx-whisper-tiny.en', hint: 'stt' }, ...]
```

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
