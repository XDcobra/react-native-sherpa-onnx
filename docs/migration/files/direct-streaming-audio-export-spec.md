# Direct-streaming audio export: detailed implementation spec

**Status:** Specification — all design decisions resolved; ready for implementation.  
**Scope:** Replace the temp-file-then-copy approach for Android SAF (`contentUri` / `contentTree`) destinations in audio conversion with a **direct file-descriptor-based** encoding path. Also restructure the `FileIOResolver` write-handle model so the conversion pipeline can encode directly into the destination without intermediate copies.  
**Platforms affected:** Android only. iOS destinations are always local file paths (no SAF equivalent) — no changes needed on iOS.

---

## 1. Problem statement

### Current behavior (Android)

When `convertPipelineAudioToDestination` receives a stream-based destination (`contentUri`, `contentTree`), the flow is:

```
1. resolveDestination() → WriteHandle.Stream (OutputStream)
2. Encode to temp file in cache dir via FFmpeg avio_open(tempPath)
3. FileIOStreamCopy.copy(tempFile → outputStream)
4. Delete temp file
```

This means **every SAF audio export** performs:
- One full FFmpeg encode pass (write to temp)
- One full file copy pass (read temp → write SAF stream)
- One file delete

For a 100 MB audio file, this doubles the I/O and disk usage.

### Target behavior

```
1. resolveDestination() → WriteHandle.FileDescriptor (seekable fd from ContentResolver)
2. Encode directly to fd via FFmpeg avio_open("/proc/self/fd/<n>")
3. Close fd
```

One pass. No temp files. No copies. FFmpeg writes directly into the SAF-backed file descriptor.

### Why this works

Android's `ContentResolver.openFileDescriptor(uri, "rw")` returns a `ParcelFileDescriptor` that provides a **native, seekable file descriptor**. SAF document providers (including the default one for shared storage) back this with a real filesystem file. The fd supports read, write, and **lseek** — exactly what FFmpeg needs for:
- WAV: header size back-patch via `av_write_trailer()`
- MP3/FLAC/AAC/Opus: container trailer writes
- Any format: `avio_open("/proc/self/fd/<n>")` treats this as a regular file

### Why `/proc/self/fd/<n>` is the right approach

FFmpeg's `file` protocol handler (which is compiled into our build) uses standard POSIX `open()`/`read()`/`write()`/`lseek()`/`close()` on the path. On Android/Linux, `/proc/self/fd/<n>` is a symlink to the underlying file for that fd. Opening it via FFmpeg's `avio_open()` works identically to a regular file path — including seeking.

Alternative approaches considered:

| Approach | Pros | Cons |
|----------|------|------|
| **`/proc/self/fd/<n>` path** | Zero C++ changes, zero FFmpeg rebuild, conventional Linux fd passing | Linux-specific (fine — Android is Linux) |
| Build FFmpeg with `--enable-protocol=android_content` | Native `content://` URI support in FFmpeg | Requires FFmpeg rebuild, JNI AndroidContext setup, more complex; our build is minimal |
| `avio_alloc_context()` custom callbacks | Full control, no path hack | Requires new C++ code for every encode function, callback plumbing, complex lifecycle |
| New C++ overloads taking `int fd` | Clean API | Requires new JNI methods, duplicated C++ encode functions, maintenance burden |

**Decision: `/proc/self/fd/<n>` path approach.** It requires only Kotlin changes in `FileIOResolver` and `SherpaOnnxModule`, zero C++ changes, zero FFmpeg rebuilds, and is the standard Linux mechanism for passing already-opened fds to path-based APIs. Android's bionic libc and procfs fully support this.

---

## 2. Current code analysis

### 2.1 `FileIOResolver.WriteHandle` (as-is)

```kotlin
sealed class WriteHandle : Closeable {
  class FilePath(val file: File) : WriteHandle() {
    override fun close() {} // no-op
  }
  class Stream(
    val outputStream: OutputStream,
    val resultUri: Uri,
  ) : WriteHandle() {
    override fun close() = outputStream.close()
  }
}
```

For `contentUri` / `contentTree`: opens `ContentResolver.openOutputStream(uri, "w")`, which returns a non-seekable `OutputStream`.

**Problem:** `OutputStream` cannot be used by FFmpeg (needs seekable file I/O). Hence the temp-file fallback.

### 2.2 `convertPipelineAudioToDestination` (as-is)

```kotlin
val writeHandle = fileIOHelper.resolveDestination(destination, ...)
when (writeHandle) {
  is WriteHandle.FilePath -> outputPath = writeHandle.file.absolutePath
  is WriteHandle.Stream -> {
    tmpPath = File(cacheDir, "fileio_conv_<uuid>.<fmt>").absolutePath
    outputPath = tmpPath  // encode to temp
  }
}
// ... encode to outputPath via FFmpeg ...
if (tmpPath != null && writeHandle is Stream) {
  FileIOStreamCopy.copy(FileInputStream(tmpPath), writeHandle.outputStream)
  writeHandle.close()
  File(tmpPath).delete()
}
```

### 2.3 `copyFile` (as-is)

Uses `InputStream` → `OutputStream` streaming via `FileIOStreamCopy.copy()`. This is correct for byte-copy operations where no seeking is needed. **No changes needed for `copyFile`.**

### 2.4 FFmpeg C++ encoding (as-is)

Both `sherpa_audio_convert_pcm_to_format()` and `sherpa_audio_convert_to_format()` use:

```cpp
avio_open(&outFmt->pb, outputPath, AVIO_FLAG_WRITE)
// ... encode ...
av_write_trailer(outFmt)  // may seek for WAV header back-patch
avio_closep(&outFmt->pb)
```

The `outputPath` is an arbitrary path string. `/proc/self/fd/<n>` works identically because FFmpeg uses `open()` which follows procfs symlinks.

### 2.5 FFmpeg build configuration (as-is)

```bash
--enable-protocol=file    # only file protocol enabled
```

The `file` protocol handles arbitrary path strings including `/proc/self/fd/<n>`.

---

## 3. Target design

### 3.1 New `WriteHandle.FileDescriptor` variant

Add a third `WriteHandle` variant that holds a `ParcelFileDescriptor` + the procfs path:

```kotlin
sealed class WriteHandle : Closeable {
  class FilePath(val file: File) : WriteHandle() {
    override fun close() {}
  }

  /** Seekable fd from ContentResolver.openFileDescriptor(). */
  class FileDescriptor(
    val pfd: android.os.ParcelFileDescriptor,
    val fdPath: String,     // "/proc/self/fd/<n>"
    val resultUri: Uri,
  ) : WriteHandle() {
    override fun close() = pfd.close()
  }

  /** Non-seekable OutputStream — retained for copyFile/saveText where seeking is not needed. */
  class Stream(
    val outputStream: OutputStream,
    val resultUri: Uri,
  ) : WriteHandle() {
    override fun close() = outputStream.close()
  }
}
```

### 3.2 Updated `resolveDestination()`

For `contentUri` and `contentTree`, the resolver now returns `WriteHandle.FileDescriptor` instead of `WriteHandle.Stream`:

```kotlin
"contentUri" -> {
  val uri = Uri.parse(uriStr)
  val pfd = context.contentResolver.openFileDescriptor(uri, "rw")
    ?: throw FileIOException(WRITE_ERROR, "Cannot open file descriptor for URI: $uriStr")
  val fdPath = "/proc/self/fd/${pfd.fd}"
  WriteHandle.FileDescriptor(pfd, fdPath, uri)
}

"contentTree" -> {
  // Create document first (same as current), then use fd:
  val docUri = createDocumentInDirectory(resolver, treeUri, filename, mimeType)
  val pfd = context.contentResolver.openFileDescriptor(docUri, "rw")
    ?: throw FileIOException(WRITE_ERROR, "Cannot open file descriptor for created document")
  val fdPath = "/proc/self/fd/${pfd.fd}"
  WriteHandle.FileDescriptor(pfd, fdPath, docUri)
}
```

### 3.3 Why we also keep `WriteHandle.Stream`

`copyFile` and `saveText` don't need seeking — they write sequentially. For these operations, `OutputStream` is perfectly fine and slightly simpler. We could switch them to fd too, but there's no benefit and `OutputStream` is the canonical Android API for sequential writes.

**However**, for API simplicity and to avoid callers needing to check handle types, we provide a unified resolver with a **mode parameter** that determines what type of handle to return:

```kotlin
enum class WriteMode {
  /** Sequential write (copyFile, saveText). Returns Stream for SAF, FilePath for fs/app. */
  SEQUENTIAL,
  /** Seekable write (audio encoding). Returns FileDescriptor for SAF, FilePath for fs/app. */
  SEEKABLE,
}

fun resolveDestination(
  destination: ReadableMap,
  mode: WriteMode = WriteMode.SEQUENTIAL,
  overwrite: Boolean = true,
  createParentDirectories: Boolean = false,
): WriteHandle
```

For `fs`/`app` destinations, the mode doesn't matter — both return `FilePath`.  
For `contentUri`/`contentTree`:
- `SEQUENTIAL` → `WriteHandle.Stream` (OutputStream)
- `SEEKABLE` → `WriteHandle.FileDescriptor` (ParcelFileDescriptor + fdPath)

### 3.4 Updated `convertPipelineAudioToDestination`

```kotlin
override fun convertPipelineAudioToDestination(...) {
  // ... validation ...
  
  val writeHandle = fileIOHelper.resolveDestination(
    destination,
    mode = WriteMode.SEEKABLE  // request seekable handle for FFmpeg
  )

  val outputPath: String
  val outputKind: String

  when (writeHandle) {
    is WriteHandle.FilePath -> {
      outputPath = writeHandle.file.absolutePath
      outputKind = "fs"
    }
    is WriteHandle.FileDescriptor -> {
      outputPath = writeHandle.fdPath  // "/proc/self/fd/<n>" — FFmpeg writes here directly
      outputKind = "contentUri"
    }
    is WriteHandle.Stream -> {
      // Should not happen with SEEKABLE mode, but handle gracefully
      // Fall back to temp-file approach
      // ...
    }
  }

  try {
    // Encode directly to outputPath (no temp file needed!)
    if (bufferId.startsWith("off_")) {
      convertOfflineBuffer(bufferId, outputPath, fmt, rate)
    } else if (bufferId.startsWith("live_")) {
      convertLiveBuffer(bufferId, outputPath, fmt, rate)
    }
  } finally {
    writeHandle.close()  // closes ParcelFileDescriptor → flushes and syncs
  }

  val result = Arguments.createMap().apply {
    putString("outputKind", outputKind)
    putString("outputPath", when (writeHandle) {
      is WriteHandle.FileDescriptor -> writeHandle.resultUri.toString()
      is WriteHandle.FilePath -> outputPath
      else -> outputPath
    })
  }
  promise.resolve(result)
}
```

**Key difference from current:** No `tmpPath`, no `FileIOStreamCopy.copy()`, no `File(tmpPath).delete()`. FFmpeg encodes directly into the SAF fd.

---

## 4. Detailed changes

### 4.1 `FileIOResolver.kt`

#### New enum

```kotlin
enum class WriteMode {
  SEQUENTIAL,
  SEEKABLE,
}
```

#### New `WriteHandle` variant

```kotlin
class FileDescriptor(
  val pfd: android.os.ParcelFileDescriptor,
  val fdPath: String,
  val resultUri: Uri,
) : WriteHandle() {
  override fun close() = pfd.close()
}
```

#### Updated `resolveDestination()`

Add `mode: WriteMode` parameter. For `contentUri`/`contentTree`:

- `SEEKABLE`: use `openFileDescriptor(uri, "rw")` → `WriteHandle.FileDescriptor`
- `SEQUENTIAL`: use `openOutputStream(uri, "w")` → `WriteHandle.Stream` (current behavior)

For `fs`/`app`: unchanged (`WriteHandle.FilePath` regardless of mode).

Default `mode = WriteMode.SEQUENTIAL` preserves backward compatibility for `copyFile`/`saveText`.

#### `contentTree` with `SEEKABLE` mode

```kotlin
"contentTree" -> {
  val docUri = createDocumentInDirectory(resolver, treeUri, filename, mimeType)
  when (mode) {
    WriteMode.SEEKABLE -> {
      val pfd = resolver.openFileDescriptor(docUri, "rw")
        ?: throw FileIOException(WRITE_ERROR, "Cannot open fd for created document")
      WriteHandle.FileDescriptor(pfd, "/proc/self/fd/${pfd.fd}", docUri)
    }
    WriteMode.SEQUENTIAL -> {
      val outputStream = resolver.openOutputStream(docUri, "w")
        ?: throw FileIOException(WRITE_ERROR, "Cannot open stream for created document")
      WriteHandle.Stream(outputStream, docUri)
    }
  }
}
```

### 4.2 `FileIOHelper.kt`

#### Updated `resolveDestination()` helper

```kotlin
fun resolveDestination(
  destination: ReadableMap,
  mode: FileIOResolver.WriteMode = FileIOResolver.WriteMode.SEQUENTIAL,
  overwrite: Boolean = true,
  createParentDirectories: Boolean = false,
): FileIOResolver.WriteHandle = resolver.resolveDestination(destination, mode, overwrite, createParentDirectories)
```

No changes to `copyFile()` or `saveText()` — they continue using `SEQUENTIAL` mode (default).

### 4.3 `SherpaOnnxModule.kt` — `convertPipelineAudioToDestination`

Full replacement of the method body. Key changes:

1. Call `resolveDestination(destination, mode = WriteMode.SEEKABLE)`
2. Match on `WriteHandle.FilePath` or `WriteHandle.FileDescriptor` (no `Stream` expected)
3. Pass `fdPath` directly as `outputPath` to the existing encode functions
4. Remove all temp-file logic: no `tmpPath`, no `FileIOStreamCopy.copy()`, no `File(tmpPath).delete()`
5. Close `WriteHandle` in `finally` block to ensure fd is released

### 4.4 No C++ changes

`sherpa_audio_convert_pcm_to_format()` and `sherpa_audio_convert_to_format()` already accept any path string. `/proc/self/fd/<n>` is a valid path that FFmpeg's `avio_open()` → `open()` resolves correctly.

### 4.5 No JNI changes

`nativeConvertPcmToFormat()` and `nativeConvertAudioToFormat()` pass the path as a `jstring` → `const char*`. No change needed.

### 4.6 No iOS changes

iOS destinations are always `FileIOWriteHandle.isFilePath = YES`. No SAF equivalent exists. The iOS `convertPipelineAudioToDestination` already writes directly to a file path. No temp-file dance happens on iOS.

### 4.7 No TypeScript changes

The JS API (`convertAudioToFormat`, `copyFile`, `saveText`, `shareFile`) is unaffected. The `FileDestination` type, `ResolvedFileRef` return, and `AudioConversionOptions` remain identical. This is a purely internal native optimization.

---

## 5. `createOfflineAudioBufferFromSource` — read path via fd

The current `createOfflineAudioBufferFromSource` uses `fileIOHelper.resolveSourceToFilePath(source)` which for `contentUri` sources copies the entire file to a temp cache file (see `FileIOResolver.resolveSourceToFilePath()`).

The same fd approach can optimize the **read** path: instead of copying a `content://` audio file to cache before decoding, pass its fd directly to FFmpeg for decoding.

### 5.1 New `ReadHandle.FileDescriptor` variant

```kotlin
class FileDescriptor(
  val pfd: android.os.ParcelFileDescriptor,
  val fdPath: String,
) : ReadHandle() {
  override fun close() = pfd.close()
}
```

### 5.2 Updated `resolveSource()` for `contentUri`

```kotlin
"contentUri" -> {
  val uri = Uri.parse(uriStr)
  val pfd = try {
    resolver.openFileDescriptor(uri, "r")
  } catch (e: SecurityException) {
    throw FileIOException(PERMISSION_DENIED, "No permission for URI: $uriStr", e)
  } ?: throw FileIOException(NOT_FOUND, "Cannot open fd for URI: $uriStr")
  ReadHandle.FileDescriptor(pfd, "/proc/self/fd/${pfd.fd}")
}
```

### 5.3 Updated `resolveSourceToFilePath()`

```kotlin
fun resolveSourceToFilePath(source: ReadableMap): File {
  val handle = resolveSource(source)
  return when (handle) {
    is ReadHandle.FilePath -> handle.file
    is ReadHandle.FileDescriptor -> {
      // Return a pseudo-File wrapping the fd path.
      // FFmpeg can read this directly; no temp copy needed.
      File(handle.fdPath)
      // NOTE: caller must keep the ReadHandle alive until done using the file!
    }
    is ReadHandle.Stream -> {
      // Fallback: copy stream to temp file (non-fd streams)
      handle.use { h ->
        val tmpFile = File(context.cacheDir, "fileio_tmp_${UUID.randomUUID()}")
        tmpFile.outputStream().use { out ->
          h.inputStream.copyTo(out, 65536)
        }
        tmpFile
      }
    }
  }
}
```

**Lifecycle concern:** The fd-backed `File(fdPath)` is only valid while the `ParcelFileDescriptor` is open. The caller must hold onto the `ReadHandle.FileDescriptor` and close it after FFmpeg finishes reading. This requires a small refactor of `createOfflineAudioBufferFromSource` in `SherpaOnnxModule.kt` — instead of calling a helper that returns `File`, it should resolve the handle, use it, then close it.

### 5.4 Updated `SherpaOnnxModule.createOfflineAudioBufferFromSource`

```kotlin
override fun createOfflineAudioBufferFromSource(source: ReadableMap, ...) {
  val readHandle = fileIOHelper.resolveSource(source)  // NEW: get handle, not file
  try {
    val filePath = when (readHandle) {
      is ReadHandle.FilePath -> readHandle.file.absolutePath
      is ReadHandle.FileDescriptor -> readHandle.fdPath  // "/proc/self/fd/<n>"
      is ReadHandle.Stream -> {
        // Fallback: copy to temp for non-fd streams
        val tmpFile = File(cacheDir, "fileio_tmp_${UUID.randomUUID()}")
        readHandle.inputStream.use { input ->
          tmpFile.outputStream().use { out -> input.copyTo(out, 65536) }
        }
        tmpFile.absolutePath
      }
    }
    // ... decode via PipelineAudioRegistry.createOfflineFromFile(filePath, ...) ...
  } finally {
    readHandle.close()  // closes ParcelFileDescriptor or Stream
  }
}
```

This eliminates the temp-file copy for `contentUri` read operations on Android. A `content://` audio file is decoded directly from its fd, zero copies.

---

## 6. Edge cases and robustness

### 6.1 SAF providers that don't support `openFileDescriptor("rw")`

Some storage providers (rare edge cases like cloud-backed SAF providers) may not support `openFileDescriptor` with write mode. In that case, `openFileDescriptor()` returns `null` or throws.

**Mitigation:** Fall back to the `Stream` handle (temp-file approach):

```kotlin
"contentUri" -> {
  val uri = Uri.parse(uriStr)
  when (mode) {
    WriteMode.SEEKABLE -> {
      val pfd = try {
        resolver.openFileDescriptor(uri, "rw")
      } catch (e: Exception) { null }
      
      if (pfd != null) {
        WriteHandle.FileDescriptor(pfd, "/proc/self/fd/${pfd.fd}", uri)
      } else {
        // Fallback: non-seekable stream (caller handles temp-file approach)
        val outputStream = resolver.openOutputStream(uri, "w")
          ?: throw FileIOException(WRITE_ERROR, "Cannot open stream for URI: $uriStr")
        WriteHandle.Stream(outputStream, uri)
      }
    }
    WriteMode.SEQUENTIAL -> { /* ... existing stream logic ... */ }
  }
}
```

And in `convertPipelineAudioToDestination`, retain the **temp-file fallback** for the rare case where a `Stream` handle is returned from a `SEEKABLE` request:

```kotlin
when (writeHandle) {
  is WriteHandle.FilePath -> { /* direct path */ }
  is WriteHandle.FileDescriptor -> { /* direct fd path */ }
  is WriteHandle.Stream -> {
    // Fallback: SAF provider doesn't support fd
    tmpPath = File(cacheDir, "fileio_conv_${UUID.randomUUID()}.$fmt").absolutePath
    outputPath = tmpPath
  }
}
// ... encode ...
if (tmpPath != null && writeHandle is WriteHandle.Stream) {
  FileInputStream(File(tmpPath)).use { input ->
    FileIOStreamCopy.copy(input, writeHandle.outputStream)
  }
  writeHandle.close()
  File(tmpPath).delete()
}
```

This ensures the system is **strictly no-regression**: the exact same behavior as today for edge-case providers, direct streaming for the common case.

### 6.2 Read-only `contentUri` for write

If a `contentUri` points to a read-only document (e.g., a `content://` URI from a picker that only grants read), `openFileDescriptor(uri, "rw")` will throw `SecurityException`.

**Mitigation:** Same fallback as 6.1 — catch the exception, try `openOutputStream()`. If that also fails, propagate `FILEIO_PERMISSION_DENIED`.

### 6.3 WAV header back-patch on fd

WAV format writes a RIFF header with placeholder sizes at the beginning, then patches the actual size after encoding via `av_write_trailer()`. This requires `lseek()` to position 0.

**On a regular SAF fd:** `lseek()` works. Most Android SAF providers back documents with real files on ext4/F2FS, so seeking is fully supported.

**On a cloud-backed SAF provider (rare):** If `openFileDescriptor` succeeds but the fd is a pipe (non-seekable), `lseek()` fails. FFmpeg's `av_write_trailer()` will fail to patch the WAV header. The file is still written but may have incorrect RIFF size fields.

**Mitigation:** For the common case (99%+ of SAF usage), this works perfectly. For the rare pipe fd case, the temp-file fallback in §6.1 handles it (since `openFileDescriptor` typically returns `null` for non-seekable providers anyway).

### 6.4 `ParcelFileDescriptor` lifecycle

The `ParcelFileDescriptor` must remain open for the entire duration of the FFmpeg encoding operation. The `WriteHandle.FileDescriptor.close()` call (in the `finally` block) calls `pfd.close()` which:
- Flushes any pending writes
- Releases the fd back to the provider
- On `contentTree`: triggers the provider's document-modified notification

This is correct and safe.

### 6.5 Thread safety

`convertPipelineAudioToDestination` runs on a background thread (React Native's async dispatch). The fd is opened on this thread and used only on this thread. No concurrent access issues.

### 6.6 Temp file cleanup on crash

Current behavior: if the process crashes between encoding and temp-file deletion, an orphaned temp file remains in cache. With the fd approach, no temp file is created at all for the happy path. This is strictly better.

---

## 7. Changes matrix

| File | Change | Scope |
|------|--------|-------|
| `android/.../fileio/FileIOResolver.kt` | Add `WriteMode` enum, `WriteHandle.FileDescriptor`, `ReadHandle.FileDescriptor`, update `resolveDestination()` and `resolveSource()` | Core |
| `android/.../fileio/FileIOHelper.kt` | Update `resolveDestination()` signature to pass `WriteMode`, expose `resolveSource()` for direct handle access | Core |
| `android/.../SherpaOnnxModule.kt` | Rewrite `convertPipelineAudioToDestination` for fd-direct, update `createOfflineAudioBufferFromSource` for fd-direct read | Core |
| `docs/migration/files/fileio-current-vs-target-high-level-plan.md` | Update gap status | Doc |
| `docs/fileio.md` | Add note about direct streaming on Android | Doc |
| `docs/audio-conversion.md` | Remove "temp file for stream destinations" note, add fd-direct note | Doc |

**Not changed:**
- All C++ files (zero changes)
- All JNI files (zero changes)
- All iOS files (zero changes)
- All TypeScript files (zero changes)
- FFmpeg build scripts (zero changes)
- `FileIOStreamCopy.kt` (no changes; still used by `copyFile`)
- `copyFile`, `saveText`, `shareFile` (no changes; still use `SEQUENTIAL` mode)

---

## 8. Implementation phases

### Phase 1: `FileIOResolver` changes

1. Add `WriteMode` enum.
2. Add `WriteHandle.FileDescriptor` sealed class variant.
3. Add `ReadHandle.FileDescriptor` sealed class variant.
4. Update `resolveDestination()`: accept `mode` parameter (default `SEQUENTIAL`). For `contentUri`/`contentTree` with `SEEKABLE` mode, attempt `openFileDescriptor("rw")` → `FileDescriptor`, falling back to `Stream` on failure.
5. Update `resolveSource()`: for `contentUri`, attempt `openFileDescriptor("r")` → `ReadHandle.FileDescriptor`, falling back to `Stream` on failure.
6. Verify: `copyFile`/`saveText`/`shareFile` continue working (they use default `SEQUENTIAL` mode, unchanged behavior).

### Phase 2: `SherpaOnnxModule` — write path

1. Update `convertPipelineAudioToDestination`: call `resolveDestination(mode = SEEKABLE)`.
2. Handle `WriteHandle.FileDescriptor`: use `fdPath` as output path, set `outputKind = "contentUri"`.
3. Retain temp-file fallback for `WriteHandle.Stream` (edge case).
4. Close `WriteHandle` in `finally` block.
5. Remove the default temp-file path (moved to fallback only).

### Phase 3: `SherpaOnnxModule` — read path

1. Update `createOfflineAudioBufferFromSource`: work with `ReadHandle` directly instead of `resolveSourceToFilePath()`.
2. For `ReadHandle.FileDescriptor`: use `fdPath` as the file path for decoding.
3. For `ReadHandle.Stream`: fallback to temp-file copy (existing behavior).
4. Close `ReadHandle` in `finally` block.

### Phase 4: `FileIOHelper` plumbing

1. Update `resolveDestination()` helper to forward `WriteMode`.
2. Add `resolveSource()` method that returns the `ReadHandle` directly (for use by `SherpaOnnxModule`).

### Phase 5: Documentation

1. Update `docs/fileio.md` — add implementation notes about direct fd on Android.
2. Update `docs/audio-conversion.md` — note that SAF destinations now write directly.
3. Update `docs/migration/files/fileio-current-vs-target-high-level-plan.md` — mark gap as closed.

---

## 9. Acceptance criteria

- [ ] `convertAudioToFormat(buf, { kind: 'contentUri', uri }, 'wav')` encodes directly to the SAF fd on Android — no temp file created.
- [ ] `convertAudioToFormat(buf, { kind: 'contentTree', treeUri, displayName }, 'mp3')` encodes directly to the SAF fd — no temp file.
- [ ] `convertAudioToFormat(buf, { kind: 'fs', path }, 'wav')` works unchanged (direct file path).
- [ ] `createOfflineAudioBufferFromFile({ kind: 'contentUri', uri })` decodes directly from the SAF fd — no temp copy to cache.
- [ ] `copyFile` continues working with non-seekable streams (uses `SEQUENTIAL` mode, unchanged).
- [ ] `saveText` continues working with streams (unchanged).
- [ ] WAV header back-patch works correctly on SAF fd (sizes in RIFF header are correct after encoding).
- [ ] All output formats (wav, mp3, flac, aac, m4a, opus, webm, mkv, ogg) work with fd-direct path.
- [ ] Fallback to temp-file approach works for SAF providers that don't support `openFileDescriptor`.
- [ ] `ParcelFileDescriptor` is closed in `finally` block, even on encoding errors.
- [ ] iOS behavior is unchanged (already file-path-only).
- [ ] TypeScript API is unchanged — no breaking changes.
- [ ] No C++ or JNI changes required.

---

## 10. Resolved design decisions

### Q1: Approach for direct SAF encoding → **`/proc/self/fd/<n>` path (Option A)**

FFmpeg's `avio_open()` calls POSIX `open()` on the provided path. `/proc/self/fd/<n>` is a valid path on Android (Linux) that resolves to the file behind the fd. This is the standard Linux mechanism for converting an fd to a path for path-based APIs.

**Rejected alternatives:**
- `--enable-protocol=android_content` in FFmpeg build: too invasive, requires JNI context setup in FFmpeg
- `avio_alloc_context()` with custom callbacks: requires C++ changes, complex lifecycle management
- New C++ overloads taking `int fd` param: C++ changes, JNI changes, maintenance cost

### Q2: WriteHandle model → **Tri-split with WriteMode (Option C)**

Three handle variants: `FilePath` (local), `FileDescriptor` (SAF fd), `Stream` (non-seekable sequential). A `WriteMode` parameter on `resolveDestination()` determines which variant is returned for SAF destinations.

**Rationale:** `copyFile`/`saveText` only need sequential writes (no seeking), so `OutputStream` is fine. Audio encoding needs seeking, so `ParcelFileDescriptor` is needed. Instead of always opening an fd (which requires `"rw"` permissions, potentially more restrictive than `"w"`), let the caller declare intent.

### Q3: Fallback strategy → **Automatic fallback to Stream + temp-file (Option B)**

If `openFileDescriptor("rw")` fails (returns null or throws), the resolver silently falls back to `openOutputStream("w")` → `WriteHandle.Stream`. The conversion code retains the temp-file path as an explicit fallback for `Stream` handles.

**Rationale:** Strictly no-regression. 99%+ of Android SAF usage supports fd. The rare cases that don't still work via the existing temp-file path.

### Q4: Read path optimization → **Yes, include (Option A)**

`createOfflineAudioBufferFromSource` with `contentUri` sources is also optimized with fd-direct decoding. Same `ReadHandle.FileDescriptor` variant with `/proc/self/fd/<n>`.

**Rationale:** Same technique, same benefits (no temp copy), and the read handle infrastructure naturally follows from the write handle changes.

### Q5: iOS changes → **None (Option A)**

iOS has no SAF equivalent. All iOS destinations resolve to local file paths via `FileIOWriteHandle.isFilePath = YES`. No stream handles, no fd dance needed. The current iOS implementation is already optimal.

### Q6: TypeScript API changes → **None (Option A)**

This is a purely internal native optimization. The JS API surface (`FileDestination`, `ResolvedFileRef`, `convertAudioToFormat`, etc.) is unchanged. Breaking changes are not needed.

### Q7: Progress reporting for fd-direct → **Not applicable (Option A)**

FFmpeg encoding progress (% encoded) would require intercepting FFmpeg's internal encoding progress, which is not exposed by the C API. The current implementation doesn't report encoding progress either (only `copyFile` does via `FileIOStreamCopy`). No regression.

If encoding progress is needed in the future, it can be added by:
1. Computing total expected output size from input buffer info
2. Polling the written file size via `fstat()` on the fd during encoding
3. Emitting progress events from a parallel check

But this is out of scope — the current API doesn't promise encoding progress, only copy progress.

---

## 11. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `/proc/self/fd/<n>` not working on some Android version | Very low (procfs is standard Linux, supported since Android 1.0) | Write failure | Automatic fallback to temp-file via `WriteHandle.Stream` |
| SAF provider fd doesn't support seeking | Low (most providers use local files) | WAV header corruption | Automatic fallback to temp-file for providers that don't support `openFileDescriptor` |
| `openFileDescriptor("rw")` requires stricter permissions than `openOutputStream("w")` | Low (SAF grants full access for persisted URIs) | Silent fallback to temp-file | Handled by fallback in §6.1 |
| FFmpeg encoding error leaves fd in partial state | Same as current temp-file approach | Partial output file | Unavoidable — same risk as writing to any file path |

---

## 12. Performance impact

### Write path (audio encoding)

| Scenario | Current | After |
|----------|---------|-------|
| `fs`/`app` destination | Direct file write | Unchanged |
| `contentUri` destination (100 MB audio) | Encode → temp (100 MB) + copy (100 MB) + delete = 200 MB I/O | Encode → fd (100 MB) = 100 MB I/O |
| `contentTree` destination | Same as contentUri | Same improvement |

**50% I/O reduction** for SAF destinations. No temp file disk usage. Faster completion.

### Read path (audio buffer import)

| Scenario | Current | After |
|----------|---------|-------|
| `fs`/`app` source | Direct file read | Unchanged |
| `contentUri` source (50 MB audio) | Copy (50 MB) to cache + decode from cache | Decode directly from fd = 50 MB I/O saved |

**50% I/O reduction** for contentUri sources. No temp copy in cache.

---

## 13. Related documents

- [Generic File I/O high-level plan](generic-file-io-high-level-plan.md) — parent architecture document
- [File I/O current vs target state](fileio-current-vs-target-high-level-plan.md) — gap tracking document
- [Audio conversion docs](../../audio-conversion.md) — user-facing audio conversion documentation
- [File I/O docs](../../fileio.md) — user-facing file I/O documentation
