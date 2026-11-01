# Speaker embedding manager: upstream export / import

**Status:** **Done** for readout. sherpa-onnx **2.0.1** ships `GetEmbedding` + `DestroyEmbedding` on the C-API. The SDK bridges that through `SpeakerEmbeddingManager.getEmbedding(name)` and SID `exportEnrollments` (JS enrollment mirror removed).  
**Scope:** Named-speaker persistence for SID (`SpeakerEmbeddingManager` in sherpa-onnx).  
**Motivation:** Export enrollments from the native store without a parallel JS copy of embedding vectors.

**Related:**

- [speaker-identification-offline.md](../speaker-identification-offline.md) — `exportEnrollments` / `importEnrollments` (native readout)
- [speaker-embedding-foundation.md](../internal/speaker-embedding/speaker-embedding-foundation.md) — persistence outside the extractor
- Upstream C++: `third_party/sherpa-onnx/sherpa-onnx/csrc/speaker-embedding-manager.{h,cc}`
- Upstream C-API / cxx-API: `SherpaOnnxSpeakerEmbeddingManagerGetEmbedding` in `c-api/c-api.h` (2.0.1)

---

## 1. What the SDK ships

```ts
const bundle = await sid.exportEnrollments(); // listSpeakers + getEmbedding
await sid.importEnrollments(bundle, { replaceExisting?: boolean });
```

- Bundle: `{ version: 1, dim, modelKey?, speakers: { name, embeddings: number[][] }[] }`
- Native export is **one** averaged, L2-normalized row per name: `embeddings: [averagedRow]`
- Import still calls `manager.add`. Older bundles with multiple clip rows remain valid (native averages)
- App owns file / key-value storage — SDK does not write enrollment files
- `dim` / optional `modelKey` guards prevent loading into the wrong extractor
- A listed name without a readable vector rejects with `SID_ENROLL_INVALID_RESULT` (no silent drop)

Low-level apps can also call `SpeakerEmbeddingManager.getEmbedding(name)` → `Float32Array | null`.

---

## 2. Upstream API (2.0.1)

```text
const float *SherpaOnnxSpeakerEmbeddingManagerGetEmbedding(p, name);
void SherpaOnnxSpeakerEmbeddingManagerDestroyEmbedding(v);
```

Returns the **stored** (averaged, L2-normalized) row for `name`, or `NULL` if missing. Ownership matches extractor embeddings (`Get` + `Destroy`).

SID rebuilds the portable JSON bundle by `GetAllSpeakers` + `GetEmbedding` per name.

---

## 3. Remaining (not this change)

- Optional native Save / Load blob (not needed; JSON bundle stays the app contract)
- Kotlin bindings in upstream sherpa-onnx itself (we stay on C-API, same as the rest of the manager)
- Changing cosine search / verify semantics
- Storing diarization cluster indices in the named-speaker manager
- Audio-clip archives as the primary enrollment format
- Bumping `SpeakerEnrollmentBundle.version` (v1 still holds)

---

## 4. Acceptance

- [x] Upstream `GetEmbedding` (+ C-API Dim / Destroy) in sherpa-onnx 2.0.1
- [x] RN C-API Core + Wrapper + Android JNI + iOS bridge + TurboModule
- [x] `SpeakerEmbeddingManager.getEmbedding(name)`
- [x] SID `exportEnrollments` via native readout; JS enrollment mirror removed
- [x] `importEnrollments` still `add`s N rows; `dim` / `modelKey` validated
- [x] Docs: offline persistence section notes native export path
