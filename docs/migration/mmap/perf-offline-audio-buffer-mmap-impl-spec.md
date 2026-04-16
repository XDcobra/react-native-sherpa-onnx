# File-backed mmap for large offline audio buffers — implementation spec

**Status:** Ready for implementation.  
**Supersedes:** [`perf-offline-audio-buffer-backing-spec.md`](./perf-offline-audio-buffer-backing-spec.md) (high-level motivation and goals).  
**Audience:** Native contributors (Kotlin, Objective-C++), SDK maintainers.  
**Breaking changes:** Allowed — SDK is pre-release. Changes that simplify internals or improve robustness are welcome.

---

## 0. Resolved open questions

| Question | Decision |
|---|---|
| **Exact threshold / per-platform** | Hard-code **10 MB of raw PCM** (`numSamples × bytesPerSample × channels`). A future plan will make it dynamic per platform and device. |
| **Random access requirement** | Yes — JSI slice reads and potential alignment internals need random access. Use **mmap** as the backing strategy. |
| **Temp file robustness** | Implement a **three-layer** cleanup strategy: deterministic release, startup orphan sweep, and OS-level temp directory semantics. See §4. |

---

## 1. Scope

### In scope

- Replace `readAllSamples()`-based full-load for file-backed `OfflineEntry` / `PaOfflineEntry` with **mmap**-backed access.
- Apply the **10 MB threshold** to decide `InMemory` vs `FileBacked` for **all** offline buffer creation paths (not just live-to-offline).
- Enable the **enhancement output** path to produce `FileBacked` buffers when the result exceeds the threshold.
- Provide a **robust temp file lifecycle** (deterministic cleanup, crash-resilient orphan sweep).
- Enable **JSI slice access** for file-backed buffers (currently returns `BUFFER_NOT_IN_MEMORY`).
- Keep the **public TypeScript API stable** — same exports, same method signatures.

### Out of scope

- Dynamic / per-device threshold tuning (future plan).
- Live buffer ring or spool changes (unrelated lifecycle).
- Changes to offline text buffer semantics.
- Multi-channel (stereo) support — current pipeline is mono-only.

---

## 2. Architecture overview

```
                        OfflineEntry (sealed / variant)
                       ┌─────────────────────────────────┐
                       │  InMemory                        │
                       │    samples: FloatArray / vector   │
                       │    (used when rawPcmSize < 10 MB)│
                       ├─────────────────────────────────┤
                       │  FileBacked                       │
                       │    tempFile: path                 │
                       │    metadata: WavHeader / raw info │
                       │    mmapRegion: MappedByteBuffer / │
                       │                mmap ptr + len     │
                       │    (used when rawPcmSize ≥ 10 MB)│
                       └─────────────────────────────────┘
                                     │
                    ┌────────────────┼─────────────────────┐
                    │                │                      │
              readAllSamples()  readSlice(start,count)  asFloatPtr()
              (copies to RAM      (zero-copy from        (zero-copy
               for C APIs         mmap region)            float* view
               that need it)                              for C APIs)
```

### Key principle

**mmap provides a virtual memory window into the file.** The OS pages data in/out on demand. This gives:

- **Random access** without manual seek/read — important for JSI slices and alignment.
- **Low resident RSS** — the OS evicts pages under memory pressure; only accessed pages are resident.
- **Zero-copy reads** for consumers that accept a `const float*` pointer (alignment, JSI slices).
- **Contiguous float\* address** — mmap region is contiguous in virtual address space, satisfying the sherpa-onnx C API requirement (`acceptWaveform(float*, n)`) without copying into a heap buffer.

### When readAllSamples() is still needed

Some consumers still need a **heap-owned copy** because they mutate data or the mmap region may outlive the consumer (e.g. the C library holds a reference longer than expected). In practice, `readAllSamples()` on a mmap-backed buffer degrades to a `memcpy` of the mmap region — still better than re-reading the file, but the primary win is that **most access paths avoid it entirely**.

---

## 3. Backing file format: raw Float32 PCM (not WAV)

### Rationale

Today's file-backed buffers store **WAV** files (from the spool). This requires:

1. Header parsing on every open.
2. Format conversion (int16 → float32) on every read.
3. Two code paths (PCM int16 vs IEEE float32).

For **internally-managed temp files**, we control the format. Storing **raw float32 PCM** with a sidecar metadata struct eliminates all three costs.

### File layout

```
┌──────────────────────────────────────────────┐
│  Raw file: <tempDir>/pa_off_<bufferId>.f32   │
│                                               │
│  Byte 0 … (numSamples×4 - 1):               │
│    float32 samples, little-endian, mono       │
│                                               │
│  No header, no padding.                       │
└──────────────────────────────────────────────┘
```

Metadata is held **in-memory only** in the `OfflineEntry` / `PaOfflineEntry` struct:

```
sampleRate:    int
channelCount:  int  (always 1 for now)
numSamples:    int
fileSize:      long  (= numSamples × 4)
filePath:      string
```

### Exception: external WAV files (createOfflineFromFile with user-supplied WAV)

When the user calls `createOfflineAudioBufferFromFile` with a WAV/audio file:

1. Decode via FFmpeg into float32 PCM.
2. If decoded size < 10 MB → `InMemory`.
3. If decoded size ≥ 10 MB → write decoded float32 samples to a **raw .f32 temp file**, then mmap it.

The original WAV is **not** mmap'd directly (it may be int16, compressed, or have complex chunk layouts). The temp file is always raw float32.

### Exception: live-to-offline (`createOfflineFromLive` with spool)

When `fullIfSpooled` mode finds a finalized spool WAV:

1. If spool is float32 WAV and size ≥ 10 MB → **convert** to raw .f32 temp file (strip WAV header, ensure float32), then mmap. Delete spool if it was marked temporary.
2. If spool is int16 WAV → decode + convert to .f32 temp file, then mmap. Delete spool.
3. If size < 10 MB → `InMemory` (read spool into memory, delete spool if temporary).

This avoids carrying the WAV format conversion cost into every consumer read.

---

## 4. Temp file lifecycle — three-layer cleanup

### 4.1 Layer 1: deterministic release

`releasePipelineAudioBuffer(bufferId)`:

1. **Unmap** the mmap region:
   - Android: `MappedByteBuffer` — set reference to `null`, call `System.gc()` hint (or use `sun.misc.Cleaner` / `DirectByteBuffer` cleanup on API 26+). See §5.1 for details.
   - iOS: `munmap(ptr, len)`.
2. **Close** the file descriptor.
3. **Delete** the temp file (`File.delete()` / `unlink()`).
4. **Remove** the entry from the registry.

If the file is already deleted (e.g. by orphan sweep), steps 2–3 are no-ops.

### 4.2 Layer 2: startup orphan sweep

On **native module initialization** (called once per app launch):

```
scanDir = platform temp directory
prefix  = "pa_off_"
suffix  = ".f32"
maxAge  = 1 hour (configurable constant)

for each file matching prefix+suffix in scanDir:
    if file.lastModified < (now - maxAge):
        delete file
```

This catches:

- App crash / force-kill before `release()` was called.
- Developer forgot to release a buffer.
- System killed the process under memory pressure.

**Why 1 hour?** A buffer that has been untouched for 1 hour is almost certainly orphaned. Active buffers are continuously accessed (mmap page faults update OS-level access time) or are processed within seconds/minutes.

Platform specifics:

- **Android:** Run in `SherpaOnnxModule.initialize()` or a `ContentProvider` auto-init. Use `context.cacheDir` as the scan directory.
- **iOS:** Run in `+[SherpaOnnx load]` or the first TurboModule method call. Use `NSTemporaryDirectory()`.

### 4.3 Layer 3: OS temp directory semantics

Both platforms guarantee that files in the cache/temp directory may be **reclaimed by the OS** when disk space is low:

- **Android:** `context.cacheDir` — the system may delete files here when storage is low.
- **iOS:** `NSTemporaryDirectory()` — the system purges contents periodically and on device storage pressure.

This is the last-resort safety net. We do **not** rely on it for correctness, but it prevents unbounded disk growth from truly abandoned files.

### 4.4 Naming convention

```
pa_off_<bufferId>.f32
```

Where `bufferId` is the UUID portion of the full buffer ID (e.g. `off_550e8400-e29b-41d4-a716-446655440000` → `pa_off_550e8400-e29b-41d4-a716-446655440000.f32`).

Prefix `pa_off_` is unique enough to avoid collisions with other SDK files. The `.f32` extension signals the raw format.

---

## 5. Platform implementation details

### 5.1 Android (Kotlin + JNI)

#### mmap via `FileChannel.map()`

```kotlin
// In FileBacked constructor or lazy init
val raf = RandomAccessFile(File(filePath), "r")
val channel = raf.channel
val mappedBuffer: MappedByteBuffer = channel.map(
    FileChannel.MapMode.READ_ONLY,
    0,
    fileSize
)
mappedBuffer.order(ByteOrder.LITTLE_ENDIAN)
channel.close()
raf.close()
// mappedBuffer remains valid after channel/raf close — backed by OS mapping
```

#### Reading samples from mmap

```kotlin
// Zero-copy float view
fun floatBufferView(): FloatBuffer = mappedBuffer.asFloatBuffer()

// Slice access (for JSI)
fun readSlice(startSample: Int, count: Int): FloatArray {
    val fb = mappedBuffer.asFloatBuffer()
    fb.position(startSample)
    val out = FloatArray(count)
    fb.get(out)
    return out
}

// Full read (for STT, enhancement — copies mmap into heap FloatArray)
override fun readAllSamples(): FloatArray {
    val fb = mappedBuffer.asFloatBuffer()
    fb.position(0)
    val out = FloatArray(numSamples)
    fb.get(out)
    return out
}
```

#### Passing to sherpa-onnx C API via JNI

The sherpa-onnx JNI bridge already accepts `float[]` (heap array). For mmap-backed buffers, `readAllSamples()` produces a heap copy. This is acceptable because:

1. The copy is **one-time** per transcription/enhancement call.
2. The mmap region is not held in RSS otherwise — pages are evicted when not accessed.
3. A future optimization could pass the `MappedByteBuffer`'s address directly to JNI as a `long` pointer, but this is not required for the initial implementation.

#### Cleanup of `MappedByteBuffer`

Java does not expose a public `unmap()`. Options:

1. **Preferred (API 26+, minSdk requirement met):** Use `sun.misc.Unsafe` or the internal `DirectByteBuffer.cleaner()` to force unmap. Wrap in a try-catch for safety.
2. **Fallback:** Set `mappedBuffer = null` and rely on GC + finalizer. The file can still be deleted on most filesystems (Linux/Android unlink semantics — file is removed from directory but data persists until last fd/mapping is closed).
3. **Practical:** On Android (Linux kernel), `File.delete()` after `mappedBuffer = null` succeeds immediately because `unlink()` removes the directory entry. The mapping remains valid until GC collects the `MappedByteBuffer`, but the disk space is reclaimed once both the mapping and all fds are released. This is safe for our use case.

**Recommended approach:** Strategy 3 — null the reference, delete the file, let GC handle the mapping cleanup. The temp file disappears from the filesystem immediately.

#### OfflineEntry sealed class changes

```kotlin
sealed class OfflineEntry {
    abstract val bufferId: String
    abstract val sampleRate: Int
    abstract val channelCount: Int
    abstract val numSamples: Int

    abstract fun readAllSamples(): FloatArray
    abstract fun readSlice(startSample: Int, count: Int): FloatArray
    abstract fun releaseResources()

    class InMemory(
        override val bufferId: String,
        override val sampleRate: Int,
        override val channelCount: Int,
        @Volatile var samples: FloatArray
    ) : OfflineEntry() {
        override val numSamples get() = samples.size

        override fun readAllSamples() = samples
        override fun readSlice(startSample: Int, count: Int): FloatArray =
            samples.copyOfRange(startSample, startSample + count)
        override fun releaseResources() { samples = FloatArray(0) }

        // Existing adoptSamples / tryAdoptSamples methods remain
    }

    class FileBacked(
        override val bufferId: String,
        override val sampleRate: Int,
        override val channelCount: Int,
        override val numSamples: Int,
        val filePath: String,
        private var mappedBuffer: MappedByteBuffer?
    ) : OfflineEntry() {
        override fun readAllSamples(): FloatArray {
            val fb = requireMapping().asFloatBuffer()
            fb.position(0)
            val out = FloatArray(numSamples)
            fb.get(out)
            return out
        }

        override fun readSlice(startSample: Int, count: Int): FloatArray {
            val fb = requireMapping().asFloatBuffer()
            fb.position(startSample)
            val out = FloatArray(count)
            fb.get(out)
            return out
        }

        override fun releaseResources() {
            mappedBuffer = null   // Release reference → GC will unmap
            try { File(filePath).delete() } catch (_: Exception) {}
        }

        private fun requireMapping(): MappedByteBuffer =
            mappedBuffer ?: throw IllegalStateException("Buffer already released")
    }
}
```

### 5.2 iOS (Objective-C++ / C++)

#### mmap via POSIX `mmap()`

```cpp
struct PaMmapRegion {
    void *base = nullptr;    // mmap base pointer
    size_t length = 0;       // mmap length in bytes

    ~PaMmapRegion() { unmap(); }
    PaMmapRegion(const PaMmapRegion &) = delete;
    PaMmapRegion &operator=(const PaMmapRegion &) = delete;
    PaMmapRegion(PaMmapRegion &&o) noexcept : base(o.base), length(o.length) {
        o.base = nullptr; o.length = 0;
    }

    bool valid() const { return base != nullptr && base != MAP_FAILED; }

    static PaMmapRegion open(const std::string &path) {
        PaMmapRegion r;
        int fd = ::open(path.c_str(), O_RDONLY);
        if (fd < 0) return r;

        struct stat st;
        if (fstat(fd, &st) != 0) { ::close(fd); return r; }
        r.length = (size_t)st.st_size;

        r.base = ::mmap(nullptr, r.length, PROT_READ, MAP_PRIVATE, fd, 0);
        ::close(fd);  // fd can be closed after mmap — mapping persists

        if (r.base == MAP_FAILED) { r.base = nullptr; r.length = 0; }
        return r;
    }

    void unmap() {
        if (base && base != MAP_FAILED) {
            ::munmap(base, length);
        }
        base = nullptr;
        length = 0;
    }

    const float *floatPtr() const {
        return reinterpret_cast<const float *>(base);
    }

    int numSamples() const { return (int)(length / sizeof(float)); }
};
```

#### Updated PaOfflineEntry

```cpp
struct PaOfflineEntry {
    std::string bufferId;
    int sampleRate = 0;
    int channelCount = 1;

    // --- InMemory variant ---
    std::vector<float> samples;

    // --- FileBacked variant ---
    bool isFileBacked = false;
    std::string filePath;
    PaMmapRegion mmapRegion;

    int numSamples() const {
        return isFileBacked ? mmapRegion.numSamples() : (int)samples.size();
    }

    // Zero-copy pointer for C APIs that accept const float*
    const float *floatPtr() const {
        return isFileBacked ? mmapRegion.floatPtr() : samples.data();
    }

    // Full copy (for consumers that need an owned mutable buffer)
    std::vector<float> readAllSamples() const {
        if (!isFileBacked) return samples;
        const float *p = mmapRegion.floatPtr();
        return std::vector<float>(p, p + mmapRegion.numSamples());
    }

    // Slice copy (for JSI)
    std::vector<float> readSlice(int startSample, int count) const {
        const float *p = floatPtr();
        return std::vector<float>(p + startSample, p + startSample + count);
    }

    void release() {
        if (isFileBacked) {
            mmapRegion.unmap();
            if (!filePath.empty()) {
                std::remove(filePath.c_str());
                filePath.clear();
            }
        }
        samples.clear();
        samples.shrink_to_fit();
    }
};
```

#### Passing to sherpa-onnx C API

On iOS, the C++ wrapper can accept `const float*` directly:

```cpp
// STT — pass mmap pointer directly, ZERO COPY
wrapper->transcribeSamples(entry->floatPtr(), entry->sampleRate, entry->numSamples());

// Enhancement — needs mutable input → readAllSamples() copy
std::vector<float> input = audioInEntry->readAllSamples();
auto result = wrapper->runSamples(input, audioInEntry->sampleRate);

// Alignment — pass mmap pointer directly
AlignAccurateFromFloatPcm(model, text, entry->floatPtr(), entry->sampleRate, gran);
```

**Critical advantage over Android:** On iOS, mmap gives us a `const float*` that we can pass **directly** to sherpa-onnx C APIs without any heap copy. STT, alignment, and TTS reference audio all benefit from zero-copy access.

---

## 6. Threshold logic

### Definition

```
rawPcmSize = numSamples × sizeof(float)   // = numSamples × 4 bytes
threshold  = 10 * 1024 * 1024             // = 10 MB = 10,485,760 bytes
                                           // = 2,621,440 samples
                                           // ≈ 164 seconds @ 16 kHz mono
                                           // ≈ 60 seconds @ 44.1 kHz mono
```

### Application points

The threshold check must be applied at **every** offline buffer creation path:

| Creation path | Current behavior | New behavior |
|---|---|---|
| `createOfflineAudioBufferFromFile` (FFmpeg decode) | Always InMemory | Apply threshold after decode |
| `createOfflineAudioBufferFromSamples` (JSI) | Always InMemory | Apply threshold (copy samples to temp .f32 if large) |
| `createEmptyOfflineAudioBuffer` (for TTS/enhancement output) | Always InMemory | Create InMemory; **upgrade** to FileBacked after `adoptSamples()` if large (see §7) |
| `createOfflineFromLive` (fullIfSpooled) | FileBacked only if spool exists | Convert spool → .f32 + mmap if large; InMemory if small |
| `createOfflineFromLive` (windowSnapshot) | Always InMemory (ring snapshot) | Apply threshold (ring snapshot is typically < 10 MB, but check) |

### Constant location

```kotlin
// Android
internal const val PA_FILE_BACKED_THRESHOLD_BYTES: Long = 10L * 1024 * 1024

// iOS
static const long kPaFileBackedThreshold = 10L * 1024 * 1024;
```

---

## 7. Enhancement output — deferred upgrade to FileBacked

### Problem

Enhancement creates an **empty** `InMemory` buffer, then atomically adopts the output samples. We don't know the output size at creation time (it equals the input size, but the abstraction shouldn't assume that).

### Solution: post-adopt upgrade

After `tryAdoptSamples()` or `samples = std::move(result)`, check if the adopted data exceeds the threshold:

```
if adoptedSamples.size × 4 ≥ threshold:
    write samples to temp .f32 file
    mmap the file
    replace InMemory entry with FileBacked entry in registry
    (same bufferId, same metadata)
```

This is an **internal optimization** — the buffer ID and all external references remain valid. The registry swap must be atomic (hold the lock).

#### Android

```kotlin
fun upgradeToFileBackedIfNeeded(entry: OfflineEntry.InMemory): OfflineEntry {
    val rawSize = entry.numSamples.toLong() * 4
    if (rawSize < PA_FILE_BACKED_THRESHOLD_BYTES) return entry

    val tempFile = File(cacheDir, "pa_off_${entry.bufferId}.f32")
    FileOutputStream(tempFile).use { fos ->
        val buf = ByteBuffer.allocate(entry.numSamples * 4).order(ByteOrder.LITTLE_ENDIAN)
        buf.asFloatBuffer().put(entry.samples)
        fos.write(buf.array())
    }
    entry.samples = FloatArray(0)  // Release heap memory

    val raf = RandomAccessFile(tempFile, "r")
    val mapped = raf.channel.map(FileChannel.MapMode.READ_ONLY, 0, tempFile.length())
    mapped.order(ByteOrder.LITTLE_ENDIAN)
    raf.close()

    return OfflineEntry.FileBacked(
        bufferId = entry.bufferId,
        sampleRate = entry.sampleRate,
        channelCount = entry.channelCount,
        numSamples = entry.numSamples,
        filePath = tempFile.absolutePath,
        mappedBuffer = mapped
    )
}
```

#### iOS

```cpp
void pa_upgrade_to_file_backed_if_needed(std::shared_ptr<PaOfflineEntry> &entry) {
    if (entry->isFileBacked) return;
    long rawSize = (long)entry->samples.size() * sizeof(float);
    if (rawSize < kPaFileBackedThreshold) return;

    NSString *tmpDir = NSTemporaryDirectory();
    std::string path = [tmpDir UTF8String];
    path += "/pa_off_" + entry->bufferId + ".f32";

    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f.write(reinterpret_cast<const char *>(entry->samples.data()),
            entry->samples.size() * sizeof(float));
    f.close();

    entry->mmapRegion = PaMmapRegion::open(path);
    if (!entry->mmapRegion.valid()) return;  // Fallback: stay InMemory

    entry->samples.clear();
    entry->samples.shrink_to_fit();
    entry->isFileBacked = true;
    entry->filePath = path;
}
```

---

## 8. Consumer changes

### 8.1 STT offline

| Platform | Current | New |
|---|---|---|
| **Android** | `entry.readAllSamples()` → heap FloatArray → JNI | No change needed. `readAllSamples()` now copies from mmap instead of streaming from file. Functionally identical, slightly faster (no format conversion). |
| **iOS** | `entry->readAllSamples()` → vector copy → C API | **Optimization:** Use `entry->floatPtr()` directly as the `const float*` argument to `transcribeSamples()`. **Zero-copy.** |

### 8.2 Enhancement

| Platform | Current | New |
|---|---|---|
| **Both** | `readAllSamples()` for input | No change for input (copy still needed — enhancement may mutate). Output buffer: apply **post-adopt upgrade** (§7). |

### 8.3 Alignment

| Platform | Current | New |
|---|---|---|
| **Android** | `FileBacked` → pass `filePath`; `InMemory` → pass `samples` | **Change:** `FileBacked` with .f32 is no longer WAV → update `nativeAlignAccurateFromFile` to accept raw .f32 **OR** add a third path using `readAllSamples()`. Simpler: always use the in-memory path via `readAllSamples()` — alignment is fast and the copy is negligible. |
| **iOS** | Same dual-path | **Optimization:** `FileBacked` → use `entry->floatPtr()` via the float PCM path. Eliminates the file-path path entirely for mmap-backed buffers (the backing file is raw .f32, not WAV). |

**Decision:** Simplify alignment to always use the `floatPtr()` / `readAllSamples()` path. Remove the `AlignAccurateFromFile` path for pipeline buffers — it was an optimization for WAV files that is now superseded by mmap zero-copy.

### 8.4 JSI slice access

| Platform | Current | New |
|---|---|---|
| **Both** | `FileBacked` → returns `BUFFER_NOT_IN_MEMORY` error | **Fix:** Use `readSlice(startSample, count)` which works for both `InMemory` and `FileBacked`. Remove the error path. |

### 8.5 TTS reference audio

| Platform | Current | New |
|---|---|---|
| **Both** | `readAllSamples()` for voice cloning reference | No change. Reference audio is typically small (< 30s ≈ 1.9 MB @ 16 kHz). If it exceeds threshold, `readAllSamples()` copies from mmap — still correct. |

---

## 9. Public API changes

### 9.1 TypeScript API — no breaking changes

All existing exports remain identical:

```typescript
createOfflineAudioBufferFromFile(source, options?)  → OfflineAudioBufferRef
createOfflineAudioBufferFromSamples(samples, rate)  → OfflineAudioBufferRef
createEmptyOfflineAudioBuffer(rate)                 → OfflineAudioBufferRef
getPipelineAudioBufferInfo(buffer)                  → PipelineAudioBufferInfo
releasePipelineAudioBuffer(buffer)                  → void
sliceOfflineAudioBuffer(id, start, count)           → Float32Array  // NOW WORKS for file-backed
```

### 9.2 Optional observability extension (non-breaking)

Add an optional field to `OfflineAudioBufferInfo`:

```typescript
export interface OfflineAudioBufferInfo {
    // ... existing fields ...
    storageKind?: 'ram' | 'mmap';  // Optional, for debugging
}
```

Native fills this based on the entry variant. JS consumers can ignore it.

### 9.3 Breaking internal changes (native only)

- `OfflineEntry.FileBacked` no longer stores `FileBackedMetadata` with WAV header info. It stores simple metadata (sampleRate, channelCount, numSamples) + mmap region.
- `FileBackedReader` class becomes unnecessary — remove or keep for legacy WAV import only.
- `FileBackedWav.kt` / WAV-header-based file-backed logic is replaced by raw .f32 + mmap.
- iOS `PaOfflineEntry` adds `PaMmapRegion` field, removes `PaWavHeader wavHeader` for mmap-backed entries.

---

## 10. Implementation order

### Phase 1: Infrastructure (no behavior change)

1. **Add `PaMmapRegion` / mmap helper** on iOS.
2. **Add `FileBacked` with `MappedByteBuffer`** on Android (update sealed class).
3. **Add temp file naming utility** (`pa_off_<id>.f32`) and directory resolution on both platforms.
4. **Add startup orphan sweep** on both platforms.
5. **Add `readSlice()` method** to `OfflineEntry` / `PaOfflineEntry` (works for both variants).

### Phase 2: Apply threshold to creation paths

6. **`createOfflineAudioBufferFromFile`** — after FFmpeg decode, check threshold → write .f32 + mmap if large.
7. **`createOfflineFromLive` (fullIfSpooled)** — convert spool WAV → .f32 + mmap if large.
8. **`createOfflineAudioBufferFromSamples` (JSI)** — check threshold → write .f32 + mmap if large.

### Phase 3: Consumer updates

9. **JSI slice access** — remove `BUFFER_NOT_IN_MEMORY` error, use `readSlice()`.
10. **iOS STT** — use `floatPtr()` zero-copy path.
11. **iOS alignment** — use `floatPtr()` path, remove `AlignAccurateFromFile` for pipeline buffers.
12. **Enhancement output** — add post-adopt upgrade to `FileBacked`.

### Phase 4: Cleanup

13. **Remove** `FileBackedWav.kt` reader class (Android) if no longer needed.
14. **Remove** `PaWavHeader` struct usage for pipeline-managed files (iOS).
15. **Update** `PipelineAudioBufferInfo` to include optional `storageKind`.
16. **Update** documentation: `audiobuffer-offline.md`, this spec status → "Implemented".

---

## 11. Testing strategy

### Unit tests (per-platform)

| Test | Validates |
|---|---|
| Create InMemory buffer < 10 MB, verify `readAllSamples()` | Baseline — no regression |
| Create FileBacked buffer ≥ 10 MB, verify `readAllSamples()` returns correct data | mmap read correctness |
| `readSlice()` on FileBacked — bounds, correctness, out-of-range error | Slice access |
| `release()` on FileBacked — file is deleted, mapping is invalidated | Cleanup |
| Create + release + re-create with same ID — no conflicts | ID reuse safety |
| Orphan sweep deletes old .f32 files but not recent ones | Sweep correctness |
| Enhancement output exceeding threshold → upgrade to FileBacked | Post-adopt upgrade |

### Integration tests (example app / CI)

| Test | Validates |
|---|---|
| STT on large file (> 10 MB PCM) → correct transcription | End-to-end with mmap |
| Enhancement on large file → output buffer is FileBacked | Enhancement + upgrade |
| JSI `sliceOfflineAudioBuffer` on large file-backed buffer | JSI slice fix |
| Two large buffers alive simultaneously → measure RSS | Memory improvement |

### Memory profiling

- **Android:** Use `Debug.getNativeHeapAllocatedSize()` or Android Profiler to verify that two 10 MB+ buffers do not cause 2× heap growth.
- **iOS:** Use Instruments (Allocations + VM Tracker) to verify mmap pages vs heap allocations.

---

## 12. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| mmap page faults cause latency spikes during STT | Low | Medium | OS prefetch handles sequential reads well. For STT, the full buffer is accessed sequentially — page faults amortize. Use `madvise(MADV_SEQUENTIAL)` / `posix_madvise` hint. |
| `MappedByteBuffer` GC delay on Android | Medium | Low | File deletion via `unlink` works immediately (removes dir entry). Mapping cleanup is deferred to GC but does not block. |
| Disk I/O slower than RAM for small buffers near threshold | Low | Low | 10 MB threshold is conservative. Buffers just above threshold have minimal mmap overhead vs. the RAM savings. |
| Temp file write fails (disk full) | Low | Medium | Fall back to `InMemory` if .f32 write fails. Log a warning. |
| Orphan sweep deletes file belonging to active buffer | Very Low | High | Orphan sweep only deletes files older than 1 hour. Active buffers are created within the current session. Buffer IDs are UUIDs — no collisions. |

---

## 13. Acceptance criteria

1. **Memory:** For two simultaneously alive offline buffers with ≥ 10 MB raw PCM each, peak **native heap** does not grow by 2 × buffer size (mmap pages are not counted as heap).
2. **Correctness:** All existing example flows produce identical results (STT transcriptions, enhancement output, alignment timestamps).
3. **Cleanup:** After `releasePipelineAudioBuffer`, the backing .f32 file is deleted within 1 second.
4. **Orphan safety:** After simulated crash (kill -9), restart cleans up .f32 files older than 1 hour.
5. **JSI slices:** `sliceOfflineAudioBuffer` works for both InMemory and FileBacked buffers.
6. **No public API changes:** TypeScript API surface unchanged (except optional `storageKind` addition).

---

## 14. Related documents

- [`perf-offline-audio-buffer-backing-spec.md`](./perf-offline-audio-buffer-backing-spec.md) — high-level motivation (superseded by this document).
- [`audiobuffer.md`](../audiobuffer.md) — pipeline audio buffer overview.
- [`audiobuffer-offline.md`](../audiobuffer-offline.md) — offline buffer concepts and API.
- [`stt-offline.md`](../stt-offline.md) — offline STT consumer.
