# Implementation plan — Alignment Phase 2: Accurate auto drivers (`chunked_forced_ctc`, `asr_mediated`)

**Goal:** Emit **`OrchestrationProgress`** events from **`runAccurateChunkedForcedCtc`** and **`runAccurateAsrMediated`** at **step start**, with **`totalSegments`** known **before** the first step when possible, matching [phase-0](./phase-0-alignment-progress-semantics.md). Until multi-step semantics are fully validated, the **fallback** remains single-shot (`totalSegments === 1`, `currentSegment === 0`).

**Prerequisites:** [Phase 1](./impl-alignment-phase-1-api.md) complete (`progress.ts`, `onProgress` on options, pass-through into driver inputs).

---

## 1. Shared wiring

### 1.1 Session creation

- At entry of **`runAlignTextToAudio`** (or each driver): `const progress = createAlignmentProgressSession(options.onProgress, Date.now())`.
- Pass **`progress`** (or `onProgress` + startedAt) into **`runAccurateChunkedForcedCtc`** / **`runAccurateAsrMediated`**.

### 1.2 When to call `emitStep`

- **Only** when `options.onProgress` is defined (session no-ops internally).
- Call **immediately before** the expensive native call for that step:
  - chunked: before `SherpaOnnx.alignAccurateForcedCtcFromPcm(...)`
  - asr_mediated: before `SherpaOnnx.alignAccurateFromPcm(...)`

---

## 2. `runAccurateChunkedForcedCtc`

**File:** [`src/alignment/chunkedForcedCtc/driver.ts`](../../../src/alignment/chunkedForcedCtc/driver.ts)

### 2.1 Step definition (normative for v1)

- **Progress steps** map 1:1 to **anchor array indices** in `anchors` (post-`toSpeechAnchors`), in **stable iteration order** of `for (const anchor of anchors)`.
- **`totalSegments = anchors.length`** once `anchors` is known (after empty-anchor early return).
- **`currentSegment`**: 0-based index into `anchors` for the iteration that is **about to** run native alignment.

**Emit points:**

1. Convert `for (const anchor of anchors)` to indexed loop **`for (let i = 0; i < anchors.length; i++)`** (or track index manually).
2. At **top of each iteration**, after `assertAnchorRangeWithinAudio` is acceptable **or** immediately after entering loop — **before** `peekCursorWindow` / native call:
   - `progress.emitStep(i, anchors.length, anchorDurationMs)` where `anchorDurationMs` is derived from `anchor.endSample - anchor.startSample` and `anchor.sampleRate` (same formula as existing `anchorDurationMs` block lines 460–463).
3. **Early exits inside loop** (`continue` on zero frame count, `break` on exhausted cursor): progress already emitted for that index if emit-at-top; **document** that some anchor indices may run “no native call” after progress tick — acceptable coarse UX; alternatively emit **only** when `anchorFrameCount > 0` **but** then `totalSegments` must be precomputed as count of positive-length anchors only — **pick one in PR** and update [phase-0](./phase-0-alignment-progress-semantics.md) contract row if it diverges from “anchor list length”.

**Recommended v1:** `totalSegments = anchors.length`, emit at loop entry **always** (simplest, matches “anchor windows” language in phase-0 TBD row).

### 2.2 Early returns (no progress)

| Return | Progress |
| --- | --- |
| `anchors.length === 0` | No emit (no work). |
| Cursor exhausted before loop | No emit. |
| `segmentOut` non-empty (throw) | No emit before throw. |

### 2.3 Failure mid-loop

- On thrown error after some `emitStep` calls: **no** terminal “complete” event (matches orchestrator — no end tick). Caller uses try/catch.

---

## 3. `runAccurateAsrMediated`

**File:** [`src/alignment/asrMediated/driver.ts`](../../../src/alignment/asrMediated/driver.ts)

### 3.1 Step definition

- **`jobs`** from `buildAnchorJobs(...)` is the natural unit of work (each job → one `alignAccurateFromPcm` attempt).
- **`totalSegments = jobs.length`** after `jobs.length === 0` guard.
- Indexed loop **`for (let j = 0; j < jobs.length; j++)`**, **`emitStep(j, jobs.length, durationMs)`** at **start** of each iteration (`durationMs` from `job.anchor` frame count / sample rate).

### 3.2 `continue` paths

- Jobs with `frameCount <= 0`: if emit-at-top, still fire progress then `continue` — consistent with §2.1 recommendation.

### 3.3 Fallback (TBD)

- If product decides **`jobs` length unknowable** without linker (it is knowable after `buildAnchorJobs`), still use `jobs.length`. If linker refactor changes shape, revisit phase-0 row.

---

## 4. Tests

| Case | Expectation |
| --- | --- |
| `onProgress` undefined | Zero invocations (mock or spy). |
| Chunked: 3 anchors, all processed | Exactly 3 calls; `currentSegment` 0,1,2; `totalSegments === 3`; `fraction` 0, 1/3, 2/3; `elapsedMs` non-decreasing. |
| Chunked: early `break` (cursor exhausted mid-array) | Calls only for iterations entered; document that `fraction` may not approach `1` — **acceptable** for v1 or add note in user docs. |
| Asr_mediated: 2 jobs | Two emissions before respective native calls. |
| Native throws on first anchor | One progress event then rejection. |

**Test strategy:** Prefer **dependency injection** of a fake `SherpaOnnx.alignAccurateForcedCtcFromPcm` in test harness if test infra allows; else **integration** with golden small buffers (slower). At minimum **unit-test** indexed loop with extracted pure function `planChunkedProgressSteps(anchors)` if logic becomes non-trivial.

---

## 5. Documentation updates (in-PR)

- Update [phase-0](./phase-0-alignment-progress-semantics.md) **TBD** rows for chunked / asr_mediated with **chosen** `totalSegments` definition (anchor count vs job count vs positive-duration filter).
- [alignment-offline.md](../../alignment-offline.md): note that **accurate auto** modes emit multi-step progress when `onProgress` set.

---

## 6. Exit criteria

- [ ] Both drivers call `emitStep` at correct boundaries with orchestrator-identical `fraction`.
- [ ] Phase-0 contract table updated from TBD to concrete for these two modes.
- [ ] Automated tests cover ordering and bounds (`0 <= currentSegment < totalSegments`).
- [ ] Manual smoke: one real model + anchor buffer; verify callback cadence in dev menu or logging.

---

## 7. Optional follow-up (not Phase 2 blocker)

- **`currentSegmentDurationMs`:** use anchor span ms (already computed) for richer UI.
- Consider **not** emitting for anchors skipped by `continue` before emit — refactor loop order if UX feedback demands it.
