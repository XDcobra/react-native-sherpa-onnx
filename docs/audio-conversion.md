# Audio conversion API

This document describes the SDK's audio conversion helpers used to produce WAV (and optionally MP3/FLAC) in the format expected by sherpa-onnx (16 kHz mono 16-bit PCM for STT) or for saving TTS output in different formats.

## Overview

The conversion API is exposed from the **`react-native-sherpa-onnx/audio`** module:

- **Android**: Implemented with FFmpeg (prebuilts or AAR). All formats (WAV, MP3, FLAC) share a single conversion pipeline with proper resampling, accumulator-buffered encoding, and monotonic PTS handling. Input can be a file path or a `content://` URI; content URIs are transparently copied to a temporary file. Decoding to float PCM (`decodeAudioFileToFloatSamples`) uses the same FFmpeg decode path; WAV files may use a fast path via sherpa-onnx `WaveReader` when no resampling is requested.
- **iOS**: Implemented with FFmpeg when linked (same family as conversion). Supports common input formats (MP3, AAC, FLAC, WAV, WebM, etc.). When FFmpeg is disabled, decode/conversion helpers fail at runtime; see [disable-ffmpeg.md](disable-ffmpeg.md).

## API reference

### `convertAudioToFormat(inputPath, outputPath, format, outputSampleRateHz?)`

Converts an audio file to a requested format.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Absolute file path, or on Android a `content://` URI. |
| `outputPath` | `string` | Absolute path for the output file. |
| `format` | `string` | Target format: `"wav"`, `"mp3"`, `"flac"`, `"m4a"`, `"aac"`, `"opus"`, `"oggm"`, `"webm"`, `"mkv"`. |
| `outputSampleRateHz` | `number` (optional) | For MP3: 32000, 44100, or 48000. For Opus: 8000, 12000, 16000, 24000, or 48000. Ignored for WAV/FLAC. WAV output is always 16 kHz mono. |

**Returns:** `Promise<void>` — resolves on success, rejects with an error message on failure.

**Platform notes:**

- **Android**: All three output formats supported. Requires FFmpeg (see [Disabling FFmpeg](disable-ffmpeg.md) if you need to avoid it).
- **iOS**: Only `format === "wav"` is supported. For `"mp3"` or `"flac"` the promise rejects.

### `convertAudioToWav16k(inputPath, outputPath)`

Converts any supported audio file to WAV 16 kHz mono 16-bit PCM — the format expected by sherpa-onnx for offline STT (`transcribeFile`). Internally delegates to `convertAudioToFormat(inputPath, outputPath, "wav")`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Absolute file path, or on Android a `content://` URI. |
| `outputPath` | `string` | Absolute path for the output WAV file. |

**Returns:** `Promise<void>` — resolves on success, rejects with an error message on failure.

### `decodeAudioFileToFloatSamples(inputPath, targetSampleRateHz?)`

Decodes an audio file to **mono float samples** (approximately in `[-1, 1]`) and the **effective sample rate** of those samples. Same input coverage as `convertAudioToFormat` (FFmpeg-backed where applicable).

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Absolute file path, or on Android a `content://` URI. |
| `targetSampleRateHz` | `number` (optional) | If `> 0`, resample to this rate after decode (mono). If `0` or omitted, keep the stream’s native decoded rate. |

**Returns:** `Promise<{ samples: number[]; sampleRate: number }>` — rejects with an error message on failure.

**Platform notes:**

- **Android**: Non-WAV formats require FFmpeg. WAV may use `WaveReader` when `targetSampleRateHz` is `0` or matches the file rate; otherwise FFmpeg is used (e.g. resampling or unsupported WAV features).
- **iOS**: Requires FFmpeg in the build. Returns an error if FFmpeg is not linked.

## Platform support matrix

| Feature | Android | iOS |
|---------|---------|-----|
| Input: file path | Yes | Yes |
| Input: `content://` URI | Yes (auto-copied to temp) | N/A (picker returns `file://`) |
| Output: WAV 16 kHz mono | Yes (FFmpeg) | Yes (FFmpeg; unavailable if FFmpeg is disabled or not linked) |
| Output: MP3 | Yes (libshine) | Yes (libshine) |
| Output: FLAC | Yes (FFmpeg) | Yes (FFmpeg) |
| Output: AAC / M4A | Yes (FFmpeg) | Yes (FFmpeg) |
| Output: OPUS / WEBM / MKV | Yes (libopus) | Yes (libopus) |
| Decode to float PCM (`decodeAudioFileToFloatSamples`) | Yes (FFmpeg; WAV fast path when applicable) | Yes (FFmpeg) |
| Disable conversion | Yes, see [disable-ffmpeg.md](disable-ffmpeg.md) | Yes |

## Content URI support (Android)

On Android, both functions accept `content://` URIs. The SDK:

1. Copies the URI content to a temporary cache file via `ContentResolver`.
2. Passes the temp file to the native converter.
3. Deletes the temp file after conversion.

You do not need to copy the file yourself before calling. However, for reliability (some content providers have transient reads), copying to local cache right after the user picks a file is recommended.

## STT integration example

Pick file --> copy to cache --> validate --> convert to 16 kHz WAV if non-WAV --> transcribe --> cleanup.

```ts
import * as DocumentPicker from '@react-native-documents/picker';
import { convertAudioToWav16k } from 'react-native-sherpa-onnx/audio';
import { copyContentUriToCache } from 'react-native-sherpa-onnx/files';
import { CachesDirectoryPath, copyFile, stat, unlink } from '@dr.pogodin/react-native-fs';

// 1. Pick audio file
const res = await DocumentPicker.pick({ type: [DocumentPicker.types.audio] });
const file = Array.isArray(res) ? res[0] : res;
const uri = file.uri;
const name = file.name || 'audio.wav';
const ext = name.toLowerCase().endsWith('.mp3') ? 'mp3'
          : name.toLowerCase().endsWith('.flac') ? 'flac' : 'wav';

// 2. Copy to local cache (content:// or file path)
const cacheFileName = `stt_picked_${Date.now()}.${ext}`;
const cachePath = uri.startsWith('content://')
  ? await copyContentUriToCache(uri, cacheFileName)
  : await (async () => {
      const dest = `${CachesDirectoryPath}/${cacheFileName}`;
      await copyFile(uri, dest);
      return dest;
    })();

// 3. Validate
const info = await stat(cachePath);
if (info.size < 1024) {
  await unlink(cachePath).catch(() => {});
  throw new Error('File too small — may be corrupt.');
}

// 4. Convert to 16 kHz WAV if non-WAV, then transcribe
let pathToTranscribe = cachePath;
let tempWavPath: string | null = null;
if (ext === 'mp3' || ext === 'flac') {
  tempWavPath = `${CachesDirectoryPath}/stt_${Date.now()}_16k.wav`;
  await convertAudioToWav16k(cachePath, tempWavPath);
  pathToTranscribe = tempWavPath;
}

try {
  const result = await engine.transcribeFile(pathToTranscribe);
  // use result...
} finally {
  if (tempWavPath) await unlink(tempWavPath).catch(() => {});
}
```

> **Tip:** WAV files can be passed directly to `transcribeFile` — sherpa-onnx's `WaveReader` handles any WAV sample rate natively. Only MP3/FLAC need conversion.

## TTS save example

**Recommended:** encode and write in one step with **`saveAudioFromGeneration`** (native PCM → codec; no app-managed WAV temp file).

```ts
import { CachesDirectoryPath } from '@dr.pogodin/react-native-fs';
import { saveAudioFromGeneration } from 'react-native-sherpa-onnx/tts';

// Android SAF — MP3 (requires FFmpeg)
const savedUri = await saveAudioFromGeneration(
  audio,
  { kind: 'androidContent', directoryUri, filename: 'output.mp3' },
  { format: 'mp3' }
);

// Local file — FLAC
const path = await saveAudioFromGeneration(
  audio,
  { kind: 'file', path: `${CachesDirectoryPath}/out.flac` },
  { format: 'flac' }
);
```

**Alternative (still valid):** file-based pipeline using `react-native-sherpa-onnx/audio` — save WAV, `convertAudioToFormat`, then `copyFileToContentUri` from [`react-native-sherpa-onnx/files`](files.md) for SAF. See [TTS offline — Persistence](tts-offline.md#persistence--sharing).

## Disabling FFmpeg (Android)

If you need to avoid shipping FFmpeg (e.g. symbol clashes), see [disable-ffmpeg.md](disable-ffmpeg.md). When disabled, `convertAudioToFormat` and `convertAudioToWav16k` reject at runtime; you must use WAV or another conversion path.
