# LiveText meta: JSON-tree contract (future work)

**Status:** Design note — schedule **after Audio Tagging** lands (Phases 5–6).  
**Priority:** Cross-cutting contract upgrade; **breaking changes are acceptable and preferred** when they yield a clearer, more robust long-term API.  
**Trigger:** Audio Tagging live overload needs top-K `events[]` on LiveText commits; today’s scalar-only meta forces a JSON-string workaround.  
**Related (adjacent):** [live-text-pipeline-append-partial-channel.md](./live-text-pipeline-append-partial-channel.md), [segmentation-ec-03-live-text-segment-index-dedup-invariant.md](./segmentation-ec-03-live-text-segment-index-dedup-invariant.md).

---

## 1. Problem

LiveText segment `meta` is documented and enforced as:

- **JSON scalars** (`string | number | boolean | null`)
- plus optional **`extra: Record<string, string>`** (TTS)

Two layers silently drop nested values:

| Layer | Behaviour today |
|---|---|
| Android `pipelineLiveTextSegmentAppended` emit | `WritableMap` typed puts only; nested `List` / `Map` → **skipped** |
| JS `projectNativeSegmentMeta` / `toPublicTextMeta` | Scalars + string-only `extra`; arrays / nested objects → **stripped** |

iOS can pass nested `NSDictionary` / `NSArray` more readily, but JS still strips them — so **Android and iOS disagree** and apps cannot rely on nested meta.

### What features do today (workarounds)

| Feature | LiveText `meta` today | Structured data elsewhere |
|---|---|---|
| **Audio Tagging (live)** | `durationMs` + `events` as **JSON string** | Optional live segment `payloadJson` (also JSON string, full events) |
| **SLID (live)** | `durationMs` only (primary lang in `text`) | Segment `payloadJson` `{ source, lang }`; offline result has nested `distribution` / `switches` via **promise result**, not LiveText |
| **SID (live)** | No LiveText | Segment `payloadJson` only |
| **KWS** | Scalars (`keyword`, `source`, …) | Tokens / timestamps as **first-class** segment fields |
| **Punctuation / STT** | Scalars / reserved `__segment*` | — |
| **TTS** | `sid`, `speed`, `extra: Record<string, string>` | Nested needs → flatten into `extra` strings |
| **VAD / Diarization** | N/A (segment channel) | `payloadJson` strings |

Audio Tagging’s string encode/decode is **house-consistent** with `payloadJson` / TTS `extra`, but it is **not** the end-state we want for LiveText: feature code must serialize/parse, typos fail at runtime, and the public “opaque meta” story promises more than the bridge delivers.

---

## 2. Goal (new contract)

Make LiveText `meta` a **Fabric-safe JSON tree**:

```ts
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
// LiveText segment meta
meta?: Record<string, JsonValue>;
```

**Invariants (non-negotiable):**

1. **Plain data only** — no native handles, HybridData, typed arrays, or host objects in meta that survive across the bridge.
2. **Finite depth / size** — document soft limits (e.g. depth ≤ 4, payload ≤ few KB per segment) so spool / event storms stay bounded.
3. **Deterministic projection** — Android emit, iOS emit, JS projector, and `getLiveTextBufferSegments(..., { includeMeta })` all round-trip the **same** JSON tree.
4. **Reserved keys** stay reserved (`__segmentReason`, …); public meta remains filterable via `toPublicTextMeta`.

**Breaking changes are in scope and desirable**, including:

- Removing silent drop of nested values (apps that accidentally relied on “nested = gone” will observe new keys).
- Tightening TypeScript types away from unbounded `Record<string, unknown>` toward `JsonValue`.
- Deprecating / deleting feature-level JSON-string conventions once nested trees work.
- Optionally narrowing TTS `extra` from “strings only” into the general tree (or folding `extra` into plain nested keys).

Do **not** preserve the scalar-only contract for compatibility theatre. Prefer one honest contract over dual “scalar vs stringified JSON” paths.

---

## 3. Implementation sketch

### 3.1 Native emit / read

- **Android:** Recursive `Any?` → `WritableMap` / `WritableArray` (and reverse for slice APIs). Replace `else -> skip` / `value.toString()` footguns in:
  - live segment event emit (`SherpaOnnxModule` / text pipeline)
  - `getLiveTextBufferSegments` meta packing
- **iOS:** Keep `NSDictionary` / `NSArray` trees; ensure every path that copies meta into events or TurboModule maps preserves arrays/dicts (no accidental stringification).
- **Storage:** In-memory segment `meta` may stay as platform maps; spool/checkpoint must either omit meta or store **canonical JSON** (decide explicitly — prefer canonical JSON in spool if meta is ever reconstituted).

### 3.2 JS boundary

- Replace `projectNativeSegmentMeta` / `toPublicTextMeta` scalar filters with a **recursive JSON sanitizer** (drop non-JSON values; keep reserved-key stripping for public views).
- Export a shared helper (e.g. `sanitizeJsonMeta`) used by live events and offline/live segment reads.
- Update `src/textbuffer/types.ts` + public docs (`textbuffer-streaming.md`, internal `livetextbuffer-internal.md`).

### 3.3 Tests (required)

- Round-trip: nested object + array of objects through **emit → onSegment** and **getSegments includeMeta** on Android **and** iOS.
- Reject / strip HybridData-like / function / `undefined` values.
- Depth / size guard behaviour (document + test).
- Regression: existing scalar-only features (KWS, punctuation, SLID `durationMs`) unchanged in shape.

---

## 4. Cross-feature simplifications (after contract lands)

Once nested meta works, migrate features **away** from string encode/decode where LiveText is the primary live callback channel:

| Feature | Simplify to | Notes |
|---|---|---|
| **Audio Tagging** | `meta.events: AudioTaggingEvent[]` (real array) + `durationMs` | Delete native `JSONArray.toString()` / JS `JSON.parse` path; keep segment `payloadJson` only if segment buffer remains optional dual output. |
| **SLID live** | Optional `meta.score` / `meta.candidates` / per-span diagnostics | Today live `onSegment` is lang-only; nested meta unlocks parity with richer offline insights **without** forcing `targetSegmentBuffer`. Distribution across the whole session can stay on finalize/result APIs. |
| **SID** | If/when a LiveText label path exists: `meta.speakerName`, `meta.score`, … | Today SID is segment-payload-only; nested LiveText meta is optional enrichment, not required to keep SID on segments. |
| **KWS** | Optional `meta.score` / keyword metadata objects | Scalars already work; nested is optional enrichment. |
| **TTS** | Nested generation options in meta instead of string-only `extra` | Breaking OK: prefer typed nested keys over `Record<string, string>` bag. |
| **Punctuation / STT** | Unchanged unless new structured side-channels appear | First-class `tokens` / `timestamps` stay first-class (do **not** shove them into meta). |
| **VAD / Diarization** | Keep segment `payload` as structured when emitted to JS | Related cleanup (see §5); not blocked on LiveText, but same JSON-tree discipline. |

**Do not** use nested LiveText meta as a dumping ground for large embeddings or PCM — those stay on audio/segment buffers.

---

## 5. Related cleanup (optional same epic or follow-up)

**Segment `payloadJson: string`** is the twin workaround on the speech-segment channel (SLID, SID, AT, VAD, diarization). A parallel “segment payload = JSON tree” contract would:

- Align LiveText meta and segment payload mental models
- Remove duplicate stringify/parse in native workers + JS mappers
- Allow typed `SpeechSegmentPayload` to flow without `JSON.parse` at the boundary

Treat as **same design family**, possibly same PR series, but **not** a blocker for LiveText meta trees. Prefer one shared native/JS JSON bridge helper for both.

---

## 6. Explicit non-goals

- Changing LiveText **text** / **tokens** / **timestamps** first-class fields
- Making meta a substitute for Offline/Live **result** promises (e.g. full SLID `distribution` for a whole file)
- Preserving binary compatibility with apps that stringify nested meta manually (they keep working if they still pass strings; we simply stop *requiring* that)

---

## 7. Suggested rollout

1. Land Audio Tagging with current JSON-string workaround (done / in progress).
2. Implement JSON-tree LiveText meta (this doc) as a dedicated change set — **break** projector + Android emit first, then migrate AT.
3. Migrate AT → nested `meta.events`; remove string parse helpers.
4. Opportunistically enrich SLID/TTS/KWS where nested meta removes dual channels or string bags.
5. Optionally tackle segment `payloadJson` tree alignment.

---

## 8. Acceptance criteria

- [ ] Documented public contract: LiveText `meta` is a JSON tree; scalars-only language removed from types/docs.
- [ ] Android + iOS emit and slice APIs round-trip nested arrays/objects.
- [ ] JS projector no longer strips arrays/objects; still strips non-JSON / reserved internals on public views.
- [ ] Audio Tagging live uses nested `meta.events` (no required JSON string).
- [ ] At least one other consumer simplified or explicitly documented as “no change needed” (e.g. KWS).
- [ ] Breaking-change note in changelog / migration blurb: nested meta now visible; stringified payloads deprecated for AT.

---

## 9. Code / doc anchors

- JS projector: `src/textbuffer/index.ts` — `projectNativeSegmentMeta`, `toPublicTextMeta`
- Types: `src/textbuffer/types.ts` — segment `meta` comment
- Android emit: `SherpaOnnxModule` live text segment event meta packing (`else -> skip`)
- AT workaround: `AudioTaggingOfflineLivePipelineWorker` (Android/iOS) + `src/audio-tagging/live.ts` `parseEventsFromMeta`
- SLID live (scalar-only meta): `SlidOfflineLivePipelineWorker` + `src/language-identification/live.ts`
- Internal architecture: [livetextbuffer-internal.md](../internal/livetextbuffer-internal.md)
- AT plan LiveText row: [audio-tagging-plan.md](../internal/audio-tagging-plan.md)
