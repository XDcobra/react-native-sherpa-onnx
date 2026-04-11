# Large offline audio buffers: file-backed storage and mmap (future work)

**Status:** Planned improvement (not implemented as of this document).  
**Audience:** Native (Kotlin / iOS) and anyone extending pipeline stages (offline STT, enhancement, alignment).  
**Scope:** Internal storage and memory behavior of **offline** pipeline audio buffers. The **public JS/TS API** (`react-native-sherpa-onnx/audiobuffer`, buffer handles, `getPipelineAudioBufferInfo`, slice helpers) is intended to remain **stable**; changes are **native-side** unless we later add optional observability fields (e.g. storage kind in info).

---

## 1. Motivation

### 1.1 Problem

Pipeline flows such as:

`Audio file → OfflineAudioBuffer₁ → Enhancement → OfflineAudioBuffer₂ → release(₁) → STT → OfflineTextBuffer`

imply a **short overlap** where two offline audio buffers exist. If both hold **full decoded PCM in RAM**, peak memory can approach **two full waveforms** plus model and DSP working memory. For **very long or high–sample-rate** inputs, that is undesirable on mobile.

### 1.2 Goal

Reduce **resident RAM** for large offline PCM by preferring **file-backed** storage and **mmap** (or equivalent read-through file access) for **large** offline buffers, while:

- Keeping **pipeline semantics** unchanged (immutable offline snapshot per buffer id, lifecycle via `releasePipelineAudioBuffer`).
- Ensuring consumers (offline STT, enhancement, alignment, debug slices) read PCM **through the buffer registry**, not by forcing full materialization into JS or duplicate full native RAM copies when avoidable.

### 1.3 Non-goals

- **Not** a promise to cap **compute** memory (features, model activations, enhancement scratch). Those depend on algorithms and model choice.
- **Not** merging this document’s behavior with the **live** ring + optional WAV **spool** API into a single user-facing concept; see section 3 for terminology.
- **Not** changing **offline text buffer** immutability rules in this spec (text remains snapshot / populate-once unless separately specified).

---

## 2. Proposed behavior (native)

### 2.1 Heuristic and policy

- For **offline** buffers created from **file** (e.g. `createOfflineAudioBufferFromFile`), the codebase already documents a **size threshold** (e.g. on the order of **10 MB**) above which PCM may stay **file-backed** instead of fully loaded into RAM. This spec **generalizes and hardens** that idea:
  - Apply a consistent **large-buffer policy** across **all** native paths that **allocate** offline pipeline audio (decode from WAV, enhancement output, resampling output, etc.).
  - **Threshold** may remain configurable internally; exact MB value is an implementation detail.

### 2.2 Backing strategies

| Strategy | Use case |
| --- | --- |
| **In-RAM dense PCM** | Small buffers; lowest latency for repeated random access. |
| **File-backed / temp WAV + mmap or buffered read** | Large buffers; STT and other consumers read via **slices** or internal decode feeding the recognizer without holding the entire waveform in RAM. |

Rules:

1. **Transparency:** Callers use the same `bufferId` / `OfflineAudioBufferRef`; native registry chooses backing.
2. **Release:** `releasePipelineAudioBuffer` must **close** files, **unmap** regions, and delete **temporary** files when applicable.
3. **No accidental full copy:** No public API path should **require** shipping the entire PCM to JS for large buffers. Existing slice APIs remain the right surface for inspection.

### 2.3 Pipeline overlap

When **OfflineAudioBuffer₁** and **OfflineAudioBuffer₂** both use file-backed storage:

- Overlap primarily costs **disk footprint** and **I/O**, not necessarily **two full in-RAM waveforms**.
- After `release(₁)`, STT may read **only** from **₂**’s backing store, provided all references to **₁** are dropped.

### 2.4 Enhancement and other producers

Any stage that **creates** a new offline audio buffer (e.g. post-enhancement output) must use the **same registry and large-buffer policy**, not only the initial `createOfflineAudioBufferFromFile` path. Otherwise buffer **₂** might still be fully RAM-backed and the overlap benefit is lost for the dominant allocation.

---

## 3. Terminology vs. live “spool”

- **Live buffer spool** (today): rolling ring + optional **linear WAV persistence** for capture / long sessions; append-centric.
- **Large offline backing** (this spec): **immutable** snapshot semantics; typically **one** backing file per offline buffer (source WAV, temp WAV, or mmap of a materialized file). Same **goal** (avoid huge RAM), **different** lifecycle and data structure.

Documentation should **not** overload the word “spool” for offline file-backed storage without clarification, to avoid confusion with **live** spool APIs.

---

## 4. Public API stability

This work is intentionally **backward compatible** at the TypeScript boundary:

- Same exports from `react-native-sherpa-onnx/audiobuffer`.
- Same TurboModule method names and buffer id contract.
- Optional **future** extension: add a field on `PipelineAudioBufferInfo` / offline info such as `storageKind: 'ram' | 'file' | 'mmap'` for debugging and support (not required for the optimization itself).

---

## 5. Implementation order

1. **Complete migration** of features to the **pipeline model** (offline audio + offline text buffers) so all consumers go through the registry.
2. **Unify** native offline buffer allocation paths behind one implementation (threshold, temp file naming, mmap lifecycle).
3. **Verify** offline STT, enhancement (when ported), and alignment **read** paths against file-backed buffers (no hidden full-buffer reads).
4. **Measure** peak RAM and I/O on long files and low-memory devices.

---

## 6. Acceptance criteria (draft)

- For synthetic **large** WAV inputs, peak **native RSS** during “two offline buffers alive” does **not** scale linearly with **2 × full PCM size** (within measurement tolerance), when both buffers are produced under the new policy.
- `releasePipelineAudioBuffer` leaves no **leaked** mmap regions or temp files for buffers it owned.
- All existing **JS** tests and example flows **unchanged** (same calls); only native behavior and resource graphs improve.

---

## 7. Related documentation

- [Pipeline audio buffers (`audiobuffer`)](../audiobuffer.md) — offline vs live concepts.
- [Offline STT (`stt-offline.md`)](../stt-offline.md) — transcribe into text buffers.
- [TextBuffer pipeline spec](../migration/textbuffer/textbuffer-pipeline-spec.md) — pipeline direction for text output.

---

## 8. Open questions

- Exact **threshold** and whether it should differ per platform (iOS vs Android memory pressure).
- Whether **alignment** or other modules need **random access** patterns that favor mmap over streaming read for the same backing file.
- **Temp file** location (cache dir) and cleanup on **app crash** (OS temp cleanup vs explicit orphan handling).
