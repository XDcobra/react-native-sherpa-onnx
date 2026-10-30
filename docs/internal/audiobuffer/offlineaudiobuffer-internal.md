# OfflineAudioBuffer — Internal Architecture

**Scope:** Internal implementation details of `offlinePcmBuffer` (the offline/immutable audio buffer).  
**Audience:** SDK developers planning engine integrations, buffer pipeline flows, and memory management strategies.  
**Native entry types:** `OfflineEntry` sealed class (Android/Kotlin), `PaOfflineEntry` struct (iOS/C++).

---

## 1. Overview

An `OfflineAudioBuffer` is an **immutable, fully populated PCM buffer**. Once created and populated, its content never changes. It represents a complete audio clip — decoded from a file, synthesized by TTS, produced by enhancement, or snapshotted from a live buffer.

Key characteristics:
- **Immutable after population:** No append, no partial writes. The buffer is either empty (awaiting native producer) or fully populated.
- **Single-owner semantics:** Native code fills it exactly once (e.g., during `transcribe()`, `enhance()`, or `synthesize()`).
- **Two storage backends:** RAM (in-memory) or file-backed (mmap), chosen automatically by a dynamic threshold policy.

---

## 2. Core Data Structures

### 2.1 Storage Variants

The offline buffer uses a **sealed/variant** pattern with two storage strategies:

```
              OfflineEntry (sealed / variant)
             ┌─────────────────────────────────┐
             │  InMemory                        │
             │    samples: FloatArray / vector   │
             │    (when rawPcmSize < threshold)  │
             ├─────────────────────────────────┤
             │  FileBacked (MmapBacked)          │
             │    filePath: string               │
             │    mmapRegion: MappedByteBuffer / │
             │                mmap ptr + len     │
             │    (when rawPcmSize ≥ threshold)  │
             └─────────────────────────────────┘
```

### 2.2 InMemory Variant

```
┌─────────────────────────────────────────────┐
│              InMemory                        │
│                                              │
│  bufferId: string (off_<uuid>)               │
│  sampleRate: int                             │
│  channelCount: int (always 1)                │
│  samples: Float32Array / FloatArray / vector │
│  numSamples: samples.length                  │
│                                              │
│  storageKind: 'ram'                          │
│                                              │
│  Access:                                     │
│    readAllSamples() → direct reference       │
│    readSlice(start, count) → array copy      │
│    floatPtr() → samples.data() [iOS]         │
└─────────────────────────────────────────────┘
```

**Key properties:**
- **Heap-allocated:** The full PCM waveform lives in native heap memory.
- **Fast random access:** Direct array indexing, no I/O.
- **Full memory cost:** The entire waveform is in RSS at all times.
- **Used for:** Small audio clips (< threshold), empty buffers awaiting population, JSI-created buffers.

### 2.3 FileBacked (MmapBacked) Variant

```
┌─────────────────────────────────────────────────────────────┐
│              FileBacked                                       │
│                                                              │
│  bufferId: string (off_<uuid>)                               │
│  sampleRate: int                                             │
│  channelCount: int (always 1)                                │
│  numSamples: int                                             │
│  filePath: <cacheDir>/pa_off_<bufferId>.f32                  │
│  mmapRegion:                                                 │
│    Android: MappedByteBuffer (FileChannel.map READ_ONLY)     │
│    iOS: mmap(PROT_READ, MAP_PRIVATE)                         │
│                                                              │
│  storageKind: 'mmap'                                         │
│                                                              │
│  Access:                                                     │
│    readAllSamples() → memcpy from mmap to heap array         │
│    readSlice(start, count) → position+get from mmap view     │
│    floatPtr() → mmap base cast to const float* [iOS]         │
└─────────────────────────────────────────────────────────────┘
```

**Key properties:**
- **Virtual memory window:** The OS pages data in/out on demand. Only accessed pages are resident in RAM.
- **Low RSS:** For a 100 MB waveform, RSS might only be a few MB (the pages currently accessed).
- **Random access:** mmap provides contiguous virtual address space — any sample is accessible via pointer arithmetic.
- **Zero-copy on iOS:** `floatPtr()` returns a `const float*` directly into the mmap region. STT, alignment, and other C APIs can read directly without copying.
- **Copy required on Android (JNI):** `readAllSamples()` copies mmap data to a heap `FloatArray` for JNI. This is one-time per API call.

### 2.4 Backing File Format

**Raw Float32 PCM** — no header, no metadata in the file.

```
┌──────────────────────────────────────────────┐
│  File: <cacheDir>/pa_off_<bufferId>.f32      │
│                                              │
│  Byte 0 … (numSamples × 4 - 1):             │
│    float32 samples, little-endian, mono      │
│                                              │
│  No header, no padding.                      │
└──────────────────────────────────────────────┘
```

Metadata (sampleRate, channelCount, numSamples) is held **in-memory only** in the `OfflineEntry` struct.

**Rationale:** Raw F32 eliminates header parsing, format conversion (no S16→F32), and simplifies mmap — every byte in the file is a sample.

---

## 3. Dynamic Threshold Policy

The decision between InMemory and FileBacked is made by a **dynamic native policy**:

```
rawPcmSize = numSamples × 4 bytes
threshold  = clamp(platformBase(pathType) × ramMultiplier(ramClass), 4 MB, 32 MB)
```

### Path Types

| Path Type | Description | Platforms |
|---|---|---|
| `file-origin` | Buffer created from file decode, spool conversion, or file-centric paths | Android base: 6 MB, iOS base: 8 MB |
| `heap-origin` | Buffer created from Float32Array, in-memory creation, or upgrade paths | Android base: 10 MB, iOS base: 12 MB |

### RAM Class Multipliers

| RAM Class | Multiplier | Typical Devices |
|---|---|---|
| `LOW` | 0.75× | Low-end phones (< 3 GB RAM) |
| `MID` | 1.0× | Mid-range phones (3-6 GB RAM) |
| `HIGH` | 1.5× | High-end phones (6-8 GB RAM) |
| `VERY_HIGH` | 2.0× | Flagship/tablets (> 8 GB RAM) |

**Examples:**
- Android mid-range, file decode: `clamp(6 × 1.0, 4, 32) = 6 MB` → files > 6 MB decoded PCM use mmap.
- iOS high-end, JSI samples: `clamp(12 × 1.5, 4, 32) = 18 MB` → only > 18 MB JSI buffers get mmap.

---

## 4. Creation Paths

Every offline buffer creation path applies the threshold policy:

| Creation Path | Input | Threshold Type | Behavior |
|---|---|---|---|
| `createOfflineAudioBufferFromFile` | Audio file (any FFmpeg format) | `file-origin` | FFmpeg decode → if large: write .f32 + mmap; if small: InMemory |
| `createOfflineAudioBufferFromSamples` | Float32Array (JSI) | `heap-origin` | If large: write .f32 + mmap; if small: InMemory |
| `createEmptyOfflineAudioBuffer` | None (for TTS/enhancement output) | — | Create InMemory (empty). After native producer fills it: upgrade if exceeds threshold |
| `createOfflineAudioBufferFromLive('fullIfSpooled')` | Live buffer spool WAV | `file-origin` | Strip 44-byte WAV header → raw copy to .f32 → mmap if large; InMemory if small |
| `createOfflineAudioBufferFromLive('windowSnapshot')` | Live buffer ring | `heap-origin` | Snapshot ring samples → if large: .f32 + mmap; if small: InMemory |

### Post-Adopt Upgrade (Enhancement/TTS Output)

For `createEmptyOfflineAudioBuffer` → native producer fills it:

```
1. Buffer created as InMemory (empty, numSamples=0)
2. Native producer (TTS/Enhancement) calls adoptSamples(float[])
3. Check: adoptedSize × 4 ≥ threshold?
   YES → write samples to .f32 temp file → mmap → swap entry to FileBacked
   NO  → keep as InMemory
4. Registry swap is atomic (same bufferId)
```

---

## 5. Temp File Lifecycle — Three-Layer Cleanup

### Layer 1: Deterministic Release
`releasePipelineAudioBuffer(bufferId)`:
1. **Unmap:** Android: null the MappedByteBuffer reference; iOS: `munmap(ptr, len)`.
2. **Close:** File descriptors (fd can be closed after mmap on both platforms).
3. **Delete:** `File.delete()` / `unlink()` the .f32 temp file.
4. **Remove** entry from native registry.

### Layer 2: Startup Orphan Sweep
On module initialization, scan the cache/temp directory:
- Match files with prefix `pa_off_` and suffix `.f32`.
- Delete files older than **1 hour** (configurable constant).
- Catches crashes, force-kills, and developer forgot-to-release scenarios.

### Layer 3: OS Temp Directory Semantics
- **Android:** `context.cacheDir` — OS may reclaim under storage pressure.
- **iOS:** `NSTemporaryDirectory()` — OS purges periodically.

**File naming convention:** `pa_off_<bufferId>.f32`

---

## 6. Random Access

### InMemory
- **Full array access:** `readAllSamples()` returns the array directly (zero-copy on same platform).
- **Slice access:** `readSlice(start, count)` copies a subrange → `FloatArray` / `vector<float>`.
- **JSI access:** `getOfflineAudioBufferSamplesSlice(buffer, start, count)` returns `Float32Array` via JSI.

### FileBacked (Mmap)
- **Full array access:** `readAllSamples()` copies from mmap to heap array (one-time cost).
- **Slice access:** `readSlice(start, count)` reads directly from mmap → no full-buffer copy.
- **JSI access:** Same `getOfflineAudioBufferSamplesSlice` API — transparently reads from mmap.
- **Zero-copy pointer (iOS only):** `floatPtr()` returns `const float*` into mmap region — STT, alignment, and TTS reference audio use this directly.

**Key improvement over legacy:** Previously, `FileBacked` buffers returned `BUFFER_NOT_IN_MEMORY` for JSI slice access. Now, mmap enables transparent slice reads regardless of storage backend.

---

## 7. Memory & Performance Architecture

### Memory Comparison

| Scenario | InMemory RSS | FileBacked RSS |
|---|---|---|
| 30 min audio @ 16 kHz | 115 MB | ~2-4 MB (active pages only) |
| 5 min audio @ 16 kHz | 19 MB | Not triggered (below threshold) |
| Two buffers overlapping (pipeline) | 2 × full size | 2 × active pages + disk |

### Pipeline Overlap

In a typical offline pipeline:
```
AudioFile → OfflineAudioBuffer₁ → Enhancement → OfflineAudioBuffer₂ → release(₁) → STT → TextBuffer
```

With both buffers file-backed:
- Overlap costs **disk** (two .f32 files) but not **two full waveforms in RAM**.
- After `release(₁)`, only buffer ₂'s mmap remains.

### Consumer Access Patterns

| Consumer | Access Pattern | Benefit from Mmap |
|---|---|---|
| **Offline STT** | Sequential read of full waveform | iOS: zero-copy `floatPtr()`. Android: one-time `readAllSamples()` copy. |
| **Enhancement** | Sequential read → mutable copy needed | `readAllSamples()` copy from mmap (still better than keeping full buffer in heap permanently). |
| **Alignment** | Random access (seek to specific timestamps) | `floatPtr()` + pointer arithmetic — ideal for mmap. |
| **JSI slice** | Random access (user/debug reads) | `readSlice()` pages in only the requested region. |
| **Audio export** | Sequential read to encoder | Can stream from mmap without full materialization. |

---

## 8. Thread Safety

- **Immutable after population:** No concurrent write concerns — only reads after creation.
- **Registry access** is protected by a lock (buffer lookup by ID).
- **mmap reads** are thread-safe (read-only, MAP_PRIVATE).
- **Release** must not race with active reads — the registry lock ensures this.

---

## 9. Key Design Decisions

| Decision | Rationale |
|---|---|
| Raw .f32 (not WAV) for temp files | No header parsing, no format conversion. Every byte is a float sample. |
| Dynamic threshold (not fixed 10 MB) | Different devices have different RAM. A flagship with 12 GB RAM can afford more in-memory; a low-end phone cannot. |
| mmap (not buffered file I/O) | mmap provides contiguous virtual address space, zero-copy pointer access (iOS), and OS-managed paging. Superior to manual read/seek for random access patterns. |
| Post-adopt upgrade for empty buffers | We don't know the output size at creation time. Upgrade after population avoids speculative file creation. |
| Three-layer cleanup | Deterministic + orphan sweep + OS semantics covers all failure modes (normal, crash, leak). |
| `storageKind` exposed in info | Debugging and support — developers can verify which backend is used without native logs. |

---

## 10. Implications for Fake-Live Engines

A Fake-Live engine might create offline buffers as intermediate steps:

1. **Extract segment from LiveAudioBuffer:** `createOfflineAudioBufferFromLive(liveBuffer, 'windowSnapshot')` → small InMemory buffer with just the segment's audio.
2. **Pass to offline STT/Enhancement:** The offline engine consumes the small buffer.
3. **Release immediately:** After processing, the segment buffer is released.

**Key insight:** For Fake-Live, each segment's offline buffer is typically small (a few seconds of audio = a few hundred KB). These will always be InMemory (well below any threshold). The mmap optimization primarily benefits full-file offline processing, not the per-segment Fake-Live path. This is the desired behavior — small buffers stay fast (no file I/O overhead), large buffers stay memory-efficient (mmap).
