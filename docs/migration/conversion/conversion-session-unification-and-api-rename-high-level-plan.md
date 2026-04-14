# Conversion migration — Implementation spec (unified sessions + API rename)

## Purpose

This document is the concrete implementation spec for unifying the audio conversion pipeline with the shared `AudioDecodeSession` / `AudioEncodeSession` architecture and renaming the public API.

The migration is intentionally breaking. No aliases, no deprecation period.

---

## Table of Contents

1. [Scope and decisions](#scope-and-decisions)
2. [Target architecture](#target-architecture)
3. [TypeScript public API — new types](#typescript-public-api--new-types)
4. [TurboModule spec changes](#turbomodule-spec-changes)
5. [C++ AudioEncodeSession — new primitive](#c-audioencodesession--new-primitive)
6. [Native bridge changes — Android](#native-bridge-changes--android)
7. [Native bridge changes — iOS](#native-bridge-changes--ios)
8. [Progress and cancellation model](#progress-and-cancellation-model)
9. [Legacy code removal](#legacy-code-removal)
10. [Docs and examples update plan](#docs-and-examples-update-plan)
11. [Migration phases](#migration-phases)
12. [Breaking changes summary](#breaking-changes-summary)
13. [Validation and acceptance criteria](#validation-and-acceptance-criteria)
14. [Resolved design decisions](#resolved-design-decisions)

---

## Scope and decisions

### In scope

| Old name | New name | Change type |
|----------|----------|-------------|
| `convertAudioToFormat` | `saveAudioAsFile` | Public API rename + input type expansion |
| `convertAudioToWav16k` | `saveAudioAsWav16k` | Public API rename |
| `AudioConversionOptions` | `SaveAudioOptions` | Type rename + new fields (`quality`, `bitrate`) |
| `ConversionErrorCode` | `AudioSaveErrorCode` | Error code object rename |
| `ConversionErrorCodeValue` | `AudioSaveErrorCodeValue` | Type rename |
| `CONVERSION_*` error string values | `AUDIO_SAVE_*` | Error string value rename |
| `convertPipelineAudioToDestination` (TurboModule) | `saveAudioBufferToFile` | Native bridge rename |
| — (new) | `saveFileAsAudioFile` (TurboModule) | New bridge method for `FileSource` → file encode |
| `cancelFileIO` (for conversion ops) | `cancelAudioSave` | Cancel bridge rename |
| `fileIOProgress` (event for conversion) | `audioSaveProgress` | Event channel rename |
| `saveOfflineAudioBufferToWav` | removed | Consolidated into `saveAudioAsFile` (see [D7](#d7-saveofflineaudiobuffertowav-removed-consolidated-into-saveaudioasfile)) |
| Legacy `audio_convert_file.cpp` + `audio_pcm_to_format.cpp` | Replaced by `AudioEncodeSession` | Internal refactor |
| Legacy `sherpa-onnx-audio-convert-jni.cpp` | Replaced by new JNI entry | Internal refactor |
| Legacy `SherpaOnnxAudioConvert.mm` | Replaced by direct C++ calls | Internal refactor |

### Out of scope

- Compatibility aliases or deprecation period
- New output formats (current set: wav, mp3, flac, aac, m4a, opus, webm, mkv, ogg)
- Changing `AudioOutputFormat` type (values stay the same)

---

## Target architecture

```
JS: saveAudioAsFile(input, output, format, options?)
│
├─ discriminate input type:
│   ├─ PipelineAudioBufferIdSource → resolvePipelineAudioBufferId(input) → bufferId (string)
│   └─ FileSource → pass through as object
├─ serialize FileDestination → bridge Object
├─ generateOperationId() → operationId
├─ subscribe "audioSaveProgress" event
│
▼ TurboModule bridge (two methods, dispatched by input type)
│
├─ saveAudioBufferToFile(bufferId, destination, format, sampleRateHz, bitrate, quality, operationId)
│   ▼ Native (Kotlin / ObjC++)
│   ├─ validate format + sample rate + quality/bitrate
│   ├─ resolve FileDestination → output path/fd (SEEKABLE mode)
│   ├─ resolve buffer source:
│   │   ├─ offline file-backed   → AudioDecodeSession(filePath) → chunks
│   │   ├─ offline in-memory     → direct PCM chunks (no decode needed)
│   │   ├─ live finalized+spool  → AudioDecodeSession(spoolPath) → chunks
│   │   └─ live finalized no-spool → ring snapshot → direct PCM chunks
│   ├─ create AudioEncodeSession(outputPath, format, sampleRate, channels, bitrate, quality)
│   ├─ feed chunks → encodeSession.feedChunk(samples, frameCount)
│   ├─ encodeSession.finish()
│   └─ emit throttled progress events via "audioSaveProgress"
│
└─ saveFileAsAudioFile(source, destination, format, sampleRateHz, bitrate, quality, operationId)
    ▼ Native (Kotlin / ObjC++)
    ├─ validate format + sample rate + quality/bitrate
    ├─ resolve FileSource → input path/fd
    ├─ resolve FileDestination → output path/fd (SEEKABLE mode)
    ├─ AudioDecodeSession(inputPath) → chunks
    ├─ create AudioEncodeSession(outputPath, format, decodedSampleRate, channels, bitrate, quality)
    ├─ decode callback → encodeSession.feedChunk(samples, frameCount)
    ├─ encodeSession.finish()
    └─ emit throttled progress events via "audioSaveProgress"
│
▼ Return
{ outputKind: "fs"|"contentUri", outputPath: string }
```

### Data flow variants

| Input type | Decode needed? | Source data | Encode input |
|---|---|---|---|
| Offline file-backed buffer | Yes | `AudioDecodeSession` reads buffer file | Decode chunks → `AudioEncodeSession` |
| Offline in-memory buffer | No | `float[]` from `PaOfflineEntry` | Slice into CHUNK_FRAMES → `AudioEncodeSession` |
| Live finalized + spool WAV | Yes | `AudioDecodeSession` reads spool | Decode chunks → `AudioEncodeSession` |
| Live finalized no spool | No | Ring buffer snapshot `float[]` | Slice into CHUNK_FRAMES → `AudioEncodeSession` |
| **`FileSource` (file-to-file)** | **Yes** | **`AudioDecodeSession` reads source file** | **Decode chunks → `AudioEncodeSession`** |

The `FileSource` path bypasses the buffer registry entirely — no intermediate buffer allocation, no temp files. This is the most efficient path for "convert audio file A to format B" use cases.

---

## TypeScript public API — new types

### `src/audio/types.ts` (full replacement)

```ts
import type { FileSource } from '../fileio/types';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';

/**
 * Supported output formats for audio save operations.
 * WAV is always 16-bit signed PCM.
 */
export type AudioOutputFormat =
  | 'wav'
  | 'mp3'
  | 'flac'
  | 'aac'
  | 'm4a'
  | 'opus'
  | 'webm'
  | 'mkv'
  | 'ogg';

/**
 * Input for audio save operations.
 *
 * - PipelineAudioBufferIdSource: save an existing offline or finalized live buffer.
 * - FileSource: direct file-to-file encode (no buffer registry involvement).
 */
export type AudioSaveInput = PipelineAudioBufferIdSource | FileSource;

/**
 * Progress event emitted during audio save operations.
 */
export interface AudioSaveProgressEvent {
  /** Unique operation identifier for correlation. */
  operationId: string;
  /** Current phase: "decode" (file-backed/FileSource input), "encode", or "finalize". */
  phase: 'decode' | 'encode' | 'finalize';
  /** Frames processed so far in current phase. */
  framesProcessed: number;
  /** Estimated total frames (0 if unknown). */
  totalFramesEstimate: number;
  /** Progress percentage 0–100 (0 when total unknown). */
  percent: number;
}

/**
 * Options for audio save operations.
 */
export interface SaveAudioOptions {
  /**
   * Target sample rate. Semantics depend on format:
   * - WAV:  0 or omitted = source's native sample rate. Explicit value = resample.
   * - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
   * - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
   * - FLAC/AAC/M4A: 0 = source's native rate. Explicit value = resample.
   */
  outputSampleRateHz?: number;

  /**
   * Encoding quality hint for lossy formats.
   * Mapped to format-specific internal settings:
   * - MP3:  low=64kbps, medium=128kbps, high=192kbps
   * - AAC:  low=64kbps, medium=128kbps, high=192kbps
   * - Opus: low=24kbps, medium=64kbps, high=128kbps
   * Ignored for lossless formats (WAV, FLAC).
   * Overridden by explicit `bitrate` if both are set.
   */
  quality?: 'low' | 'medium' | 'high';

  /**
   * Target bitrate in kbps for lossy formats.
   * Takes precedence over `quality` if both are specified.
   * Ignored for lossless formats (WAV, FLAC).
   * 0 or omitted = use `quality` mapping or codec default.
   */
  bitrate?: number;

  /** AbortSignal to cancel the save operation. */
  signal?: AbortSignal;

  /** Progress callback — wired to native "audioSaveProgress" events. */
  onProgress?: (event: AudioSaveProgressEvent) => void;
}

/**
 * Error codes for audio save operations.
 * String values use the `AUDIO_SAVE_*` prefix.
 */
export const AudioSaveErrorCode = {
  /** Input argument is invalid (bad buffer ID format, invalid FileSource). */
  INVALID_ARGUMENT: 'AUDIO_SAVE_INVALID_ARGUMENT',
  /** Buffer not found in native registry. */
  BUFFER_NOT_FOUND: 'AUDIO_SAVE_BUFFER_NOT_FOUND',
  /** Live buffer is still in recording state — must be finalized first. */
  BUFFER_NOT_FINALIZED: 'AUDIO_SAVE_BUFFER_NOT_FINALIZED',
  /** Buffer contains zero samples. */
  BUFFER_EMPTY: 'AUDIO_SAVE_BUFFER_EMPTY',
  /** Source file not found or not readable (FileSource input). */
  SOURCE_NOT_FOUND: 'AUDIO_SAVE_SOURCE_NOT_FOUND',
  /** Unsupported format or format unavailable. */
  UNSUPPORTED_FORMAT: 'AUDIO_SAVE_UNSUPPORTED_FORMAT',
  /** Invalid outputSampleRateHz for the requested format. */
  INVALID_SAMPLE_RATE: 'AUDIO_SAVE_INVALID_SAMPLE_RATE',
  /** Invalid quality or bitrate value. */
  INVALID_QUALITY: 'AUDIO_SAVE_INVALID_QUALITY',
  /** Native encoding/conversion error. */
  ENCODE_ERROR: 'AUDIO_SAVE_ENCODE_ERROR',
  /** Output file could not be written. */
  FILE_WRITE_ERROR: 'AUDIO_SAVE_FILE_WRITE_ERROR',
  /** Operation was cancelled via AbortSignal. */
  CANCELLED: 'AUDIO_SAVE_CANCELLED',
} as const;

export type AudioSaveErrorCodeValue =
  (typeof AudioSaveErrorCode)[keyof typeof AudioSaveErrorCode];
```

Key changes vs current:
- `AudioConversionOptions` → `SaveAudioOptions`
- `ConversionErrorCode` → `AudioSaveErrorCode`
- `CONVERSION_*` prefixes → `AUDIO_SAVE_*`
- Added `CANCELLED` error code (was previously using `FILEIO_CANCELLED`)
- Renamed `CONVERT_ERROR` → `ENCODE_ERROR` (more accurate)
- Added `SOURCE_NOT_FOUND` for FileSource input errors
- Added `INVALID_QUALITY` for bad quality/bitrate values
- Progress callback type changed: `FileIOProgressEvent` → `AudioSaveProgressEvent` (includes `phase` + `operationId`)
- New `AudioSaveInput` union type accepting both buffer refs and `FileSource`
- New `quality` and `bitrate` fields on `SaveAudioOptions`

### `src/audio/index.ts` (full replacement)

```ts
import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';
import type {
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
  AudioSaveProgressEvent,
} from './types';
import type { FileDestination, FileSource, ResolvedFileRef } from '../fileio/types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';

let eventEmitter: NativeEventEmitter | null = null;
function getEventEmitter(): NativeEventEmitter {
  if (!eventEmitter) {
    eventEmitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  }
  return eventEmitter;
}

let idCounter = 0;
function generateOperationId(): string {
  return `save_${Date.now()}_${++idCounter}`;
}

function parseResolvedFileRef(result: {
  outputKind: string;
  outputPath: string;
}): ResolvedFileRef {
  if (result.outputKind === 'contentUri') {
    return { kind: 'contentUri', uri: result.outputPath };
  }
  return { kind: 'fs', path: result.outputPath };
}

/**
 * Type guard: returns true if the input is a FileSource (has a `kind` property
 * matching one of the FileSource discriminants).
 */
function isFileSource(input: AudioSaveInput): input is FileSource {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    typeof (input as any).kind === 'string' &&
    ['fs', 'app', 'contentUri', 'securityScoped', 'pad'].includes(
      (input as any).kind
    )
  );
}

/**
 * Map quality string to internal numeric value (0=default, 1=low, 2=medium, 3=high).
 */
function mapQuality(quality?: 'low' | 'medium' | 'high'): number {
  switch (quality) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    default: return 0;
  }
}

/**
 * Save audio to an encoded file at the given destination.
 *
 * Input can be:
 * - A pipeline audio buffer (offline or finalized live): ref, handle, info, or raw ID string.
 * - A FileSource for direct file-to-file encoding without intermediate buffers.
 *
 * Output: FileDestination descriptor.
 * Returns a ResolvedFileRef pointing to the written file.
 */
export async function saveAudioAsFile(
  input: AudioSaveInput,
  output: FileDestination,
  format: AudioOutputFormat,
  options?: SaveAudioOptions
): Promise<ResolvedFileRef> {
  const operationId = generateOperationId();
  const outputSampleRateHz = options?.outputSampleRateHz ?? 0;
  const bitrate = options?.bitrate ?? 0;
  const quality = mapQuality(options?.quality);

  let progressSubscription: { remove: () => void } | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    // Progress listener — listens to native "audioSaveProgress" events
    if (options?.onProgress) {
      const emitter = getEventEmitter();
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener(
        'audioSaveProgress',
        (event: AudioSaveProgressEvent) => {
          if (event.operationId === operationId) {
            onProgress(event);
          }
        }
      );
    }

    // AbortSignal → native cancel
    if (options?.signal) {
      if (options.signal.aborted) {
        throw Object.assign(new Error('Operation cancelled'), {
          code: 'AUDIO_SAVE_CANCELLED',
        });
      }
      abortHandler = () => {
        SherpaOnnx.cancelAudioSave(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    let result: { outputKind: string; outputPath: string };

    if (isFileSource(input)) {
      // File-to-file path: AudioDecodeSession → AudioEncodeSession, no buffer registry
      result = await SherpaOnnx.saveFileAsAudioFile(
        input as any,
        output as any,
        format,
        outputSampleRateHz,
        bitrate,
        quality,
        operationId
      );
    } else {
      // Buffer path: resolve to string bufferId, look up in native registry
      result = await SherpaOnnx.saveAudioBufferToFile(
        resolvePipelineAudioBufferId(input),
        output as any,
        format,
        outputSampleRateHz,
        bitrate,
        quality,
        operationId
      );
    }

    return parseResolvedFileRef(result);
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Save audio as WAV 16 kHz mono 16-bit PCM.
 * Shortcut for saveAudioAsFile(input, output, 'wav', { outputSampleRateHz: 16000 }).
 *
 * Accepts both buffer references and FileSource.
 */
export function saveAudioAsWav16k(
  input: AudioSaveInput,
  output: FileDestination
): Promise<ResolvedFileRef> {
  return saveAudioAsFile(input, output, 'wav', {
    outputSampleRateHz: 16000,
  });
}

export type {
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
  AudioSaveProgressEvent,
} from './types';
export { AudioSaveErrorCode } from './types';
export type { AudioSaveErrorCodeValue } from './types';
```

### Exports affected

`src/index.tsx` does **not** re-export audio conversion (it's a subpath import `react-native-sherpa-onnx/audio`), so no changes needed there.

---

## TurboModule spec changes

### `src/NativeSherpaOnnx.ts`

Replace:

```ts
convertPipelineAudioToDestination(
  bufferId: string,
  destination: Object,
  format: string,
  outputSampleRateHz: number,
  operationId: string
): Promise<{
  outputKind: string;
  outputPath: string;
}>;
```

With:

```ts
/**
 * Save a pipeline audio buffer to an encoded file via AudioEncodeSession.
 * File-backed inputs are decoded via AudioDecodeSession first.
 * Direct PCM inputs are fed to the encoder in chunks without decode.
 *
 * @param bufferId - "off_*" or "live_*" (must be finalized if live)
 * @param destination - Serialized FileDestination
 * @param format - Target format string (wav, mp3, flac, etc.)
 * @param outputSampleRateHz - 0 = format-dependent default
 * @param bitrate - Target bitrate in kbps (0 = codec default or quality-derived)
 * @param quality - 0=default, 1=low, 2=medium, 3=high
 * @param operationId - For progress/cancel correlation
 */
saveAudioBufferToFile(
  bufferId: string,
  destination: Object,
  format: string,
  outputSampleRateHz: number,
  bitrate: number,
  quality: number,
  operationId: string
): Promise<{
  outputKind: string;
  outputPath: string;
}>;

/**
 * Encode a source audio file to an output file via AudioDecodeSession → AudioEncodeSession.
 * No buffer registry involvement — direct file-to-file pipeline.
 *
 * @param source - Serialized FileSource
 * @param destination - Serialized FileDestination
 * @param format - Target format string (wav, mp3, flac, etc.)
 * @param outputSampleRateHz - 0 = format-dependent default
 * @param bitrate - Target bitrate in kbps (0 = codec default or quality-derived)
 * @param quality - 0=default, 1=low, 2=medium, 3=high
 * @param operationId - For progress/cancel correlation
 */
saveFileAsAudioFile(
  source: Object,
  destination: Object,
  format: string,
  outputSampleRateHz: number,
  bitrate: number,
  quality: number,
  operationId: string
): Promise<{
  outputKind: string;
  outputPath: string;
}>;

/**
 * Cancel a running audio save operation.
 */
cancelAudioSave(operationId: string): Promise<void>;
```

Note: `cancelFileIO` remains for fileio copy operations. `cancelAudioSave` is the new dedicated entry point for audio save cancel. Both set the same `std::atomic<bool>` cancel flag on the C++ side.

Also remove (consolidated, see [D7](#d7-saveofflineaudiobuffertowav-removed-consolidated-into-saveaudioasfile)):

```ts
// REMOVE — consolidated into saveAudioAsFile / saveAudioBufferToFile:
nativeSaveOfflineBufferToWav(...): Promise<...>;
```

---

## C++ AudioEncodeSession — new primitive

### Header: `AudioEncodeSession.h`

Located in `android/src/main/cpp/jni/audio/` (shared source compiled by both Android CMakeLists.txt and iOS Xcode project).

```cpp
#pragma once

#include <string>
#include <memory>
#include <functional>
#include <atomic>

struct AudioEncodeConfig {
  const char* outputPath;               // Output file path (or /proc/self/fd/<n> for SAF)
  const char* formatHint;               // "wav", "mp3", "flac", "aac", "m4a", "opus", "webm", "mkv", "ogg"
  int inputSampleRate;                  // Source PCM sample rate
  int inputChannelCount;                // Source PCM channel count (typically 1)
  int outputSampleRateHz;               // 0 = format-dependent default

  /**
   * Target bitrate in kbps for lossy codecs. 0 = codec default or quality-derived.
   * Passed to AVCodecContext.bit_rate (×1000).
   * Ignored for lossless formats (WAV, FLAC).
   */
  int bitrate;

  /**
   * Quality hint: 0=default, 1=low, 2=medium, 3=high.
   * Mapped to format-specific settings:
   * - MP3 (libshine):  low=64kbps, medium=128kbps, high=192kbps
   * - AAC:             low=64kbps, medium=128kbps, high=192kbps
   * - Opus (libopus):  low=24kbps, medium=64kbps, high=128kbps
   * Ignored when `bitrate > 0` (explicit bitrate takes precedence).
   * Ignored for lossless formats (WAV, FLAC).
   */
  int quality;
};

/**
 * Progress callback for encode operations.
 * Called synchronously inside feedChunk() — the caller (bridge layer) controls
 * throttling and dispatch to JS (see D1).
 *
 * framesEncoded: total frames fed so far.
 * totalFramesEstimate: 0 if unknown.
 * percent: 0–100.
 */
using EncodeProgressCallback = std::function<void(int64_t framesEncoded, int64_t totalFramesEstimate, int percent)>;

/**
 * Streaming audio encoder backed by FFmpeg (with WAV fast-path, see D6).
 *
 * Usage:
 *   auto session = AudioEncodeSession::create(config, onProgress, cancelFlag);
 *   session->feedChunk(samples, frameCount);  // repeat
 *   session->finish();  // flush + close
 *
 * Thread safety: create/feedChunk/finish must be called from same thread.
 * Cancel flag can be set from any thread.
 *
 * WAV fast-path: when formatHint is "wav", the encoder bypasses FFmpeg entirely.
 * It writes a RIFF/WAV header directly, converts float32→S16LE inline, and
 * writes raw PCM data. If resampling is needed (outputSampleRateHz != inputSampleRate
 * and outputSampleRateHz != 0), only SwrContext is used for the resample step.
 * This avoids all avcodec/avformat overhead for the most common export format.
 */
class AudioEncodeSession {
public:
  /**
   * Create an encode session. Opens output file, initializes encoder.
   * For WAV: writes provisional RIFF header (data size = 0xFFFFFFFF),
   *          finalized in finish() with actual byte count.
   * For other formats: initializes FFmpeg muxer + encoder.
   * Returns nullptr + populates errorOut on failure.
   */
  static std::unique_ptr<AudioEncodeSession> create(
      const AudioEncodeConfig& config,
      EncodeProgressCallback onProgress,    // nullable
      std::atomic<bool>& cancelFlag,
      std::string& errorOut
  );

  ~AudioEncodeSession();

  /**
   * Feed a chunk of float32 interleaved PCM samples.
   *
   * The samples pointer must remain valid until feedChunk() returns (synchronous,
   * see D3). Internally copies whatever data it needs into the accumulation buffer.
   *
   * WAV fast-path: converts float32→S16LE and writes directly to output file.
   * FFmpeg path: resamples (if needed), accumulates to encoder frame boundary,
   *              encodes, and writes packets to muxer.
   *
   * Calls onProgress synchronously before returning (if set, see D1).
   *
   * Returns empty string on success, error message on failure.
   */
  std::string feedChunk(const float* samples, int frameCount);

  /**
   * Flush encoder, write trailer, close output.
   * WAV fast-path: seeks back to header and writes final data size.
   * FFmpeg path: flushes encoder, writes trailer via avformat.
   * Must be called exactly once after all feedChunk() calls.
   * Returns empty string on success, error message on failure.
   */
  std::string finish();

  /** Total frames fed so far. */
  int64_t framesEncoded() const;

private:
  AudioEncodeSession();
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
```

### Implementation: `AudioEncodeSession.cpp`

Extracted from the existing encode logic in `audio_pcm_to_format.cpp`.

#### Internal state (`Impl` struct)

```cpp
struct AudioEncodeSession::Impl {
  // --- Common ---
  bool isWavFastPath;                    // true when formatHint == "wav"
  int inputSampleRate;
  int outputSampleRate;                  // resolved (0 → format default)
  int inputChannelCount;
  int64_t totalFramesFed_;
  EncodeProgressCallback onProgress_;
  std::atomic<bool>& cancelFlag_;

  // --- WAV fast-path (D6) ---
  FILE* wavFile;                         // direct file handle
  int64_t wavDataBytesWritten;           // for finalizing RIFF header
  // If resample needed:
  SwrContext* wavSwr;                    // only for rate conversion
  std::vector<int16_t> wavResampleBuf;   // temp buffer for resampled S16LE

  // --- FFmpeg path ---
  AVFormatContext* outFmt;               // output muxer
  AVCodecContext* encCtx;                // encoder context
  SwrContext* swr;                       // resampler (input rate/format → encoder rate/format)
  std::vector<uint8_t> accumBuf;         // accumulation buffer for encoder frame alignment
  int accumOffset;                       // read offset (lazy compaction pattern from existing code)
  int encFrameSize;                      // encoder-required frame size
};
```

#### WAV fast-path implementation detail (D6)

When `formatHint == "wav"`:

1. **`create()`**: Open output file with `fopen()`. Write provisional 44-byte RIFF/WAV header with `dataSize = 0xFFFFFFFF` (placeholder). If `outputSampleRateHz != 0 && outputSampleRateHz != inputSampleRate`, initialize a `SwrContext` for float32@inputRate → S16LE@outputRate conversion. Otherwise, no SwrContext needed — just float32→S16LE conversion.

2. **`feedChunk(samples, frameCount)`**:
   - If no resample: convert float32→S16LE inline (`int16_t(clamp(sample, -1.0f, 1.0f) * 32767.0f)`), `fwrite()` to file.
   - If resample: feed float32 into SwrContext, receive S16LE frames, `fwrite()` to file.
   - Increment `wavDataBytesWritten`.
   - Call `onProgress_` synchronously (D1).

3. **`finish()`**: `fseek()` back to byte offset 4 (RIFF chunk size) and byte offset 40 (data chunk size), write actual sizes. `fclose()`.

This fast-path completely avoids `avformat_alloc_output_context2`, `avcodec_find_encoder`, `avcodec_open2`, `avformat_write_header`, `av_write_frame`, and `av_write_trailer`.

#### FFmpeg path (unchanged logic, refactored into session)

Same logic as current `sherpa_audio_convert_pcm_to_format()`:
- Codec selection: MP3→libshine, FLAC→flac, AAC→aac, Opus→libopus, others→format default
- `avcodec_get_supported_config` probing for channel layout + sample format
- Accumulation buffer + frame alignment pattern
- SwrContext setup for rate/format conversion
- `bitrate` applied: `encCtx->bit_rate = config.bitrate * 1000` (when > 0)
- `quality` mapped: when bitrate == 0 and quality > 0, derive bitrate from format-specific table (D5)

#### Bitrate resolution logic (D5)

```
if config.bitrate > 0:
    encCtx->bit_rate = config.bitrate * 1000    // explicit kbps
elif config.quality > 0:
    encCtx->bit_rate = QUALITY_TABLE[format][config.quality] * 1000
else:
    // codec default (no bit_rate set)
```

Quality table:

| Format | low (1) | medium (2) | high (3) |
|--------|---------|------------|----------|
| MP3    | 64 kbps | 128 kbps   | 192 kbps |
| AAC    | 64 kbps | 128 kbps   | 192 kbps |
| Opus   | 24 kbps | 64 kbps    | 128 kbps |

### Shared between platforms

`AudioEncodeSession.h` / `.cpp` is compiled into both Android (via CMakeLists.txt) and iOS (via Xcode build). Same source, no platform-specific code inside.

---

## Native bridge changes — Android

### `SherpaOnnxModule.kt` — method rename + session refactor

Old method: `convertPipelineAudioToDestination` → New: `saveAudioBufferToFile`

```kotlin
override fun saveAudioBufferToFile(
    bufferId: String,
    destination: ReadableMap,
    format: String,
    outputSampleRateHz: Double,
    bitrate: Double,
    quality: Double,
    operationId: String,
    promise: Promise
) {
    // 1. Validate format + sample rate + quality/bitrate
    // 2. Resolve destination → output path (SEEKABLE mode)
    // 3. Register cancel flag for operationId
    // 4. Route by buffer type:

    audioScope.launch {
        var outputPath: String? = null
        try {
            outputPath = resolveOutputPath(destination)

            when {
                bufferId.startsWith("off_") -> saveOfflineBuffer(
                    bufferId, outputPath, format, rate,
                    bitrate.toInt(), quality.toInt(), operationId
                )
                bufferId.startsWith("live_") -> saveLiveBuffer(
                    bufferId, outputPath, format, rate,
                    bitrate.toInt(), quality.toInt(), operationId
                )
                else -> throw IllegalArgumentException("Invalid buffer id")
            }

            val result = WritableNativeMap().apply {
                putString("outputKind", resolvedKind)
                putString("outputPath", resolvedPath)
            }
            promise.resolve(result)
        } catch (e: CancellationException) {
            // Cancel: auto-delete temp output file (D2)
            cleanupTempFile(outputPath)
            promise.reject("AUDIO_SAVE_CANCELLED", "Operation cancelled")
        } catch (e: Exception) {
            // Error: auto-delete temp output file (D2)
            cleanupTempFile(outputPath)
            promise.reject(mapErrorCode(e), e.message)
        }
    }
}
```

### New: `saveFileAsAudioFile` — FileSource-to-file path (D4)

```kotlin
override fun saveFileAsAudioFile(
    source: ReadableMap,
    destination: ReadableMap,
    format: String,
    outputSampleRateHz: Double,
    bitrate: Double,
    quality: Double,
    operationId: String,
    promise: Promise
) {
    audioScope.launch {
        var outputPath: String? = null
        try {
            val inputPath = resolveFileSource(source)   // uses existing FileSource resolver
            outputPath = resolveOutputPath(destination)

            saveViaDecodeEncode(
                inputPath, outputPath, format,
                outputSampleRateHz.toInt(), 0 /* inputSampleRate: discovered by decoder */,
                bitrate.toInt(), quality.toInt(), operationId
            )

            val result = WritableNativeMap().apply {
                putString("outputKind", resolvedKind)
                putString("outputPath", resolvedPath)
            }
            promise.resolve(result)
        } catch (e: CancellationException) {
            cleanupTempFile(outputPath)
            promise.reject("AUDIO_SAVE_CANCELLED", "Operation cancelled")
        } catch (e: Exception) {
            cleanupTempFile(outputPath)
            promise.reject(mapErrorCode(e), e.message)
        }
    }
}
```

#### File-backed path (decode → encode):

```kotlin
private suspend fun saveViaDecodeEncode(
    inputPath: String, outputPath: String, format: String,
    outputSampleRateHz: Int, inputSampleRate: Int,
    bitrate: Int, quality: Int, operationId: String
) {
    // Uses existing nativeDecodeFileStreaming + new nativeEncodeSession* JNI calls:
    //
    // 1. nativeEncodeSessionCreate(outputPath, format, inputSampleRate, 1,
    //        outputSampleRateHz, bitrate, quality, cancelFlagPtr) → sessionPtr
    // 2. decodeFile() with onChunk callback:
    //      onChunk(samples, frameCount) → nativeEncodeSessionFeedChunk(sessionPtr, samples, frameCount)
    //      onProgress → throttle + emit "audioSaveProgress" event with phase="decode"
    // 3. nativeEncodeSessionFinish(sessionPtr)
    // 4. nativeEncodeSessionRelease(sessionPtr)
}
```

#### Direct PCM path (encode only):

```kotlin
private suspend fun saveViaPcmEncode(
    samples: FloatArray, sampleRate: Int, channelCount: Int,
    outputPath: String, format: String, outputSampleRateHz: Int,
    bitrate: Int, quality: Int, operationId: String
) {
    // 1. nativeEncodeSessionCreate(outputPath, format, sampleRate, channelCount,
    //        outputSampleRateHz, bitrate, quality, cancelFlagPtr) → sessionPtr
    // 2. iterate samples in CHUNK_FRAMES slices:
    //      nativeEncodeSessionFeedChunk(sessionPtr, slice, frameCount)
    //      throttle + emit "audioSaveProgress" with phase="encode"
    // 3. nativeEncodeSessionFinish(sessionPtr)
    // 4. nativeEncodeSessionRelease(sessionPtr)
}
```

#### Temp file cleanup helper (D2)

```kotlin
private fun cleanupTempFile(path: String?) {
    if (path == null) return
    try {
        val file = File(path)
        if (file.exists()) file.delete()
    } catch (_: Exception) { /* best-effort */ }
}
```

#### Progress throttle helper (D1)

```kotlin
private class ProgressThrottle(
    private val operationId: String,
    private val emitter: DeviceEventManagerModule.RCTDeviceEventEmitter,
    private val minIntervalMs: Long = 100
) {
    private var lastEmitTime = 0L
    private var isFirst = true

    fun maybeEmit(phase: String, framesProcessed: Long, totalEstimate: Long, percent: Int) {
        val now = SystemClock.elapsedRealtime()
        // Always emit first (0%) and last (100%)
        if (isFirst || percent >= 100 || (now - lastEmitTime >= minIntervalMs)) {
            isFirst = false
            lastEmitTime = now
            val event = WritableNativeMap().apply {
                putString("operationId", operationId)
                putString("phase", phase)
                putDouble("framesProcessed", framesProcessed.toDouble())
                putDouble("totalFramesEstimate", totalEstimate.toDouble())
                putInt("percent", percent)
            }
            emitter.emit("audioSaveProgress", event)
        }
    }
}
```

### New JNI entry points

Replace `sherpa-onnx-audio-convert-jni.cpp` with `audio_encode_jni.cpp`:

```cpp
// New JNI bridge for AudioEncodeSession
extern "C" {

// Create encode session, returns pointer as jlong (0 on error)
JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionCreate(
    JNIEnv* env, jclass, jstring outputPath, jstring format,
    jint inputSampleRate, jint inputChannelCount, jint outputSampleRateHz,
    jint bitrate, jint quality,
    jlong cancelFlagPtr);

// Feed a chunk of float32 samples
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionFeedChunk(
    JNIEnv* env, jclass, jlong sessionPtr, jfloatArray samples, jint frameCount);

// Flush + close
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionFinish(
    JNIEnv* env, jclass, jlong sessionPtr);

// Release session (idempotent)
JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionRelease(
    JNIEnv* env, jclass, jlong sessionPtr);

}
```

### Kotlin companion object additions

```kotlin
companion object {
    // ... existing declarations ...

    @JvmStatic private external fun nativeEncodeSessionCreate(
        outputPath: String, format: String,
        inputSampleRate: Int, inputChannelCount: Int,
        outputSampleRateHz: Int, bitrate: Int, quality: Int,
        cancelFlagPtr: Long
    ): Long  // session pointer, 0 on error

    @JvmStatic private external fun nativeEncodeSessionFeedChunk(
        sessionPtr: Long, samples: FloatArray, frameCount: Int
    ): String  // empty = success

    @JvmStatic private external fun nativeEncodeSessionFinish(
        sessionPtr: Long
    ): String  // empty = success

    @JvmStatic private external fun nativeEncodeSessionRelease(
        sessionPtr: Long
    )
}
```

### `cancelAudioSave` bridge method

```kotlin
override fun cancelAudioSave(operationId: String, promise: Promise) {
    // Set the std::atomic<bool> cancel flag associated with operationId
    // Both AudioDecodeSession and AudioEncodeSession check this flag
    val flag = activeSaveOperations.remove(operationId)
    if (flag != null) {
        flag.set(true)  // cancel
    }
    promise.resolve(null)
}
```

### Remove: `saveOfflineAudioBufferToWav` (consolidated, D7)

Delete the `nativeSaveOfflineBufferToWav` JNI declaration and the `saveOfflineAudioBufferToWav` bridge method from `SherpaOnnxModule.kt`. All WAV export flows through `saveAudioBufferToFile` with `format="wav"`.

---

## Native bridge changes — iOS

### `SherpaOnnx+PipelineAudio.mm`

Same structural changes as Android:

```objc
// Old:
- (void)convertPipelineAudioToDestination:(NSString *)bufferId ...

// New:
- (void)saveAudioBufferToFile:(NSString *)bufferId
                  destination:(NSDictionary *)destination
                       format:(NSString *)format
              outputSampleRateHz:(double)outputSampleRateHz
                      bitrate:(double)bitrate
                      quality:(double)quality
                  operationId:(NSString *)operationId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    // Same flow: validate → resolve destination → route by buffer type
    // File-backed: AudioDecodeSession → AudioEncodeSession
    // In-memory: direct → AudioEncodeSession
    // iOS calls C++ directly (no JNI layer)
    //
    // On cancel/error: auto-delete temp output file (D2)
    // [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
}

// New: FileSource-to-file path (D4)
- (void)saveFileAsAudioFile:(NSDictionary *)source
                destination:(NSDictionary *)destination
                     format:(NSString *)format
            outputSampleRateHz:(double)outputSampleRateHz
                    bitrate:(double)bitrate
                    quality:(double)quality
                operationId:(NSString *)operationId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    // Resolve FileSource → input path (using existing resolveFileSource helper)
    // Resolve FileDestination → output path
    // AudioDecodeSession → AudioEncodeSession pipeline
    // No buffer registry involvement
    //
    // On cancel/error: auto-delete temp output file (D2)
}

- (void)cancelAudioSave:(NSString *)operationId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    // Set cancel flag for operationId
}
```

iOS uses the same C++ `AudioEncodeSession` class directly (compiled as part of the Xcode project). No Objective-C wrapper needed — `AudioEncodeSession::create()` / `feedChunk()` / `finish()` are called inline.

iOS progress throttle follows the same 100 ms / first+last rule as Android (D1). Implementation uses `CACurrentMediaTime()` or `mach_absolute_time()` for timing.

### Remove: `saveOfflineAudioBufferToWav` (consolidated, D7)

Delete the `saveOfflineAudioBufferToWav` bridge method from iOS. All WAV export flows through `saveAudioBufferToFile` with `format="wav"`.

### `ios/audio/SherpaOnnxAudioConvert.mm` → deleted after cutover

All encode paths move to `AudioEncodeSession`. The wrapper class is no longer needed.

---

## Progress and cancellation model

### Event infrastructure

| Event name | Emitter | Payload |
|---|---|---|
| `audioSaveProgress` | Native → JS via `RCTDeviceEventEmitter` | `AudioSaveProgressEvent` (see types above) |

The existing `fileIOProgress` event is **not reused** for audio save — it remains reserved for `copyFile` operations.

### Progress emission — C++ layer (D1)

`AudioEncodeSession` calls the `EncodeProgressCallback` **synchronously** inside `feedChunk()`. The callback fires on the same thread that called `feedChunk()`. This is the simplest model — no internal threading in the session.

### Progress emission — bridge layer throttle (D1)

The bridge layer (Kotlin/ObjC++) is responsible for throttling/coalescing progress events before dispatching to JS:

```
feedChunk() → onProgress callback (synchronous, every chunk)
  → bridge throttle: coalesce to max 1 event per 100ms
    → emit "audioSaveProgress" to JS main thread
```

**Throttle rules:**
- Minimum interval between JS events: **100 ms**
- Always emit the **first** event (0%) and the **last** event (100%)
- Between first and last: emit only if ≥100 ms elapsed since last emit
- The bridge stores `lastEmitTimestamp` per operation

**Dispatch:**
- Android: `reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(...)`
- iOS: `[self sendEventWithName:@"audioSaveProgress" body:...]`

Both dispatch to the JS thread — no additional threading needed.

### Progress phases

**File-backed / FileSource path (decode → encode):**
- Phase `"decode"`: emitted during `AudioDecodeSession` chunk callback, percent = decode progress
- Phase `"encode"`: emitted after `AudioEncodeSession.feedChunk()`, percent tracks frames encoded vs decoded total
- Phase `"finalize"`: emitted once during `finish()` (encoder flush + trailer)

**Direct PCM path (encode only):**
- Phase `"encode"`: percent = frames fed / total frames
- Phase `"finalize"`: emitted once during `finish()`

### Cancellation

- JS: `AbortSignal` → calls `SherpaOnnx.cancelAudioSave(operationId)`
- Native: sets `std::atomic<bool>` cancel flag
- `AudioDecodeSession::decodeFile()` checks flag between chunks
- `AudioEncodeSession::feedChunk()` checks flag before processing
- Both return early with a cancel-specific error message
- Kotlin/ObjC++ catches this and rejects the promise with `AUDIO_SAVE_CANCELLED`

### Temp file cleanup on cancel (D2)

When an operation is cancelled or fails with an error, the bridge layer **automatically deletes** the output temp file before rejecting the promise:

- **Android**: `File(outputPath).delete()` in the catch blocks (both `CancellationException` and general `Exception`)
- **iOS**: `[[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil]`

This covers:
- SAF fallback temp files (Android writes to temp → copies to content URI)
- Direct file outputs that were partially written
- Any intermediate files created during the encode

The deletion is best-effort — failures are silently ignored (the file may not have been created yet).

---

## Legacy code removal

### Files to delete

| File | Reason |
|---|---|
| `android/src/main/cpp/jni/audio/audio_convert_file.cpp` | Replaced by `AudioDecodeSession` + `AudioEncodeSession` |
| `android/src/main/cpp/jni/audio/audio_pcm_to_format.cpp` | Encode logic extracted into `AudioEncodeSession` |
| `android/src/main/cpp/jni/audio/audio_convert_file.h` | Header for removed files |
| `android/src/main/cpp/jni/audio/sherpa-onnx-audio-convert-jni.cpp` | Old JNI bridge; replaced by `audio_encode_jni.cpp` |
| `ios/audio/SherpaOnnxAudioConvert.mm` | iOS wrapper; logic now in shared C++ |
| `ios/audio/SherpaOnnxAudioConvert.h` | Header for removed wrapper |

### Bridge methods to remove

| Platform | Method | Reason |
|---|---|---|
| Android | `convertPipelineAudioToDestination` | Replaced by `saveAudioBufferToFile` |
| Android | `saveOfflineAudioBufferToWav` (bridge) | Consolidated (D7) |
| Android | `nativeSaveOfflineBufferToWav` (JNI) | Consolidated (D7) |
| iOS | `convertPipelineAudioToDestination:...` | Replaced by `saveAudioBufferToFile:...` |
| iOS | `saveOfflineAudioBufferToWav:...` | Consolidated (D7) |

### Files to update

| File | Change |
|---|---|
| `android/src/main/cpp/CMakeLists.txt` | Remove old source files, add `AudioEncodeSession.cpp` + `audio_encode_jni.cpp` |
| Xcode project / `SherpaOnnx.podspec` | Remove old `.mm`, add `AudioEncodeSession.cpp` |
| `android/.../SherpaOnnxModule.kt` | Remove old JNI declarations (see below) |
| Generated codegen specs | Will regenerate from updated `NativeSherpaOnnx.ts` |

### Kotlin companion cleanup

Remove from companion object:
```kotlin
// REMOVE:
private external fun nativeConvertAudioToFormat(inputPath: String, outputPath: String, format: String, outputSampleRateHz: Int): String
private external fun nativeConvertPcmToFormat(samples: FloatArray, sampleRate: Int, channelCount: Int, outputPath: String, format: String, outputSampleRateHz: Int): String
private external fun nativeSaveOfflineBufferToWav(bufferId: String, outputPath: String): String
```

---

## Docs and examples update plan

### `docs/audio-conversion.md`

Full rewrite:
- Title: "Audio save (`react-native-sherpa-onnx/audio`)"
- All examples use `saveAudioAsFile` / `saveAudioAsWav16k`
- Document that `saveAudioAsFile` accepts both buffer refs and `FileSource` (D4)
- Show file-to-file encoding example
- Show quality/bitrate usage (D5)
- Error code table uses `AUDIO_SAVE_*` codes
- Progress example uses `AudioSaveProgressEvent` with `phase`
- API reference section updated with new signatures

### Other docs that reference conversion:

| Doc | Change needed |
|---|---|
| `docs/audiobuffer-offline.md` | Update "Related" links and cross-references |
| `docs/audiobuffer-streaming.md` | Update conversion example if present |
| `docs/fileio.md` | Update integration section references |
| `docs/pcm-player.md` | Check for conversion mentions |
| Any doc referencing `saveOfflineAudioBufferToWav` | Replace with `saveAudioAsFile(..., 'wav', ...)` |

### Example app

- `example/src/screens/**` — search for `convertAudioToFormat` / `convertAudioToWav16k` and update to `saveAudioAsFile` / `saveAudioAsWav16k`
- Add file-to-file conversion example demonstrating `FileSource` input
- Update imports from `react-native-sherpa-onnx/audio`

---

## Migration phases

### Phase 1 — Public API rename + TypeScript surface

1. Replace `src/audio/types.ts` with new types (including `AudioSaveInput`, `quality`, `bitrate`)
2. Replace `src/audio/index.ts` with new implementation (dual dispatch: buffer vs FileSource)
3. Rename TurboModule methods in `src/NativeSherpaOnnx.ts` (add `saveAudioBufferToFile`, `saveFileAsAudioFile`, `cancelAudioSave`)
4. Remove `nativeSaveOfflineBufferToWav` from TurboModule spec
5. Update all TypeScript imports/usages in `src/`, `example/`
6. Update `docs/audio-conversion.md` and all cross-references
7. Run `yarn prepare` to rebuild `lib/`

Deliverable: only new names in TS surface; native bridge temporarily broken (method name mismatch)

### Phase 2 — AudioEncodeSession C++ primitive

1. Create `AudioEncodeSession.h` + `AudioEncodeSession.cpp`
2. Implement WAV fast-path (D6): RIFF header write, float32→S16LE, optional SwrContext for resample
3. Implement FFmpeg path with quality/bitrate support (D5)
4. Create `audio_encode_jni.cpp` (Android JNI bridge)
5. Update `CMakeLists.txt` to include new files (keep old files temporarily)
6. Update Xcode project to include new C++ source
7. Unit-test `AudioEncodeSession` in isolation (WAV, MP3, FLAC round-trip)
8. Test WAV fast-path: verify no FFmpeg calls when format="wav" and rates match

Deliverable: new encode primitive compiles and passes basic tests

### Phase 3 — Native bridge conversion to session architecture

1. Rename + rewrite `saveAudioBufferToFile` in `SherpaOnnxModule.kt`
2. Add `saveFileAsAudioFile` in Kotlin (D4)
3. Add `cancelAudioSave` in Kotlin
4. Add progress throttle (100 ms coalescing, D1) in Kotlin bridge
5. Add temp file auto-cleanup in catch blocks (D2)
6. Rename + rewrite `saveAudioBufferToFile` in `SherpaOnnx+PipelineAudio.mm`
7. Add `saveFileAsAudioFile` in iOS (D4)
8. Add `cancelAudioSave` in iOS
9. Add progress throttle (100 ms coalescing, D1) in iOS bridge
10. Add temp file auto-cleanup in catch blocks (D2)
11. Wire progress events: emit `audioSaveProgress` from encode/decode callbacks
12. Remove `saveOfflineAudioBufferToWav` from both platforms (D7)
13. Add Kotlin companion JNI declarations for new encode session methods

Deliverable: full conversion flow works end-to-end through new session architecture

### Phase 4 — Legacy removal + cleanup

1. Delete old source files (see table above)
2. Remove old companion object JNI declarations (including `nativeSaveOfflineBufferToWav`, D7)
3. Remove old files from CMakeLists.txt / Xcode project
4. Run `yarn prepare` to rebuild
5. Run full grep verification:
   ```
   rg "convertAudioToFormat|convertAudioToWav16k|convertPipelineAudioToDestination|nativeConvertAudioToFormat|nativeConvertPcmToFormat|saveOfflineAudioBufferToWav|nativeSaveOfflineBufferToWav|CONVERSION_|ConversionErrorCode" src ios android example docs
   ```
6. Update generated codegen artifacts

Deliverable: no legacy conversion code remains; single encode/decode backend; no `saveOfflineAudioBufferToWav`

---

## Breaking changes summary

### Removed

| Symbol | Type |
|---|---|
| `convertAudioToFormat` | Public function |
| `convertAudioToWav16k` | Public function |
| `AudioConversionOptions` | TypeScript interface |
| `ConversionErrorCode` | Error code object |
| `ConversionErrorCodeValue` | TypeScript type |
| `CONVERSION_*` error string values | Error code strings |
| `convertPipelineAudioToDestination` | TurboModule method |
| `saveOfflineAudioBufferToWav` | Public function (consolidated, D7) |
| `nativeSaveOfflineBufferToWav` | TurboModule method (consolidated, D7) |

### Added

| Symbol | Type |
|---|---|
| `saveAudioAsFile` | Public function (accepts both buffer refs and `FileSource`) |
| `saveAudioAsWav16k` | Public function (accepts both buffer refs and `FileSource`) |
| `AudioSaveInput` | TypeScript union type (`PipelineAudioBufferIdSource \| FileSource`) |
| `SaveAudioOptions` | TypeScript interface (with `quality` + `bitrate` fields) |
| `AudioSaveErrorCode` | Error code object |
| `AudioSaveErrorCodeValue` | TypeScript type |
| `AudioSaveProgressEvent` | TypeScript interface |
| `AUDIO_SAVE_*` error string values | Error code strings |
| `AUDIO_SAVE_SOURCE_NOT_FOUND` | New error code for FileSource input |
| `AUDIO_SAVE_INVALID_QUALITY` | New error code for invalid quality/bitrate |
| `saveAudioBufferToFile` | TurboModule method |
| `saveFileAsAudioFile` | TurboModule method (FileSource → file, D4) |
| `cancelAudioSave` | TurboModule method |
| `audioSaveProgress` | Native event name |

### Changed

| Aspect | Before | After |
|---|---|---|
| Input type | `PipelineAudioBufferIdSource` only | `AudioSaveInput` (`PipelineAudioBufferIdSource \| FileSource`) |
| Progress event type | `FileIOProgressEvent` (bytes-based) | `AudioSaveProgressEvent` (frames-based + phase) |
| Progress event channel | `fileIOProgress` | `audioSaveProgress` |
| Progress threading | Unspecified | Synchronous in C++, throttled 100 ms at bridge (D1) |
| Cancel mechanism | `cancelFileIO(operationId)` | `cancelAudioSave(operationId)` |
| Cancel cleanup | Unspecified | Auto-delete temp output file (D2) |
| Internal encode impl | Monolithic `audio_convert_file.cpp` | Streaming `AudioEncodeSession` (with WAV fast-path, D6) |
| WAV export | Through FFmpeg `PCM_S16LE` encoder | Direct RIFF/S16LE write (WAV fast-path, D6) |
| Quality control | Not available | `quality` + `bitrate` in `SaveAudioOptions` (D5) |

---

## Validation and acceptance criteria

### Functional

- [ ] Offline in-memory buffer → WAV/MP3/FLAC/AAC/Opus saves correctly on Android + iOS
- [ ] Offline file-backed buffer → all formats saves correctly
- [ ] Live finalized buffer with spool → all formats saves correctly
- [ ] Live finalized buffer without spool → all formats saves correctly
- [ ] **FileSource → all formats saves correctly (file-to-file, no buffer) (D4)**
- [ ] Sample-rate constraints enforced (MP3: 32k/44.1k/48k; Opus: 8k/12k/16k/24k/48k)
- [ ] SAF `contentUri` / `contentTree` destinations work (Android)
- [ ] Security-scoped destinations work (iOS)
- [ ] `saveAudioAsWav16k` produces valid 16 kHz mono S16LE WAV

### Quality and bitrate (D5)

- [ ] `quality: 'low'` produces smaller files than `quality: 'high'` (MP3, AAC, Opus)
- [ ] `bitrate: 64` produces ~64 kbps output for MP3
- [ ] `bitrate` takes precedence over `quality` when both specified
- [ ] `quality` and `bitrate` are ignored for lossless formats (WAV, FLAC)

### WAV fast-path (D6)

- [ ] WAV export with matching input rate does **not** invoke any FFmpeg API calls
- [ ] WAV export with different input rate uses only `SwrContext` (no avcodec)
- [ ] WAV fast-path output is byte-identical to FFmpeg path output (bit-for-bit RIFF compliance)
- [ ] WAV fast-path RIFF header contains correct `dataSize` and `fileSize`

### Progress + cancel (D1, D2)

- [ ] `onProgress` fires with `phase: "decode"` for file-backed/FileSource inputs
- [ ] `onProgress` fires with `phase: "encode"` for all paths
- [ ] Progress events throttled to ≤10/sec from bridge to JS
- [ ] `AbortSignal` abort → promise rejects with `AUDIO_SAVE_CANCELLED`
- [ ] Cancelled operations auto-delete temp output files
- [ ] Progress percent reaches 100 before promise resolves

### Architecture

- [ ] After Phase 4, `rg "nativeConvertAudioToFormat|nativeConvertPcmToFormat|audio_convert_file|audio_pcm_to_format|saveOfflineAudioBufferToWav|nativeSaveOfflineBufferToWav" android ios` returns zero hits
- [ ] `AudioEncodeSession` is shared code (same .cpp compiled for both platforms)
- [ ] No encode logic remains outside `AudioEncodeSession`

### API

- [ ] `rg "convertAudioToFormat|convertAudioToWav16k|CONVERSION_|saveOfflineAudioBufferToWav" src docs example` returns zero hits
- [ ] Only `saveAudioAsFile` / `saveAudioAsWav16k` appear in public exports

---

## Resolved design decisions

All design decisions below were resolved before implementation began. They are documented here for traceability. Each decision is referenced throughout the spec as **(D1)** through **(D7)**.

### D1: AudioEncodeSession — progress callback is synchronous

**Decision**: `AudioEncodeSession` calls the `EncodeProgressCallback` synchronously inside `feedChunk()`, on the caller's thread. No internal dispatch mechanism.

**Rationale**: Simplest model — no threading overhead in the C++ session. The bridge layer (Kotlin/ObjC++) is responsible for throttling (coalesce to max 1 event per 100 ms) and dispatching to the JS main thread.

### D2: Temp files are auto-deleted on cancel or error

**Decision**: When an encode operation is cancelled via `cancelAudioSave` or fails with any error, the bridge layer deletes the output temp file before rejecting the promise.

**Rationale**: Public SDK should not leave garbage files. The app has no use for a partially-written encode output. Deletion is best-effort (failure silently ignored). This covers both SAF fallback temp files and direct file outputs.

### D3: feedChunk() pointer valid until return, copies internally

**Decision**: The `samples` pointer passed to `feedChunk()` must remain valid only until `feedChunk()` returns (synchronous call). The session copies whatever data it needs into its internal accumulation buffer.

**Rationale**: This matches the existing accumulator pattern in `audio_pcm_to_format.cpp`. The caller is free to reuse/release the buffer immediately after the call returns.

### D4: saveAudioAsFile accepts FileSource input (file-to-file encode)

**Decision**: `saveAudioAsFile` accepts `AudioSaveInput = PipelineAudioBufferIdSource | FileSource`. When a `FileSource` is passed, the bridge dispatches to `saveFileAsAudioFile` which runs `AudioDecodeSession → AudioEncodeSession` directly, bypassing the buffer registry entirely.

**Rationale**: The "convert file A to format B" use case should not require creating a temporary buffer. `FileSource → AudioDecodeSession → AudioEncodeSession → FileDestination` is the most efficient path: no memory allocation for the full audio, no temp files, streaming decode→encode. This is critical for a public SDK.

**Example:**
```ts
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

// Direct file-to-file encode — no buffer, no temp files
const ref = await saveAudioAsFile(
  { kind: 'fs', path: '/path/to/input.wav' },
  { kind: 'fs', path: '/path/to/output.mp3' },
  'mp3',
  { quality: 'high' }
);
```

### D5: Quality and bitrate parameters added

**Decision**: `SaveAudioOptions` gets `quality?: 'low' | 'medium' | 'high'` and `bitrate?: number` (kbps). `bitrate` takes precedence if both are set. Both are ignored for lossless formats. `AudioEncodeConfig` gets corresponding `int bitrate` and `int quality` fields.

**Rationale**: A public audio SDK must expose encoding quality controls. Format-specific defaults are handled in `AudioEncodeSession::create()` so the public API stays clean.

### D6: WAV fast-path inside AudioEncodeSession

**Decision**: When `formatHint == "wav"`, `AudioEncodeSession` bypasses FFmpeg entirely. It writes a RIFF/WAV header directly, converts float32→S16LE inline, and writes raw PCM data. If resampling is needed, only `SwrContext` is used.

**Rationale**: WAV is the most common export format (especially `saveAudioAsWav16k`). The FFmpeg muxer/encoder overhead for PCM_S16LE is unnecessary — a direct write is significantly faster and removes the dependency on `avcodec`/`avformat` for the hot path. The fast-path lives **inside** `AudioEncodeSession` (not outside) so the caller code is uniform across all formats.

### D7: saveOfflineAudioBufferToWav removed, consolidated into saveAudioAsFile

**Decision**: `saveOfflineAudioBufferToWav` and its native implementations (`nativeSaveOfflineBufferToWav`) are deleted. All WAV export uses `saveAudioAsFile(input, output, 'wav', { outputSampleRateHz: 16000 })` or the `saveAudioAsWav16k` shortcut.

**Rationale**: Having two separate WAV export paths is confusing for SDK consumers and duplicates encode logic. The WAV fast-path inside `AudioEncodeSession` (D6) makes the unified path just as fast as a dedicated function. One function, one code path, one set of error codes.
