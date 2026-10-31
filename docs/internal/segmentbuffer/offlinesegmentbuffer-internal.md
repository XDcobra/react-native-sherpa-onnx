# OfflineSegmentBuffer — Internal Architecture

**Scope:** Internal implementation details of `offlineSegmentBuffer` (the offline/immutable segment buffer).  
**Audience:** SDK developers planning batch processing, export, and deterministic replay flows.  
**Native entry types:** `OfflineSegmentEntry` (Android/Kotlin), `PaOfflineSegmentEntry` (iOS/C++).

---

## 1. Overview

An `OfflineSegmentBuffer` is an **immutable, fully populated list of audio segment metadata**. It represents a complete set of temporal segment boundaries — typically a snapshot from a finalized live segment buffer or a pre-populated set for batch processing.

Key characteristics:
- **Immutable after creation:** No append, no mutation.
- **Metadata-only:** Contains segment boundaries (start/end samples) and typed payloads, not actual PCM audio.
- **References audio buffers:** Each segment carries a `sourceAudioBufferId` pointing to the `PipelineAudioBuffer` containing the actual audio.

---

## 2. Core Data Structure

```
┌─────────────────────────────────────────────────────────────┐
│              OfflineSegmentEntry                             │
│                                                              │
│  bufferId: string (seg_off_<uuid>)                           │
│  kind: 'offlineSegmentBuffer'                                │
│  state: 'immutable'                                          │
│  sourceAudioBufferId?: string (optional default reference)   │
│                                                              │
│  segments: [                                                 │
│    SegmentMeta {                                             │
│      id: string (unique segment UUID)                        │
│      kind: 'speech' | 'alignment'                            │
│      sourceAudioBufferId: string                             │
│      startSample: number                                     │
│      endSample: number                                       │
│      sampleRate: number                                      │
│      durationMs: number                                      │
│      confidence?: number                                     │
│      payload?: SpeechSegmentPayload | AlignmentSegmentPayload│
│    },                                                        │
│    ...                                                       │
│  ]                                                           │
│                                                              │
│  segmentCount: number                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Storage: Always In-Memory

Like `OfflineTextBuffer`, segment buffers are **always in-memory**:

- Segment metadata is small. Even thousands of segments typically fit in < 1 MB.
- No file-backed/mmap variant exists for offline segment buffers.
- All segment data is held in native heap memory (a list/vector of segment structs).

---

## 4. Creation Paths

### 4.1 `createEmptyOfflineSegmentBuffer(options?)`

Creates an empty offline segment buffer:
- Can optionally specify a `sourceAudioBufferId` as a default reference.
- Segments can be appended by native producers (not exposed to JS for offline buffers — native-only write path).
- Used as output target for batch operations that produce segmentation results.

### 4.2 `createOfflineSegmentBufferFromLive(liveBuffer, mode)`

Creates an immutable snapshot from a live segment buffer:

| Mode | Behavior |
|---|---|
| `'fullIfSpooled'` | Replays the live buffer's spool (`.segc` checkpoint + `.segj` journal) → reconstructs full segment history → populates offline buffer. Strict: rejects with `SEGMENT_SPOOL_UNAVAILABLE` if spool is disabled. |
| `'windowSnapshot'` | Snapshots the current in-memory segment log of the live buffer → populates offline buffer. Only captures segments currently in the live window. |

**Replay process for `fullIfSpooled`:**
1. Load checkpoint file (`.segc`) if present → parse JSON `{"segments":[...]}` → initialize segment list.
2. Replay journal (`.segj`) records in order:
   - Each `SEGMENT_APPEND` record adds one segment.
   - `CHECKPOINT_MARK` and `FINALIZE_MARK` are ignored during replay.
3. Return the reconstructed full segment list as an immutable offline buffer.

---

## 5. Segment Kinds and Payload Contracts

Identical to `LiveSegmentBuffer` (same types, same validation):

### `kind: 'speech'`

Discriminated by `payload.source`:

| Source | Keys | Use Case |
|---|---|---|
| `'vad'` | `source`, `engine`, `decision`, `score` | VAD boundaries |
| `'stt'` | `source`, `transcript`, `tokenCount`, `isFinal` | STT endpoints |
| `'tts'` | `source`, `text`, `chunkIndex`, `isFinalChunk` | TTS chunks |

### `kind: 'alignment'`

| Key | Required | Type |
|---|---|---|
| `text` | ✅ | string |
| `timingMode` | ✅ | `'proportional'` \| `'estimated'` \| `'accurate'` \| `'vad'` |
| `granularity` | ✅ | `'sentence'` \| `'word'` \| `'character'` |
| `confidence` | ❌ | number |
| `tokenMetadata` | ❌ | object |
| `wordMetadata` | ❌ | object |
| `languageHints` | ❌ | string[] |

---

## 6. Data Access

### Reading Segments

```ts
getOfflineSegmentBufferSegments(buffer, start?, maxCount?): Promise<SegmentMeta[]>
```

- **start** (default: 0): Starting index in the segment list.
- **maxCount** (default: 1024): Maximum number of segments to return.
- Returns `SegmentMeta[]` with full metadata including kind-discriminated payloads.

### Info Query

```ts
getPipelineSegmentBufferInfo(buffer): Promise<PipelineSegmentBufferInfo>
```

Returns:
```ts
{
  bufferId: string,
  kind: 'offlineSegmentBuffer',
  state: 'immutable',
  segmentCount: number,
  sourceAudioBufferId?: string
}
```

---

## 7. Memory & Performance Architecture

### Memory Footprint

| Component | Typical Size | Notes |
|---|---|---|
| Segment structs | < 200 bytes each | IDs, sample ranges, payload |
| 1000 segments | ~200 KB | Typical long VAD session |
| 10000 segments | ~2 MB | Very long session |
| **Total** | **< 2 MB typical** | Well within mobile memory budget |

### Batch Access Pattern

Offline segment buffers are designed for batch access:
- Read all segments at once with `getOfflineSegmentBufferSegments(buf, 0, segmentCount)`.
- Or paginate for very large sets.
- Each read is a single bridge call returning a JSON-serialized segment array.

---

## 8. Relationship to Audio Buffers

```
OfflineSegmentBuffer                 PipelineAudioBuffer(s)
┌──────────────────┐                ┌──────────────────┐
│ Segment 0        │                │ LiveAudioBuffer   │
│   audioRef: A    │── references ─►│   (id: A)         │
│   start/end      │                │                    │
│                  │                └──────────────────┘
│ Segment 1        │                ┌──────────────────┐
│   audioRef: B    │── references ─►│ OfflineAudioBuffer│
│   start/end      │                │   (id: B)         │
│                  │                │                    │
│ Segment 2        │                └──────────────────┘
│   audioRef: A    │── references ─►  (same buffer A)
└──────────────────┘
```

**Important:** The offline segment buffer does **not** hold the audio data. The referenced audio buffers must still exist for any consumer that wants to extract the actual audio for each segment. If the audio buffer has been released, the segment metadata is still valid but the audio is no longer accessible.

---

## 9. Thread Safety

- **Immutable after creation:** No concurrent write concerns.
- **Registry access** protected by lock.
- **Reads** are thread-safe.

---

## 10. Key Design Decisions

| Decision | Rationale |
|---|---|
| Always in-memory | Segment metadata is small. No need for file backing. |
| Immutable snapshot | Batch consumers need deterministic, stable data. No mutation after creation. |
| Same payload types as LiveSegmentBuffer | Consistency. Live→Offline conversion is a simple copy. Consumers don't need to handle different types. |
| sourceAudioBufferId per segment (not per buffer) | Segments from different pipeline stages may reference different audio buffers (e.g., raw vs. enhanced). |
| No append API for offline | Offline buffers are populated at creation. They serve as output containers, not incremental collectors. |

---

## 11. Implications for Fake-Live / Pipeline Flows

### As VAD Output
```
LiveAudioBuffer → VAD → LiveSegmentBuffer → finalize → createOfflineFromLive('fullIfSpooled')
    → OfflineSegmentBuffer (complete segment list for the session)
```

### As Input to Per-Segment Processing
```
OfflineSegmentBuffer.segments.forEach(segment => {
    // Extract audio slice from referenced audio buffer
    const audio = getSlice(segment.sourceAudioBufferId, segment.startSample, segment.endSample - segment.startSample);
    // Process with offline engine
    const result = offlineSTT.transcribe(audio);
    // Collect results
});
```

### In a Fake-Live Engine
1. Pre-segment the audio (VAD or fixed-window) into an `OfflineSegmentBuffer`.
2. Iterate over segments, extract audio slices, process with offline models.
3. Write results to a `LiveTextBuffer` for unified streaming-like output.

**Key insight:** The `OfflineSegmentBuffer` provides a **deterministic, replayable** segment list. This is critical for Fake-Live: the segmentation decision is made once (deterministically), and then each segment is processed independently. Unlike a `LiveSegmentBuffer`, there's no concern about new segments arriving during processing.
