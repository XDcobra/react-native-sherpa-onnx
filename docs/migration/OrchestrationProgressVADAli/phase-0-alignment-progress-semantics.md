# Phase 0 — Alignment offline: `OrchestrationProgress` semantics per mode

This document locks **caller-visible meaning** of `OrchestrationProgress` fields for **`AlignTextToAudioOptions.onProgress`** after [ADR-001](./ADR-001-alignment-offline-progress-strategy.md).  
Implementation may lag; this table is the **contract** to implement and test against.

## Disambiguation — Alignment `vad`, VAD offline, and streaming

Normative tables below apply **only** to **`AlignTextToAudioOptions.onProgress`**. Related surfaces differ on purpose:

| Surface | What it is | Progress / events |
| --- | --- | --- |
| **Alignment `mode: 'vad'`** | Consumes **existing** speech anchors from an **offline segment buffer** (`seg_off_*`). Alignment does **not** run the VAD engine inside `alignTextToAudio`. | `totalSegments` / steps describe **alignment** milestones (see contract row). Richer or finer anchor buffers (e.g. from improved **VAD offline** upstream) change **inputs**, not this contract, unless alignment gains matching **instrumented steps**. |
| **VAD offline** | `createStreamingVAD` + offline `process`, `runVadOffline`, optional future **segmentation** loop. | **`onProgress` / `OrchestrationProgress`** lives on **VAD** options when shipped — see [README §3](./README.md) and the planned ADR-002 — **not** on `AlignTextToAudioOptions`. |
| **VAD streaming** | Live pipeline and **live** segment buffer. | **No** `OrchestrationProgress` on the pipeline handle ([README §4](./README.md)). Use **`onSegmentAppended`** (and related buffer/stream events) for a **running segment count**; streams are usually **open-ended**, so there is **no** batch-style `totalSegments` known at step 0. Treat that as **app-level** UI state, not the same semantic as `fraction` here unless a **follow-up ADR** introduces a dedicated streaming progress shape. |

**Global rules (all modes):**

- **`onProgress`** is optional; if omitted, behaviour matches today (no events).
- **When:** event fires at the **start** of step `i` (before the step’s main work), matching `offlineOrchestrator.reportProgress`.
- **`elapsedMs`:** monotonic wall time from a **per-`runAlignTextToAudio` invocation** start (`Date.now()` at entry), unless we later thread a shared session clock (not Phase 0).
- **`currentSegmentDurationMs`:** use **meaningful** duration for the step when known (e.g. anchor audio span in ms); otherwise **`0`** is allowed if the step is not time-scoped (document per row).

**Field mapping (normative names from `OrchestrationProgress`):**

| Field | Meaning |
| --- | --- |
| `currentSegment` | 0-based index of the step **starting now** |
| `totalSegments` | Total steps planned for this invocation **when known at step 0**; see per-mode rules when unknown upfront |
| `fraction` | `totalSegments > 0 ? currentSegment / totalSegments : 1` (same formula as orchestrator) |

---

## Contract table (by `AlignTextToAudioOptions.mode`)

Rows marked **TBD impl** need a short spike in the driver / native bridge to count real inner steps; until then the **fallback** column is the **minimum** contract we ship if we ship progress for that mode at all.

| Mode | Code path (high level) | `totalSegments` | Steps (`currentSegment`) | Fallback if inner steps TBD |
| --- | --- | --- | --- | --- |
| **`accurate`** + `segmentation.mode === 'auto'` + **`chunked_forced_ctc`** | `runAccurateChunkedForcedCtc` | **`anchors.length`** (speech anchors after `toSpeechAnchors`, known before first native call). | **Anchor index `i`** for the native forced-CTC attempt about to start (`0 .. anchors.length-1`). | If no anchors or cursor exhausts before any native attempt, callback may not fire. |
| **`accurate`** + `segmentation.mode === 'auto'` + **`asr_mediated`** | `runAccurateAsrMediated` | **`jobs.length`** from `buildAnchorJobs(...)` (known before first native call). | **Job index `j`** for the native accurate attempt about to start (`0 .. jobs.length-1`). | If no jobs can be materialized, mode fails with linker errors before progress emission. |
| **`accurate`** + `segmentation` absent, `off`, or not `auto` | Native `alignOfflineTextToAudio` (mode resolved as today; see `alignTextToAudio.ts`) | **`1`** | Single step: only `currentSegment === 0` | — |
| **`proportional`** | Native single call | **`1`** | `0` once at start | — |
| **`estimated`** | Native with `chunks.segmentSampleCounts` | **`max(1, segmentSampleCounts.length)`** when counts are the natural progress units; else **`1`**. | `i` = index of chunk **about** to be aligned **if** native/TS exposes sequential work; if native is one opaque call → **`1`** step only | **`1`** |
| **`vad`** | VAD anchors + native; early exit if zero speech anchors | **`1`** if zero anchors (no work); else **TBD impl:** ideally `speechAnchorCount` or derived pass count | If single native batch after anchor prep → **`1`** | **`1`** |
| **`aligned`** (if exposed as user-facing mode name) | Same native family as non-auto accurate path | **`1`** unless we document sub-phases | Single step | **`1`** |

---

## Unknown `totalSegments` upfront

**Phase 0 rule:** avoid extending the `OrchestrationProgress` type for v1. If a driver cannot know `totalSegments` before step 0:

1. Prefer **single-shot** progress: `totalSegments = 1`, `currentSegment = 0`, `fraction = 0` at invocation start (caller gets “started”).
2. If mid-run discovery becomes possible later, add a **follow-up ADR** for optional fields or a dedicated **`AlignmentProgress`** type — **not** Phase 0.

---

## Testing matrix (minimum)

| Mode | Minimum test |
| --- | --- |
| Any mode with `totalSegments === 1` | At most one `onProgress` call with `currentSegment === 0`, `fraction === 0`. |
| Chunked CTC (when multi-step implemented) | `currentSegment` strictly increasing; last `currentSegment === totalSegments - 1`; `fraction` monotonic non-decreasing with formula. |
| `onProgress` undefined | Zero calls (regression guard). |

---

## Doc updates (checklist)

- [x] [alignment-offline.md](../../alignment-offline.md) — new “Progress (`onProgress`)" section linking here + ADR-001.
- [x] [README](./README.md) — Phase 0 row points to this file; strategy row shows **C accepted**.

---

*Living document: adjust rows when implementation spikes complete; bump footnote or date on change.*
