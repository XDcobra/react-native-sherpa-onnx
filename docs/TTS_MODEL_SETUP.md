# Text-to-Speech (TTS) Model Setup Guide

This guide explains how to download, configure, and use TTS models with `react-native-sherpa-onnx`.

## Table of Contents

- [Overview](#overview)
- [Supported Model Types](#supported-model-types)
- [Model Download Links](#model-download-links)
- [File Structure Requirements](#file-structure-requirements)
- [Platform-Specific Setup](#platform-specific-setup)
- [Model Configuration Examples](#model-configuration-examples)
- [Troubleshooting](#troubleshooting)

## Overview

The TTS module supports multiple model architectures, each with specific file requirements. Models are **not bundled** with the library - you must download and configure them yourself.

**Auto-Detection**: The library can automatically detect model types based on the files present in the model directory. You can also explicitly specify the model type if needed.

## Supported Model Types

| Model Type | Description | Use Case | File Requirements |
|------------|-------------|----------|-------------------|
| **VITS** | Fast, high-quality TTS (includes Piper, Coqui, MeloTTS, MMS) | General purpose, production use | `model.onnx`, `tokens.txt` |
| **Matcha** | High-quality acoustic model + vocoder | High-quality synthesis | `acoustic_model.onnx`, `vocoder.onnx`, `tokens.txt` |
| **Kokoro** | Multi-speaker, multi-language | Multiple voices, languages | `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/` |
| **KittenTTS** | Lightweight, multi-speaker | Resource-constrained devices | `model.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/` |
| **Zipvoice** | Voice cloning capable | Custom voice synthesis | `encoder.onnx`, `decoder.onnx`, `vocoder.onnx`, `tokens.txt` |

## Model Download Links

### VITS Models

**Piper Models** (Recommended for production):
- **English (US)** - Lessac Medium: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2)
- **English (US)** - Amy Low: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2)
- **English (GB)** - Alba Medium: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alba-medium.tar.bz2)
- **German**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2)
- **Spanish**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_ES-sharvard-medium.tar.bz2)
- **French**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-fr_FR-siwis-medium.tar.bz2)
- More languages: [Piper Models Collection](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)

**Coqui/MeloTTS Models**:
- See [sherpa-onnx TTS documentation](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/index.html)

### Kokoro Models

- **Kokoro EN v0.19**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2)
  - Multi-speaker English model
  - High quality, expressive voices

### KittenTTS Models

- **KittenTTS**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-tts.tar.bz2)
  - Lightweight, efficient
  - Multiple speakers

### Matcha Models

- See [sherpa-onnx Matcha documentation](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html)

### Zipvoice Models

- See [sherpa-onnx Zipvoice documentation](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html)

## File Structure Requirements

### VITS Models

```
models/vits-piper-en_US-lessac-medium/
├── model.onnx              # Required: Main TTS model
├── tokens.txt              # Required: Token vocabulary
├── model.json              # Optional but recommended: Model metadata
│                           # (speaker names, inference parameters, sample rate)
├── lexicon.txt             # Optional: Pronunciation dictionary
└── espeak-ng-data/         # Optional: Phonemization data
    └── ...
```

**Quantized Models**: Some VITS models offer `model.int8.onnx` for smaller size and faster inference.

**Note**: `model.json` contains valuable metadata such as speaker ID mappings, optimal inference parameters (noise_scale, length_scale), sample rate information, and phoneme mappings. While not strictly required for basic operation, it is **recommended** as it enables better speaker selection (by name instead of numeric ID) and improved audio quality through optimized parameters. The library automatically loads this file if present in the model directory.

### Matcha Models

```
models/matcha-english/
├── acoustic_model.onnx     # Required: Acoustic model
├── vocoder.onnx            # Required: Vocoder
├── tokens.txt              # Required: Token vocabulary
├── lexicon.txt             # Optional: Pronunciation dictionary
└── espeak-ng-data/         # Optional: Phonemization data
    └── ...
```

### Kokoro Models

```
models/kokoro-en-v0_19/
├── model.onnx              # Required: Main model
├── voices.bin              # Required: Voice embeddings
├── tokens.txt              # Required: Token vocabulary
├── espeak-ng-data/         # Required: Phonemization data
│   └── ...
├── lexicon.txt             # Optional: Pronunciation dictionary
└── [Additional language-specific files - auto-loaded if present]
    ├── date-{lang}.fst     # Optional: Date text normalization
    ├── number-{lang}.fst   # Optional: Number text normalization
    ├── phone-{lang}.fst    # Optional: Phone number normalization
    └── dict/               # Optional: Language-specific tokenization
        └── ...             # (e.g., Jieba dictionaries for Chinese)
```

**Note**: Language-specific files (FST files and `dict/` folder) are automatically loaded by sherpa-onnx if present in the model directory. They do not need to be explicitly configured in code. These files enable better text normalization for non-English languages (e.g., Chinese number/date formatting, word segmentation).

### KittenTTS Models

```
models/kitten-tts/
├── model.onnx              # Required: Main model (or model.fp16.onnx)
├── voices.bin              # Required: Voice embeddings
├── tokens.txt              # Required: Token vocabulary
└── espeak-ng-data/         # Required: Phonemization data
    └── ...
```

### Zipvoice Models

```
models/zipvoice/
├── encoder.onnx            # Required: Encoder
├── decoder.onnx            # Required: Decoder
├── vocoder.onnx            # Required: Vocoder
├── tokens.txt              # Required: Token vocabulary
├── lexicon.txt             # Optional: Pronunciation dictionary
└── espeak-ng-data/         # Optional: Phonemization data
    └── ...
```

## Platform-Specific Setup

### Android Setup

1. **Create model directory**:
   ```
   android/app/src/main/assets/models/
   ```

2. **Extract model files** to the directory:
   ```bash
   # Example: Extract Piper model
   cd android/app/src/main/assets/models/
   tar -xjf vits-piper-en_US-lessac-medium.tar.bz2
   ```

3. **Directory structure should be**:
   ```
   android/app/src/main/assets/models/
   └── vits-piper-en_US-lessac-medium/
       ├── model.onnx
       ├── tokens.txt
       └── espeak-ng-data/
           └── ...
   ```

4. **Use in code**:
   ```typescript
   await initializeTTS({
     modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' }
   });
   ```

### iOS Setup

1. **Extract model files** to a temporary location

2. **Add to Xcode project**:
   - Open Xcode project
   - Drag model folder into project navigator
   - **Important**: Select "Create folder references" (not "Create groups")
   - Ensure "Copy items if needed" is checked
   - Add to app target

3. **Verify in Xcode**:
   - Model folder should appear blue (folder reference)
   - Check "Copy Bundle Resources" in Build Phases

4. **Use in code**:
   ```typescript
   await initializeTTS({
     modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' }
   });
   ```

   > Note: For consistency with Android and with `listAssetModels()`, we recommend
   > placing all bundled TTS models under a `models/` folder and using asset paths
   > that start with `models/` (e.g., `models/vits-piper-en_US-lessac-medium`).

### File System Storage (Alternative)

You can also store models in the device's file system:

```typescript
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';

const modelPath = Platform.select({
  ios: `${RNFS.DocumentDirectoryPath}/models/vits-piper-en_US-lessac-medium`,
  android: `${RNFS.ExternalDirectoryPath}/models/vits-piper-en_US-lessac-medium`,
});

await initializeTTS({
  modelPath: { type: 'file', path: modelPath! }
});
```

## Model Configuration Examples

### Basic VITS Initialization (Auto-Detect)

```typescript
import { initializeTTS, generateSpeech } from 'react-native-sherpa-onnx/tts';

// Auto-detect model type from files
await initializeTTS({ type: 'auto', path: 'models/vits-piper-en_US-lessac-medium' });

const audio = await generateSpeech('Hello, world!');
console.log(`Generated ${audio.samples.length} samples at ${audio.sampleRate} Hz`);
```

### Explicit Model Type

```typescript
await initializeTTS({
  modelPath: { type: 'asset', path: 'models/kokoro-en-v0_19' },
  modelType: 'kokoro',  // Explicit type
  numThreads: 4,        // Use 4 threads
  debug: true           // Enable debug logging
});
```

### Multi-Speaker Model (Kokoro/Kitten)

```typescript
import { initializeTTS, generateSpeech, getNumSpeakers } from 'react-native-sherpa-onnx/tts';

await initializeTTS({
  modelPath: { type: 'asset', path: 'models/kokoro-en-v0_19' },
  modelType: 'kokoro'
});

// Check available speakers
const numSpeakers = await getNumSpeakers();
console.log(`Model has ${numSpeakers} voices`);

// Generate with different speakers
for (let i = 0; i < numSpeakers; i++) {
  const audio = await generateSpeech('Hello from speaker ' + i, { sid: i });
  // ... use audio
}
```

### Speech Speed Control

```typescript
// Normal speed
const audio1 = await generateSpeech('Normal speed', { speed: 1.0 });

// Faster (2x speed)
const audio2 = await generateSpeech('Faster speech', { speed: 2.0 });

// Slower (0.5x speed)
const audio3 = await generateSpeech('Slower speech', { speed: 0.5 });
```

### Complete Example

```typescript
import {
  initializeTTS,
  generateSpeech,
  getModelInfo,
  unloadTTS
} from 'react-native-sherpa-onnx/tts';

async function textToSpeechExample() {
  try {
    // Initialize
    await initializeTTS({
      modelPath: { type: 'asset', path: 'models/vits-piper-en_US-lessac-medium' },
      numThreads: 2
    });

    // Get model info
    const info = await getModelInfo();
    console.log(`Sample rate: ${info.sampleRate} Hz`);
    console.log(`Speakers: ${info.numSpeakers}`);

    // Generate speech
    const audio = await generateSpeech('Hello, this is a test!', {
      speed: 1.0,
      sid: 0
    });

    console.log(`Generated ${audio.samples.length} samples`);
    
    // TODO: Save or play audio.samples
    // The samples are float values in range [-1.0, 1.0]
    // You can convert them to WAV format or stream them

    // Cleanup
    await unloadTTS();
  } catch (error) {
    console.error('TTS Error:', error);
  }
}
```

## Troubleshooting

### Model Not Found

**Error**: `Model directory does not exist`

**Solutions**:
- Verify model files are correctly extracted
- Check path spelling and case sensitivity
- For Android: Ensure files are in `assets/models/`
- For iOS: Verify folder is added as "folder reference" (blue folder icon)

### Initialization Failed

**Error**: `Failed to initialize TTS` or `Cannot auto-detect model type`

**Solutions**:
- Verify all required files are present (see [File Structure Requirements](#file-structure-requirements))
- Check file names match exactly (case-sensitive)
- Ensure `tokens.txt` exists for all model types
- For Kokoro/Kitten: Verify `voices.bin` and `espeak-ng-data/` are present
- For Matcha: Verify both `acoustic_model.onnx` and `vocoder.onnx` exist

### Generation Failed

**Error**: `Failed to generate speech` or empty samples

**Solutions**:
- Ensure TTS is initialized before calling `generateSpeech()`
- Check input text is not empty
- For multi-speaker models: Verify `sid` is within valid range (0 to numSpeakers-1)
- Check logs for detailed error messages (enable `debug: true`)

### Audio Quality Issues

**Symptoms**: Robotic voice, distortion, incorrect speed

**Solutions**:
- Try different `speed` values (0.8 - 1.2 is usually safe)
- For VITS: Try `model.int8.onnx` vs regular `model.onnx`
- Verify sample rate matches expected output (check with `getSampleRate()`)
- Ensure audio playback uses correct sample rate

### iOS Build Errors

**Error**: `'sherpa-onnx/c-api/cxx-api.h' file not found`

**Solutions**:
- Ensure sherpa-onnx XCFramework is properly installed
- Run `cd ios && pod install`
- Verify Podspec configuration

### Performance Issues

**Symptoms**: Slow generation, high CPU usage

**Solutions**:
- Reduce `numThreads` (try 1 or 2)
- Use quantized models (`model.int8.onnx`, `model.fp16.onnx`)
- Use smaller models (e.g., Piper "low" quality variants)
- For long text: Break into smaller chunks

## Model Size Comparison

| Model | Size | Quality | Speed | Best For |
|-------|------|---------|-------|----------|
| Piper Low | ~5-10 MB | Good | Fast | Mobile apps, quick responses |
| Piper Medium | ~15-30 MB | Very Good | Medium | General purpose |
| Piper High | ~50-100 MB | Excellent | Slower | High-quality synthesis |
| Kokoro | ~100-200 MB | Excellent | Medium | Multi-speaker, expressive |
| KittenTTS | ~20-40 MB | Very Good | Fast | Resource-constrained |

## Additional Resources

- [sherpa-onnx TTS Documentation](https://k2-fsa.github.io/sherpa/onnx/tts/index.html)
- [Piper TTS Project](https://github.com/rhasspy/piper)
- [All Pre-trained Models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)
- [sherpa-onnx GitHub](https://github.com/k2-fsa/sherpa-onnx)

## License Notes

Models have different licenses:
- **Piper models**: Various open-source licenses (check individual model repos)
- **Coqui models**: Mozilla Public License 2.0
- **Other models**: Check respective documentation

Always verify license compatibility with your use case before deployment.
