# AudioBuffer file-input expansion — Implementation Spec

> Concrete implementation spec for expanding AudioBuffer creation from files.
> All design decisions resolved. Ready for implementation.

---

## Table of Contents

1. [Purpose](#purpose)
2. [Current state](#current-state-as-is)
3. [Architecture](#architecture)
4. [Internal layers](#internal-layer-design)
5. [New TypeScript types](#new-typescript-types)
6. [Public API — Offline buffer](#public-api--offline-buffer-creation)
7. [Public API — Live buffer file ingest](#public-api--live-buffer-file-ingest)
8. [Public API — Audio conversion refactor](#public-api--audio-conversion-refactor)
9. [TurboModule spec changes](#turbomodule-spec-changes)
10. [Native implementation — AudioDecodeSession (C++)](#native-implementation--audiodecodesession-c)
11. [Native implementation — Platform bindings](#native-implementation--platform-bindings)
12. [Rollout plan](#rollout-in-two-parts)
13. [Code duplication eliminated](#code-duplication-eliminated)
14. [Breaking changes summary](#breaking-changes-summary)
15. [Non-goals](#non-goals)
16. [Success criteria](#success-criteria)
17. [Design decisions log](#design-decisions-log)

---

## Purpose

Expand AudioBuffer creation from files while eliminating internal code duplication across `fileio`, `audio`, and `audiobuffer`. One unified native decode pipeline serves offline buffer creation, live buffer file ingest, and audio conversion. Buffer kind controls delivery, not decode.

Core goals:

- One internal chunk-based decode-to-PCM path (FFmpeg) shared by offline, live, and conversion
- File source resolution reuses `fileio` infrastructure exclusively
- Public API stays minimal: options-object pattern, auto format detection, no redundant parameters
- Breaking changes are used freely to produce the cleanest possible API

---

## Current state (as-is)

### What exists

| Module | Capability | Implementation |
|--------|-----------|----------------|
| `audiobuffer` | `createOfflineAudioBufferFromFile(source, targetSampleRateHz?, forceMono?)` | FileSource → native: WAV → direct parse / non-WAV → `WaveReader` (Android) or `ReadWave` (iOS), full in-memory load |
| `audiobuffer` | `createLiveAudioBuffer(options)` + mic / `appendSamples` / `appendOffline` | No file-source input path |
| `audio` | `convertAudioToFormat(buffer, dest, format, options?)` | buffer → FFmpeg PCM-to-encoded pipeline (C++) |
| `fileio` | `copyFile(source, dest)` with `FileSource` / `FileDestination` | Unified resolver + streaming copy with progress/cancel |

### Identified duplication and gaps

1. **Two independent decode stacks**
   - Offline buffer creation: `WaveReader.readWave()` (Android) / `sherpa_onnx::cxx::ReadWave()` (iOS) — one-shot, in-memory, limited format support.
   - Audio conversion: FFmpeg full decode+encode pipeline (`audio_convert_file.cpp`) — chunk-based, all formats, but file→file only.
   - No reusable "decode file → PCM chunks" primitive.

2. **File source resolution duplicated**
   - `fileio` has `FileIOResolver` (content URI → fd, app-relative → absolute, SAF, security-scoped, PAD).
   - `SherpaOnnxModule.createOfflineAudioBufferFromSource` re-implements parts of the same resolution.

3. **No chunked decode for buffers**
   - Offline: entire file into memory (or file-backed WAV-only fast path).
   - Live: no file input at all.
   - FFmpeg's decode loop works frame-by-frame but outputs to encoder directly.

4. **Resampling scattered**
   - Kotlin `Resampler.resampleLinear()`, FFmpeg `SwrContext`, iOS `pa_resampleLinear()` — three implementations.

---

## Architecture

```
                    ┌──────────────┐
                    │   fileio     │
                    │ FileSource   │
                    │  resolver    │
                    └──────┬───────┘
                           │  resolved fd / path
                           ▼
              ┌────────────────────────────┐
              │      AudioDecodeSession    │  ← shared C++ primitive
              │      (FFmpeg / WAV fast)   │
              │                            │
              │  demux → decode → resample │
              │       → float32 chunks     │
              └────────────┬───────────────┘
                           │  float32 PCM chunks (callback)
              ┌────────────┼────────────────┐
              │            │                │
        ┌─────▼─────┐ ┌───▼────────┐ ┌─────▼──────────┐
        │  Offline   │ │   Live     │ │  AudioEncode   │
        │  Buffer    │ │   Buffer   │ │  Session       │
        │            │ │            │ │                 │
        │ collect    │ │ append     │ │ chunks →        │
        │ all chunks │ │ chunk by   │ │ encoder → file  │
        │ → immut.   │ │ chunk      │ │ (conversion)    │
        └────────────┘ └────────────┘ └─────────────────┘
```

### Key principles

1. **Single decode primitive** (`AudioDecodeSession`): FFmpeg-based, chunk-streaming, lives in C++ (shared between Android JNI and iOS). Outputs float32 mono PCM chunks at target sample rate. Replaces `WaveReader`, `ReadWave`, `sherpa_onnx::cxx::ReadWave()`, and the decode half of `audio_convert_file`.

2. **fileio resolver is the only source resolver**: Buffer creation delegates to `FileIOResolver` for all `FileSource` kinds. Duplicate resolution in `SherpaOnnxModule` is removed.

3. **Buffer kind controls chunk delivery, not decode**:
   - Offline: session runs to completion, chunks accumulated. Promise resolves when done.
   - Live: session feeds chunks into ring (+ spool). `onFramesAppended` fires per chunk.

4. **Audio conversion refactored**: `audio_convert_file.cpp` is split into `AudioDecodeSession` (shared) + `AudioEncodeSession` (encode-only). `convertAudioToFormat` reuses the decode primitive when the input is a file.

5. **Resampling consolidated**: FFmpeg `SwrContext` handles all sample rate conversion and channel downmix. Kotlin and iOS linear resamplers removed.

6. **iOS uses FFmpeg** (already linked): Same `AudioDecodeSession` C++ code on both platforms. `sherpa_onnx::cxx::ReadWave()` removed.

7. **Format detection is always automatic**: No `AudioInputFormat` in the public API. FFmpeg probes container/codec internally. Simpler API surface.

---

## Internal layer design

### Layer 1: File source resolution (`fileio`)

Existing `FileIOResolver`. Used as-is, no changes.

- Input: `FileSource` (any kind)
- Output: native fd (Android) or absolute path (iOS), plus detected MIME if available
- Permissions, SAF, security-scoped bookmarks handled here
- Error codes: `FILEIO_*` family (reused, not duplicated)

### Layer 2: Audio decode primitive (`AudioDecodeSession`)

New shared C++ primitive. Single implementation compiled for both Android (JNI) and iOS.

#### C++ interface

```cpp
namespace sherpa {

struct AudioDecodeConfig {
  int targetSampleRate;   // 0 = keep source rate
  bool forceMono;         // true = downmix to mono (default: true)
  int chunkSize;          // samples per callback (default: 8192)
};

struct AudioDecodeResult {
  int64_t totalFramesDecoded;
  int sourceSampleRate;
  int sourceChannels;
};

// Callback signatures
using DecodeChunkCallback = std::function<void(const float* samples, int frameCount)>;
using DecodeProgressCallback = std::function<void(int64_t framesDecoded, int64_t totalFramesEstimate)>;

// Main entry point. Blocks calling thread until decode completes or is cancelled.
// Returns result on success. Throws on error (with DECODE_* error code).
AudioDecodeResult decodeFile(
  const char* pathOrFd,             // file path or /proc/self/fd/<n>
  const AudioDecodeConfig& config,
  DecodeChunkCallback onChunk,
  DecodeProgressCallback onProgress, // may be nullptr
  std::atomic<bool>& cancelFlag
);

} // namespace sherpa
```

#### Behavior

- **FFmpeg path**: `avformat_open_input` → find audio stream → `avcodec_find_decoder` → decode loop → `SwrContext` (resample + downmix) → `onChunk` callback per `chunkSize` samples.
- **WAV fast path**: If file is PCM WAV (s16le or f32le, mono, matching target rate or no target specified), bypass FFmpeg entirely. Direct binary read in chunks. Threshold: 10 MB for file-backed decision unchanged.
- **Cancellation**: `cancelFlag` checked between decode iterations. Sets `DECODE_CANCELLED` error.
- **Progress estimation**: When container provides duration → exact frame estimate. Otherwise → estimate from `(fileSize * 8) / bitrate`. Progress is always reported as `{ framesDecoded, totalFramesEstimate, percent }` with best-effort `percent` (never null — estimated when exact value unavailable).
- **Error codes**: All errors use new `DECODE_*` family (see [error codes](#decode-error-codes)).

### Layer 3: Buffer accumulation (platform Kotlin / ObjC++)

#### Offline buffer fill

- Resolves `FileSource` via `FileIOResolver` → fd/path
- Creates `AudioDecodeSession`, collects all chunks into growing buffer
- Size threshold 10 MB: below → `InMemory` (`FloatArray` / `std::vector<float>`), above → temp WAV file-backed (stream chunks to temp file, wrap as `FileBacked`)
- Promise resolves when decode completes
- Error during decode → reject promise, release partial resources
- Cancellation via `AbortSignal` → native abort flag → reject with `DECODE_CANCELLED`

#### Live buffer file ingest

- Resolves `FileSource` via `FileIOResolver` → fd/path
- Creates `AudioDecodeSession`, appends each chunk to existing `LiveEntry` ring via same internal path as `appendSamples`
- **Spool is always enabled** for file ingest (prevents data loss during fast decode). If no `persistencePath` was set on the buffer, native creates an automatic temp spool.
- `onFramesAppended` fires per chunk with `source: 'file_ingest'`
- Runs on background thread (executor / `std::thread`), does not block JS
- Cancellation: abort → retain already-appended samples → buffer stays `recording`. Caller decides next step.
- `autoFinalize` option (default: `false`): when `true`, buffer transitions `recording` → `finished` automatically when decode completes.
- Returns `FileIngestHandle` (see types) for control/status/cancellation.

### Layer 4: Audio encode (`AudioEncodeSession`)

Extracted from current `audio_convert_file.cpp`. Accepts float32 PCM chunks → FFmpeg encode → muxed output file.

```cpp
namespace sherpa {

struct AudioEncodeConfig {
  const char* outputPath;
  const char* format;       // "wav", "mp3", "flac", "opus", etc.
  int outputSampleRate;     // 0 = format default
  int channelCount;         // 1 for mono
  int inputSampleRate;      // sample rate of incoming PCM
};

// Streaming encoder: call feedChunk repeatedly, then finalize.
class AudioEncodeSession {
public:
  static std::unique_ptr<AudioEncodeSession> create(const AudioEncodeConfig& config);
  void feedChunk(const float* samples, int frameCount);
  void finalize();  // flush encoder, write trailer
  ~AudioEncodeSession();
};

} // namespace sherpa
```

`convertAudioToFormat` for buffer→file continues using `sherpa_audio_convert_pcm_to_format` (feeds entire buffer). For future file→file conversion without buffer intermediate, `AudioDecodeSession` chunks pipe directly into `AudioEncodeSession`.

---

## New TypeScript types

All new types are added to `src/audiobuffer/types.ts` and `src/audio/types.ts`.

### Decode options (shared by offline and live ingest)

```ts
/** Options for decoding an audio file into a pipeline buffer. */
export interface AudioDecodeOptions {
  /**
   * Target sample rate in Hz. If omitted or 0, keeps the source file's native sample rate.
   * When specified, FFmpeg SwrContext resamples during decode (no second pass).
   */
  targetSampleRateHz?: number;

  /**
   * Force mono downmix. Default: true.
   * When true and source is stereo/multi-channel, downmixed during decode.
   */
  forceMono?: boolean;

  /**
   * Cancel the decode operation. When aborted, already-decoded data is retained
   * (offline: promise rejects; live: buffer stays recording with partial data).
   */
  signal?: AbortSignal;

  /**
   * Progress callback. Fired periodically during decode.
   * `percent` is always provided (estimated from file size when container
   * does not declare duration).
   */
  onProgress?: (event: DecodeProgressEvent) => void;
}
```

### Decode progress event

```ts
/** Progress event emitted during audio file decode. */
export interface DecodeProgressEvent {
  /** Number of output frames decoded so far. */
  framesDecoded: number;
  /**
   * Estimated total output frames. Exact when container provides duration,
   * estimated from file size and bitrate otherwise.
   */
  totalFramesEstimate: number;
  /** Progress 0–100. Always provided (estimated when exact value unavailable). */
  percent: number;
  /** Source file's original sample rate (before resampling). */
  sourceSampleRate: number;
  /** Source file's original channel count (before downmix). */
  sourceChannels: number;
}
```

### File ingest handle (live buffer)

```ts
/**
 * Handle for a running file ingest operation on a live buffer.
 * Returned by `ingestFileToLiveAudioBuffer`.
 */
export interface FileIngestHandle {
  /** Unique ingest operation id (native-generated). */
  readonly ingestId: string;

  /** The live buffer being ingested into. */
  readonly liveBufferId: string;

  /**
   * Promise that resolves when ingest completes (all chunks decoded and appended).
   * Rejects on decode error or cancellation.
   */
  readonly done: Promise<FileIngestResult>;

  /**
   * Cancel the ingest. Already-appended samples are retained.
   * Buffer stays in `recording` state. Equivalent to aborting the signal.
   */
  cancel(): void;

  /** Query ingest status. Non-blocking. */
  getStatus(): Promise<FileIngestStatus>;
}

/** Result returned when file ingest completes successfully. */
export interface FileIngestResult {
  /** Total frames appended to the live buffer from this ingest. */
  totalFramesIngested: number;
  /** Source file's original sample rate. */
  sourceSampleRate: number;
  /** Source file's original channel count. */
  sourceChannels: number;
  /** Whether the buffer was auto-finalized after ingest. */
  autoFinalized: boolean;
}

/** Status snapshot of a running file ingest operation. */
export interface FileIngestStatus {
  /** Whether the ingest is still running. */
  isRunning: boolean;
  /** Frames decoded and appended so far. */
  framesIngested: number;
  /** Estimated total frames (same semantics as DecodeProgressEvent). */
  totalFramesEstimate: number;
  /** Progress 0–100. */
  percent: number;
  /** Error message if ingest failed (undefined while running or on success). */
  error?: string;
}
```

### File ingest options (live buffer)

```ts
/** Options for `ingestFileToLiveAudioBuffer`. */
export interface FileIngestOptions extends AudioDecodeOptions {
  /**
   * Automatically finalize the live buffer when file ingest completes.
   * Default: `false`.
   *
   * When false, the buffer stays in `recording` state after ingest,
   * allowing further appends (more files, mic, samples).
   * When true, the buffer transitions to `finished` after the last chunk.
   */
  autoFinalize?: boolean;
}
```

### Decode error codes

```ts
/** Error codes for audio decode operations (new DECODE_* family). */
export const DecodeErrorCode = {
  /** File not found or fd invalid. */
  NOT_FOUND: 'DECODE_NOT_FOUND',
  /** FFmpeg could not open/probe the input (unsupported or corrupted container). */
  OPEN_FAILED: 'DECODE_OPEN_FAILED',
  /** No audio stream found in container. */
  NO_AUDIO_STREAM: 'DECODE_NO_AUDIO_STREAM',
  /** Decoder initialization failed (unsupported codec). */
  CODEC_UNSUPPORTED: 'DECODE_CODEC_UNSUPPORTED',
  /** Error during decode loop (corrupted frames, read error). */
  DECODE_ERROR: 'DECODE_DECODE_ERROR',
  /** Resampling/downmix configuration failed. */
  RESAMPLE_ERROR: 'DECODE_RESAMPLE_ERROR',
  /** Operation cancelled via AbortSignal. */
  CANCELLED: 'DECODE_CANCELLED',
  /** Permission denied accessing the source. */
  PERMISSION_DENIED: 'DECODE_PERMISSION_DENIED',
  /** Generic internal decode error. */
  INTERNAL_ERROR: 'DECODE_INTERNAL_ERROR',
} as const;

export type DecodeErrorCodeValue =
  (typeof DecodeErrorCode)[keyof typeof DecodeErrorCode];
```

### LiveBufferAppendSource extension

```ts
// Added to existing LiveBufferAppendSource union:
export type LiveBufferAppendSource =
  | 'mic'
  | 'append'
  | 'append_offline'
  | 'file_ingest'    // ← NEW: from ingestFileToLiveAudioBuffer
  | 'enhancement'
  | 'tts'
  | 'unknown'
  | 'mixed';
```

---

## Public API — Offline buffer creation

### `createOfflineAudioBufferFromFile(source, options?)` (breaking change)

Positional args replaced with options object.

```ts
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

/**
 * Decode an audio file into an immutable offline pipeline buffer.
 *
 * Accepts any audio format supported by FFmpeg (wav, mp3, flac, aac, opus, ogg, etc.).
 * Format is auto-detected from file content (no format hint needed).
 *
 * Small files (<10 MB decoded PCM) are stored in memory.
 * Large files are file-backed (streaming reader, no full memory load).
 *
 * File source resolution uses the fileio resolver for all FileSource kinds.
 * Decode + resample + downmix happen in a single native pass (FFmpeg + SwrContext).
 *
 * @param source - Any FileSource: fs, app, contentUri, securityScoped, pad.
 * @param options - Decode options (sample rate, mono, cancellation, progress).
 * @returns Immutable offline buffer reference.
 *
 * @example
 * // Decode MP3 from filesystem, resample to 16 kHz:
 * const buf = await createOfflineAudioBufferFromFile(
 *   { kind: 'fs', path: '/tmp/speech.mp3' },
 *   { targetSampleRateHz: 16000 }
 * );
 *
 * @example
 * // Decode from Android content URI with progress:
 * const buf = await createOfflineAudioBufferFromFile(
 *   { kind: 'contentUri', uri: pickedUri },
 *   {
 *     targetSampleRateHz: 16000,
 *     onProgress: (e) => console.log(`${e.percent}%`),
 *   }
 * );
 *
 * @example
 * // Cancellable decode:
 * const controller = new AbortController();
 * const buf = await createOfflineAudioBufferFromFile(
 *   { kind: 'fs', path: '/tmp/large.flac' },
 *   { signal: controller.signal }
 * );
 * // controller.abort() cancels decode, promise rejects with DECODE_CANCELLED
 */
export async function createOfflineAudioBufferFromFile(
  source: FileSource,
  options?: AudioDecodeOptions,
): Promise<OfflineAudioBufferRef>;
```

**Implementation**: Single TurboModule call `decodeFileToOfflineBuffer(source, targetSampleRateHz, forceMono, operationId)`. Native side:
1. `FileIOResolver.resolve(source)` → fd/path
2. `AudioDecodeSession::decodeFile(...)` with chunk callback that appends to growing buffer
3. Progress events emitted via `NativeEventEmitter` keyed by `operationId`
4. Cancellation via `cancelDecode(operationId)`
5. Returns `OfflineAudioBufferInfo`

---

## Public API — Live buffer file ingest

### `ingestFileToLiveAudioBuffer(liveBuffer, source, options?)`

New function. Composable with existing live buffer creation and all append paths.

```ts
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

/**
 * Decode an audio file and stream its PCM chunks into an existing live buffer.
 *
 * The live buffer must be in `recording` state. Chunks are appended as they
 * are decoded — downstream pipeline consumers (STT, enhancement) can start
 * processing before the file is fully decoded.
 *
 * Spool is automatically enabled for the duration of file ingest to prevent
 * data loss (ring overwrite during fast decode). If the buffer was created
 * without a persistencePath, a temporary spool is used and cleaned up
 * after ingest completes or the buffer is released.
 *
 * `onFramesAppended` fires per decoded chunk with `source: 'file_ingest'`.
 *
 * This is the third append path alongside `appendSamplesToLiveAudioBuffer`
 * and `appendOfflineToLiveAudioBuffer`. All three can be used on the same
 * buffer, sequentially or interleaved.
 *
 * @param liveBuffer - Live buffer in recording state.
 * @param source - Any FileSource: fs, app, contentUri, securityScoped, pad.
 * @param options - Decode + ingest options.
 * @returns Handle to monitor/cancel the ingest operation.
 *
 * @example
 * // Basic: create buffer, ingest file, finalize:
 * const live = await createLiveAudioBuffer({ sampleRate: 16000 });
 * const ingest = await ingestFileToLiveAudioBuffer(
 *   live,
 *   { kind: 'fs', path: '/tmp/recording.opus' },
 *   { targetSampleRateHz: 16000 }
 * );
 * await ingest.done;
 * await finalizeLiveAudioBuffer(live);
 *
 * @example
 * // Pipeline: file ingest → streaming STT (STT starts before decode finishes):
 * const live = await createLiveAudioBuffer({
 *   sampleRate: 16000,
 *   emitAppendedEvents: true,
 *   onFramesAppended: (e) => console.log(`[${e.source}] +${e.frameCount}`),
 * });
 * const sttPipeline = await recognizer.transcribe(live, textOut);
 * const ingest = await ingestFileToLiveAudioBuffer(
 *   live,
 *   { kind: 'contentUri', uri: pickedUri },
 *   { targetSampleRateHz: 16000, autoFinalize: true }
 * );
 * // STT processes chunks as they arrive.
 * // When ingest.done resolves, buffer auto-finalizes → STT pipeline sees EOF.
 *
 * @example
 * // Sequential: ingest file A, then file B, then mic:
 * const live = await createLiveAudioBuffer({ sampleRate: 16000 });
 * await (await ingestFileToLiveAudioBuffer(live, fileA)).done;
 * await (await ingestFileToLiveAudioBuffer(live, fileB)).done;
 * await startMicToLiveAudioBuffer(live);
 * // ... later stop mic, finalize
 *
 * @example
 * // Cancellation (partial ingest):
 * const ingest = await ingestFileToLiveAudioBuffer(live, source);
 * // ... later:
 * ingest.cancel(); // buffer keeps already-appended samples, stays recording
 * // ingest.done rejects with DECODE_CANCELLED
 *
 * @example
 * // Progress monitoring:
 * const ingest = await ingestFileToLiveAudioBuffer(live, source, {
 *   onProgress: (e) => console.log(`Ingest: ${e.percent}%`),
 * });
 */
export async function ingestFileToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  source: FileSource,
  options?: FileIngestOptions,
): Promise<FileIngestHandle>;
```

**Implementation**: TurboModule call `startFileIngestToLiveBuffer(liveBufferId, source, targetSampleRateHz, forceMono, autoFinalize, operationId)`. Native side:
1. Validate buffer exists and is `recording`
2. `FileIOResolver.resolve(source)` → fd/path
3. Enable auto-spool if no spool configured
4. Spawn background thread: `AudioDecodeSession::decodeFile(...)` with chunk callback → `LiveEntry.appendSamples(..., source = "file_ingest")`
5. Progress events via `NativeEventEmitter` keyed by `operationId`
6. On completion: if `autoFinalize` → `LiveEntry.finalize_()`
7. On cancel: set abort flag, retain samples, stay `recording`
8. Returns `{ ingestId, operationId }` — JS wraps into `FileIngestHandle`

### Convenience wrapper (optional, can be added later)

```ts
/**
 * Convenience: create a live buffer and immediately start file ingest.
 * Equivalent to `createLiveAudioBuffer(options)` + `ingestFileToLiveAudioBuffer(...)`.
 */
export async function createLiveAudioBufferFromFile(
  source: FileSource,
  options: CreateLiveAudioBufferOptions & FileIngestOptions,
): Promise<LiveAudioBufferRef & { ingest: FileIngestHandle }>;
```

Not in scope for initial implementation. Added later when usage patterns stabilize.

---

## Public API — Audio conversion refactor

`convertAudioToFormat` remains unchanged in its public signature. Internal refactoring only.

Current internal: `audio_convert_file.cpp` does decode+encode in one monolithic FFmpeg pipeline.

After refactor: `audio_convert_file.cpp` (or `audio_convert.cpp`) uses:
1. When input is a **buffer** (current path): `AudioEncodeSession` fed by buffer samples. Same as today but using the extracted encode-only primitive.
2. When input is a **file** (future path): `AudioDecodeSession` → chunk callback → `AudioEncodeSession.feedChunk()`. No intermediate buffer materialization.

The encode-only primitive is extracted from the existing code. No public API change.

---

## TurboModule spec changes

New methods added to `NativeSherpaOnnx.ts`:

```ts
// ==================== REPLACE ====================
// Old: createOfflineAudioBufferFromSource(source, targetSampleRateHz?, forceMono?)
// New:
decodeFileToOfflineBuffer(
  source: Object,               // FileSource serialized
  targetSampleRateHz: number,   // 0 = keep source rate
  forceMono: boolean,
  operationId: string,          // for progress events + cancellation
): Promise<Object>;             // OfflineAudioBufferInfo

// ==================== ADD ====================

/** Start streaming file decode into an existing live buffer. */
startFileIngestToLiveBuffer(
  liveBufferId: string,
  source: Object,               // FileSource serialized
  targetSampleRateHz: number,   // 0 = keep source rate
  forceMono: boolean,
  autoFinalize: boolean,
  operationId: string,
): Promise<{ ingestId: string }>;

/** Query file ingest status. */
getFileIngestStatus(ingestId: string): Promise<{
  isRunning: boolean;
  framesIngested: number;
  totalFramesEstimate: number;
  percent: number;
  error?: string;
}>;

/** Cancel a running decode operation (offline or ingest). */
cancelDecode(operationId: string): Promise<void>;

// ==================== REMOVE ====================
// createOfflineAudioBufferFromSource (replaced by decodeFileToOfflineBuffer)
```

Progress events emitted via `NativeEventEmitter`:

```ts
// Event name: 'decodeProgress'
interface NativeDecodeProgressEvent {
  operationId: string;
  framesDecoded: number;
  totalFramesEstimate: number;
  percent: number;
  sourceSampleRate: number;
  sourceChannels: number;
}
```

---

## Native implementation — AudioDecodeSession (C++)

### File layout

```
android/src/main/cpp/jni/audio/
  AudioDecodeSession.h          // C++ header (shared with iOS via symlink or copy)
  AudioDecodeSession.cpp         // C++ implementation
  AudioEncodeSession.h           // Extracted encode-only primitive
  AudioEncodeSession.cpp

ios/audio/
  AudioDecodeSession.h           // Same header (or symlink)
  AudioDecodeSession.cpp         // Same implementation (conditional compile if needed)
  AudioEncodeSession.h
  AudioEncodeSession.cpp
```

### AudioDecodeSession.h

```cpp
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace sherpa {

struct AudioDecodeConfig {
  int targetSampleRate = 0;  // 0 = keep source rate
  bool forceMono = true;
  int chunkSize = 8192;      // output frames per callback
};

struct AudioDecodeResult {
  int64_t totalFramesDecoded = 0;
  int sourceSampleRate = 0;
  int sourceChannels = 0;
};

using DecodeChunkCallback =
    std::function<void(const float* samples, int frameCount)>;

using DecodeProgressCallback =
    std::function<void(int64_t framesDecoded, int64_t totalFramesEstimate, int percent)>;

/**
 * Decode an audio file to float32 PCM chunks.
 *
 * Blocks the calling thread until decode completes, errors, or is cancelled.
 * Chunks are delivered via onChunk callback.
 *
 * WAV fast path: PCM WAV (s16le/f32le mono) at matching target rate bypasses FFmpeg.
 * All other formats use FFmpeg demux → decode → SwrContext resample/downmix.
 *
 * Throws std::runtime_error with DECODE_* error code prefix on failure.
 */
AudioDecodeResult decodeFile(
    const char* pathOrFd,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,   // may be nullptr
    std::atomic<bool>& cancelFlag
);

} // namespace sherpa
```

### WAV fast path conditions

Bypass FFmpeg when all of these are true:
- Valid RIFF/WAVE header
- Audio format: PCM 16-bit (format code 1) or IEEE float 32-bit (format code 3)
- Mono (1 channel)
- `targetSampleRate == 0` or `targetSampleRate == sourceRate`

Otherwise fall through to FFmpeg path (handles all containers, codecs, channel layouts, sample rates).

### Progress estimation

1. **Container provides duration** (`AVFormatContext->duration` > 0): `totalFramesEstimate = (duration_seconds * targetSampleRate)`. Exact.
2. **No duration but file size + bitrate known**: `totalFramesEstimate = ((fileSize * 8) / bitRate) * targetSampleRate`. Estimated.
3. **Neither**: `totalFramesEstimate = 0`, `percent = 0`. Edge case (raw piped streams).

`percent` is computed as `min(100, (framesDecoded * 100) / totalFramesEstimate)`. Always an integer 0–100.

---

## Native implementation — Platform bindings

### Android (Kotlin ↔ JNI)

#### New Kotlin methods in `SherpaOnnxModule.kt`

```kotlin
// Replaces createOfflineAudioBufferFromSource
override fun decodeFileToOfflineBuffer(
    source: ReadableMap,
    targetSampleRateHz: Double,
    forceMono: Boolean,
    operationId: String,
    promise: Promise
) {
    // 1. FileIOResolver.resolve(source) → path/fd
    // 2. Register operationId → cancelFlag in decode registry
    // 3. Background thread: AudioDecodeSession.decodeFile(...)
    //    - onChunk: accumulate into growing FloatArray (or temp file if > 10 MB)
    //    - onProgress: emit 'decodeProgress' event with operationId
    //    - cancelFlag: checked from cancelDecode(operationId)
    // 4. On complete: create OfflineEntry, resolve promise with info
    // 5. On error: reject promise with DECODE_* code
}

override fun startFileIngestToLiveBuffer(
    liveBufferId: String,
    source: ReadableMap,
    targetSampleRateHz: Double,
    forceMono: Boolean,
    autoFinalize: Boolean,
    operationId: String,
    promise: Promise
) {
    // 1. Validate liveBuffer exists and is RECORDING
    // 2. Enable auto-spool if needed
    // 3. FileIOResolver.resolve(source) → path/fd
    // 4. Register ingest in FileIngestRegistry
    // 5. Background thread: AudioDecodeSession.decodeFile(...)
    //    - onChunk: liveEntry.appendSamples(chunk, rate, "file_ingest")
    //    - onProgress: emit 'decodeProgress' event with operationId
    // 6. On complete: if autoFinalize → liveEntry.finalize_()
    // 7. Resolve promise with { ingestId }
}

override fun getFileIngestStatus(ingestId: String, promise: Promise) { ... }
override fun cancelDecode(operationId: String, promise: Promise) { ... }
```

#### JNI bridge

```cpp
// android/src/main/cpp/jni/audio/audio_decode_jni.cpp

extern "C" JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDecodeFile(
    JNIEnv* env, jobject thiz,
    jstring path, jint targetSampleRate, jboolean forceMono,
    jint chunkSize, jlong cancelFlagPtr,
    jobject chunkCallback,   // Java functional interface
    jobject progressCallback // Java functional interface (nullable)
);
```

Alternative (simpler): Keep decode loop in Kotlin using JNI calls per-frame to C++ FFmpeg functions. Trade-off: more JNI crossings but simpler callback plumbing. Decision deferred to implementation.

### iOS (ObjC++ direct C++ access)

iOS calls `sherpa::decodeFile(...)` directly from `SherpaOnnx+PipelineAudio.mm` — no JNI overhead. The `onChunk` callback writes to `PaOfflineEntry` (offline) or `PaLiveEntry` (live ingest).

```objc
// SherpaOnnx+PipelineAudio.mm — decodeFileToOfflineBuffer

- (void)decodeFileToOfflineBuffer:(NSDictionary *)source
              targetSampleRateHz:(double)targetSampleRateHz
                       forceMono:(BOOL)forceMono
                     operationId:(NSString *)operationId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    dispatch_async(self.decodeQueue, ^{
        std::string path = [self resolveFileSource:source]; // uses FileIOResolver
        std::atomic<bool> cancelFlag{false};
        [self registerCancelFlag:operationId flag:&cancelFlag];

        std::vector<float> accumulator;
        auto onChunk = [&](const float* samples, int count) {
            accumulator.insert(accumulator.end(), samples, samples + count);
        };
        auto onProgress = [&](int64_t decoded, int64_t total, int pct) {
            [self emitDecodeProgress:operationId decoded:decoded total:total percent:pct ...];
        };

        try {
            auto result = sherpa::decodeFile(path.c_str(), config, onChunk, onProgress, cancelFlag);
            // Create PaOfflineEntry from accumulator
            // Resolve promise with info
        } catch (const std::runtime_error& e) {
            reject(@"DECODE_ERROR", @(e.what()), nil);
        }
    });
}
```

### Removals

| Platform | Removed | Reason |
|----------|---------|--------|
| Android | `WaveReader.readWave()` usage in `PipelineAudioRegistry.createOfflineFromFile()` | Replaced by `AudioDecodeSession` |
| Android | `Resampler.resampleLinear()` | Replaced by FFmpeg `SwrContext` in decode session |
| Android | Inline source resolution in `SherpaOnnxModule.createOfflineAudioBufferFromSource` | Replaced by `FileIOResolver` |
| iOS | `sherpa_onnx::cxx::ReadWave()` usage in `SherpaOnnx+PipelineAudio.mm` | Replaced by `AudioDecodeSession` |
| iOS | `pa_resampleLinear()` in `SherpaOnnx+PipelineAudio.mm` | Replaced by FFmpeg `SwrContext` |
| iOS | `pa_parseWavHeader()` in `SherpaOnnx+PipelineAudio.mm` | Replaced by C++ WAV fast path in `AudioDecodeSession` |
| Android | `parseWavHeader()` / `FileBackedReader` in `FileBackedWav.kt` | Replaced by C++ WAV fast path in `AudioDecodeSession` |
| TurboModule | `createOfflineAudioBufferFromSource` | Replaced by `decodeFileToOfflineBuffer` |

---

## Rollout in two parts

### Part 1: Unified decode primitive + offline expansion

Scope:

1. Implement `AudioDecodeSession` in C++ (chunk-streaming FFmpeg decode + WAV fast path + SwrContext resample/downmix)
2. Implement `AudioEncodeSession` in C++ (extracted from `audio_convert_file.cpp`)
3. Refactor `audio_convert_file.cpp` to use `AudioDecodeSession` + `AudioEncodeSession`
4. Wire JNI (Android) and direct C++ (iOS) bindings for `AudioDecodeSession`
5. Implement `decodeFileToOfflineBuffer` TurboModule method (replaces `createOfflineAudioBufferFromSource`)
6. Route all file source resolution through `FileIOResolver` (remove duplicate resolution)
7. Remove: `WaveReader` usage, `sherpa_onnx::cxx::ReadWave()` usage, `Resampler.resampleLinear()`, `pa_resampleLinear()`, platform-specific WAV header parsers
8. Update public TS API: `createOfflineAudioBufferFromFile(source, options?)` with `AudioDecodeOptions`
9. Add `DECODE_*` error codes to TS types
10. Implement progress events (`decodeProgress` native event → `onProgress` callback)
11. Implement cancellation (`cancelDecode` TurboModule method → `AbortSignal`)
12. Verify all `FileSource` kinds work for offline buffer creation
13. Verify existing offline STT/alignment/TTS tests pass

Why first:

- Establishes shared decode primitive that Part 2 and conversion refactor depend on
- Lower lifecycle complexity than live ingest
- Immediately testable with existing pipeline consumers
- Removes all redundant decode stacks in one step

Expected outcome:

- `createOfflineAudioBufferFromFile` accepts any FFmpeg-supported audio format via any `FileSource` kind
- One decode path (C++ `AudioDecodeSession`), one resampler (`SwrContext`), one resolver (`FileIOResolver`)
- File-backed WAV fast path preserved for large PCM WAV files
- `audio_convert_file` refactored to decode+encode primitives

### Part 2: Live buffer file ingest

Scope:

1. Implement `startFileIngestToLiveBuffer` TurboModule method
2. Implement auto-spool for file ingest (temp spool when no `persistencePath`)
3. Implement `FileIngestRegistry` (Android) / `g_file_ingests` (iOS) for tracking active ingests
4. Implement `getFileIngestStatus` TurboModule method
5. Wire cancellation to existing `cancelDecode` path
6. Add `'file_ingest'` to `LiveBufferAppendSource` on native side
7. Implement `autoFinalize` behavior (default: `false`)
8. Implement `ingestFileToLiveAudioBuffer` TS wrapper returning `FileIngestHandle`
9. Implement `FileIngestHandle.done` promise (resolves on native completion event)
10. Verify pipeline consumer compatibility (streaming STT with file ingest source)
11. Verify sequential ingest (file A → file B → mic on same buffer)
12. Verify cancellation (partial ingest, buffer stays recording)

Why second:

- Depends on stable `AudioDecodeSession` from Part 1
- Adds lifecycle states (ingest running, cancel, auto-finalize)
- Requires auto-spool logic
- Needs coordination between decode thread and pipeline consumer threads

Expected outcome:

- `ingestFileToLiveAudioBuffer` streams file decode into any live buffer
- Downstream pipeline consumers process chunks as they arrive
- Sequential and mixed sources (file + mic + file) work on the same buffer
- Spool prevents data loss during fast decode

---

## Code duplication eliminated

| Current duplication | After refactor |
|--------------------|--------------------|
| `WaveReader.readWave()` (Android) + `sherpa_onnx::cxx::ReadWave()` (iOS) + FFmpeg decode in conversion | Single `AudioDecodeSession` (C++) |
| `FileIOResolver` (fileio) + inline source resolution (`SherpaOnnxModule`) | `FileIOResolver` only |
| Kotlin `Resampler.resampleLinear()` + iOS `pa_resampleLinear()` + FFmpeg `SwrContext` | FFmpeg `SwrContext` only |
| WAV header parsing: `parseWavHeader` (Android) + `pa_parseWavHeader` (iOS) | Single C++ WAV fast-path in `AudioDecodeSession` |
| Monolithic `audio_convert_file.cpp` (decode+encode coupled) | `AudioDecodeSession` + `AudioEncodeSession` (independent, composable) |

---

## Breaking changes summary

| What changed | Before | After |
|---|---|---|
| `createOfflineAudioBufferFromFile` signature | `(source, targetSampleRateHz?, forceMono?)` | `(source, options?: AudioDecodeOptions)` |
| TurboModule method | `createOfflineAudioBufferFromSource` | `decodeFileToOfflineBuffer` (different params) |
| `LiveBufferAppendSource` values | No `'file_ingest'` | Added `'file_ingest'` |
| New public functions | — | `ingestFileToLiveAudioBuffer` |
| New types | — | `AudioDecodeOptions`, `DecodeProgressEvent`, `FileIngestHandle`, `FileIngestResult`, `FileIngestStatus`, `FileIngestOptions`, `DecodeErrorCode` |
| Removed native code | `WaveReader`, `ReadWave`, platform-specific resamplers, platform-specific WAV parsers | Replaced by `AudioDecodeSession` |

---

## Non-goals

- Raw encoded formats as native in-memory buffer representation (buffers stay float32 PCM)
- Redesigning pipeline consumer APIs (STT, TTS, enhancement interfaces unchanged)
- Public `AudioInputFormat` type (format detection is always automatic via FFmpeg probing)
- `createLiveAudioBufferFromFile` convenience wrapper (deferred to post-implementation)

---

## Success criteria

- Part 1: offline buffer creation works for all FFmpeg-supported input formats via any `FileSource` kind
- Part 2: live buffer file ingest with streaming behavior, compatible with existing pipeline consumers
- Single decode stack: C++ `AudioDecodeSession` (FFmpeg + WAV fast path) on both platforms
- Single file source resolver: `FileIOResolver`
- Single resampler: FFmpeg `SwrContext`
- `audio_convert_file` refactored to `AudioDecodeSession` + `AudioEncodeSession`
- All existing pipeline consumer tests pass (STT, alignment, TTS, enhancement, waveform UI)
- No JS bridge roundtrips during steady-state decode (progress events are native→JS one-way, chunks stay native)

---

## Design decisions log

All decisions resolved. Reference for implementation.

### 1. Live ingest API shape

**Decision: Option B — Ingest method on existing buffer.**

`ingestFileToLiveAudioBuffer(liveBuffer, source, options?)` is the primary API. Reasons:
- Consistent with existing append paths (`appendSamplesToLiveAudioBuffer`, `appendOfflineToLiveAudioBuffer`) — file ingest is the third append kind.
- Composable: file → mic → second file on the same buffer is natural.
- No architectural dead ends: Option A would require adding ingest-on-existing-buffer later anyway.
- Pipeline consumers (STT, enhancement) attach to the buffer before ingest starts — same flow as mic capture.

Optional convenience `createLiveAudioBufferFromFile` can be added later as a thin wrapper.

### 2. Auto-finalize behavior

**Decision: `autoFinalize` option, default `false`.**

- Default `false`: buffer stays `recording` after ingest. Caller can append more data.
- Set `true` for "file → pipeline → done" use cases where finalization should happen automatically.
- Matches the explicit-finalize model of the rest of the live buffer API.

### 3. Cancellation semantics for live ingest

**Decision: Keep already-appended samples, buffer stays `recording`.**

- On cancel: abort flag set, decode loop exits, already-appended chunks are retained.
- Buffer state: unchanged (`recording`). Caller decides: finalize, append more, or release.
- `ingest.done` promise rejects with `DECODE_CANCELLED`.
- Rationale: non-destructive default. Caller has full control over what happens with partial data.

### 4. WAV fast path threshold

**Decision: Keep as-is (10 MB).**

- File-backed threshold for decoded PCM: 10 MB.
- WAV fast path (bypass FFmpeg): PCM WAV s16le/f32le mono at matching sample rate.
- No change to fast-path conditions or threshold.

### 5. AudioInputFormat — public API

**Decision: No public `AudioInputFormat` type. Auto-detection only.**

- FFmpeg probes container and codec automatically. Reliable for all supported formats.
- No `inputFormat` parameter in public API. Simpler surface, fewer wrong-usage paths.
- If probing fails, error is `DECODE_OPEN_FAILED` — user provides a valid audio file.

### 6. iOS decode path

**Decision: FFmpeg on iOS (already linked). Same `AudioDecodeSession` C++ code.**

- FFmpeg framework is already linked on iOS.
- Identical C++ `AudioDecodeSession` on both platforms. No platform-specific decode stack.
- `sherpa_onnx::cxx::ReadWave()` removed from offline buffer creation path.

### 7. Progress granularity

**Decision: Estimate from file size + bitrate. `percent` is always provided.**

- Container provides duration → exact estimate.
- No duration → estimate from `(fileSize * 8) / bitrate`.
- `DecodeProgressEvent.percent` is always `number` (never null). Best-effort 0–100.
- `totalFramesEstimate` is always `number` (never null). Estimated when exact value unavailable.

### 8. audio_convert_file refactor scope

**Decision: Full refactor. Split into `AudioDecodeSession` + `AudioEncodeSession`.**

- `audio_convert_file.cpp` refactored into two independent primitives.
- Decode side becomes the shared `AudioDecodeSession`.
- Encode side becomes `AudioEncodeSession` (streaming encoder, `feedChunk` + `finalize`).
- Existing `convertAudioToFormat` (buffer → file) uses `AudioEncodeSession` directly (no decode needed — samples already in buffer).
- Future file → file conversion chains both without intermediate buffer.
- Done in Part 1 to establish the full dedup from the start.

### 9. Live ingest backpressure

**Decision: Spool always enabled for file ingest.**

- When `ingestFileToLiveAudioBuffer` runs, spool is automatically enabled on the live buffer.
- If buffer was created without `persistencePath`: native creates a temp spool file, cleaned up after ingest or buffer release.
- Prevents data loss: ring overflow drops old samples from the ring, but spool retains everything.
- Decode speed is not throttled — full-speed decode, pipeline consumers drain at their own pace via cursors.

### 10. Error code consolidation

**Decision: New `DECODE_*` family.**

- All decode errors use `DECODE_*` prefix (separate from `AUDIO_*` buffer errors and `CONVERSION_*` encode errors).
- Clear boundary: `DECODE_*` = input file → PCM. `CONVERSION_*` = PCM → output file. `AUDIO_*` = buffer lifecycle.
- `DecodeErrorCode` const object exported from `react-native-sherpa-onnx/audiobuffer`.

