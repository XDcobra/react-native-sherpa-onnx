# LiveTextBuffer — Internal Architecture

**Scope:** Internal implementation details of `liveTextBuffer` (the streaming/live text buffer).  
**Audience:** SDK developers planning engine integrations, text pipeline flows, and partial/segment-based UI.  
**Native entry types:** `LiveTextEntry` (Android/Kotlin), `PaLiveTextEntry` (iOS/C++).

---

## 1. Overview

A `LiveTextBuffer` is a **streaming, mutable text buffer** with a `recording → finished` lifecycle. It stores two kinds of text data simultaneously:

1. **Partial text** — the current, unstable hypothesis (e.g., what a streaming STT model is currently predicting).
2. **Committed segments** — finalized text segments that will not change (e.g., after an STT endpoint detection).

This dual-track design allows UI to display a rolling transcription where committed segments are stable and the partial text updates rapidly.

---

## 2. Core Data Structures

### 2.1 Partial Window (In-Memory)

The partial text is a **mutable string** that represents the current unstable hypothesis.

```
┌─────────────────────────────────────────────┐
│              Partial Window                  │
│                                              │
│  partialText: string                         │
│  revision: number (monotonic)                │
│  totalCharsWritten: number                   │
│                                              │
│  Operations:                                 │
│    SET: replace entire partial               │
│    APPEND: append to current partial         │
│    COMMIT → segment log: partial → segment   │
│    CLEAR: reset partial (after commit)       │
└─────────────────────────────────────────────┘
```

**Key properties:**
- **Mutable:** The partial text can be completely replaced (e.g., when the STT model re-decodes with more context) or appended to.
- **Revision counter:** Each write increments `revision` — a monotonic counter that native event coalescing uses to skip stale events.
- **Window size limit:** `windowMaxChars` caps the in-memory partial text (default: native/SDK-determined). This prevents unbounded memory growth from very long partial hypotheses.
- **UTF-16 units:** All character counts and slice positions use UTF-16 code unit indices (matches JavaScript string semantics).

### 2.2 Segment Log (In-Memory)

The segment log is an **ordered list** of committed text segments.

```
┌─────────────────────────────────────────────┐
│              Segment Log                     │
│                                              │
│  segments: [                                 │
│    { segmentIndex: 0, text: "Hello world",   │
│      source: "stt_stream",                   │
│      tokens?: [...], timestamps?: [...],     │
│      meta?: { sid?: 1, speed?: 1.0 } },      │
│    { segmentIndex: 1, text: "How are you",   │
│      ... },                                  │
│    ...                                       │
│  ]                                           │
│                                              │
│  maxSegments: number (default: 1000)         │
│  segmentCount: number                        │
│  eviction: FIFO when count > maxSegments     │
└─────────────────────────────────────────────┘
```

**Key properties:**
- **Append-only:** Segments are appended at the end. No in-place mutation.
- **Bounded:** `maxSegments` limits how many segments are kept in memory (default: 1000). When exceeded, oldest segments are evicted from the in-memory log.
- **Rich metadata per segment:**
  - `text`: the committed text string.
  - `source`: discriminator (`'stt_stream'`, `'append'`, `'replace'`, `'mixed'`, `'unknown'`).
  - `tokens`: optional token-level breakdown.
  - `timestamps`: optional per-token timestamps.
  - `meta`: opaque metadata dictionary (pipeline workers interpret feature-specific keys, e.g., TTS `sid`, `speed`).
- **Segment index:** Monotonically increasing, never reset. Even after eviction from the in-memory window, the index continues.

### 2.3 Spool (On-Disk Persistence)

The spool provides **full-history retention** beyond the in-memory window using a journal + checkpoint model.

**Spool format:** See `docs/internal/textbuffer-spool-v2-format.md` for binary details.

**File layout:**
```
<baseSpoolPath>.txtj    — Append-only journal file
<baseSpoolPath>.txtc    — Periodic compact checkpoint
```

**Record types in the journal:**
| Record Type | Purpose |
|---|---|
| `TEXT_PARTIAL_SET` | Full partial text replacement |
| `TEXT_PARTIAL_APPEND` | Append to partial text |
| `TEXT_SEGMENT_COMMIT` | New committed segment |
| `CHECKPOINT_MARK` | Marks a checkpoint boundary |
| `FINALIZE_MARK` | Marks buffer finalization |

**Record header (16 bytes, little-endian):**
- `magic` (u32): `TXT2`
- `version` (u16): `2`
- `recordType` (u16)
- `payloadLength` (u32)
- `checksum` (u32)

**Spooling modes:**

| Mode | Behavior |
|---|---|
| `'on'` (default) | Spool from the beginning. Every partial update and segment commit is journaled. |
| `'auto'` | Activate spool once a threshold is exceeded (e.g., `thresholdBytes`). |
| `'off'` | No spool file. Only in-memory window/segment log. `fullIfSpooled` will fail. |

**Checkpoint policy:**
- Checkpoint written every **128 events** or **1 MiB** journal growth, whichever comes first.
- After checkpoint, the journal is rotated/truncated and a `CHECKPOINT_MARK` is emitted.
- Checkpoint contains the full current state (all retained segments + current partial).

**Cleanup:**
- Temporary spool files (auto-generated paths) are deleted on `release()`.
- Explicit spool paths (`spooling.path`) are retained by default unless `temporary: true`.

---

## 3. State Machine

```
┌──────────────┐       finalize()       ┌──────────────┐
│  recording   │ ─────────────────────► │   finished   │
│              │                         │              │
│ Partial SET  │                         │ Partial READ │
│ Partial APPEND│                        │ Segment READ │
│ Segment COMMIT│                        │ No writes    │
│ Event emission │                       │              │
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

## 4. Data Flow: Streaming STT → LiveTextBuffer

The most common producer is a streaming STT pipeline worker:

```
Online Recognizer
    │
    ├── partial hypothesis changes ──► TEXT_PARTIAL_SET on LiveTextBuffer
    │                                   → partialText replaced
    │                                   → revision incremented
    │                                   → pipelineLiveTextPartial event emitted
    │
    ├── endpoint detected ──► TEXT_SEGMENT_COMMIT on LiveTextBuffer
    │                          → current partial → new segment in log
    │                          → partial cleared
    │                          → pipelineLiveTextPartial event with isEndpoint=true
    │
    └── (repeat until drain complete)
```

**Source tags for segments:**
| Source | Who wrote |
|---|---|
| `'stt_stream'` | Streaming STT endpoint commit |
| `'append'` | JS `appendLiveTextSegment()` |
| `'replace'` | Programmatic replacement |
| `'mixed'` | Multiple sources in one event |
| `'unknown'` | Source not identified |

---

## 5. Random Access

### Partial Text
- **Sliced reads:** `getLiveTextBufferPartialSlice(buffer, startUtf16, maxUtf16)` returns a substring of the current partial.
- **Full read:** Slice with `startUtf16=0, maxUtf16=windowMaxChars`.

### Segment Log (In-Memory)
- **Index-based:** `getLiveTextBufferSegments(buffer, startIndex, maxCount)` returns segments by their monotonic index.
- **Count query:** `getLiveTextBufferSegmentCount(buffer)` returns the number of currently retained segments.
- **Limitation:** If segments have been evicted from the in-memory window (exceeded `maxSegments`), they are no longer accessible through these APIs unless spool is active.

### Spool (Full History)
- **No direct random-access API** to the spool journal.
- **Indirect access:** `createOfflineTextBufferFromLive(buffer, 'fullIfSpooled')` replays the entire spool (checkpoint + journal) to reconstruct the full text, then returns an immutable `OfflineTextBuffer`.
- The replay process:
  1. Load checkpoint (`.txtc`) if present — extract JSON `fullText` (Android) or raw snapshot string (iOS checkpoint file).
  2. Replay journal (`.txtj`) records in order.
  3. Reconstruct full text. **`PARTIAL_SET` must not shrink** output below the checkpoint baseline (Android journals only the unstable partial window from `writePartial()`).
  4. Fail strict with `TEXT_SPOOL_*` errors on unavailable/read/corrupted conditions.
- Checkpoints and `commitSegment` snapshots use `committed segments + partial remainder` (not `segments + currentText` verbatim) to avoid duplicating the committed tail in spool replay.
- Unit tests: `android/src/test/java/com/sherpaonnx/text/pipeline/TextSpoolReplayTest.kt`.

---

## 6. Memory & Performance Architecture

### Steady-State Memory
```
Partial window:   windowMaxChars × 2 bytes (UTF-16)
                  Typically small (a few KB)

Segment log:      maxSegments × (avg segment size)
                  Example: 1000 segments × 100 chars = ~200 KB

Spool I/O:        Small write buffer

Total per buffer: Typically < 1 MB in RAM + spool on disk
```

### Event Throttling
`streamEvents.partial.minIntervalMs` controls how often JS receives partial update events.
- `0`: every partial update.
- Higher values: coalesce rapid partial updates into fewer events.
- Native-side: events are batched and the latest partial text is sent.

### Native-Side Processing
The STT worker writes directly to the native LiveTextEntry — no JS roundtrip for each partial update. JS only receives notification events with the partial text string.

---

## 7. Conversion Paths

### Live → Offline (`createOfflineTextBufferFromLive`)

| Mode | Behavior |
|---|---|
| `'fullIfSpooled'` | Replays spool journal + checkpoint → reconstructs full text → immutable `OfflineTextBuffer`. Strict: rejects if spool unavailable/corrupted. |
| `'windowSnapshot'` | Snapshots the current in-memory window (partial + segments) → `OfflineTextBuffer`. |

### Offline → Live (`createLiveTextBufferFromOffline`)

Seeds a new live buffer with the offline text buffer's content. The live buffer starts in `recording` state, allowing further appends.

---

## 8. Thread Safety

- **Partial writes** and **segment commits** are protected by a lock per buffer instance.
- **Spool writes** happen inside the same lock.
- **Event emission** happens outside the lock (after data is written) to avoid blocking producers.
- **Multiple concurrent readers** (JS polling + native pipeline status queries) are safe.

---

## 9. Key Design Decisions

| Decision | Rationale |
|---|---|
| Dual-track (partial + segment log) | Streaming STT produces unstable partials and stable endpoints. Separating them lets UI show both without losing committed text. |
| Journal + checkpoint spool | Append-only journal is fast; periodic checkpoints bound replay cost. Better than a monolithic file for long sessions. |
| Spool on by default (`mode: 'on'`) | Most use cases need full history (export, post-processing). Opt-out with `'off'` for memory-only lightweight buffers. |
| UTF-16 for slice positions | JavaScript strings are UTF-16. Using UTF-16 indices avoids costly codepoint conversion at the bridge. |
| maxSegments eviction | Prevents unbounded memory growth in very long sessions (hours of transcription). Spool retains evicted segments. |
| Opaque `meta` on segments | Allows pipeline workers (TTS, punctuation, etc.) to attach feature-specific metadata without schema coupling. |

---

## 10. Implications for Fake-Live Engines

A Fake-Live STT engine (segmenting audio → offline models) would write to a `LiveTextBuffer` as follows:

1. For each audio segment processed by the offline STT model:
   - Set partial text to the result (optional, for UI feedback).
   - Commit the result as a segment with `source: 'stt_stream'`.
2. The `LiveTextBuffer` handles the segment log, spool, and event emission identically to a real streaming STT.
3. Downstream consumers (UI, TTS pipeline) cannot distinguish between real-time and fake-live text production.

**Key insight:** The `LiveTextBuffer` is **producer-agnostic**. It does not care whether text comes from a streaming model or from an offline model called repeatedly. This makes it the natural output target for both real and fake-live engines.
