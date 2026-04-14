# Live ingest mandatory spool — Implementation plan

## Problem

`ingestFileToLiveAudioBuffer` can decode a file faster than consumers process it. The ring buffer silently overwrites old samples when full (`totalSamplesDropped` increments). If the live buffer was created **without** a `persistencePath`, no spool exists and samples are permanently lost.

The JS-side docs (`src/audiobuffer/index.ts`) state "Spool is automatically enabled for the duration of file ingest to prevent data loss", but the native implementation does **not** enforce this. Spool activation depends entirely on whether the caller provided `persistencePath` at buffer creation time.

## Goal

When `ingestFileToLiveAudioBuffer` (or the native `startFileIngestToLiveBuffer`) begins, the live buffer **must** have an active spool. If none was configured at creation, the ingest path creates a temporary spool automatically before the first chunk is appended.

No data loss during file ingest, regardless of how the live buffer was originally created.

---

## Design

### Approach: late spool activation on LiveEntry

Add an `enableSpool(path, format)` method to `LiveEntry` (Android) and `PaLiveEntry` (iOS) that can be called **after** construction but **before** the first ingest chunk. This avoids changing LiveEntry's constructor or existing creation paths.

### Constraints

- Only allowed while buffer is in `RECORDING` state
- Only allowed when no spool is currently active (`hasActiveSpool == false`)
- Must be called before the first `appendSamples` from the ingest path
- Must be thread-safe (another producer like mic could be appending concurrently)
- Temporary spool file is placed in platform cache directory
- Temporary spool file is cleaned up on `release()` (not on finalize, since `createOfflineFromLive(mode: fullIfSpooled)` may still need it)

---

## Android implementation

### 1. Add `enableSpool` to `LiveEntry.kt`

Location: after the existing spool-related properties (around line 92).

```kotlin
@Volatile
private var spoolWriter: SpoolWriter? = persistence?.let { SpoolWriter(it, sampleRate, channelCount) }

private var isTemporarySpool = false

fun enableSpool(config: PersistenceConfig, temporary: Boolean = false) {
  check(state == State.RECORDING) { "Cannot enable spool on finalized buffer" }
  check(spoolWriter == null) { "Spool already active" }
  spoolWriter = SpoolWriter(config, sampleRate, channelCount)
  isTemporarySpool = temporary
}
```

Key changes:
- `spoolWriter` changes from `val` to `@Volatile private var`
- new `isTemporarySpool` flag for cleanup tracking

### 2. Cleanup temporary spool in `release()`

Extend `release()` to delete temp spool file:

```kotlin
fun release() {
  if (state == State.RECORDING) {
    finalize_()
  }
  flushPendingFramesAppendedEvent()
  val path = spoolWriter?.filePath
  spoolWriter?.release()
  if (isTemporarySpool && path != null) {
    try { File(path).delete() } catch (_: Exception) {}
  }
  synchronized(cursors) { cursors.clear() }
}
```

### 3. Call `enableSpool` in `startFileIngestToLiveBuffer` (SherpaOnnxModule.kt)

Before resolving the promise and starting the decode executor, insert:

```kotlin
if (!liveEntry.hasActiveSpool) {
  val tmpSpoolPath = File(
    reactApplicationContext.cacheDir,
    "ingest_spool_${java.util.UUID.randomUUID()}.wav"
  ).absolutePath
  liveEntry.enableSpool(
    PersistenceConfig(tmpSpoolPath, SpoolFormat.WAV_PCM_S16LE),
    temporary = true
  )
}
```

Location: after the RECORDING state check (around line 802), before `promise.resolve`.

---

## iOS implementation

### 4. Add `enableSpool` to `PaLiveEntry` in `PaLiveEntry.h`

Add a new method after the constructor:

```cpp
void enableSpool(const std::string &path, bool isFloat, bool temporary = false) {
  if (state != RECORDING) return;
  if (hasActiveSpool) return;

  hasActiveSpool = true;
  spoolPath = path;
  spoolIsFloat = isFloat;
  isTemporarySpool = temporary;
  spoolFile.open(spoolPath, std::ios::binary | std::ios::trunc);
  if (spoolFile) {
    int bytesPerSample = isFloat ? 4 : 2;
    int audioFormat = isFloat ? 3 : 1;
    pa_writeWavHeaderToStream(spoolFile, sampleRate, bytesPerSample * 8, audioFormat, 0);
  }
}
```

Add member variable:

```cpp
bool isTemporarySpool = false;
```

### 5. Cleanup temporary spool in `release()`

Extend `release()` in `PaLiveEntry`:

```cpp
void release() {
  if (state == RECORDING) finalize_();
  flushPendingFramesAppended();
  if (spoolFile.is_open()) spoolFile.close();
  if (isTemporarySpool && !spoolPath.empty()) {
    std::remove(spoolPath.c_str());
  }
  cursors.clear();
}
```

### 6. Call `enableSpool` in `startFileIngestToLiveBuffer` (SherpaOnnx+PipelineAudio.mm)

Before `resolve(@{@"ingestId": ...})`, insert:

```objc
if (!liveEntry->hasActiveSpool) {
  NSString *tmpSpoolPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
    [NSString stringWithFormat:@"ingest_spool_%@.wav", [[NSUUID UUID] UUIDString]]];
  liveEntry->enableSpool([tmpSpoolPath UTF8String], false, true);
}
```

---

## Edge cases and thread safety

### Concurrent mic + file ingest

- `enableSpool` must be called **before** the background decode thread starts.
- In the current implementation, both Android and iOS resolve the promise (and thus `enableSpool`) on the calling thread before `decodeExecutor.execute` / `dispatch_async` starts.
- Therefore: no race between `enableSpool` and the first `appendSamples` from the decode thread.
- Mic append continues to work: `spoolWriter.append()` / spool write is already outside the ring lock and safe for concurrent callers (SpoolWriter has its own lock on Android; iOS spool writes happen under `appendSamples` which holds `ringMutex`).

### Spool already active

- If user created buffer with `persistencePath`, `enableSpool` is a no-op (guard: `hasActiveSpool`).
- No double-spool scenario.

### Spool created mid-stream

- If mic has already been appending before `ingestFileToLiveAudioBuffer` is called, the temporary spool starts from that point. Earlier mic samples in the ring are **not** retroactively written to spool.
- This is acceptable: the spool's purpose here is preventing data loss **during fast file decode**, not retroactive backup.
- Document this behavior explicitly.

### Buffer released without finalize

- `release()` calls `finalize_()` internally, so spool header is always patched before deletion.

---

## Testing checklist

- [ ] Live buffer created **without** `persistencePath` + `ingestFileToLiveAudioBuffer` -> verify `hasActiveSpool` becomes `true` before first chunk
- [ ] After ingest + finalize + `createOfflineFromLive(mode: fullIfSpooled)` -> verify offline buffer uses spool file (not ring snapshot)
- [ ] After `releasePipelineAudioBuffer` -> verify temp spool file is deleted from cache
- [ ] Live buffer created **with** `persistencePath` + `ingestFileToLiveAudioBuffer` -> verify existing spool is used, no temp spool created
- [ ] Concurrent mic + file ingest -> verify no crash, no data corruption
- [ ] Cancel ingest mid-stream -> verify partial spool is retained until release
- [ ] `totalSamplesDropped` remains `0` for file ingest on a buffer with temp spool (ring may still overflow, but spool captures all)

---

## Files to modify

| File | Change |
|------|--------|
| `android/.../LiveEntry.kt` | `spoolWriter` val->var, add `enableSpool()`, add `isTemporarySpool`, extend `release()` |
| `android/.../SherpaOnnxModule.kt` | Call `enableSpool` in `startFileIngestToLiveBuffer` before decode starts |
| `ios/audio/pipeline/PaLiveEntry.h` | Add `enableSpool()`, add `isTemporarySpool`, extend `release()` |
| `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm` | Call `enableSpool` in `startFileIngestToLiveBuffer` before decode starts |

No TypeScript, doc, or public API changes required (behavior matches existing documented contract).
