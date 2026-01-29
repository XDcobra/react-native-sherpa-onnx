# Speech-to-Text (STT) Model Setup Guide

This guide explains how to download, configure, and use STT models with `react-native-sherpa-onnx`.

## Table of Contents

- [Overview](#overview)
- [Supported Model Types](#supported-model-types)
- [Model Download Links](#model-download-links)
- [File Structure Requirements](#file-structure-requirements)
- [Platform-Specific Setup](#platform-specific-setup)
- [Model Configuration Examples](#model-configuration-examples)
- [Troubleshooting](#troubleshooting)

## Overview

The STT module supports multiple model architectures for offline speech recognition. Models are **not bundled** with the library - you must download and configure them yourself.

**Auto-Detection**: The library can automatically detect model types based on the files present in the model directory. You can also explicitly specify the model type if needed.

**Quantization Support**: Most models support int8 quantization for reduced size and faster inference with minimal accuracy loss.

## Supported Model Types

| Model Type | Description | Use Case | File Requirements |
|------------|-------------|----------|-------------------|
| **Zipformer/Transducer** | High-accuracy streaming ASR | Production use, real-time | `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, `tokens.txt` |
| **Paraformer** | Fast non-streaming ASR | Batch processing, high throughput | `model.onnx`, `tokens.txt` |
| **NeMo CTC** | NVIDIA NeMo CTC models | English, high accuracy | `model.onnx`, `tokens.txt` |
| **Whisper** | OpenAI Whisper models | Multilingual, robust | `encoder.onnx`, `decoder.onnx`, `tokens.txt` |
| **WeNet CTC** | WeNet CTC models | Chinese, multilingual | `model.onnx`, `tokens.txt` |
| **SenseVoice** | High-quality ASR with emotion | Multilingual, emotion detection | `model.onnx`, `tokens.txt` |
| **FunASR Nano** | Lightweight streaming ASR | Edge devices, low latency | `encoder_adaptor.onnx`, `llm.onnx`, `embedding.onnx`, `tokenizer/` |

## Model Download Links

### Zipformer/Transducer Models

**English**:
- **Zipformer Transducer (Small)**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-en-2023-06-26.tar.bz2) - ~66MB
- **Zipformer Transducer (Medium)**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-en-2023-06-21.tar.bz2) - ~200MB
- More models: [Zipformer Collection](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html)

**Chinese**:
- **Zipformer Chinese**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-zh-2023-10-24.tar.bz2)

**Multilingual**:
- **Zipformer Multilingual**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2.tar.bz2)

### Paraformer Models

**Chinese**:
- **Paraformer Chinese**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2)
- **Paraformer Chinese (Small)**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2)

**Multilingual**:
- **Paraformer Trilingual** (Chinese/English/Japanese): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-trilingual-zh-cantonese-en-2024-03-20.tar.bz2)

More models: [Paraformer Collection](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html)

### NeMo CTC Models

**English**:
- **NeMo Parakeet TDT CTC** (0.6B params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-ctc-en-v1.17.0.tar.bz2) - ~700MB
- **NeMo Parakeet CTC** (1.1B params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-ctc-en-v1.17.0.tar.bz2) - ~1.2GB

More models: [NeMo CTC Collection](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)

### Whisper Models

**All Languages**:
- **Tiny** (~39M params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2) - ~74MB
- **Base** (~74M params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2) - ~140MB
- **Small** (~244M params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2) - ~460MB
- **Medium** (~769M params): [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-medium.tar.bz2) - ~1.5GB
- **Large-v2**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-large-v2.tar.bz2) - ~2.9GB
- **Large-v3**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-large-v3.tar.bz2) - ~2.9GB

**English-Only** (higher accuracy for English):
- **Tiny.en**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2)
- **Base.en**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2)
- **Small.en**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2)
- **Medium.en**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-medium.en.tar.bz2)

More info: [Whisper Models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)

### WeNet CTC Models

**Chinese**:
- **WeNet Chinese**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zh-wenet-wenetspeech.tar.bz2)
- **WeNet Aishell**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zh-wenet-aishell.tar.bz2)

**English**:
- **WeNet Gigaspeech**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-en-wenet-gigaspeech.tar.bz2)

More models: [WeNet CTC Collection](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)

### SenseVoice Models

**Multilingual** (Chinese, English, Japanese, Korean, Cantonese):
- **SenseVoice Small**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2) - ~150MB

More info: [SenseVoice Models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)

### FunASR Nano Models

**Chinese/English**:
- **FunASR Nano**: [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-zh-en-2024-12-11.tar.bz2) - ~65MB

More info: [FunASR Nano Models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)

## File Structure Requirements

### Zipformer/Transducer Models

```
models/sherpa-onnx-zipformer-en-2023-06-26/
├── encoder.onnx            # Required: Encoder network
├── decoder.onnx            # Required: Decoder network
├── joiner.onnx             # Required: Joiner network
├── tokens.txt              # Required: Token vocabulary
├── encoder.int8.onnx       # Optional: Quantized encoder
├── decoder.int8.onnx       # Optional: Quantized decoder
└── joiner.int8.onnx        # Optional: Quantized joiner
```

**Note**: Int8 models are automatically preferred if available (unless `preferInt8: false`).

### Paraformer Models

```
models/sherpa-onnx-paraformer-zh-2023-09-14/
├── model.onnx              # Required: Main model
├── tokens.txt              # Required: Token vocabulary
└── model.int8.onnx         # Optional: Quantized model
```

### NeMo CTC Models

```
models/sherpa-onnx-nemo-parakeet-tdt-ctc-en/
├── model.onnx              # Required: Main model
├── tokens.txt              # Required: Token vocabulary
└── model.int8.onnx         # Optional: Quantized model
```

### Whisper Models

```
models/sherpa-onnx-whisper-base/
├── encoder.onnx            # Required: Encoder
├── decoder.onnx            # Required: Decoder
└── tokens.txt              # Required: Token vocabulary (includes special tokens)
```

### WeNet CTC Models

```
models/sherpa-onnx-zh-wenet-wenetspeech/
├── model.onnx              # Required: Main model
├── tokens.txt              # Required: Token vocabulary
└── model.int8.onnx         # Optional: Quantized model
```

### SenseVoice Models

```
models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/
├── model.onnx              # Required: Main model
├── tokens.txt              # Required: Token vocabulary
└── model.int8.onnx         # Optional: Quantized model
```

### FunASR Nano Models

```
models/sherpa-onnx-funasr-nano-zh-en/
├── encoder_adaptor.onnx    # Required: Encoder adaptor
├── llm.onnx                # Required: Language model
├── embedding.onnx          # Required: Embedding model
├── tokenizer/              # Required: Tokenizer directory
│   └── ...
├── encoder_adaptor.int8.onnx  # Optional: Quantized encoder
└── llm.int8.onnx           # Optional: Quantized LLM
```

## Platform-Specific Setup

### Android Setup

1. **Create model directory**:
   ```
   android/app/src/main/assets/models/
   ```

2. **Extract model files** to the directory:
   ```bash
   # Example: Extract Zipformer model
   cd android/app/src/main/assets/models/
   tar -xjf sherpa-onnx-zipformer-en-2023-06-26.tar.bz2
   ```

3. **Directory structure should be**:
   ```
   android/app/src/main/assets/models/
   └── sherpa-onnx-zipformer-en-2023-06-26/
       ├── encoder.onnx
       ├── decoder.onnx
       ├── joiner.onnx
       └── tokens.txt
   ```

4. **Use in code**:
   ```typescript
   await initializeSTT({
     modelPath: { type: 'asset', path: 'models/sherpa-onnx-zipformer-en-2023-06-26' }
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
   await initializeSTT({
     modelPath: { type: 'asset', path: 'sherpa-onnx-zipformer-en-2023-06-26' }
   });
   ```

### File System Storage (Alternative)

You can also store models in the device's file system:

```typescript
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';

const modelPath = Platform.select({
  ios: `${RNFS.DocumentDirectoryPath}/models/sherpa-onnx-zipformer-en-2023-06-26`,
  android: `${RNFS.ExternalDirectoryPath}/models/sherpa-onnx-zipformer-en-2023-06-26`,
});

await initializeSTT({
  modelPath: { type: 'file', path: modelPath! }
});
```

## Model Configuration Examples

### Basic Initialization (Auto-Detect)

```typescript
import { initializeSTT, transcribeFile } from 'react-native-sherpa-onnx/stt';

// Auto-detect model type and prefer int8 quantization
await initializeSTT('models/sherpa-onnx-zipformer-en-2023-06-26');

const transcription = await transcribeFile('path/to/audio.wav');
console.log('Transcription:', transcription);
```

### Explicit Model Type

```typescript
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-nemo-parakeet-tdt-ctc-en' },
  modelType: 'nemo_ctc',  // Explicit type
  preferInt8: true         // Prefer quantized models
});
```

### Quantization Control

```typescript
// Default: try int8 first, then regular
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/my-model' }
});

// Explicitly prefer int8 models (smaller, faster)
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/my-model' },
  preferInt8: true
});

// Explicitly prefer regular models (higher accuracy)
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/my-model' },
  preferInt8: false
});
```

### Complete Example

```typescript
import {
  initializeSTT,
  transcribeFile,
  unloadSTT
} from 'react-native-sherpa-onnx/stt';
import { resolveModelPath } from 'react-native-sherpa-onnx';

async function speechToTextExample() {
  try {
    // Resolve model path
    const modelPath = await resolveModelPath({
      type: 'asset',
      path: 'models/sherpa-onnx-whisper-tiny'
    });

    // Initialize with Whisper model
    await initializeSTT({
      modelPath,
      modelType: 'whisper'
    });

    // Transcribe audio file
    const transcription = await transcribeFile('path/to/audio.wav');
    console.log('Transcription:', transcription);

    // Cleanup
    await unloadSTT();
  } catch (error) {
    console.error('STT Error:', error);
  }
}
```

### Multi-Model Example

```typescript
// English model for English audio
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-zipformer-en-2023-06-26' },
  modelType: 'transducer'
});

const englishResult = await transcribeFile('english.wav');

// Switch to Chinese model
await unloadSTT();
await initializeSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-paraformer-zh-2023-09-14' },
  modelType: 'paraformer'
});

const chineseResult = await transcribeFile('chinese.wav');
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

**Error**: `Failed to initialize` or `Cannot auto-detect model type`

**Solutions**:
- Verify all required files are present (see [File Structure Requirements](#file-structure-requirements))
- Check file names match exactly (case-sensitive)
- Ensure `tokens.txt` exists
- For Zipformer: Verify all three files (`encoder.onnx`, `decoder.onnx`, `joiner.onnx`) exist
- For Whisper: Verify both `encoder.onnx` and `decoder.onnx` exist
- Try specifying `modelType` explicitly

### Transcription Failed

**Error**: `Transcription failed` or empty result

**Solutions**:
- Ensure STT is initialized before calling `transcribeFile()`
- Verify audio file format: **WAV, 16kHz, mono, 16-bit PCM**
- Check audio file exists and path is correct
- Try with a different audio file to isolate the issue
- Enable debug logging if available

### Audio Format Issues

**Symptoms**: Empty transcription, garbled output, or crashes

**Solutions**:
- Convert audio to correct format:
  ```bash
  # Using ffmpeg
  ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 output.wav
  ```
- Ensure sample rate is exactly 16kHz (16000 Hz)
- Ensure mono (single channel)
- Ensure 16-bit PCM encoding

### Performance Issues

**Symptoms**: Slow transcription, high CPU usage, crashes on long audio

**Solutions**:
- Use quantized models (`.int8.onnx`) - set `preferInt8: true`
- Use smaller models (e.g., Whisper Tiny instead of Medium)
- Split long audio files into shorter segments
- For Zipformer: Use the "small" variant
- Close other apps to free memory

### Model-Specific Issues

#### Whisper Models

**Issue**: Incorrect language detection

**Solution**: Use language-specific Whisper models (e.g., `tiny.en` for English)

#### NeMo CTC Models

**Issue**: Model too large, out of memory

**Solution**: Use int8 quantized versions or smaller models

#### FunASR Nano

**Issue**: Tokenizer directory not found

**Solution**: Ensure entire `tokenizer/` directory is copied, not just individual files

### iOS Build Errors

**Error**: Headers not found or framework missing

**Solutions**:
- Ensure sherpa-onnx XCFramework is installed: `cd ios && pod install`
- Check Podspec configuration
- Verify framework is in Build Phases → Link Binary With Libraries

### Android Build Errors

**Error**: Native library not found

**Solutions**:
- Clean and rebuild: `cd android && ./gradlew clean`
- Verify `android/build.gradle` has correct sherpa-onnx dependency
- Check JNI library is properly linked in CMake

## Model Size Comparison

| Model | Size | Accuracy | Speed | Best For |
|-------|------|----------|-------|----------|
| Whisper Tiny | ~74 MB | Good | Very Fast | Mobile, quick transcription |
| Zipformer Small | ~66 MB | Very Good | Fast | Production, English |
| Paraformer | ~220 MB | Very Good | Fast | Chinese, batch processing |
| Whisper Base | ~140 MB | Very Good | Fast | Multilingual, general use |
| NeMo CTC | ~700 MB | Excellent | Medium | English, high accuracy |
| Whisper Small | ~460 MB | Excellent | Medium | Multilingual, high quality |
| Whisper Medium | ~1.5 GB | Excellent | Slow | Server-side, best quality |

## Audio Format Requirements

All models require audio in **WAV format** with these specifications:

- **Sample Rate**: 16000 Hz (16 kHz)
- **Channels**: 1 (mono)
- **Bit Depth**: 16-bit
- **Encoding**: PCM (uncompressed)

**Conversion Examples**:

```bash
# Using ffmpeg
ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 output.wav

# Using sox
sox input.mp3 -r 16000 -c 1 -b 16 output.wav
```

## Additional Resources

- [sherpa-onnx STT Documentation](https://k2-fsa.github.io/sherpa/onnx/index.html)
- [All Pre-trained Models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)
- [sherpa-onnx GitHub](https://github.com/k2-fsa/sherpa-onnx)
- [Model Training Guides](https://k2-fsa.github.io/sherpa/onnx/training/index.html)

## License Notes

Models have different licenses:
- **Zipformer**: Apache 2.0
- **Paraformer**: MIT (via FunASR)
- **Whisper**: MIT (OpenAI)
- **NeMo**: Apache 2.0 (NVIDIA)
- **WeNet**: Apache 2.0
- **SenseVoice**: Check model documentation

Always verify license compatibility with your use case before deployment.
