# LiveAudioBuffer — Internal Architecture

**Scope:** Internal implementation details of `livePcmBuffer` (the streaming/live audio buffer).  
**Audience:** SDK developers planning engine integrations, buffer pipeline flows, and Fake-Live engine strategies.  
**Native entry types:** `LiveEntry` (Android/Kotlin), `PaLiveEntry` (iOS/C++ header-only).

---

## 1. Overview

A `LiveAudioBuffer` is a **streaming, mutable PCM buffer** with a `recording → finished` lifecycle. It is the primary data conduit for all streaming/live pipeline stages: mic capture, file ingest, streaming STT, streaming enhancement, and TTS chunk playback.

Unlike `OfflineAudioBuffer` (which holds a complete immutable clip), a `LiveAudioBuffer` is designed so:

1. **Producers** (mic, file decoder, JS append, native pipeline workers) **append** new Float32 PCM samples.
2. **Consumers** (streaming STT, streaming enhancement, PCM player) **drain** from the buffer via cursors.
3. At no point does the full PCM stream need to exist in RAM simultaneously.

---

## 2. Core Data Structures

### 2.1 Ring Buffer (In-Memory Window)

The primary in-memory storage is a **fixed-size circular/ring buffer** of `float` samples.

```
┌─────────────────────────────────────────────┐
│                Ring Buffer                   │
│  capacity = sampleRate × ringSeconds         │
│  (default ringSeconds = 60)                  │
│                                              │
│  writeHead ──►  newest samples               │
│  readHead  ◄──  oldest non-evicted sample    │
│                                              │
│  When writeHead wraps past readHead:         │
│    → oldest samples are evicted              │
│    → ringEvictedSamples counter increments   │
│    → NOT data loss if spool is active        │
└─────────────────────────────────────────────┘
```

**Key properties:**
- **Fixed capacity:** `sampleRate × ringSeconds` (configurable at creation, default 60 seconds = 960,000 samples at 16 kHz).
- **Overwrite semantics:** When full, the oldest samples are silently overwritten. This is tracked by `ringEvictedSamples`.
- **Zero-allocation steady state:** No heap allocation during append; samples are written into the pre-allocated ring.

### 2.2 Spool (On-Disk Persistence)

The spool is an **optional append-only file** that captures **every** sample written to the ring, providing full-history retention beyond the ring window.

**Format:** Always Float32 WAV (audioFormat=3, 32-bit IEEE float). File extension: `.wav`.
- 44-byte standard WAV header (written at creation, patched at finalize with final data size).
- Raw Float32 PCM samples appended sequentially after the header.

**Lifecycle:**
```
Creation ──► WAV header written (dataSize=0)
  │
  ▼
Append  ──► float32 samples appended to file, spoolSamplesWritten incremented
  │
  ▼
Finalize ──► WAV header patched with final dataSize (seek to byte 4 and byte 40)
  │
  ▼
Release ──► file closed, temporary spool files deleted
```

**Spool activation modes (retention policy):**

| Retention Mode | Behavior |
|---|---|
| `'auto'` (default) | Spool exists for the session; native trim not implemented yet — behaves like `session` |
| `'session'` | Spool retains every sample until buffer release |
| `'none'` | No spool; ring-only; lossless only if consumer never lags behind the ring |
| `{ mode: 'maxSeconds', ... }` | Accepted but trim not enforced yet; behaves like `session` |
| `{ mode: 'path', ... }` | Explicit spool file path with optional trim policy |

**Mandatory spool for file ingest:** When `ingestFileToLiveAudioBuffer` starts, if no spool is active, a **temporary spool** is auto-created in the platform cache directory. This prevents data loss when the decoder runs faster than consumers. The temporary spool is deleted on `release()`.

### 2.3 Cursor System

Consumers read from the ring buffer via **named cursors** that track their read position.

```
Consumer (e.g. Streaming STT)
    │
    ▼
  Cursor {
    id: string             // unique per consumer
    position: int64        // absolute sample index (monotonic, never wraps)
    lagSamples: int64      // how far behind writeHead
  }
    │
    ▼
  Ring read: ring[position % ringCapacity ... position+chunkSize % ringCapacity]
```

**Cursor mechanics:**
- Cursors track an **absolute** sample position (total samples written since buffer creation).
- The ring stores samples at `position % ringCapacity`, so cursor reads translate absolute positions to ring offsets.
- If a cursor falls behind the ring (i.e., the samples it needs have been overwritten), the read either returns what's available from the spool (if active) or reports a lag/error.
- Multiple consumers can have independent cursors at different positions, all draining from the same ring.

### 2.4 Backpressure

For file ingest, the `backpressure` option controls how the producer interacts with slow consumers:

| Mode | Behavior |
|---|---|
| `'block'` (default for file ingest) | Decoder thread blocks/waits when the slowest cursor hasn't consumed enough room in the ring. Prevents ring overwrite without spool dependency. |
| `'none'` | Decoder runs at full speed; ring may overwrite; spool captures all data. |

---

## 3. State Machine

```
┌──────────────┐       finalize()       ┌──────────────┐
│  recording   │ ─────────────────────► │   finished   │
│              │                         │              │
│ Append OK    │                         │ Append FAILS │
│ Mic OK       │                         │ Read OK      │
│ Ingest OK    │                         │ Cursors drain│
└──────────────┘                         └──────────────┘
         ▲                                      │
         │           release()                   │
         │        ┌──────────────┐              │
         └────────│   released   │◄─────────────┘
                  │              │
                  │ All freed    │
                  └──────────────┘
```

- `recording`: All producers can append. Consumers drain via cursors.
- `finished`: No new appends. Spool header patched. Consumers continue draining until complete. `createOfflineAudioBufferFromLive` available.
- `release()` internally calls `finalize_()` if still recording, then frees ring, closes spool, deletes temp files, clears cursors.

---

## 4. Producers (Data Sources)

All producers append Float32 PCM into the same ring+spool pipeline. The `source` tag in `onFramesAppended` events identifies who wrote:

| Source Tag | Producer | How it appends |
|---|---|---|
| `'mic'` | Platform mic capture (AudioRecord / AVAudioEngine) | Native thread writes directly into ring; no JS roundtrip |
| `'append'` | JS `appendSamplesToLiveAudioBuffer` | JSI synchronous call; copies Float32Array → ring |
| `'append_offline'` | `appendOfflineToLiveAudioBuffer` | Reads from offline buffer → ring (native, no JS) |
| `'file_ingest'` | `ingestFileToLiveAudioBuffer` | FFmpeg decode on background thread → ring |
| `'enhancement'` | Streaming enhancement pipeline output | Native worker appends enhanced chunks |
| `'tts'` | Streaming TTS pipeline output | Native worker appends synthesized chunks |

**JSI fast-path:** `appendSamplesToLiveAudioBuffer` and `getLiveAudioBufferSamplesSlice` use JSI (C++ → JS runtime) to transfer `ArrayBuffer` data without bridge serialization. This is critical for the `'append'` source to avoid copying Float32 samples through the React Native async bridge.

---

## 5. Consumers (Data Drains)

Native streaming pipeline workers consume from the live buffer by:

1. Registering a cursor.
2. Reading `chunkSize` samples at the cursor position from the ring.
3. Advancing the cursor.
4. Repeating until the buffer is finalized and the cursor reaches `totalSamplesWritten`.

The `StreamingPipelineHandle` (`completed`, `stop()`, `flush()`, `reset()`) orchestrates this loop.

**Consumer examples:**
- **Streaming STT:** Reads audio chunks, feeds to online recognizer, writes results to `LiveTextBuffer`.
- **Streaming Enhancement:** Reads audio chunks, runs enhancement model, writes output to a separate `LiveAudioBuffer`.
- **PCM Player:** Reads audio chunks, feeds to the platform audio output.

---

## 6. Random Access

### Ring Window
- **Supported:** `getLiveAudioBufferSamplesSlice(liveBuffer, startFrame, frameCount)` provides JSI-based random access within the current ring window.
- **Limitation:** Only samples still in the ring are accessible. Evicted samples return zeros or error.

### Spool File
- **No direct random-access API exposed.** The spool is an append-only WAV file.
- **Indirect access:** `createOfflineAudioBufferFromLive(buffer, 'fullIfSpooled')` converts the finalized spool to an offline buffer (with mmap) that supports full random access.
- The conversion process: skip 44-byte WAV header → raw byte copy to `.f32` temp file → mmap → `OfflineAudioBuffer`.

---

## 7. Memory & Performance Architecture

### Steady-State Memory
```
Ring buffer:      sampleRate × ringSeconds × 4 bytes
                  Example: 16000 × 60 × 4 = 3.84 MB

Spool I/O buffer: Small platform write buffer (typically 8–32 KB)

Total per buffer: ~4 MB + spool on disk
```

### No Full-Stream-in-Memory Guarantee
At no point during a live pipeline does the complete audio stream exist in RAM:
- The ring holds only the latest `ringSeconds` of audio.
- The spool writes to disk sequentially.
- Consumer cursors process and advance, so processed data is conceptually "freed."

### Native-Side Data Path
All steady-state audio data stays in native memory:
- Mic → ring (native thread, no JS).
- File ingest → ring (native decode thread, no JS).
- Ring → consumer cursor → native pipeline worker → output buffer (entirely native).
- JS receives only **metadata events** (`onFramesAppended` with frame count, source tag — no PCM data).

### Event Throttling
`streamEvents.framesAppended.minIntervalMs` controls how often JS receives append notifications. Setting to 0 = every append; higher values coalesce events. This prevents JS bridge flooding during high-frequency mic capture.

---

## 8. Conversion Paths

### Live → Offline (`createOfflineAudioBufferFromLive`)

| Mode | Behavior |
|---|---|
| `'fullIfSpooled'` | Reads the finalized spool WAV → strips 44-byte header → copies raw F32 bytes to `.f32` temp file → mmap → returns `OfflineAudioBuffer` with `storageKind: 'mmap'`. Falls back to ring snapshot if spool unavailable. |
| `'windowSnapshot'` | Snapshots the current ring window → `OfflineAudioBuffer` with `storageKind: 'ram'` (or `'mmap'` if exceeds dynamic threshold). |

### Offline → Live (`appendOfflineToLiveAudioBuffer`)

Reads all samples from the offline buffer (via `readAllSamples()` or `floatPtr()`) and appends them into the live ring + spool. Source tag: `'append_offline'`.

---

## 9. Thread Safety

- **Ring writes** are protected by a mutex (`ringMutex` on iOS, `synchronized` on Android).
- **Spool writes** happen inside the ring lock (iOS) or via a separate SpoolWriter lock (Android).
- **Cursor reads** acquire the ring lock briefly to copy the chunk, then release.
- **Multiple producers** (mic + file ingest) can append concurrently; the mutex serializes their writes.
- **enableSpool()** must be called before any append from the ingest path (guaranteed by the sequencing in `startFileIngestToLiveBuffer`).

---

## 10. Key Design Decisions

| Decision | Rationale |
|---|---|
| Fixed-size ring (not growable) | Predictable memory. Mobile devices have limited RAM; a 60s ring at 16 kHz = ~4 MB is a safe default. |
| Spool always Float32 WAV (not S16) | Eliminates F32→S16→F32 precision loss. Spool is internal/temporary, not for user distribution. |
| Spool is write-once, not random-access | Simplicity. The only consumer of raw spool data is `createOfflineFromLive`, which does a sequential copy. |
| Mandatory spool for file ingest | File decode can outrun consumers 100×. Without spool, the ring silently overwrites data. |
| JSI for sample transport | TurboModule async bridge would serialize Float32Array to JSON. JSI provides zero-copy ArrayBuffer sharing. |
| Events are metadata-only | Sending actual PCM to JS would defeat the purpose of native-side processing. Events carry frame counts and source tags. |

---

## 11. Implications for Fake-Live Engines

A "Fake-Live" engine (segmenting audio and feeding segments to offline models) would:

1. Create a `LiveAudioBuffer` and ingest the full file into it (file ingest with backpressure).
2. A segmentation step (VAD or fixed-window) reads from the live buffer via a cursor.
3. For each segment: extract the segment's samples → create a temporary `OfflineAudioBuffer` from the slice → pass to the offline engine API.
4. Results are written to a `LiveTextBuffer` as segments.

**Key insight:** The live buffer's ring + spool architecture means the full file is never in RAM. The segmenter reads from the ring/spool, extracts a small window, and the offline engine processes that window. Memory pressure stays bounded.
