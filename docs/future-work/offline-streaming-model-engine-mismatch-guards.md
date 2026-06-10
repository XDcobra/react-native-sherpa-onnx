# Offline vs streaming: model / engine direction mismatch (future work)

**Status:** Design note — not implemented.  
**Scope:** Cross-cutting policy and native **guards** when a model asset is used with the “other” engine family: **OfflineEngine** (batch / non-streaming APIs) vs **streaming** (online / stateful) engines.

**Related (implemented or in flight):** Feature-specific **online** ORT / layout guards (e.g. [enhancement online guard](../../android/src/main/cpp/jni/model_detect/enhancement/sherpa-onnx-enhancement-online-guard.cpp), punctuation [online guard](../../android/src/main/cpp/jni/model_detect/punctuation/sherpa-onnx-punctuation-online-guard.cpp), [punctuation model detect](../../android/src/main/cpp/jni/model_detect/punctuation/sherpa-onnx-model-detect-punctuation.cpp). This document generalises the **asymmetric** rules and a **reusable** path for the dangerous direction.

---

## 1. Asymmetry (sherpa-onnx reality)

| Direction | Safe? | What we need |
|-----------|--------|----------------|
| **Streaming-capable (online) model** used with **OfflineEngine** (batch) | **Often yes** in principle: many models that support streaming I/O are still valid to run in a one-shot or offline batch path if the **runtime** chooses the right **offline** config and session shape. | **No generic abort guard**; instead, **per feature**, ensure **correct offline config** (and document any unsupported combos). |
| **Offline-only model** (batch weights / layout) used with **StreamingEngine** (online) | **No** in general: the online code path expects a different graph / state / I/O. Using an offline layout here is a **user or packaging error**. | A **reusable, deterministic guard** that **fails with a clear error** — **no** silent fallback to another model type. |

Rationale: offline batch is usually the **simpler** or **strict subset** of execution; streaming needs **state**, chunking, and often different tensors. Dropping the wrong way round maps to “can’t run online with this layout,” not the other way round in the same sense.

---

## 2. Workstream A — “Offline model → streaming engine” (guard)

**Goal:** One **general pattern** (shared helpers + consistent error shape) that:

1. **Detects** (from the same model folder / metadata the feature already has) that the **resolved** layout is **offline-only** or not eligible for the **selected streaming** API.  
2. **Aborts** init (or the first `reset` that would commit to online) with a **documented, user-facing** message, e.g. *“this directory does not contain a model suitable for the streaming (online) engine; use the offline/batch API or a streaming-compatible asset.”*  
3. Stays **deterministic**: no picking another engine, no “best effort” with the wrong model.

**Implementation sketch:**

- **Common layer** in native detect / validation (Android parity with iOS as today): e.g. shared enum or flags: `kinds.streamingEligible`, `kinds.offlineBatchEligible` per feature, derived from the same heuristics as [model_detect](../../android/src/main/cpp/jni/model_detect/).  
- **Call site:** streaming / online facades (STT, punctuation, enhancement, …) call the guard before constructing the online object.  
- **Tests:** at least one fixture or golden path: offline-only tree → expect **rejection** with stable code or substring.

**Not in scope** for a minimal first step: a single C++ class name for every feature; **behavioural** contract (fail fast, same user-visible policy) is more important than a single `Guard.cpp` for all domains.

---

## 3. Workstream B — “Streaming model → OfflineEngine” (config, not a universal guard)

**Goal:** When user chooses **OfflineEngine** but the folder **also** or **only** contains assets that are primarily **online/streaming** (e.g. CNN-Transducer vs CT for speech, or “online” punctuation heuristics in detect), the batch path must still:

- Select **`Offline…` C++ / Kotlin / Swift** types and **offline** config members only.  
- **Not** auto-route to a streaming class “because detect said online is possible” — that would mix APIs.

This maps to **product + implementer** rules already discussed for e.g. **offline punctuation**: deterministic init — **if** the resolved model is **not** suitable for the offline public API, **error**, don’t fall back to online inside the same factory.

**Per feature**, document:

- Which `modelType` / `auto` / explicit kind resolution applies.  
- When **only** the streaming product should be offered for that tree.

Optional later: a **soft** “info” in detect (e.g. *“this directory is also streaming-capable”*) without changing the offline init decision — purely UX.

---

## 4. Checklist (when touching a new feature)

- [ ] Does this feature have **two** public engines (offline batch vs streaming online)? If only one, skip cross-matrix.  
- [ ] **Offline →** wrong: add / reuse **guard** in the **streaming** init path.  
- [ ] **Streaming →** offline: verify **config table** and **rejection** if offline invariants aren’t met (no silent online substitute).  
- [ ] Expose the same **policy** in TS JSDoc / one line in the feature plan so the asymmetry doesn’t get “fixed” in the wrong layer later.

---

## 5. Open questions (not blocking the write-up)

- **Single** cross-feature error code vs **feature-scoped** codes (easier to map to support / docs).  
- Whether `detect*Model` JSON should carry **explicit** booleans like `suitableForOfflineEngine` / `suitableForStreamingEngine` for the JS layer, or we keep that logic native-only to avoid desync.

---

## 6. Related documents

- Punctuation and offline/online detect — see internal buffer / detect docs and `src/licenses.ts` / model streams as updated with the product.  
- [OfflineTextBuffer internal](../internal/offlinetextbuffer-internal.md) (offline text pipeline assumptions).
