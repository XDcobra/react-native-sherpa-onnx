# LiveSegmentBuffer — Internal Architecture

**Scope:** Internal implementation details of `liveSegmentBuffer` (the streaming/live segment buffer).  
**Audience:** SDK developers planning VAD integration, alignment flows, and incremental post-processing.  
**Native entry types:** `LiveSegmentEntry` (Android/Kotlin), `PaLiveSegmentEntry` (iOS/C++).

---

## 1. Overview

A `LiveSegmentBuffer` is a **streaming, mutable buffer for audio segment metadata** with a `recording → finished` lifecycle. It stores temporal segment boundaries (start/end samples) along with typed payloads, rather than the audio data itself.

Primary producers:
- **VAD (Voice Activity Detection):** Appends `speech` segments with `source: 'vad'` as voice activity is detected.
- **Streaming STT:** Appends `speech` segments with `source: 'stt'` after endpoint detection.
- **Streaming TTS:** Appends `speech` segments with `source: 'tts'` for generated audio chunks.
- **Alignment:** Appends `alignment` segments with timing and text metadata.

The buffer acts as a **metadata index** into an associated `LiveAudioBuffer` — it references audio by sample ranges, not by storing actual PCM data.

---

## 2. Core Data Structures

### 2.1 Segment Log (In-Memory Window)

The primary in-memory storage is a **bounded ordered list** of `SegmentMeta` entries.

```
┌─────────────────────────────────────────────────────────────┐
│                    Segment Log                               │
│                                                              │
│  segments: [                                                 │
│    { id: "seg_uuid1", kind: "speech",                        │
│      sourceAudioBufferId: "live_uuid",                       │
│      startSample: 0, endSample: 16000,                      │
│      sampleRate: 16000, durationMs: 1000,                    │
│      payload: { source: "vad", score: 0.93 } },             │
│    { id: "seg_uuid2", kind: "alignment",                     │
│      sourceAudioBufferId: "live_uuid",                       │
│      startSample: 16000, endSample: 32000,                  │
│      sampleRate: 16000, durationMs: 1000,                    │
│      payload: { text: "hello", timingMode: "vad",            │
│                 granularity: "word" } },                      │
│    ...                                                       │
│  ]                                                           │
│                                                              │
│  maxSegments: number (configurable)                          │
│  totalSegmentsWritten: number (monotonic, never reset)       │
│  eviction: FIFO when count > maxSegments                     │
└─────────────────────────────────────────────────────────────┘
```

**Key properties:**
- **Append-only:** Each `appendLiveSegment` call adds one entry. No in-place mutation.
- **Bounded:** `maxSegments` limits the in-memory window. Oldest segments are evicted when exceeded.
- **Unique ID per segment:** Each segment receives a native-generated UUID (`seg_uuid`).
- **Monotonic index:** `totalSegmentsWritten` only increases; used for index-based reads even after eviction.

### 2.2 Segment Kinds and Payload Contracts

Each segment has a `kind` discriminator that determines its payload schema:

#### `kind: 'speech'`

Payload is discriminated by `source`:

| Source | Allowed Keys | Use Case |
|---|---|---|
| `'vad'` | `source`, `engine`, `decision`, `score` | VAD segment detection |
| `'stt'` | `source`, `transcript`, `tokenCount`, `isFinal` | STT endpoint segment |
| `'tts'` | `source`, `text`, `chunkIndex`, `isFinalChunk` | TTS audio chunk |

#### `kind: 'alignment'`

| Key | Required | Type | Purpose |
|---|---|---|---|
| `text` | ✅ | string | Aligned text content |
| `timingMode` | ✅ | `'proportional'` \| `'estimated'` \| `'accurate'` \| `'vad'` | How timing was determined |
| `granularity` | ✅ | `'sentence'` \| `'word'` \| `'character'` | Alignment level |
| `confidence` | ❌ | number | Optional confidence score |
| `tokenMetadata` | ❌ | object | Optional token-level details |
| `wordMetadata` | ❌ | object | Optional word-level details |
| `languageHints` | ❌ | string[] | Optional language hints |

**Runtime validation:** All payloads are strictly validated at append time. Invalid payloads (wrong keys, missing required fields, wrong types) are rejected with `SEGMENT_INVALID_ARGUMENT`.

### 2.3 Source Audio Reference

Each segment carries a `sourceAudioBufferId` — the ID of the `PipelineAudioBuffer` (live or offline) that the segment's sample range references.

```
LiveSegmentBuffer                    LiveAudioBuffer
┌──────────────┐                    ┌──────────────┐
│ Segment 0    │                    │              │
│  start: 0    │───── references ──►│  PCM samples │
│  end: 16000  │                    │  [0..16000]  │
│              │                    │              │
│ Segment 1    │                    │              │
│  start: 16000│───── references ──►│  PCM samples │
│  end: 32000  │                    │  [16000..    │
│              │                    │   32000]     │
└──────────────┘                    └──────────────┘
```

### 2.4 Spool (On-Disk Persistence)

The spool provides **full-history retention** beyond the in-memory window using a journal + checkpoint model.

**Spool format:** See `docs/internal/segmentbuffer-spool-v2-format.md` for binary details.

**File layout:**
```
<baseSpoolPath>.segj    — Append-only journal file
<baseSpoolPath>.segc    — Periodic compact checkpoint
```

**Record types:**
| Record Type | Value | Purpose |
|---|---|---|
| `SEGMENT_APPEND` | 1 | One segment serialized as JSON in `{"segments":[...]}` envelope |
| `CHECKPOINT_MARK` | 2 | Marks a checkpoint boundary (payload: `{}`) |
| `FINALIZE_MARK` | 3 | Marks buffer finalization (payload: `{}`) |

**Record header (16 bytes, little-endian):**
- `magic` (u32): `0x32474553` (`SEG2`)
- `version` (u16): `2`
- `recordType` (u16)
- `payloadLength` (u32)
- `checksum` (u32)

**Payload format:** UTF-8 JSON strings.

**Spooling modes:**

| Mode | Behavior |
|---|---|
| `'on'` (default) | Spool from the beginning. Every segment append is journaled. |
| `'auto'` | Activate spool once `thresholdBytes` is exceeded. |
| `'off'` | No spool file. Only in-memory segment log. |

> **Note:** `LiveSegmentBuffer` defaults to `'on'`, matching `LiveTextBuffer`. This provides full-history reconstruction via `fullIfSpooled` by default. Use `'off'` when you explicitly want in-memory-only behavior and can accept that evicted segments are not recoverable.

**Checkpoint policy:**
- Every **128** journal append records, or **1 MiB** journal growth.
- Checkpoint writes the full current segment state atomically (temp file + rename).
- Journal is rotated/truncated after checkpoint.

---

## 3. State Machine

```
┌──────────────┐       finalize()       ┌──────────────┐
│  recording   │ ─────────────────────► │   finished   │
│              │                         │              │
│ Append OK    │                         │ Append FAILS │
│ Event emit OK│                         │ Read OK      │
│ Spool write  │                         │              │
└──────────────┘                         └──────────────┘
         ▲                                      │
         │           release()                   │
         │        ┌──────────────┐              │
         └────────│   released   │◄─────────────┘
                  │              │
                  │ Spool closed │
                  │ Temp deleted │
                  └──────────────┘
```

---

## 4. Data Flow: VAD → LiveSegmentBuffer

```
VAD Pipeline Worker
    │
    ├── speech segment detected ──► appendLiveSegment({
    │                                  kind: 'speech',
    │                                  sourceAudioBufferId: liveAudio,
    │                                  startSample: X, endSample: Y,
    │                                  sampleRate: 16000,
    │                                  payload: { source: 'vad', score: 0.93 }
    │                                })
    │                                → segment added to log
    │                                → spool journal record written (if enabled)
    │                                → pipelineLiveSegmentAppended event emitted
    │
    └── (repeat for each speech segment)
```

---

## 5. Random Access

### Segment Log (In-Memory)
- **Index-based:** `getLiveSegmentBufferSegments(buffer, startIndex, maxCount)` returns segments by monotonic index.
- **Count query:** `getLiveSegmentBufferSegmentCount(buffer)`.
- **Limitation:** Evicted segments (beyond `maxSegments`) are not accessible unless spool is active.

### Spool (Full History)
- **No direct random-access API** to the spool.
- **Indirect access:** `createOfflineSegmentBufferFromLive(buffer, 'fullIfSpooled')` replays the spool and returns an immutable `OfflineSegmentBuffer`.
- **Replay process:**
  1. Load checkpoint (`.segc`) if available.
  2. Replay journal (`.segj`) records in order.
  3. Reconstruct full segment history.

---

## 6. Memory & Performance Architecture

### Steady-State Memory
```
Segment log:      maxSegments × (avg segment struct size)
                  Example: 2048 segments × ~200 bytes = ~400 KB

Spool I/O:        Small write buffer

Total per buffer: Typically < 1 MB in RAM + spool on disk
```

Segments are metadata-only (no PCM data). Memory footprint is minimal compared to audio and text buffers.

### Event Throttling
`streamEvents.segmentAppended.minIntervalMs` controls JS notification frequency:
- `0`: every segment append triggers an event.
- Higher values: coalesce rapid appends.

Events carry **full segment metadata** (fat events) — the JS callback receives the complete segment without needing a follow-up read.

---

## 7. Conversion Paths

### Live → Offline (`createOfflineSegmentBufferFromLive`)

| Mode | Behavior |
|---|---|
| `'fullIfSpooled'` | Replays spool journal + checkpoint → reconstructs full segment list → immutable `OfflineSegmentBuffer`. Strict: rejects if spool unavailable. |
| `'windowSnapshot'` | Snapshots the current in-memory segment log → `OfflineSegmentBuffer`. |

### Reading Offline Segments

`getOfflineSegmentBufferSegments(buffer, start, maxCount)` returns `SegmentMeta[]` with the same structure as live segments.

---

## 8. Thread Safety

- **Segment appends** are protected by a per-buffer lock.
- **Spool writes** happen inside the same lock.
- **Event emission** happens outside the lock.
- **Reads** (segment queries, count queries) acquire the lock briefly.

---

## 9. Key Design Decisions

| Decision | Rationale |
|---|---|
| Metadata-only (no PCM storage) | Segments are indices into audio buffers. Duplicating PCM would be wasteful. |
| Spool on by default (`mode: 'on'`) | Keeps full-history reconstruction available (`fullIfSpooled`) without extra setup. Use `'off'` only for explicit in-memory-only operation. |
| Strict payload validation at append | Early error detection prevents corrupt segments from reaching downstream consumers. |
| Fat events (full metadata in callbacks) | Avoids a follow-up read for each segment. The segment payload is small enough to serialize. |
| sourceAudioBufferId per segment | Different segments can reference different audio buffers (e.g., after enhancement, the output buffer differs from the input). |
| Two segment kinds (speech + alignment) | Clean separation between temporal boundaries (speech) and text-aligned boundaries (alignment). Different consumers need different metadata. |

---

## 10. Implications for Fake-Live Engines

A Fake-Live engine using a `LiveSegmentBuffer` would:

1. Run VAD/segmentation on the full audio (from a `LiveAudioBuffer`).
2. Append each detected segment to the `LiveSegmentBuffer` with appropriate payload.
3. Downstream consumers (STT orchestrator) read segments from the buffer and extract the corresponding audio slice for offline processing.

**Key insight:** The `LiveSegmentBuffer` is the **coordination point** between the segmentation step and the per-segment processing step. It decouples "where are the segments?" from "what do we do with each segment?" This makes it equally useful for real-time VAD and for offline segmentation followed by per-segment offline model invocation.
