# Speaker embedding manager: upstream export / import (future work)

**Status:** Upstream **GetEmbedding** implemented locally (branch `add-speaker-embedding-manager-get-embedding` in external `sherpa-onnx` clone; uncommitted pending review; PR draft present — not pushed). SDK still ships a **JS enrollment mirror** until upstream merges and we bridge C-API.  
**Scope:** Named-speaker persistence for SID (`SpeakerEmbeddingManager` in sherpa-onnx).  
**Motivation:** Export enrollments without keeping a parallel JS copy of embedding vectors.

**Related (today):**

- [speaker-identification-offline.md](../speaker-identification-offline.md) — `exportEnrollments` / `importEnrollments` (JS mirror)
- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) — persistence outside the extractor
- Upstream C++: `third_party/sherpa-onnx/sherpa-onnx/csrc/speaker-embedding-manager.{h,cc}`
- Upstream cxx-API: `SpeakerEmbeddingManager` in `c-api/cxx-api.h` — **GetEmbedding** pending upstream merge

---

## 1. Problem statement

sherpa-onnx’s `SpeakerEmbeddingManager` stores L2-normalized embedding rows keyed by speaker name. Historically the public C++ / JNI / Kotlin / cxx surfaces exposed **write + match only**:

| Available | Missing (historical) | Now (local upstream branch) |
| --- | --- | --- |
| `Add` / `Remove` / `Contains` / `NumSpeakers` / `GetAllSpeakers` | `GetEmbedding(name)` | **Added** (C++ / C-API / cxx) |
| `Search` / `Verify` / `Score` / `GetBestMatches` (upstream; not all bridged) | — | — |

After `Add`, older pins cannot read vectors back. Cross-session SID therefore keeps a **JS mirror** of the embeddings passed into `manager.add` and serializes that as `SpeakerEnrollmentBundle`. That works for enrollments done through SID, but:

1. Speakers added only via low-level / native paths are **invisible** to `exportEnrollments`.
2. Every enroll copies floats into JS heap for the lifetime of the SID instance.
3. Import still round-trips embeddings through TurboModule `add` rather than a native load.

---

## 2. What the SDK ships today (baseline)

```ts
const bundle = await sid.exportEnrollments(); // from JS mirror
await sid.importEnrollments(bundle, { replaceExisting?: boolean });
```

- Bundle: `{ version: 1, dim, modelKey?, speakers: { name, embeddings: number[][] }[] }`
- App owns file / key-value storage — SDK does not write enrollment files
- `dim` / optional `modelKey` guards prevent loading into the wrong extractor

This should remain supported even if upstream gains native export; the mirror can become a cache or fall back.

---

## 3. Upstream possibilities

Prefer **small, composable** C++ APIs over a single opaque binary blob tied to one app format.

### 3.1 Export — `GetEmbedding` (minimum useful) — **in progress upstream**

```text
bool GetEmbedding(const std::string &name, float *out /* length == Dim() */) const;
```

Returns the **stored** (averaged, L2-normalized) row for `name`, or false if missing. C-API mirrors extractor embedding ownership (`GetEmbedding` + `DestroyEmbedding`); also exposes `Dim()`.

**Why this is enough for export:** SID can rebuild a portable JSON bundle by `GetAllSpeakers` + `GetEmbedding` per name, without a JS enroll mirror and without inventing a file format in C++.

**Propagate through:** C-API → cxx-API → (later) Kotlin/JNI → our TurboModule → SID `exportEnrollments` prefers native readout when available.

### 3.2 Import

Import can stay “`Add` per speaker” with the existing JSON bundle (`dim` / optional `modelKey` checks).

---

## 4. SDK follow-up (after upstream merge)

1. Bridge `GetEmbedding` (Android C-API helper + iOS wrapper + TurboModule).
2. Change `exportEnrollments` to prefer native readout; drop or thin the JS mirror once proven.
3. Optionally expose `SpeakerEmbeddingManager.getEmbedding(name)` for advanced apps.
4. **Do not** remove the versioned JSON bundle contract without a migration — apps already persist `SpeakerEnrollmentBundle`.

---

## 5. Out of scope for this note

- Changing cosine search / verify semantics
- Storing diarization cluster indices in the named-speaker manager
- Audio-clip archives as the primary enrollment format (re-enroll remains an app choice)
- Shipping a fork-only GetEmbedding without an upstream PR path (prefer contribute upstream)

---

## 6. Acceptance sketch (when implementing)

- [x] Upstream changes (local, uncommitted): `GetEmbedding` (+ C-API Dim / Destroy) + tests in sherpa-onnx
- [ ] Review → commit → push / open upstream PR (manual)
- [ ] Kotlin bindings for the getter (cxx done in same PR; Kotlin later if desired)
- [ ] RN bridge + unit test: enroll → destroy mirror deliberately → export still returns correct vectors via native
- [ ] `importEnrollments` unchanged or still validated against `dim` / `modelKey`
- [ ] Docs: offline persistence section notes native export path
