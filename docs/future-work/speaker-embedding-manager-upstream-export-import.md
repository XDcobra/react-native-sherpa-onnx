# Speaker embedding manager: upstream export / import (future work)

**Status:** Design note — not implemented upstream; SDK ships a **JS enrollment mirror** today.  
**Scope:** Named-speaker persistence for SID (`SpeakerEmbeddingManager` in sherpa-onnx).  
**Motivation:** Export enrollments without keeping a parallel JS copy of embedding vectors; optionally restore a manager from disk without re-passing float arrays through the TurboModule.

**Related (today):**

- [speaker-identification-offline.md](../speaker-identification-offline.md) — `exportEnrollments` / `importEnrollments` (JS mirror)
- [speaker-embedding-foundation.md](../internal/speaker-embedding-foundation.md) — persistence outside the extractor
- Upstream C++: `third_party/sherpa-onnx/sherpa-onnx/csrc/speaker-embedding-manager.{h,cc}`
- Upstream cxx-API: `SpeakerEmbeddingManager` in `c-api/cxx-api.h` (Add / Remove / Search / Verify / GetAllSpeakers — **no** GetEmbedding / Save / Load)

---

## 1. Problem statement

sherpa-onnx’s `SpeakerEmbeddingManager` stores L2-normalized embedding rows keyed by speaker name, but the public C++ / JNI / Kotlin / cxx surfaces expose **write + match only**:

| Available | Missing |
| --- | --- |
| `Add` / `Remove` / `Contains` / `NumSpeakers` / `GetAllSpeakers` | `GetEmbedding(name)` (or dump matrix) |
| `Search` / `Verify` / `Score` / `GetBestMatches` (upstream; not all bridged) | `Save` / `Load` / serialize |

After `Add`, the RN SDK cannot read vectors back. Cross-session SID therefore keeps a **JS mirror** of the embeddings passed into `manager.add` and serializes that as `SpeakerEnrollmentBundle`. That works for enrollments done through SID, but:

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

### 3.1 Export — `GetEmbedding` (minimum useful)

```text
bool GetEmbedding(const std::string &name, float *out /* length == Dim() */) const;
// or: std::vector<float> GetEmbedding(const std::string &name) const;
```

Returns the **stored** (averaged, L2-normalized) row for `name`, or false / empty if missing.

**Why this is enough for export:** SID can rebuild a portable JSON bundle by `GetAllSpeakers` + `GetEmbedding` per name, without a JS enroll mirror and without inventing a file format in C++.

**Propagate through:** C-API → cxx-API → Kotlin/JNI → our TurboModule → optional `manager.getEmbedding(name)` → SID `exportEnrollments` can prefer native readout when available.

### 3.2 Export — full dump (optional)

```text
// Parallel arrays or list of {name, embedding}
GetAllEmbeddings(...)
```

Useful for bulk export / debugging; not required if `GetEmbedding` exists.

### 3.3 Import — native load (optional, larger)

Two reasonable shapes:

| Shape | Pros | Cons |
| --- | --- | --- |
| **A. Reuse `Add`** | Already exists; JS/native import stays “add averaged vectors” | Still one bridge call per speaker; no file format |
| **B. `Load` / `Save` binary** | Fast restore of large galleries | Format versioning, endianness, dim binding, security review of untrusted files |

**Recommendation for upstream ask:** land **§3.1 first**. Import can stay “`Add` per speaker” forever; a native `Save`/`Load` is only worth it if galleries are large or cold-start must avoid many TurboModule round-trips.

If `Save`/`Load` is proposed anyway, bind it explicitly to `(dim, float32 LE rows + names)` or document that files are **not** portable across embedding models (same constraint as today’s `modelKey`).

---

## 4. SDK follow-up (after upstream)

1. Bridge `GetEmbedding` (Android Kotlin manager + iOS cxx wrapper + TurboModule).
2. Change `exportEnrollments` to prefer native readout; keep JS mirror as write-through cache **or** drop mirror once native export is proven.
3. Optionally expose `SpeakerEmbeddingManager.getEmbedding(name)` for advanced apps.
4. **Do not** remove the versioned JSON bundle contract without a migration — apps already persist `SpeakerEnrollmentBundle`.
5. Native `Save`/`Load` (if ever upstream): thin helpers beside or behind `importEnrollments`, still with `dim` / model fingerprint checks.

---

## 5. Out of scope for this note

- Changing cosine search / verify semantics
- Storing diarization cluster indices in the named-speaker manager
- Audio-clip archives as the primary enrollment format (re-enroll remains an app choice)
- Shipping a fork-only GetEmbedding without an upstream PR path (prefer contribute upstream)

---

## 6. Acceptance sketch (when implementing)

- [ ] Upstream PR: `GetEmbedding` (or equivalent) + tests in sherpa-onnx
- [ ] Kotlin + cxx bindings expose the getter
- [ ] RN bridge + unit test: enroll → destroy mirror deliberately → export still returns correct vectors via native
- [ ] `importEnrollments` unchanged or still validated against `dim` / `modelKey`
- [ ] Docs: offline persistence section notes native export path; this future-work marked done or narrowed to Save/Load only
