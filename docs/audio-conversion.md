# Audio conversion API

This document describes the SDK’s audio conversion helpers used to produce WAV (and optionally MP3/FLAC) in the format expected by sherpa-onnx (16 kHz mono 16-bit PCM for STT) or for saving TTS output in different formats.

## Overview

The conversion API is exposed from the **`react-native-sherpa-onnx/audio`** module:

- **Android**: Implemented with FFmpeg (prebuilts or AAR). Supports many input formats (MP3, FLAC, WAV, OGG, etc.) and output formats WAV, MP3, FLAC. Input can be a file path or a `content://` URI; content URIs are copied to a temporary file before conversion, then the temp file is deleted.
- **iOS**: Implemented with AVFoundation. Supports common input formats (MP3, AAC, FLAC, WAV, AIFF, etc.) and **WAV output only** (16 kHz mono). MP3/FLAC encoding is not available on iOS; use WAV or convert server-side.

## API reference

### `convertAudioToFormat(inputPath, outputPath, format, outputSampleRateHz?)`

Converts an audio file to a requested format.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Absolute file path, or on Android a `content://` URI (e.g. from a document picker). |
| `outputPath` | `string` | Absolute path for the output file. |
| `format` | `string` | Target format: `"wav"`, `"mp3"`, or `"flac"`. |
| `outputSampleRateHz` | `number` (optional) | For MP3: 32000, 44100, or 48000; 0 or omitted = 44100. Ignored for WAV/FLAC. WAV output is always 16 kHz mono. |

**Returns:** `Promise<void>` — resolves on success, rejects with an error message on failure.

**Platform notes:**

- **Android**: All three output formats supported. Requires FFmpeg (see [Disabling FFmpeg](disable-ffmpeg.md) if you need to avoid it).
- **iOS**: Only `format === "wav"` is supported. For `"mp3"` or `"flac"` the promise rejects with a message indicating MP3/FLAC encoding is not available on iOS.

### `convertAudioToWav16k(inputPath, outputPath)`

Converts any supported audio file to WAV 16 kHz mono 16-bit PCM, which is the format expected by sherpa-onnx for offline STT (e.g. `transcribeFile`).

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Absolute file path, or on Android a `content://` URI. |
| `outputPath` | `string` | Absolute path for the output WAV file. |

**Returns:** `Promise<void>` — resolves on success, rejects with an error message on failure.

**Platform notes:**

- **Android**: Uses FFmpeg; supports MP3, FLAC, WAV, OGG, etc.
- **iOS**: Uses AVFoundation; supports MP3, AAC, FLAC, WAV, AIFF, and other formats supported by `AVAudioFile`.

## Platform support matrix

| Feature | Android | iOS |
|---------|---------|-----|
| Input: file path | Yes | Yes |
| Input: `content://` URI | Yes (copied to temp, then converted) | N/A (picker returns `file://`) |
| Output: WAV 16 kHz mono | Yes (FFmpeg) | Yes (AVFoundation) |
| Output: MP3 | Yes (libshine) | No (rejects) |
| Output: FLAC | Yes (FFmpeg) | No (rejects) |
| Disable conversion (e.g. no FFmpeg) | Yes, see [disable-ffmpeg.md](disable-ffmpeg.md) | N/A |

## Content URI support (Android)

On Android, both `convertAudioToFormat` and `convertAudioToWav16k` accept `content://` URIs (e.g. from the Storage Access Framework or a document picker). The SDK:

1. Detects `content://` by prefix.
2. Copies the URI content to a temporary file in the app cache using `ContentResolver.openInputStream(uri)`.
3. Passes the temp file path to the native converter (FFmpeg).
4. Deletes the temp file after conversion.

You do not need to copy the file yourself before calling these functions. However, copying to app storage immediately after the user picks a file (e.g. with `RNFS.copyFile` or the picker’s `keepLocalCopy`) and then passing the local path can be more reliable on some devices where content provider reads are limited or transient.

## Best practices

1. **Prefer local file paths**  
   When possible, copy the user’s selection to app cache or files dir first, then pass the local path to the conversion API. This avoids content-provider quirks and keeps a single code path.

2. **Document picker flow**  
   When using a document picker:
   - Copy the picked URI to a local file (e.g. `RNFS.copyFile(uri, cachePath)`) right after the pick.
   - Validate the copied file (e.g. size &gt; 1024 bytes) to detect corrupt or empty files.
   - Store only the local path in app state and use it for conversion and transcription.

3. **Validate file size after copy**  
   If you copy a content URI to cache, check the copied file size. Very small files (e.g. &lt; 1 KB) often indicate a failed or truncated copy or a corrupt source; show a clear error and ask the user to re-export or pick again.

4. **Clean up temporary WAV files**  
   After STT transcription, delete any temporary WAV file you created for conversion (e.g. in a `finally` block) to avoid filling the cache.

5. **Error handling**  
   Conversion can fail (unsupported format, corrupt file, or on Android if FFmpeg is disabled). Always catch rejections and show a user-friendly message or fallback.

## STT integration example

Complete flow: pick file → copy to cache → validate → convert to WAV if needed → transcribe → cleanup.

```ts
import * as DocumentPicker from '@react-native-documents/picker';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';
import { CachesDirectoryPath, copyFile, stat, unlink } from '@dr.pogodin/react-native-fs';

// After user picks an audio file:
const res = await DocumentPicker.pick({ type: [DocumentPicker.types.audio] });
const file = Array.isArray(res) ? res[0] : res;
const uri = file.uri;
const name = file.name || 'audio.wav';
const ext = name.toLowerCase().endsWith('.mp3') ? 'mp3' : name.toLowerCase().endsWith('.flac') ? 'flac' : 'wav';
const cachePath = `${CachesDirectoryPath}/stt_picked_${Date.now()}.${ext}`;

await copyFile(uri, cachePath);
const info = await stat(cachePath);
if (info.size < 1024) {
  await unlink(cachePath).catch(() => {});
  throw new Error(`File too small (${info.size} bytes). It may be corrupt.`);
}

// Later, when transcribing:
let pathToTranscribe = cachePath;
let wavPath: string | null = null;
if (ext === 'mp3' || ext === 'flac') {
  wavPath = `${CachesDirectoryPath}/stt_${Date.now()}.wav`;
  await convertAudioToFormat(cachePath, wavPath, 'wav');
  pathToTranscribe = wavPath;
}

const result = await engine.transcribeFile(pathToTranscribe);

if (wavPath) {
  await unlink(wavPath).catch(() => {});
}
```

## TTS integration example

For saving TTS audio as MP3 or FLAC (e.g. to a content URI on Android), the flow is: generate WAV → convert to target format → copy to destination. See [TTS documentation](tts.md#saving-mp3flac-to-content-uri-android) for the full save flow and `copyFileToContentUri`.

## Disabling FFmpeg (Android)

If you need to avoid shipping or using FFmpeg in this SDK (e.g. to prevent symbol clashes with another FFmpeg in your app), see [disable-ffmpeg.md](disable-ffmpeg.md). When FFmpeg is disabled, `convertAudioToFormat` and `convertAudioToWav16k` return an error at runtime; you must use another conversion path or only pass already-decoded WAV to sherpa-onnx.
