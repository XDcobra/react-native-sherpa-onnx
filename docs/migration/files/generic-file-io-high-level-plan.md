# Generic File I/O — Implementation Spec

> Concrete implementation specification for the unified, type-safe file I/O layer
> across Android and iOS in `react-native-sherpa-onnx`.
>
> **Status: READY FOR IMPLEMENTATION — all design decisions resolved.**

---

## Table of Contents

1. [Goals & Scope](#1-goals--scope)
2. [Current State Inventory](#2-current-state-inventory)
3. [Location Type Model](#3-location-type-model)
4. [Public JS API — `react-native-sherpa-onnx/fileio`](#4-public-js-api--react-native-sherpa-onnxfileio)
5. [Audio API Migration](#5-audio-api-migration)
6. [TurboModule Bridge Methods](#6-turbomodule-bridge-methods)
7. [Native Architecture](#7-native-architecture)
8. [Error Model](#8-error-model)
9. [Progress & Cancellation](#9-progress--cancellation)
10. [Security — `app` Base Dir Whitelist](#10-security--app-base-dir-whitelist)
11. [Android SAF Permission Requirements](#11-android-saf-permission-requirements)
12. [iOS Security-Scoped URL Support](#12-ios-security-scoped-url-support)
13. [Migration Plan](#13-migration-plan)
14. [Test Strategy](#14-test-strategy)
15. [Documentation Plan](#15-documentation-plan)
16. [Breaking Changes Summary](#16-breaking-changes-summary)
17. [Future Scope](#17-future-scope)
18. [Design Decisions Log](#18-design-decisions-log)

---

## 1. Goals & Scope

### 1.1 Goals

- A shared TypeScript type model for file sources and destinations (discriminated unions).
- A single public module `react-native-sherpa-onnx/fileio` replacing the legacy `files` subpath.
- Unified `copyFile`, `saveText`, `shareFile` APIs that accept typed locations instead of raw strings.
- Audio buffer import (`createOfflineAudioBufferFromFile`) and audio conversion output (`convertAudioToFormat`, `convertAudioToWav16k`) migrated to the same location model.
- Direct streaming output from encoder to destination (no temp+copy for the primary path).
- Progress reporting and cancellation for all copy/conversion operations from V1.
- Minimal JS bridge roundtrips — all resolution and streaming stays native.

### 1.2 Non-Goals (V1)

- No virtual filesystem abstraction.
- No HTTP/HTTPS download integration in this API.
- No `blob`/`ArrayBuffer` as `FileSource`/`FileDestination` (requires JSI ArrayBuffer support from the [AudioBuffer JSI spec](../audiobuffer/audiobuffer-jsi-arraybuffer-implementation-spec.md) first — accepted as future scope).
- No backward-compatible wrappers for old API names — old APIs are removed immediately.

---

## 2. Current State Inventory

### 2.1 Files API (`src/files/index.ts` — to be deleted)

| Function | Signature | Platform Notes |
|---|---|---|
| `saveTextToContentUri` | `(text, directoryUri, filename, mimeType?) → Promise<string>` | Android: SAF; iOS: local path write |
| `copyFileToContentUri` | `(filePath, directoryUri, filename, mimeType) → Promise<string>` | Android: SAF; iOS: rejects |
| `copyContentUriToCache` | `(fileUri, filename) → Promise<string>` | Android: content:// → cache; iOS: file copy |
| `shareAudioFile` | `(fileUri, mimeType?) → Promise<void>` | Both platforms |

### 2.2 Audio Conversion (`src/audio/index.ts`)

| Function | Signature | Notes |
|---|---|---|
| `convertAudioToFormat` | `(input, outputPath: string, format, sampleRateHz?) → Promise<void>` | Local absolute path only |
| `convertAudioToWav16k` | `(input, outputPath: string) → Promise<void>` | Shortcut |

### 2.3 Audio Buffer Import (`src/audiobuffer/index.ts`)

| Function | Signature | Notes |
|---|---|---|
| `createOfflineAudioBufferFromFile` | `(sourcePath: string, targetSampleRateHz?, forceMono?) → Promise<OfflineAudioBufferRef>` | Local path only |

### 2.4 Native Error Codes (to be migrated)

| Current Code | Source |
|---|---|
| `FILES_SAVE_ERROR` | `SherpaOnnxFilesHelper.kt`, `SherpaOnnx+Files.mm` |
| `FILES_SHARE_ERROR` | `SherpaOnnxFilesHelper.kt`, `SherpaOnnx+Files.mm` |
| `CONVERSION_*` (8 codes) | Audio conversion |
| `AUDIO_FILE_*` (2 codes) | Audio buffer file operations |

---

## 3. Location Type Model

### 3.1 `FileSource` — Read Locations

```ts
/**
 * Discriminated union describing where to read a file from.
 * Native resolvers map each kind to platform-appropriate I/O.
 */
export type FileSource =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | { kind: 'contentUri'; uri: string }
  | { kind: 'securityScoped'; uri: string }
  | { kind: 'pad'; packName: string; path: string };
```

### 3.2 `FileDestination` — Write Locations

```ts
/**
 * Discriminated union describing where to write a file to.
 * Platform-incompatible kinds fail with FILEIO_UNSUPPORTED_ON_PLATFORM.
 */
export type FileDestination =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | { kind: 'contentUri'; uri: string }
  | {
      kind: 'contentTree';
      treeUri: string;
      filename: string;
      /** Required. MIME type for the created SAF document. */
      mimeType: string;
    }
  | { kind: 'securityScoped'; uri: string };
```

### 3.3 `AppBaseDir`

```ts
/**
 * Well-known app-relative base directories.
 * The native resolver maps these to platform-specific absolute paths.
 */
export type AppBaseDir =
  | 'cache'       // Android: context.cacheDir         | iOS: NSCachesDirectory
  | 'documents'   // Android: context.filesDir + /docs | iOS: NSDocumentDirectory
  | 'files'       // Android: context.filesDir          | iOS: app support dir
  | 'tmp'         // Android: context.cacheDir + /tmp   | iOS: NSTemporaryDirectory
  | 'externalFiles'; // Android: context.getExternalFilesDir(null) | iOS: UNSUPPORTED
```

### 3.4 `ResolvedFileRef` — Canonical Result Location

```ts
/**
 * Canonical reference to a file after a write/copy operation.
 * Always contains the concrete location the file was written to.
 */
export type ResolvedFileRef =
  | { kind: 'fs'; path: string }
  | { kind: 'contentUri'; uri: string };
```

### 3.5 Kind Semantics

| Kind | Source | Destination | Android | iOS |
|---|---|---|---|---|
| `fs` | ✅ | ✅ | Absolute file path | Absolute file path |
| `app` | ✅ | ✅ | Relative to `AppBaseDir` | Relative to `AppBaseDir` |
| `contentUri` | ✅ | ✅ (document URI) | `ContentResolver` streams | `UNSUPPORTED_ON_PLATFORM` |
| `contentTree` | — | ✅ | `DocumentsContract.createDocument` | `UNSUPPORTED_ON_PLATFORM` |
| `securityScoped` | ✅ | ✅ | `UNSUPPORTED_ON_PLATFORM` | `startAccessingSecurityScopedResource` / `stopAccessingSecurityScopedResource` |
| `pad` | ✅ (read-only) | — | PAD `getAssetPackPath` resolution | `UNSUPPORTED_ON_PLATFORM` |

### 3.6 PAD Resolution Semantics

- When the caller knows the PAD pack name and relative path, use `{ kind: 'pad', packName, path }`. The native resolver calls `getAssetPackPath(packName)` and appends the path.
- When the caller already has a resolved absolute path (e.g. from a previous `getAssetPackPath` + listing call), `{ kind: 'fs', path }` is valid.
- **`pad` is the canonical, intention-revealing choice** when addressing PAD assets. `fs` is the "already-resolved" escape hatch.

---

## 4. Public JS API — `react-native-sherpa-onnx/fileio`

The entire public surface lives at `src/fileio/index.ts`. The old `src/files/` directory is deleted.

### 4.1 `copyFile`

```ts
export interface CopyFileOptions {
  /**
   * Overwrite existing file at destination.
   * @default true
   */
  overwrite?: boolean;
  /** Create parent directories if they don't exist (fs/app destinations only). */
  createParentDirectories?: boolean;
  /**
   * AbortSignal to cancel the copy. The native operation checks this between
   * buffer reads and aborts promptly.
   */
  signal?: AbortSignal;
  /** Progress callback. Called on native thread, dispatched to JS. */
  onProgress?: (event: FileIOProgressEvent) => void;
}

export interface CopyFileResult {
  /** Number of bytes written. */
  bytesCopied: number;
  /** Canonical reference to the output file. */
  output: ResolvedFileRef;
}

/**
 * Copy a file from source to destination.
 *
 * All source/destination resolution, streaming, and error handling happens natively.
 * A single TurboModule call — no intermediate JS bridge hops.
 *
 * @throws FileIOError with code FILEIO_CANCELLED if signal is aborted.
 */
export function copyFile(
  input: FileSource,
  output: FileDestination,
  options?: CopyFileOptions,
): Promise<CopyFileResult>;
```

### 4.2 `saveText`

```ts
export interface SaveTextOptions {
  /**
   * Text encoding.
   * @default 'utf8'
   */
  encoding?: 'utf8';
  /**
   * Overwrite existing file at destination.
   * @default true
   */
  overwrite?: boolean;
}

/**
 * Write a string to a file destination.
 *
 * For contentTree destinations, the mimeType from the destination is used
 * for SAF document creation.
 */
export function saveText(
  text: string,
  output: FileDestination,
  options?: SaveTextOptions,
): Promise<ResolvedFileRef>;
```

### 4.3 `shareFile`

```ts
export interface ShareFileOptions {
  /** MIME type for the share intent. Inferred from file extension if omitted. */
  mimeType?: string;
  /** Android: chooser title. iOS: ignored. */
  title?: string;
}

/**
 * Open the system share sheet for a file.
 *
 * Side-effect only — returns void.
 */
export function shareFile(
  input: FileSource,
  options?: ShareFileOptions,
): Promise<void>;
```

### 4.4 Progress Event

```ts
/**
 * Progress event emitted during file I/O operations (copy, conversion).
 */
export interface FileIOProgressEvent {
  /** Bytes transferred so far. */
  bytesTransferred: number;
  /** Total bytes (0 if unknown, e.g. content:// streams without Content-Length). */
  totalBytes: number;
  /** Progress percentage 0–100 (0 when totalBytes is unknown). */
  percent: number;
}
```

### 4.5 Type Exports

```ts
// src/fileio/index.ts — re-exports
export type {
  FileSource,
  FileDestination,
  AppBaseDir,
  ResolvedFileRef,
  CopyFileOptions,
  CopyFileResult,
  SaveTextOptions,
  ShareFileOptions,
  FileIOProgressEvent,
} from './types';

export { FileIOErrorCode } from './types';
export type { FileIOErrorCodeValue } from './types';
```

---

## 5. Audio API Migration

### 5.1 `createOfflineAudioBufferFromFile` — Input Migration

```ts
// src/audiobuffer/index.ts (updated signature)

import type { FileSource } from '../fileio/types';

/**
 * Create an offline audio buffer from an audio file.
 * Small files are loaded into memory; large files (>10 MB) stay file-backed.
 *
 * The native resolver handles all FileSource kinds:
 * - fs/app: direct file access
 * - contentUri: Android ContentResolver stream → temp file → decode
 * - securityScoped: iOS security-scoped URL access → decode
 * - pad: PAD path resolution → decode
 *
 * Single TurboModule call. No JS-side file copying.
 */
export function createOfflineAudioBufferFromFile(
  source: FileSource,
  targetSampleRateHz?: number,
  forceMono?: boolean,
): Promise<OfflineAudioBufferRef>;
```

### 5.2 `convertAudioToFormat` — Output Migration

```ts
// src/audio/index.ts (updated signature)

import type { FileDestination, ResolvedFileRef } from '../fileio/types';

/**
 * Convert a pipeline audio buffer to an encoded audio file at the given destination.
 *
 * The native encoder streams output directly to the destination.
 * For contentUri/contentTree destinations, the encoder writes to the SAF OutputStream
 * via FFmpeg's custom I/O callbacks (Android) or writes locally then moves (iOS,
 * since security-scoped URLs support direct writes).
 *
 * Direct streaming is the primary path. Temp+copy is only used as an internal
 * fallback when the encoder cannot write directly to the destination (e.g. if
 * the format requires seekable output and the destination is a non-seekable stream).
 *
 * Returns a ResolvedFileRef pointing to the written file.
 */
export function convertAudioToFormat(
  input: PipelineAudioBufferIdSource,
  output: FileDestination,
  format: AudioOutputFormat,
  options?: AudioConversionOptions,
): Promise<ResolvedFileRef>;

export interface AudioConversionOptions {
  /**
   * Target sample rate. Semantics depend on format:
   * - WAV:  0 or omitted = buffer's native sample rate. Explicit value = resample.
   * - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
   * - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
   * - FLAC/AAC/M4A: 0 = buffer's native rate. Explicit value = resample.
   */
  outputSampleRateHz?: number;
  /** AbortSignal to cancel conversion. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: FileIOProgressEvent) => void;
}
```

### 5.3 `convertAudioToWav16k` — Updated

```ts
/**
 * Convert a pipeline audio buffer to WAV 16 kHz mono 16-bit PCM.
 * Shortcut for convertAudioToFormat(input, output, 'wav', { outputSampleRateHz: 16000 }).
 *
 * Now accepts a FileDestination instead of a plain string path.
 */
export function convertAudioToWav16k(
  input: PipelineAudioBufferIdSource,
  output: FileDestination,
): Promise<ResolvedFileRef>;
```

---

## 6. TurboModule Bridge Methods

All file I/O bridge methods serialize `FileSource`/`FileDestination` as a JS object (ReadableMap). The native side deserializes via `kind` discriminator. This is a single bridge call per operation.

### 6.1 New Methods (added to `NativeSherpaOnnx.ts`)

```ts
// ==================== File I/O ====================

/**
 * Copy file from source to destination.
 * @param source - Serialized FileSource (ReadableMap with `kind` discriminator)
 * @param destination - Serialized FileDestination (ReadableMap with `kind` discriminator)
 * @param overwrite - Overwrite existing file at destination
 * @param createParentDirectories - Create parent dirs for fs/app destinations
 * @param operationId - Unique ID for progress events and cancellation
 * @returns { bytesCopied: number, outputKind: string, outputPath: string }
 */
copyFile(
  source: Object,
  destination: Object,
  overwrite: boolean,
  createParentDirectories: boolean,
  operationId: string,
): Promise<{
  bytesCopied: number;
  outputKind: string;
  outputPath: string;
}>;

/**
 * Write text to a destination.
 * @returns { outputKind: string, outputPath: string }
 */
saveText(
  text: string,
  destination: Object,
  encoding: string,
  overwrite: boolean,
): Promise<{
  outputKind: string;
  outputPath: string;
}>;

/**
 * Open system share sheet for source file.
 */
shareFile(
  source: Object,
  mimeType: string,
  title: string,
): Promise<void>;

/**
 * Cancel an in-progress file I/O operation by operationId.
 */
cancelFileIO(operationId: string): Promise<void>;

// ==================== Audio conversion (updated) ====================

/**
 * Convert pipeline audio buffer to encoded file at destination.
 * @param bufferId - off_UUID or live_UUID
 * @param destination - Serialized FileDestination
 * @param format - Target format string
 * @param outputSampleRateHz - 0 = format-dependent default
 * @param operationId - For progress/cancel
 * @returns { outputKind: string, outputPath: string }
 */
convertPipelineAudioToDestination(
  bufferId: string,
  destination: Object,
  format: string,
  outputSampleRateHz: number,
  operationId: string,
): Promise<{
  outputKind: string;
  outputPath: string;
}>;

// ==================== Audio buffer from file (updated) ====================

/**
 * Create offline audio buffer from a FileSource.
 * @param source - Serialized FileSource
 */
createOfflineAudioBufferFromSource(
  source: Object,
  targetSampleRateHz?: number,
  forceMono?: boolean,
): Promise<{
  bufferId: string;
  kind: string;
  state: string;
  sampleRate: number;
  channelCount: number;
  numSamples: number;
  durationMs: number;
}>;
```

### 6.2 Removed Methods

The following TurboModule methods are deleted (no deprecation wrapper):

| Removed Method | Replacement |
|---|---|
| `saveTextToContentUri` | `saveText` |
| `copyFileToContentUri` | `copyFile` |
| `copyContentUriToCache` | `copyFile` |
| `shareAudioFile` | `shareFile` |
| `convertPipelineAudioBufferToFormat` | `convertPipelineAudioToDestination` |
| `createOfflineAudioBufferFromFile` | `createOfflineAudioBufferFromSource` |

### 6.3 Progress Events

Progress is delivered via the existing RN `NativeEventEmitter` mechanism:

```ts
// Event name: 'fileIOProgress'
// Event shape:
{
  operationId: string;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}
```

The JS wrapper in `src/fileio/index.ts` subscribes to the event emitter for the operation's `operationId`, forwards to the user's `onProgress` callback, and unsubscribes on completion/error/cancel.

---

## 7. Native Architecture

### 7.1 Resolver Pattern

Each platform implements a central resolver that converts `FileSource`/`FileDestination` to native I/O primitives. All feature helpers (file copy, audio conversion, buffer import) use the resolver — no duplicated URI/path logic.

#### 7.1.1 Android Resolver (`FileIOResolver.kt`)

```kotlin
/**
 * Central resolver for FileSource / FileDestination.
 * All file I/O operations go through this to avoid duplicated URI/path logic.
 */
internal class FileIOResolver(private val context: ReactApplicationContext) {

  /** Resolved read handle. Caller must close. */
  sealed class ReadHandle : Closeable {
    /** Local file — can be passed to APIs that require a path. */
    class FilePath(val file: File) : ReadHandle() { override fun close() {} }
    /** Content stream — for streaming reads (no random access). */
    class Stream(val inputStream: InputStream, val length: Long?) : ReadHandle() {
      override fun close() = inputStream.close()
    }
  }

  /** Resolved write handle. Caller must close. */
  sealed class WriteHandle : Closeable {
    /** Local file path. */
    class FilePath(val file: File) : WriteHandle() { override fun close() {} }
    /** SAF output stream — for streaming writes. */
    class Stream(
      val outputStream: OutputStream,
      val resultUri: Uri,
    ) : WriteHandle() {
      override fun close() = outputStream.close()
    }
  }

  fun resolveSource(source: ReadableMap): ReadHandle { ... }
  fun resolveDestination(destination: ReadableMap): WriteHandle { ... }
}
```

Resolution logic per kind:

| Kind | `resolveSource` | `resolveDestination` |
|---|---|---|
| `fs` | `ReadHandle.FilePath(File(path))` | `WriteHandle.FilePath(File(path))` |
| `app` | Resolve `AppBaseDir` → absolute path → `FilePath` | Resolve `AppBaseDir` → absolute path → `FilePath` |
| `contentUri` | `ContentResolver.openInputStream(uri)` → `Stream` | `ContentResolver.openOutputStream(uri, "w")` → `Stream` |
| `contentTree` | N/A (not a source) | `DocumentsContract.createDocument(...)` → open stream → `Stream` |
| `securityScoped` | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `pad` | `assetPackManager.getAssetPackPath(packName)` + path → `FilePath` | N/A (not a destination) |

#### 7.1.2 iOS Resolver (Objective-C++)

```objc
/**
 * Central resolver for FileSource / FileDestination.
 */

// Read result
struct FileIOReadHandle {
  enum Kind { kFilePath, kStream };
  Kind handleKind;
  NSString *filePath;       // kFilePath
  NSInputStream *stream;    // kStream
  int64_t length;           // -1 if unknown
  NSURL *securityScopedURL; // non-nil if security-scoped access was started
};

// Write result
struct FileIOWriteHandle {
  enum Kind { kFilePath, kStream };
  Kind handleKind;
  NSString *filePath;       // kFilePath
  NSOutputStream *stream;   // kStream
  NSString *resultPath;     // Canonical output path
  NSURL *securityScopedURL; // non-nil if security-scoped access was started
};
```

Resolution logic per kind (iOS):

| Kind | `resolveSource` | `resolveDestination` |
|---|---|---|
| `fs` | `FileIOReadHandle{kFilePath, path}` | `FileIOWriteHandle{kFilePath, path}` |
| `app` | Resolve `AppBaseDir` → absolute path → `{kFilePath}` | Resolve `AppBaseDir` → absolute path → `{kFilePath}` |
| `contentUri` | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `contentTree` | N/A | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `securityScoped` | `startAccessingSecurityScopedResource` → `{kFilePath}` | `startAccessingSecurityScopedResource` → `{kFilePath}` |
| `pad` | Throw `FILEIO_UNSUPPORTED_ON_PLATFORM` | N/A |

### 7.2 Stream Copy Engine

Both platforms implement a central copy engine used by `copyFile` and as fallback for audio conversion:

```
while (bytesRead = read(source, buffer, BUFFER_SIZE)) > 0:
  if cancelled: throw FILEIO_CANCELLED
  write(destination, buffer, bytesRead)
  totalTransferred += bytesRead
  emitProgress(operationId, totalTransferred, totalBytes)
```

- Buffer size: 64 KB (tuned for SAF performance on Android).
- Progress events emitted every 64 KB or on completion — no throttle interval (consumer-side debounce is the caller's responsibility).
- Cancellation check per buffer read — worst-case latency = one buffer write (~64 KB).

### 7.3 Audio Conversion — Direct Streaming Output

The primary path for audio conversion writes directly from the encoder to the destination:

**Android:**
- For `fs`/`app` destinations, FFmpeg writes to the local path directly.
- For `contentUri`/`contentTree` destinations, the resolver prefers a seekable `ParcelFileDescriptor` and passes `/proc/self/fd/<n>` to FFmpeg.
- This keeps the existing C++ FFmpeg path-based converter unchanged while avoiding temp+copy in the primary path.

**iOS:**
- For `fs`/`app`/`securityScoped` destinations, the encoder writes to the resolved local path directly.
- `securityScoped` destinations use `startAccessingSecurityScopedResource` before encoding and `stopAccessingSecurityScopedResource` after.

**Fallback (internal only):**
If a SAF provider cannot supply a seekable fd for a destination, the encoder writes to `app/cache/fileio_tmp_<uuid>.<ext>`, then the copy engine streams to the destination and deletes the temp file. This is transparent to the caller.

### 7.4 Audio Buffer Import — Source Resolution

`createOfflineAudioBufferFromSource` resolves the `FileSource` natively:

- `fs`/`app`/`pad`: resolved to local file path → passed directly to the existing WAV decoder / sherpa `ReadWave`.
- `contentUri` (Android): resolver prefers `openFileDescriptor(uri, "r")` and decodes via `/proc/self/fd/<n>` directly. Stream-to-temp is retained as fallback when fd access is unavailable.
- `securityScoped` (iOS): `startAccessingSecurityScopedResource` → resolve to path → decode → `stopAccessingSecurityScopedResource`.

### 7.5 File Layout

**New files:**

| File | Purpose |
|---|---|
| `src/fileio/index.ts` | Public API: `copyFile`, `saveText`, `shareFile` + re-exports |
| `src/fileio/types.ts` | All type definitions: `FileSource`, `FileDestination`, `AppBaseDir`, `ResolvedFileRef`, options, error codes |
| `android/.../fileio/FileIOResolver.kt` | Android source/destination resolver |
| `android/.../fileio/FileIOStreamCopy.kt` | Android stream copy engine with progress/cancel |
| `android/.../fileio/FileIOHelper.kt` | Android TurboModule delegate for copyFile/saveText/shareFile |
| `ios/fileio/FileIOResolver.h` / `.mm` | iOS source/destination resolver |
| `ios/fileio/FileIOStreamCopy.h` / `.mm` | iOS stream copy engine with progress/cancel |
| `ios/fileio/SherpaOnnx+FileIO.mm` | iOS TurboModule bridge methods |

**Deleted files:**

| File | Reason |
|---|---|
| `src/files/index.ts` | Replaced by `src/fileio/index.ts` |
| `android/.../SherpaOnnxFilesHelper.kt` | Replaced by `fileio/FileIOHelper.kt` |
| `ios/SherpaOnnx+Files.mm` | Replaced by `fileio/SherpaOnnx+FileIO.mm` |

**Modified files:**

| File | Changes |
|---|---|
| `src/NativeSherpaOnnx.ts` | Remove old methods, add new bridge methods (§6) |
| `src/audio/index.ts` | Update `convertAudioToFormat`/`convertAudioToWav16k` signatures |
| `src/audio/types.ts` | Add `AudioConversionOptions`; keep `AudioOutputFormat` and `ConversionErrorCode` |
| `src/audiobuffer/index.ts` | Update `createOfflineAudioBufferFromFile` signature |
| `src/index.ts` | Replace `files` re-export with `fileio` |
| `android/.../SherpaOnnxModule.kt` | Wire new bridge methods, remove old file method delegation |
| `android/.../SherpaOnnxContentUriUtils.kt` | Kept as internal util, used by `FileIOResolver` |
| `ios/SherpaOnnx.mm` | Register new bridge methods |

---

## 8. Error Model

### 8.1 Error Codes

All file I/O error codes are prefixed `FILEIO_`. Legacy `FILES_*` codes are removed (breaking).

```ts
export const FileIOErrorCode = {
  /** Argument validation failed (invalid kind, missing required field, etc.) */
  INVALID_ARGUMENT: 'FILEIO_INVALID_ARGUMENT',
  /** The location kind is not recognized. */
  UNSUPPORTED_LOCATION_KIND: 'FILEIO_UNSUPPORTED_LOCATION_KIND',
  /** The location kind is valid but not supported on this platform. */
  UNSUPPORTED_ON_PLATFORM: 'FILEIO_UNSUPPORTED_ON_PLATFORM',
  /** Missing or expired SAF/security-scoped permission. */
  PERMISSION_DENIED: 'FILEIO_PERMISSION_DENIED',
  /** Source file/URI not found. */
  NOT_FOUND: 'FILEIO_NOT_FOUND',
  /** Destination already exists and overwrite is false. */
  ALREADY_EXISTS: 'FILEIO_ALREADY_EXISTS',
  /** Error reading from source. */
  READ_ERROR: 'FILEIO_READ_ERROR',
  /** Error writing to destination. */
  WRITE_ERROR: 'FILEIO_WRITE_ERROR',
  /** Failed to resolve source or destination to a native handle. */
  RESOLVE_ERROR: 'FILEIO_RESOLVE_ERROR',
  /** Operation was cancelled via AbortSignal / cancelFileIO. */
  CANCELLED: 'FILEIO_CANCELLED',
  /** The app base dir path traversal was blocked by the security whitelist. */
  PATH_TRAVERSAL_BLOCKED: 'FILEIO_PATH_TRAVERSAL_BLOCKED',
} as const;

export type FileIOErrorCodeValue =
  (typeof FileIOErrorCode)[keyof typeof FileIOErrorCode];
```

### 8.2 Audio Conversion Error Codes

`CONVERSION_*` codes remain in `src/audio/types.ts` for audio-specific errors (format mismatch, sample rate validation, buffer state). For destination-related failures, the conversion functions throw `FILEIO_*` codes instead.

### 8.3 Error Shape

Errors are thrown as standard JS `Error` instances via `Promise.reject`. The `message` starts with the error code for programmatic matching:

```ts
// Native: promise.reject("FILEIO_NOT_FOUND", "Source file not found: /path/to/file", exception)
// JS: catch (e) { if (e.code === 'FILEIO_NOT_FOUND') { ... } }
```

---

## 9. Progress & Cancellation

### 9.1 Architecture

All copy and conversion operations support progress and cancellation from V1:

1. The JS wrapper generates a unique `operationId` (UUID) per call.
2. The `operationId` is passed to the TurboModule method.
3. Native emits `fileIOProgress` events via `NativeEventEmitter` keyed by `operationId`.
4. The JS wrapper subscribes before starting, forwards to `onProgress`, and unsubscribes on completion/error/cancel.
5. `AbortSignal` maps to `cancelFileIO(operationId)` on the native side.

### 9.2 Cancellation Flow

```
JS: const controller = new AbortController();
JS: copyFile(src, dst, { signal: controller.signal })
    → generates operationId, subscribes signal.onabort → cancelFileIO(operationId)
    → calls native copyFile(src, dst, ..., operationId)

User: controller.abort()
    → signal fires → JS calls cancelFileIO(operationId)
    → Native sets cancelled flag for operationId
    → Copy loop checks flag, throws FILEIO_CANCELLED
    → Promise rejects with FILEIO_CANCELLED
    → JS wrapper unsubscribes event listener
```

### 9.3 Operations Supporting Progress/Cancel

| Operation | Progress | Cancel |
|---|---|---|
| `copyFile` | ✅ | ✅ |
| `convertAudioToFormat` | ✅ | ✅ |
| `convertAudioToWav16k` | ✅ (via options forwarding) | ✅ |
| `saveText` | — (instant for text) | — |
| `shareFile` | — (OS-level) | — |
| `createOfflineAudioBufferFromFile` | — (decoding, not I/O) | — |

---

## 10. Security — `app` Base Dir Whitelist

The `app` kind uses a base directory + relative path model. To prevent path traversal into sensitive internal directories, the native resolver enforces:

1. **Canonicalization**: The resolved absolute path is canonicalized (`File.getCanonicalPath()` / `realpath()`).
2. **Prefix check**: The canonical path must start with the canonical base directory path.
3. **Blocked patterns**: Paths containing `..` segments that escape the base directory are rejected with `FILEIO_PATH_TRAVERSAL_BLOCKED`.
4. **Allowed base directories**: Only the `AppBaseDir` values listed in §3.3 are accepted.

Example (Android):
```kotlin
fun resolveAppPath(base: String, relativePath: String): File {
  val baseDir = when (base) {
    "cache"         -> context.cacheDir
    "documents"     -> File(context.filesDir, "docs")
    "files"         -> context.filesDir
    "tmp"           -> File(context.cacheDir, "tmp")
    "externalFiles" -> context.getExternalFilesDir(null)
      ?: throw FileIOException(UNSUPPORTED_ON_PLATFORM, "No external files dir")
    else -> throw FileIOException(UNSUPPORTED_LOCATION_KIND, "Unknown AppBaseDir: $base")
  }
  val resolved = File(baseDir, relativePath).canonicalFile
  if (!resolved.path.startsWith(baseDir.canonicalPath)) {
    throw FileIOException(PATH_TRAVERSAL_BLOCKED, "Path escapes base directory")
  }
  return resolved
}
```

---

## 11. Android SAF Permission Requirements

The SDK does not require legacy external storage permissions (`READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`).

### 11.1 Minimum Host-App Requirements

1. The app must obtain the target URI through a user-driven SAF flow (`ACTION_OPEN_DOCUMENT`, `ACTION_CREATE_DOCUMENT`, or `ACTION_OPEN_DOCUMENT_TREE`).
2. The picker intent should request URI grants needed by the use case:
   - `FLAG_GRANT_READ_URI_PERMISSION`
   - `FLAG_GRANT_WRITE_URI_PERMISSION` (for write targets)
3. For cross-session reuse, the app should also request:
   - `FLAG_GRANT_PERSISTABLE_URI_PERMISSION`
   and call `takePersistableUriPermission(uri, grantedFlags)` on the returned URI.

### 11.2 Operational Guidance

- `contentTree` is the preferred target for repeated writes into a user-selected folder.
- `contentUri` (document URI) is suitable for single-document read/write flows and also fully supported as a write target.
- If persisted permission is missing, expired, or revoked, the operation fails with `FILEIO_PERMISSION_DENIED`. The error message instructs the app to trigger a re-pick flow.
- The app is responsible for storing and managing persisted URIs; the SDK resolves and uses provided URIs but does not manage picker UX.

---

## 12. iOS Security-Scoped URL Support

Security-scoped URLs are returned by `UIDocumentPickerViewController` and similar system UI. The SDK supports them from V1 as the `securityScoped` kind.

### 12.1 Lifecycle

```
1. App presents UIDocumentPicker → user selects file → app receives security-scoped URL
2. App passes URL string to SDK as { kind: 'securityScoped', uri: '<url>' }
3. Native resolver:
   a. Convert string to NSURL
   b. Call [url startAccessingSecurityScopedResource]
   c. Perform I/O (read or write)
   d. Call [url stopAccessingSecurityScopedResource] in finally block
4. Return result
```

### 12.2 Bookmark Persistence

For cross-session reuse, the host app should create a security-scoped bookmark:
```swift
let bookmarkData = try url.bookmarkData(options: .withSecurityScope)
// Store bookmarkData in UserDefaults / database
// Later: let url = try URL(resolvingBookmarkData: data, options: .withSecurityScope, ...)
```

The SDK does not manage bookmarks. It only consumes the URL provided per-operation.

### 12.3 Error Handling

- If `startAccessingSecurityScopedResource` returns `false`, throw `FILEIO_PERMISSION_DENIED`.
- If the URL is not a security-scoped URL (e.g. a plain file URL passed as `securityScoped`), the call still works on iOS (no-op for `startAccessing`), but this is discouraged — use `fs` instead.

---

## 13. Migration Plan

### Phase 1: Type Model + Resolver Infrastructure

**Scope:** Foundation layer, no public API changes yet.

- [ ] Create `src/fileio/types.ts` with all type definitions.
- [ ] Create `android/.../fileio/FileIOResolver.kt` with `resolveSource`/`resolveDestination`.
- [ ] Create `android/.../fileio/FileIOStreamCopy.kt` with progress/cancel support.
- [ ] Create `ios/fileio/FileIOResolver.h/.mm` with resolver logic.
- [ ] Create `ios/fileio/FileIOStreamCopy.h/.mm`.
- [ ] Unit tests for resolver (all kinds, error cases, path traversal).

### Phase 2: New File I/O APIs + Remove Old

**Scope:** Public API ships. Old API deleted in same release.

- [ ] Create `src/fileio/index.ts` with `copyFile`, `saveText`, `shareFile`.
- [ ] Create `android/.../fileio/FileIOHelper.kt` — implements native bridge delegation.
- [ ] Create `ios/fileio/SherpaOnnx+FileIO.mm` — implements native bridge methods.
- [ ] Add new TurboModule methods to `NativeSherpaOnnx.ts`.
- [ ] Remove old methods from `NativeSherpaOnnx.ts` (`saveTextToContentUri`, `copyFileToContentUri`, `copyContentUriToCache`, `shareAudioFile`).
- [ ] Delete `src/files/` directory.
- [ ] Delete `SherpaOnnxFilesHelper.kt`, `SherpaOnnx+Files.mm`.
- [ ] Update `src/index.ts`: remove `files` re-export, add `fileio` re-export.
- [ ] Wire progress events (`fileIOProgress`) in native emitters.
- [ ] Integration tests: copy matrix (all source × destination combinations per platform).

### Phase 3: Audio Buffer Input Migration

**Scope:** `createOfflineAudioBufferFromFile` accepts `FileSource`.

- [ ] Add `createOfflineAudioBufferFromSource` to TurboModule.
- [ ] Remove `createOfflineAudioBufferFromFile` (old string-based) from TurboModule.
- [ ] Update `src/audiobuffer/index.ts` — new signature, delegate to new bridge method.
- [ ] Android: `SherpaOnnxModule` dispatches to resolver → fd-first decode for `contentUri`, temp-file fallback only when fd access is unavailable.
- [ ] iOS: `SherpaOnnx+PipelineAudio.mm` dispatches to resolver → existing decoder.
- [ ] Tests: `createOfflineAudioBufferFromFile` with `fs`, `contentUri`, `pad`, `securityScoped`.

### Phase 4: Audio Conversion Output Migration

**Scope:** `convertAudioToFormat` and `convertAudioToWav16k` accept `FileDestination`.

- [ ] Add `convertPipelineAudioToDestination` to TurboModule.
- [ ] Remove `convertPipelineAudioBufferToFormat` from TurboModule.
- [ ] Update `src/audio/index.ts` — new signatures with `FileDestination` + options.
- [ ] Android: use seekable fd-backed output (`/proc/self/fd/<n>`) for SAF destinations, with temp+copy fallback.
- [ ] iOS: extend conversion helper for security-scoped destinations.
- [ ] Wire progress/cancel for conversion operations.
- [ ] Tests: conversion to `fs`, `contentTree`, `securityScoped`.

### Phase 5: Cleanup & Documentation

- [ ] Remove any remaining references to old function names in example app.
- [ ] Update example app to use new APIs.
- [ ] Write `docs/fileio.md` with full API reference and platform matrix.
- [ ] Update `docs/audio-conversion.md` for new output type.
- [ ] Update `docs/audiobuffer-offline.md` for new input type.
- [ ] CHANGELOG entry with breaking change list.

---

## 14. Test Strategy

### 14.1 Copy Matrix (per platform)

**Android:**

| Source ↓ \ Dest → | `fs` | `app` | `contentUri` | `contentTree` |
|---|---|---|---|---|
| `fs` | ✅ | ✅ | ✅ | ✅ |
| `app` | ✅ | ✅ | ✅ | ✅ |
| `contentUri` | ✅ | ✅ | ✅ | ✅ |
| `pad` | ✅ | ✅ | ✅ | ✅ |

**iOS:**

| Source ↓ \ Dest → | `fs` | `app` | `securityScoped` |
|---|---|---|---|
| `fs` | ✅ | ✅ | ✅ |
| `app` | ✅ | ✅ | ✅ |
| `securityScoped` | ✅ | ✅ | ✅ |

### 14.2 Negative Tests

| Test | Expected Error |
|---|---|
| `contentUri` on iOS | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `contentTree` on iOS | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `pad` on iOS | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `securityScoped` on Android | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `externalFiles` on iOS | `FILEIO_UNSUPPORTED_ON_PLATFORM` |
| `app` with `../../etc/passwd` | `FILEIO_PATH_TRAVERSAL_BLOCKED` |
| `fs` with non-existent source | `FILEIO_NOT_FOUND` |
| `overwrite: false` on existing file | `FILEIO_ALREADY_EXISTS` |
| Expired SAF permission | `FILEIO_PERMISSION_DENIED` |
| Cancel mid-copy | `FILEIO_CANCELLED` |

### 14.3 Audio Integration Tests

| Test | Source/Dest |
|---|---|
| `createOfflineAudioBufferFromFile` + `fs` | Both platforms |
| `createOfflineAudioBufferFromFile` + `contentUri` | Android |
| `createOfflineAudioBufferFromFile` + `pad` | Android |
| `createOfflineAudioBufferFromFile` + `securityScoped` | iOS |
| `convertAudioToFormat` → `fs` | Both platforms |
| `convertAudioToFormat` → `contentTree` | Android |
| `convertAudioToFormat` → `securityScoped` | iOS |
| `convertAudioToWav16k` → `app` | Both platforms |

### 14.4 Progress & Cancel Tests

- Verify `onProgress` fires with increasing `bytesTransferred` for large file copies.
- Verify `percent` reaches 100 on completion.
- Verify `AbortSignal` abort mid-copy results in `FILEIO_CANCELLED` rejection.
- Verify partial destination file is cleaned up after cancel.

---

## 15. Documentation Plan

| Document | Action |
|---|---|
| `docs/fileio.md` | **New.** Full API reference, type definitions, platform matrix, SAF permission guide, iOS security-scoped guide, error codes, examples. |
| `docs/audio-conversion.md` | **Update.** `output` parameter is now `FileDestination`. Add `AudioConversionOptions`. Update examples. |
| `docs/audiobuffer-offline.md` | **Update.** `createOfflineAudioBufferFromFile` now takes `FileSource`. Update examples. |
| `docs/files.md` | **Delete.** Replaced by `docs/fileio.md`. |
| `CHANGELOG.md` | **Update.** Breaking changes section (§16). |

---

## 16. Breaking Changes Summary

| Change | Old | New |
|---|---|---|
| Module path | `react-native-sherpa-onnx/files` | `react-native-sherpa-onnx/fileio` |
| `saveTextToContentUri` | `(text, dirUri, filename, mime?) → Promise<string>` | **Deleted.** Use `saveText(text, destination)` |
| `copyFileToContentUri` | `(filePath, dirUri, filename, mime) → Promise<string>` | **Deleted.** Use `copyFile(source, destination)` |
| `copyContentUriToCache` | `(fileUri, filename) → Promise<string>` | **Deleted.** Use `copyFile(source, destination)` |
| `shareAudioFile` | `(fileUri, mime?) → Promise<void>` | **Deleted.** Use `shareFile(source, options?)` |
| `convertAudioToFormat` | `(input, outputPath: string, format, sampleRateHz?) → Promise<void>` | `(input, output: FileDestination, format, options?) → Promise<ResolvedFileRef>` |
| `convertAudioToWav16k` | `(input, outputPath: string) → Promise<void>` | `(input, output: FileDestination) → Promise<ResolvedFileRef>` |
| `createOfflineAudioBufferFromFile` | `(sourcePath: string, ...) → Promise<...>` | `(source: FileSource, ...) → Promise<...>` |
| Error codes | `FILES_SAVE_ERROR`, `FILES_SHARE_ERROR` | `FILEIO_*` codes |
| Return types | Raw strings for file paths/URIs | `ResolvedFileRef` / `CopyFileResult` |

---

## 17. Future Scope

The following are explicitly deferred beyond V1:

| Feature | Dependency | Notes |
|---|---|---|
| `blob`/`ArrayBuffer` as `FileSource`/`FileDestination` | [AudioBuffer JSI spec](../audiobuffer/audiobuffer-jsi-arraybuffer-implementation-spec.md) — JSI runtime must be available first | Enables in-memory file operations without disk I/O |
| Android MediaStore URIs | None | Different semantics from SAF — `content://media/...` URIs for gallery/media access |
| iCloud ubiquity container | None | iOS-specific cloud storage integration |
| HTTP/HTTPS as `FileSource` | None | Network downloads as a source location |

---

## 18. Design Decisions Log

All design decisions resolved from the original open questions:

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Breaking policy | Old APIs removed immediately, no deprecation wrappers | SDK not yet published; clean API surface preferred |
| 2 | iOS scope | Security-scoped file URLs included in V1 (`securityScoped` kind) | Essential for document picker workflows on iOS |
| 3 | Android document URI writes | `contentUri` fully supported as write destination (in addition to `contentTree`) | Covers single-document write flows from `ACTION_CREATE_DOCUMENT` |
| 4 | PAD semantics | `pad` is canonical input for PAD-aware callers; `fs` accepted when path is already resolved | Clear provenance (`pad`) vs. convenience (`fs`) — both valid |
| 5 | Audio export path | Direct streaming output is the primary path; temp+copy only as internal fallback for non-seekable edge cases | Performance-first, avoids double I/O |
| 6 | Overwrite default | `overwrite: true` | Matches most common use case, avoids friction |
| 7 | MIME type for contentTree | **Required** (not optional) in `FileDestination` | SAF `DocumentsContract.createDocument` needs explicit MIME type |
| 8 | Return types | All write/create/copy operations return `ResolvedFileRef`; side-effect-only (`shareFile`) returns `void` | Consistent, reduces confusion |
| 9 | SAF permissions | Documented minimum requirements; SDK resolves URIs but does not manage picker UX | See §11 |
| 10 | Error code migration | `FILES_*` → `FILEIO_*` (breaking) | SDK not published; clean error namespace |
| 11 | Progress/cancel | Included in V1 for all copy and conversion operations | Public SDK — consumers need progress for any file size |
| 12 | App base dir security | Explicit path traversal check + whitelist enforcement | Prevents access to sensitive internal directories |
| 13 | Module path | `react-native-sherpa-onnx/fileio` (old `files` deleted) | Fresh namespace, no legacy baggage |
| 14 | `convertAudioToWav16k` | Also accepts `FileDestination` | Consistent with `convertAudioToFormat` |
| 15 | `blob`/`ArrayBuffer` | Future scope, not V1 | Requires JSI ArrayBuffer support (separate spec) first |
