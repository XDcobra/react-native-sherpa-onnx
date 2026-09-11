# LiveText meta: JSON-tree contract

**Status:** Done (landed).  
**Priority:** Cross-cutting contract upgrade; **breaking changes accepted**.  
**Trigger:** Audio Tagging live overload needs top-K `events[]` on LiveText commits; the former scalar-only meta forced a JSON-string workaround.  
**Related (adjacent):** [live-text-pipeline-append-partial-channel.md](./live-text-pipeline-append-partial-channel.md), [segmentation-ec-03-live-text-segment-index-dedup-invariant.md](./segmentation-ec-03-live-text-segment-index-dedup-invariant.md).

---

## 1. Problem (historical)

LiveText segment `meta` was documented and enforced as:

- **JSON scalars** (`string | number | boolean | null`)
- plus optional **`extra: Record<string, string>`** (TTS)

Two layers silently dropped nested values:

| Layer | Former behaviour |
|---|---|
| Android `pipelineLiveTextSegmentAppended` emit | `WritableMap` typed puts only; nested `List` / `Map` → **skipped** |
| JS `projectNativeSegmentMeta` / `toPublicTextMeta` | Scalars + string-only `extra`; arrays / nested objects → **stripped** |

iOS could pass nested `NSDictionary` / `NSArray` more readily, but JS still stripped them — so **Android and iOS disagreed**.

### What features did (workarounds)

| Feature | LiveText `meta` (pre-landing) | Structured data elsewhere |
|---|---|---|
| **Audio Tagging (live)** | `durationMs` + `events` as **JSON string** | Optional live segment `payloadJson` (also JSON string, full events) |
| **SLID (live)** | `durationMs` only (primary lang in `text`) | Segment `payloadJson` `{ source, lang }`; offline result has nested `distribution` / `switches` via **promise result**, not LiveText |
| **SID (live)** | No LiveText | Segment `payloadJson` only |
| **KWS** | Scalars (`keyword`, `source`, …) | Tokens / timestamps as **first-class** segment fields — **no change needed** after JSON-tree |
| **Punctuation / STT** | Scalars / reserved `__segment*` | — |
| **TTS** | `sid`, `speed`, `extra: Record<string, string>` | Nested needs → flatten into `extra` strings |
| **VAD / Diarization** | N/A (segment channel) | `payloadJson` strings |

---

## 2. Goal (landed contract)

LiveText `meta` is a **Fabric-safe JSON tree**:

```ts
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
// LiveText segment meta
meta?: Record<string, JsonValue>;
```

**Invariants:**

1. **Plain data only** — no native handles, HybridData, typed arrays, or host objects in meta that survive across the bridge.
2. **Finite depth / size** — soft limits: depth ≤ **4**, array length ≤ **64**, object keys per level ≤ **64** (excess dropped, no throw on emit).
3. **Deterministic projection** — Android emit, iOS emit, JS `sanitizeJsonMeta`, and `getLiveTextBufferSegments(..., { includeMeta })` round-trip the **same** JSON tree.
4. **Reserved keys** stay reserved (`__segmentReason`, …); public meta remains filterable via `toPublicTextMeta`.
5. **Spool:** Meta is **not** persisted or reconstituted from spool (status quo).

TTS `extra` remains `Record<string, string>` under `meta.extra` (valid subtree; no TTS API change in this epic).

---

## 3. Implementation (landed)

### 3.1 Native emit / read

- **Android:** `LiveTextJsonMeta` recursive `Any?` → `WritableMap` / `WritableArray` in `emitLiveTextSegment` and `getLiveTextBufferSegments`.
- **iOS:** `NSDictionary` / `NSArray` passthrough in textbuffer bridge; SLID live commits `durationMs` in meta (parity with Android).
- **Storage:** In-memory segment `meta` stays platform maps; spool omits meta.

### 3.2 JS boundary

- `src/textbuffer/jsonMeta.ts` — `sanitizeJsonMeta` (+ `JsonValue` types).
- `projectNativeSegmentMeta` / `toPublicTextMeta` / `getLiveTextBufferSegments` all use the sanitizer.
- Types: `LiveTextSegment.meta` → `Record<string, JsonValue>`.

### 3.3 Audio Tagging migration

- Native workers commit nested `meta.events` arrays (no `JSONArray.toString()` / `NSJSONSerialization` for LiveText meta).
- JS reads nested arrays only (JSON-string workaround removed — clean cut).
- Segment `payloadJson` unchanged (optional dual output).

---

## 4. Cross-feature notes

| Feature | Status after landing |
|---|---|
| **Audio Tagging** | `meta.events: AudioTaggingEvent[]` + `durationMs` |
| **KWS** | **No change needed** — scalars remain valid JSON trees |
| **SLID live** | `durationMs` in meta on both platforms; richer nested meta still optional |
| **TTS** | `extra` string map unchanged |
| **Segment `payloadJson`** | Out of scope — follow-up (§5) |

**Do not** use nested LiveText meta as a dumping ground for large embeddings or PCM.

---

## 5. Related cleanup (follow-up)

**Segment `payloadJson: string`** remains the twin workaround on the speech-segment channel. A parallel “segment payload = JSON tree” contract is **out of scope** for this epic.

---

## 6. Explicit non-goals

- Changing LiveText **text** / **tokens** / **timestamps** first-class fields
- Making meta a substitute for Offline/Live **result** promises (e.g. full SLID `distribution`)
- TTS `extra` → free nested keys
- Spool-meta persistence
- Large embeddings/PCM in meta

---

## 7. Acceptance criteria

- [x] Documented public contract: LiveText `meta` is a JSON tree; scalars-only language removed from types/docs.
- [x] Android + iOS emit and slice APIs round-trip nested arrays/objects.
- [x] JS projector no longer strips arrays/objects; still strips non-JSON / reserved internals on public views.
- [x] Audio Tagging live uses nested `meta.events` (no required JSON string).
- [x] At least one other consumer simplified or explicitly documented as “no change needed” (KWS).
- [x] Breaking-change note in changelog / migration blurb: nested meta now visible; AT JSON-string `meta.events` removed.

---

## 8. Code / doc anchors

- JS sanitizer: `src/textbuffer/jsonMeta.ts`
- JS projector: `src/textbuffer/index.ts` — `projectNativeSegmentMeta`, `toPublicTextMeta`, `getLiveTextBufferSegments`
- Types: `src/textbuffer/types.ts` — `LiveTextSegment.meta`
- Android pack: `android/.../text/pipeline/LiveTextJsonMeta.kt`
- iOS textbuffer: `ios/textbuffer/bridge/SherpaOnnx+TextBuffer.mm`
- AT live: `AudioTaggingOfflineLivePipelineWorker` (Android/iOS), `src/audio-tagging/live.ts`
- Public docs: `docs/textbuffer-streaming.md`, `docs/audio-tagging-live.md`
- Internal: `docs/internal/livetextbuffer-internal.md`
