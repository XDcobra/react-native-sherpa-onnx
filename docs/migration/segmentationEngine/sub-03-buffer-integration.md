# Sub-Plan 03: Buffer Integration & Events

## Status
- Implemented (contract baseline)
- Depends on: Sub-Plan 01, 02
- Implementation note: `setPartial()` / `appendPartial()` are currently delivered via async TurboModule calls; optional sync-JSI fast-path is deferred to Sub-Plan 06 (Cleanup & Contract Parity).

## Purpose

Define how buffers store segments, expose segment read APIs, emit `onSegment` events, and handle manual/automatic commit mechanics.

---

## Scope

1. **Symmetric 2-Level Write Model** — data-level + segment-level public APIs for both domains
2. `onSegment` event design for LiveTextBuffer and LiveAudioBuffer
3. Segment log embedding vs. separate SegmentBuffer decision
4. Pull APIs for segment reads
5. Commit mechanics (manual + auto)
6. Event payload content (open question resolution guidance)

---

## Event Design

### LiveTextBuffer Events (updated)

| Event | Existing | New/Changed |
|---|---|---|
| `onPartial` | ✅ Keep | No change |
| `onSegment` | ❌ New | Added |
| `onError` | ❌ New | Added |

### LiveAudioBuffer Events (updated)

| Event | Existing | New/Changed |
|---|---|---|
| `onFramesAppended` | ✅ Keep | No change |
| `onSegment` | ❌ New | Added |
| `onError` | ❌ New | Added |

### `onSegment` Event Contract

```typescript
interface SegmentEvent {
  /** Buffer that emitted the event */
  bufferId: string;
  
  /** The committed segment (full metadata) */
  segment: Segment;
  
  /** Total segments committed so far */
  totalSegments: number;
}
```

**Key rules:**
- `onSegment` is a **hint**. Consumers must be able to reconstruct state via pull APIs alone.
- Event drop/coalescing must not break the pipeline.
- Consumer uses `getSegments(buffer, startIndex, count)` as source of truth.

### Event Payload Decision (✅ Resolved)

| Domain | Payload Content | Rationale |
|---|---|---|
| **Text** | Full segment metadata **including `text` field** (bounded by `maxEventTextChars`, default 4096; truncate + `textTruncated=true` if exceeded) | Text payloads are usually small. Including text avoids follow-up reads for common UI scenarios while keeping event size bounded. |
| **Speech** | Segment metadata **without PCM data** | Audio data is large. Payload includes only IDs, offsets, duration, confidence. Consumer reads audio via buffer slice APIs. |

**Coalescing behavior (final):**
- Segment events are **delivered individually** (no coalescing in v1).
- Rationale: each segment boundary is semantically meaningful; coalescing risks boundary loss.
- `minIntervalMs` throttling is not applied to `onSegment` in v1. If batching is needed later, add a separate explicit batch mode.

**Source of truth:**
- `onSegment` is advisory/hint-only.
- Pull APIs (`getSegments`, `getSegmentCount`) are authoritative.

---

## Segment Storage

### Design Principle

> **"Unified external segment access, implementation-defined internal storage."**

For SDK users, segment access is always the same API regardless of domain. Internally, each domain may store segments differently for technical reasons — but this is hidden behind a unified accessor.

### Public API: `getSegmentBuffer()`

```typescript
/**
 * Get the segment buffer associated with any buffer.
 * Returns a SegmentBufferRef that provides a unified view
 * of the buffer's segments, regardless of internal storage.
 *
 * For LiveTextBuffer: returns a view/proxy over the embedded segment log.
 * For LiveAudioBuffer: returns the associated LiveSegmentBuffer.
 * For OfflineBuffers: returns the associated OfflineSegmentBuffer.
 */
function getSegmentBuffer(
  buffer: LiveTextBufferRef | LiveAudioBufferRef | OfflineTextBufferRef | OfflineAudioBufferRef
): SegmentBufferRef;

interface SegmentBufferRef {
  segmentBufferId: string;
  /** Domain of the segments in this buffer */
  domain: 'text' | 'speech';
  /** ID of the parent buffer this was obtained from */
  parentBufferId: string;
}
```

### Unified Read API

All segment read functions accept either the parent buffer or a `SegmentBufferRef`:

```typescript
/** Read segments from any buffer or segment buffer */
function getSegments(
  buffer: LiveTextBufferRef | LiveAudioBufferRef | SegmentBufferRef | OfflineSegmentBufferRef,
  startIndex?: number,
  maxCount?: number
): Segment[];

/** Get segment count */
function getSegmentCount(
  buffer: LiveTextBufferRef | LiveAudioBufferRef | SegmentBufferRef | OfflineSegmentBufferRef
): number;
```

**Usage equivalence:**
```typescript
// Both are equivalent for any buffer type:
getSegments(myBuffer, 0, 10);
getSegments(getSegmentBuffer(myBuffer), 0, 10);
```

### Internal Storage Model (implementation-defined)

| Domain | Internal Model | `getSegmentBuffer()` returns |
|---|---|---|
| **Text (Live)** | Embedded segment log in LiveTextBuffer | Lightweight proxy/view over embedded log |
| **Audio (Live)** | Associated separate LiveSegmentBuffer | The actual associated LiveSegmentBuffer |
| **Text (Offline)** | Associated OfflineSegmentBuffer | The OfflineSegmentBuffer |
| **Audio (Offline)** | Associated OfflineSegmentBuffer | The OfflineSegmentBuffer |

```
LiveTextBuffer                     LiveAudioBuffer
├── partialText (mutable)            ├── ringBuffer (PCM)
├── segmentLog[] (embedded)          ├── spool (WAV)
├── spool (journal + checkpoint)     ├── cursors
└── engine? (if auto)                ├── engine? (if auto)
     │                                └── associatedSegBuf (separate)
     │                                     │
     ▼                                     ▼
 getSegmentBuffer() returns         getSegmentBuffer() returns
 proxy over embedded log            the associated LiveSegmentBuffer
```

### Why This Approach

**Text stays embedded** because:
- Text segments are created by committing the partial → natural extension of the existing commit model.
- No benefit to a separate buffer — text segments always belong to exactly one LiveTextBuffer.

**Audio stays separate** because:
- Audio segments can reference multiple audio buffers (e.g., raw vs. enhanced).
- Keeps audio buffer focused on PCM storage; segmentation metadata in a dedicated structure.
- The `LiveSegmentBuffer` already exists and works well.

**`getSegmentBuffer()` unifies them** because:
- SDK users get one mental model: "call `getSegmentBuffer()` on any buffer, get segments."
- No domain-specific knowledge needed for segment access.
- Internal implementation can evolve without breaking the public API.

---

## Symmetric Data-Level Write APIs

The Segmentation Engine spec defines a **symmetric 2-level write model** for both domains. This section specifies the concrete public write APIs that Sub-Plan 03 introduces.

### Level 1 — Data Write APIs

#### Text Domain: `setPartial()` / `appendPartial()`

Today, `LiveTextBuffer` partials are written only by native pipeline workers (e.g., STT). JS can only *read* the partial (via events/slices). To achieve symmetry with audio's `appendFrames()`, we introduce:

```typescript
/**
 * Replace the current partial text (full overwrite).
 * Triggers onPartial event.
 * Equivalent to the native TEXT_PARTIAL_SET operation.
 */
function setPartial(buffer: LiveTextBufferRef, text: string): void;

/**
 * Append to the current partial text.
 * Triggers onPartial event.
 * Equivalent to the native TEXT_PARTIAL_APPEND operation.
 */
function appendPartial(buffer: LiveTextBufferRef, text: string): void;
```

**Internal mapping:**

| Public API | Native Operation | Spool Record |
|---|---|---|
| `setPartial(buf, text)` | `TEXT_PARTIAL_SET` | `TEXT_PARTIAL_SET` |
| `appendPartial(buf, text)` | `TEXT_PARTIAL_APPEND` | `TEXT_PARTIAL_APPEND` |

**Key behaviors:**
- Current implementation path is Promise-based TurboModule (functionally equivalent API surface).
- Optional sync-JSI fast path is a dedicated follow-up in Sub-Plan 06.
- Both increment the buffer's `revision` counter.
- Both trigger `onPartial` event emission (subject to `minIntervalMs` throttling).
- Both are rejected with `BUFFER_NOT_RECORDING` if the buffer is finalized.
- `windowMaxChars` limit applies: if the partial exceeds the window, it is truncated (same as native behavior).

**Who uses these:**
- JS-side producers (user typing, external text source, test harness).
- Native pipeline workers (STT) continue using the internal native write path — no change for them.

#### Audio Domain: `appendFrames()` (existing)

Already public via `appendSamplesToLiveAudioBuffer()`. No change needed.

```typescript
// Existing — included for symmetry documentation
function appendFrames(buffer: LiveAudioBufferRef, samples: Float32Array): void;
```

### Level 2 — Segment Commit API

Unified `commitSegment()` for both domains (see Commit Mechanics below).

### API Symmetry Summary

| Operation | Text | Audio |
|---|---|---|
| **Data write** | `setPartial()` / `appendPartial()` | `appendFrames()` |
| **Data read** | `getPartialSlice()` | `getSamplesSlice()` |
| **Data event** | `onPartial` | `onFramesAppended` |
| **Segment commit** | `commitSegment(textBuf)` | `commitSegment(audioBuf)` |
| **Segment buffer** | `getSegmentBuffer(textBuf)` | `getSegmentBuffer(audioBuf)` |
| **Segment read** | `getSegments(buf \| segBuf)` | `getSegments(buf \| segBuf)` |
| **Segment event** | `onSegment` | `onSegment` |
| **Segment count** | `getSegmentCount(buf \| segBuf)` | `getSegmentCount(buf \| segBuf)` |
| **Error event** | `onError` | `onError` |

---

## Commit Mechanics

### Manual Commit (Text)

```typescript
// User explicitly commits current partial as a segment
commitSegment(textBuffer, { reason: 'manual_commit' });
```

**Internal flow:**
1. Read current `partialText`
2. Create `TextSegment` with text content, offsets, reason
3. Append to segment log
4. Clear partial
5. Spool journal: write `TEXT_SEGMENT_COMMIT` record
6. Emit `onSegment` event

### Manual Commit (Audio)

```typescript
// User explicitly commits current frames as a segment  
commitSegment(audioBuffer, { reason: 'manual_commit' });
```

**Internal flow:**
1. Record current write position as segment end
2. Create `SpeechSegment` with sample offsets, duration
3. Append to associated LiveSegmentBuffer
4. Emit `onSegment` event
5. Update segment start position for next segment

### Auto Commit (via Engine)

When the SegmentationEngine calls `evaluate()` and decides to commit:

1. Engine calls `buffer.internalCommitSegment(segment)` (native-only API)
2. Buffer stores the segment (embedded or in associated SegmentBuffer)
3. Buffer emits `onSegment` event
4. Engine advances its internal tracking state

### Finalize Behavior

On `buffer.finalize()`:
1. If engine attached: call `engine.flush()` → may produce final segment with `reason: 'finalize'`
2. If partial text exists (text buffer): auto-commit as final segment
3. If uncommitted frames exist (audio buffer): auto-commit as final segment
4. Emit final `onSegment` event(s)
5. Engine transitions to DETACHED

---

## Spool Integration

### Text Buffer Spool

The existing spool format already journals segment commits (`TEXT_SEGMENT_COMMIT`). The new Segment type's fields are serialized as the payload. **No format version change needed** — the payload is JSON, so adding new fields is backward-compatible.

New fields in spool payload:
- `segmentId`, `domain`, `reason`, `source`, `createdAtMs`
- These augment the existing `segmentIndex`, `text`, `source`, `tokens`, `meta`

### Audio Segment Buffer Spool

The associated `LiveSegmentBuffer` uses its own spool (`.segj` + `.segc`). The new Segment type replaces `SegmentMeta` in the spool payload.

### Offline Buffers

No spool needed. Segments are computed once and stored in-memory.

---

## Buffer Creation API Changes

### LiveTextBuffer

```typescript
createLiveTextBuffer({
  // ... existing options ...
  
  /** Segmentation configuration */
  segmentation?: SegmentationConfig;
  // If omitted: mode='manual' (existing behavior, explicit commits only)
  // If mode='auto': engine is created and attached internally
  // If mode='off': no segments, partial-only mode
});
```

**New public write APIs available after creation:**
- `setPartial(buffer, text)` — replace partial
- `appendPartial(buffer, text)` — append to partial
- `commitSegment(buffer)` — manual segment commit (when mode ≠ 'off')

### LiveAudioBuffer

```typescript
createLiveAudioBuffer({
  // ... existing options ...
  
  /** Segmentation configuration */
  segmentation?: SegmentationConfig;
  // If omitted: no segmentation (frames-only mode)
  // If mode='auto': engine + associated LiveSegmentBuffer created
  // If mode='manual': associated LiveSegmentBuffer created, manual commits
});
```

**Public write APIs (unchanged + new):**
- `appendFrames(buffer, samples)` — append PCM frames (existing)
- `commitSegment(buffer)` — manual segment commit (new, when mode ≠ 'off')

---

## Error Codes

| Code | When |
|---|---|
| `SEGMENT_COMMIT_FAILED` | Commit rejected (buffer finalized, etc.) |
| `SEGMENT_NOT_AVAILABLE` | No segmentation active on this buffer |
| `SEGMENT_INDEX_OUT_OF_RANGE` | Requested segment index beyond count |

---

## Implementation Steps

1. **Implement `setPartial()` and `appendPartial()` public APIs** for LiveTextBuffer.
2. **Implement `commitSegment()` public API** for both LiveTextBuffer and LiveAudioBuffer (manual mode).
3. Add `segmentation` option to `createLiveTextBuffer` and `createLiveAudioBuffer`.
4. Add `TextSegment` storage to LiveTextBuffer's segment log (replace old segment model).
5. Add `associatedSegmentBuffer` auto-creation on LiveAudioBuffer when segmentation active.
6. Implement `internalCommitSegment()` native API for engine auto-commit.
7. Implement `onSegment` event emission on both buffer types.
8. Implement unified `getSegments()` and `getSegmentCount()` APIs.
9. Update spool serialization for new Segment fields.
10. Update `createOfflineTextBufferFromLive('fullIfSpooled')` to reconstruct new segment type.
11. Write tests: `setPartial`/`appendPartial`, manual commit (both domains), auto commit, finalize flush, spool replay.
12. **Validate symmetry**: ensure every Level-1 and Level-2 operation is available on both buffer types.
13. *(Cleanup / optional)* Add sync-JSI host API fast path for `setPartial`/`appendPartial` while preserving TurboModule parity (Sub-Plan 06).
