# OrchestrationProgress: Alignment & VAD offline (High-Level Plan)

This note captures the **product / API consistency** goal discussed for **`OrchestrationProgress`**-style offline progress, focused on **Alignment** and **VAD offline**. **VAD streaming** is explicitly out of scope here (use segment-buffer **`onSegmentAppended`**; see [vad-streaming.md](../../vad-streaming.md)). **Concrete implementation plans:** [implementation-plans-index.md](./implementation-plans-index.md).

### Decisions & contracts (locked)

| Doc | Purpose |
| --- | --- |
| [ADR-001 — Alignment offline progress strategy](./ADR-001-alignment-offline-progress-strategy.md) | **Accepted:** hybrid **C** — driver instrumentation + shared **`OrchestrationProgress`** payload; public `onProgress` on alignment options. |
| [ADR-002 — VAD offline segmentation + progress strategy](./ADR-002-vad-offline-segmentation-progress-strategy.md) | **Accepted:** Phase-0 API/design lock for `VADOfflineRunOptions` (`segmentation`, `onProgress`, `abortSignal`) with legacy default `segmentation.mode='off'`. |
| [Phase 0 — Per-mode progress semantics](./phase-0-alignment-progress-semantics.md) | **`totalSegments` / `currentSegment`** meaning per alignment **mode**; fallbacks when inner step counts are TBD. |

---

## 1. Background & consistency target

### What exists today (reference)

- **Offline batch features** that already use **`pipeline/offlineOrchestrator.ts`** expose optional **`onProgress`** with **`OrchestrationProgress`** (segment index, `totalSegments`, `fraction`, `elapsedMs`, …) when **`segmentation.mode !== 'off'`** — e.g. STT / TTS / Enhancement / Punctuation batch paths in the SDK.
- **`OrchestrationProgress` semantics (today):** callback fires **at the start** of processing orchestrator **segment `i`** (before the per-segment native `consumer` runs). `totalSegments` is known **before** the first segment consumer runs.

### Consistency we want

| Layer | Direction |
| --- | --- |
| **Offline** models that run **multi-step / chunked** work | Users should be able to opt into **progress events** aligned with **`OrchestrationProgress`** (or a **documented equivalent**), not only silent long runs. |
| **Streaming** | Remains **buffer-event** based (`onPartial`, **`onSegment`** on live text/audio, **`onSegmentAppended`** on live segment buffers for VAD). **No** `OrchestrationProgress` on pipeline handles. |

### Out of scope for this folder

- Streaming STT / Enhancement / TTS progress (buffer callbacks + `getStatus`).
- **Diarization / Separation** (stubs / thin surfaces).

---

## 2. Alignment (offline) — first implementation target

### Current state

- Alignment is **offline-only** (no streaming alignment product surface).
- Execution goes through **`alignTextToAudio`** and native / TS **drivers** (e.g. **`runAccurateAsrMediated`**, **`runAccurateChunkedForcedCtc`**, proportional / estimated / vad / accurate paths) — **not** through **`runOfflineAudioToTextPipeline`** / **`offlineOrchestrator`**.
- **`AlignTextToAudioOptions`** has **no** `onProgress` / `OrchestrationProgress` today.
- Alignment **`segmentation`** blocks (accurate auto, vad mode, …) are **alignment-specific**; they are **not** the same knob as STT’s **`SttTranscribeOptions.segmentation`** that gates the generic audio orchestrator.

### Goal

- Emit **coarse, trustworthy progress** during long alignment runs (chunk / anchor / phase boundaries), so apps can show a **segment- or phase-based** bar without inventing private timers.
- **Public shape:** literal **`OrchestrationProgress`** + optional **`onProgress`** on alignment options — see [ADR-001](./ADR-001-alignment-offline-progress-strategy.md).

### Integration strategies (record)

| Strategy | Idea | Outcome |
| --- | --- | --- |
| **A. Reuse `offlineOrchestrator`** | Refactor alignment into the generic **consumer-per-segment** loop. | **Rejected** for v1 (see ADR-001). |
| **B. Driver-instrumented (ad-hoc payloads)** | Progress callbacks without shared type discipline. | **Subsumed by C.** |
| **C. Hybrid** | Instrument drivers + **shared emitter** + **`OrchestrationProgress`** — no orchestrator ownership of alignment flow. | **Accepted** (ADR-001). |

### Phased plan (Alignment)

| Phase | Scope | Deliverables |
| --- | --- | --- |
| **0 — Design lock** | Per-mode **`totalSegments` / step** semantics; timing rules. | [phase-0-alignment-progress-semantics.md](./phase-0-alignment-progress-semantics.md) + ADR-001; [alignment-offline.md](../../alignment-offline.md) includes **Offline progress (`onProgress`)** subsection. |
| **1 — API surface** | Add optional **`onProgress`** to **`AlignTextToAudioOptions`** (and document **non-goals**: not sample-accurate waveform progress). | Types + doc; no-op default. |
| **2 — Accurate / chunked paths first** | Instrument **`runAccurateChunkedForcedCtc`** (and optionally **asr_mediated**) where chunk / anchor indices are natural. | Unit tests with mocked native where needed; manual test matrix for one model. |
| **3 — Remaining modes** | **Proportional**, **estimated**, **vad**, **aligned** (as applicable): either single-shot progress (`0 → 1`) or meaningful sub-steps if the implementation exposes them. | Document per-mode behaviour explicitly. |
| **4 — Parity & docs** | [alignment-offline.md](../../alignment-offline.md), [feature-pipelines.md](../../feature-pipelines.md) cross-links; optional internal diagram. | Release note: new optional field, backwards compatible. |

### Risks / open questions

- **Unknown `totalSegments` upfront:** Phase 0 uses **single-shot** `totalSegments === 1` until drivers expose real counts — see [phase-0](./phase-0-alignment-progress-semantics.md#unknown-totalsegments-upfront). Avoid widening the **`OrchestrationProgress`** type in v1.
- **Cancellation:** alignment **`AbortSignal`** (if added later) must match progress **terminal** semantics.
- **Threading:** same constraints as other `onProgress` callers (avoid heavy work in callback).

---

## 3. VAD offline — second target (after Alignment)

### Current state

- Default path remains single native **`runVadOffline`** over the **entire** offline audio buffer (`off_*`) when `segmentation` is omitted or `mode: 'off'`.
- Segmented offline path is implemented for `segmentation.mode: 'auto'` in **`src/vad`** using segmentation-engine speech slices and per-slice VAD runs.
- `onProgress` (`OrchestrationProgress`) is implemented for segmented mode (Phase 2), while `mode: 'off'` intentionally emits no progress in v1.

### Goal (as discussed)

- **`segmentation.mode === 'off'`:** keep **one** `runVadOffline` over the **full** buffer (current behaviour).
- **`segmentation.mode !== 'off'`:** use the **segmentation engine** (or equivalent policy) to **split** offline PCM into **speech segments**, then run **`runVadOffline` per segment** (or an equivalent native contract), aggregating results into the **same output segment buffer / timeline shape** as today — and wire **`onProgress` / `OrchestrationProgress`** to **orchestrator-style** segment indices.

### Dependency on Alignment work

- Reuse **patterns** (progress payload, testing, docs) established for **Alignment**.
- **Does not** require Alignment code to be finished before **spiking** VAD, but **product consistency** and **review capacity** suggest **Alignment Phase 1–2 landed** before a full VAD offline rollout.

### Phased plan (VAD offline) — draft

| Phase | Scope | Deliverables |
| --- | --- | --- |
| **0 — API design** | Add **`VadOfflineOptions`** (names TBD): `segmentation?`, `onProgress?`, `abortSignal?`; define interaction with existing **`createStreamingVAD` + `process`** offline branch. | ADR; VAD doc section [vad-streaming.md](../../vad-streaming.md) / future **vad-offline.md** if split. |
| **1 — Segment + loop** | Offline path: **`segmentOfflineBuffer`** + **`getSegments`** (speech domain) → loop → **`runVadOffline`** per slice → merge segment metadata. | Matches STT orchestration pattern; engine cache / identity per sample rate unchanged where possible. |
| **2 — Progress** | Fire **`OrchestrationProgress`** (or chosen alias) **per orchestrator segment** (same semantics as STT: **before** each `runVadOffline`). | Tests + golden expectations for `totalSegments`. |
| **3 — Edge cases** | Empty audio, single segment, retry policy (align with other features or explicitly “no retry”). | Documented. |

### Risks

- **Performance:** many small `runVadOffline` calls vs one large — may need **batching** or **minimum segment duration** policy tuning.
- **Semantic change:** “VAD on whole file” vs “VAD on each detected speech chunk” can change **segment boundaries** vs today’s single-pass — must be **versioned** or gated by **`segmentation.mode`** only to preserve legacy default.

---

## 4. VAD streaming (reference only)

- **No `OrchestrationProgress`** on the pipeline handle.
- Use **`onSegmentAppended`** / **`streamEvents.segmentAppended`** on the **live segment buffer** for “new VAD segment produced”; **`onSpeechStateChanged`** for coarse speech activity.
- No change required for this migration track unless we later **unify naming** in docs (“segment events” glossary).

---

## 5. Suggested execution order

1. **Alignment:** Phases **0 → 2** (minimum) for meaningful offline progress.
2. **VAD offline:** Phases **0 → 2** after Alignment patterns are proven in production or CI.
3. **Docs sweep:** Link from [streaming-pipelines-overview.md](../../streaming-pipelines-overview.md) / download progress docs if we add a central “Progress matrix” page (optional follow-up).

---

## 6. Related code & docs

| Area | Path |
| --- | --- |
| Orchestrator & progress type | `src/pipeline/offlineOrchestrator.ts` |
| Alignment drivers | `src/alignment/chunkedForcedCtc/`, `src/alignment/asrMediated/`, `src/alignment/alignTextToAudio.ts` |
| VAD engine / offline branch | `src/vad/engine.ts`, `src/vad/types.ts` |
| Segmentation | `src/segment/`, [segmentation-engine.md](../../segmentation-engine.md) |
| Existing buffer progress ADR-style notes | `docs/migration/segmentationEngine/sub-03-buffer-integration.md` (segment vs data events) |

---

*Document status: alignment strategy/semantics locked in ADR-001 + phase-0 doc, and VAD Phase-0 design lock in ADR-002; implementation tracked separately.*
