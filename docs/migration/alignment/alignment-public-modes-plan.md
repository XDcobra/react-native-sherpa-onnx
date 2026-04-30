# Alignment: Public Modes & Accurate-Path Strategies (High-Level Plan)

## Purpose

This document is the **migration-facing overview** for the next offline alignment shape:

- **`proportional` and `estimated` remain** as today (no structural change).
- The **main lever is `mode: 'accurate'`**: segmentation-off vs segmentation-on, and—when segmentation is on—choice of **two long-term, memory-safe mapping strategies** (Vorschlag **A** and **B** from product discussion).
- The **current text↔anchor heuristic** (`mapUnitsToAnchorsMonotonicWeight` / `vadMonotonicWeightDP` style) is **intended to be removed** for the constrained-accurate path once A/B are implemented; **breaking changes are acceptable**.
- **Streaming alignment** as a separate public API remains **out of scope** for this document; “streaming” below refers only to **internal** chunked/streaming processing of audio (VAD, ASR, PCM windows) to avoid loading multi-hour material fully into alignment core memory.
- **Public API shape** (not yet released): alignment follows the same **engine** pattern as STT/TTS — see [Public API: `AlignmentEngine`](#public-api-alignmentengine) below.

Related legacy notes (superseded for mapping semantics when this plan lands):

- `docs/migration/alignment/accurate-vad-segmentation-high-level-plan.md` — first rollout assumed reuse of monotonic weight mapping; **this plan replaces that mapping goal** for constrained `accurate`.
- `docs/migration/alignment/offline-alignment-pipeline-spec.md` — contract for buffers and thresholds may be updated when A/B land (diagnostics, strategy fields).

---

## Architecture decision: where each strategy lives

| Strategy | Owner (SDK component) | Rationale |
|----------|------------------------|-----------|
| **A — ASR-mediated** | **Dedicated linker/orchestrator** (Path 3: see below) **+** Alignment | Produces **reference text ↔ audio time** couplings and per-anchor text spans; **reusable** beyond alignment (subtitles, karaoke, search/indexing). **Not** implemented as a new SegmentationEngine policy (keeps the engine lean; avoids ASR+DTW as a “policy” inside the same surface as energy/VAD). |
| **B — Chunked forced CTC + token cursor** | **Alignment engine / alignment native path only** | Text consumption is **driven by the CTC model**; not a separable cross-domain segmenter. No meaningful reuse for other features without the alignment model. |

**Path 3 (Strategy A) in one sentence:** introduce a **reusable cross-domain module** (working name: **transcript–audio linker** or similar) that:

- consumes **speech anchors** (from SegmentationEngine, e.g. `speech_vad_model` on offline audio),
- consumes a **caller-filled hypothesis `OfflineTextBuffer`** **H** (tokens + timestamps from STT — the **caller** runs `transcribe` before alignment; **`AlignmentEngine#alignTextToAudio` does not invoke STT** for ASR-mediated),
- runs **reference ↔ hypothesis** sequence alignment (token/DTW) on **R** and **H**,
- emits **per-anchor reference text spans** and/or standard **`SegmentLink` / link-map** artifacts that **downstream** code (Alignment, and later other features) can consume.

**Alignment** then only runs **forced CTC** per anchor on the **assigned substring** + **PCM slice**. STT orchestration stays **outside** the alignment entry point for this strategy so apps control model, options, and timestamp-capable configs.

**SegmentationEngine** remains responsible only for **boundary production** in the text or speech domain (here: **speech** `seg_off_*` anchors). It is **not** extended with ASR-mediated mapping logic.

---

## Public API: `AlignmentEngine`

Alignment is exposed like other features (**create engine → call methods → destroy**), not as a single freestanding function.

### Factory & lifecycle

| API | Role |
|-----|------|
| **`createAlignment(options?)`** | Returns an **`AlignmentEngine`** instance. **`options`** may include defaults reused across calls (e.g. optional **default** `modelPath` as **`ModelPathConfig`**, `language`, debug). **`options`** may be **empty** / minimal when everything is passed per call — exact shape is implementation-defined. |
| **`engine.destroy()`** | Releases native/state held by the engine (symmetric to `createSTT().destroy()` / `createTTS`). Safe to no-op on JS-only wrappers until native caches alignment models. |

### Instance methods (buffer-first contract unchanged)

All alignment modes use the **same buffers** as today: **`OfflineTextBuffer`** (`textIn`), **`OfflineAudioBuffer`** (`audioIn`), **`OfflineSegmentBuffer`** (`segmentOut`).

| Method (target) | Description |
|-----------------|-------------|
| **`engine.alignTextToAudio(textIn, audioIn, segmentOut, options)`** | **Primary** entry: **`options.mode`** selects `proportional` \| `estimated` \| `accurate` \| `vad` and the discriminated-union fields (unchanged semantically from current `AlignTextToAudioOptions`). |

**Optional later split** (if types get too large): `alignProportional`, `alignEstimated`, `alignAccurate`, `alignVad` as thin wrappers with narrower option types. The high-level plan does **not** require the split for v1—**one** `alignTextToAudio` on the engine is enough.

### Removal of the freestanding function

- **Remove** the module-level export **`alignTextToAudio(...)`** (e.g. from `react-native-sherpa-onnx/alignment`) as a **public** entry point.
- **Cold cut** is acceptable (SDK not yet published). Internal tests and the example in [alignment-asr-mediated-ts-example.md](alignment-asr-mediated-ts-example.md) should use **`const engine = await createAlignment(…); await engine.alignTextToAudio(…); await engine.destroy()`** (or `try/finally`).

### Modes without a CTC model

- **`proportional`** and **`estimated`** do not require `modelPath`; **`createAlignment()`** may be called with no model paths. Per-call validation still rejects invalid **`options`** for the chosen `mode`.

---

## Public modes overview (target state after A + B)

**Entry shape (target):** `const engine = await createAlignment(…); await engine.alignTextToAudio(textIn, audioIn, segmentOut, options);` — buffer-first; **`options.mode`** selects the row below.

Field names (`anchorSegmentBuffer`, `mappingStrategy`, nested `segmentation`) are **illustrative** until `src/alignment/types.ts` matches this plan. **`engine`** = `AlignmentEngine` from `createAlignment()`.

<!-- HTML table: first column narrow (row index only); GFM does not support column width on pipe tables. -->
<table>
<colgroup>
  <col style="width:2.5em; min-width:2.5em; max-width:2.5em" />
  <col />
  <col />
  <col />
  <col />
  <col />
  <col />
</colgroup>
<thead>
<tr>
<th scope="col">#</th>
<th scope="col"><code>mode</code></th>
<th scope="col">SegmentationEngine / segmentation option</th>
<th scope="col">Alignment model (CTC)</th>
<th scope="col">Internal mapping strategy (when relevant)</th>
<th scope="col">Summary</th>
<th scope="col">Target <code>options</code> sketch (call: <code>engine.alignTextToAudio(textIn, audioIn, segmentOut, options)</code>)</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>1</strong></td>
<td><code>proportional</code></td>
<td>Not used</td>
<td>No</td>
<td>—</td>
<td>Duration × text-weight; granularity <code>sentence</code> | <code>word</code>.</td>
<td><code>{ mode: 'proportional', granularity?: 'sentence' | 'word', language?: string }</code></td>
</tr>
<tr>
<td><strong>2</strong></td>
<td><code>estimated</code></td>
<td>Not used</td>
<td>No</td>
<td>—</td>
<td>Caller <code>segmentSampleCounts</code> timeline; <code>sentence</code> | <code>word</code>.</td>
<td><code>{ mode: 'estimated', chunks: { sampleRate, segmentSampleCounts }, granularity?: 'sentence' | 'word', language?: string }</code></td>
</tr>
<tr>
<td><strong>3</strong></td>
<td><code>accurate</code></td>
<td><strong>Off</strong> / absent (<code>segmentation.mode</code> omitted or <code>off</code>)</td>
<td><strong>Yes</strong> (<code>modelPath: ModelPathConfig</code> required)</td>
<td><strong>Single full-buffer CTC</strong> — one <code>AlignAccurateFromPcm</code> over entire offline PCM</td>
<td>Best quality when file fits practical memory/time limits; <code>sentence</code> | <code>word</code> | <code>character</code>.</td>
<td><code>{ mode: 'accurate', modelPath: ModelPathConfig, granularity?: 'sentence' | 'word' | 'character', language?: string }</code> — no <code>segmentation</code>, or <code>segmentation: { mode: 'off' }</code> once types define it</td>
</tr>
<tr>
<td><strong>4a</strong></td>
<td><code>accurate</code></td>
<td><strong>On</strong> (<code>segmentation</code> with <code>mode: 'auto'</code> and speech policy, e.g. <code>speech_vad_model</code>; anchors in <code>seg_off_*</code>; <strong>pre-filled ASR hypothesis buffer</strong> for linker)</td>
<td><strong>Yes</strong></td>
<td><strong>Strategy A — ASR-mediated</strong> via <strong>linker (Path 3)</strong> + CTC in Alignment</td>
<td>Caller runs <strong><code>transcribe</code> → H</strong>; segmentation → speech anchors; <strong>linker</strong> → per-anchor reference spans (R↔H DTW); <strong>AlignmentEngine</strong> path → CTC per slice only. <strong>No internal STT</strong> on <strong><code>engine.alignTextToAudio</code></strong>. <strong>OOM-safe</strong> (long audio). Reusable linker for future non-alignment features.</td>
<td><code>mappingStrategy: 'asr_mediated'</code> + <code>segmentation</code> with <code>anchorSegmentBuffer</code> + <code>asr.hypothesisTextBuffer</code> — <strong>expanded:</strong> <a href="#target-options-sketches-by-row">§ Row 4a</a></td>
</tr>
<tr>
<td><strong>4b</strong></td>
<td><code>accurate</code></td>
<td><strong>On</strong> (same anchor contract as 4a)</td>
<td><strong>Yes</strong></td>
<td><strong>Strategy B — Chunked forced CTC + token cursor</strong> (Alignment <strong>only</strong>)</td>
<td>No ASR; cursor + windowed CTC per anchor; <strong>OOM-safe</strong>; more edge-case sensitive than A.</td>
<td>Same as 4a but <code>mappingStrategy: 'chunked_forced_ctc'</code> and <strong>no</strong> <code>asr</code> block — <strong>expanded:</strong> <a href="#target-options-sketches-by-row">§ Row 4b</a></td>
</tr>
<tr>
<td><strong>5</strong></td>
<td><code>vad</code></td>
<td>Typically <strong>on</strong> (engine fills <code>speech</code> anchors)</td>
<td><strong>No</strong></td>
<td>Monotonic text↔anchor or slimmer path if product narrows scope</td>
<td>Time from VAD/speech anchors only; no wav2vec2; <code>sentence</code> | <code>word</code>.</td>
<td><code>{ mode: 'vad', granularity?: 'sentence' | 'word', language?: string, segmentation: { source: 'vad', segmentBuffer: anchorRef, minAnchors?: number } }</code> (shape aligned with today’s <code>AlignTextToAudioOptionsVad</code>; <code>source</code>/<code>field names</code> may be renamed when types are consolidated)</td>
</tr>
</tbody>
</table>

**Notes:**

- Rows **4a** and **4b** are not separate top-level `mode` literals; they are **`accurate` + segmentation on** distinguished by an explicit **strategy selector** in options (e.g. `mappingStrategy: 'asr_mediated' | 'chunked_forced_ctc'`). Only one strategy applies per call.
- **Anchor contract** for rows 4a/4b: offline segment buffer with `kind: 'speech'` segments and valid sample ranges — produced by **SegmentationEngine** (e.g. `segmentOfflineBuffer` on offline audio with `speech_vad_model`), not by duplicate VAD logic inside alignment or the linker.

### Target `options` sketches by row (expanded TypeScript)

Illustrative multi-line objects for copy/paste while implementing types. **`textIn`**, **`audioIn`**, **`segmentOut`** are existing offline buffer refs.

**Row 1 — `proportional`**

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'proportional',
  granularity: 'word',
  language: 'en',
});
```

**Row 2 — `estimated`**

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'estimated',
  granularity: 'word',
  chunks: {
    sampleRate: 16000,
    segmentSampleCounts: [3200, 4000, 2800],
  },
  language: 'en',
});
```

**Row 3 — `accurate` (segmentation off, one-shot CTC)**

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'accurate',
  modelPath: { type: 'file', path: '/path/to/wav2vec2-alignment' }, // ModelPathConfig (STT/VAD shape)
  granularity: 'word', // or 'sentence' | 'character'
  language: 'en',
});
```

**Row 4a — `accurate` + ASR-mediated (`mappingStrategy: 'asr_mediated'`)**

Caller must run `transcribe(audioIn, asrHypothesisOut, …)` **before** this call; `anchorRef` comes from e.g. `segmentOfflineBuffer(audioIn, { evaluator: 'speech_vad_model', … })`.

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'accurate',
  modelPath: { type: 'file', path: '/path/to/wav2vec2-alignment' },
  granularity: 'word',
  language: 'en',
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: anchorRef, // or { segmentBufferId: 'seg_off_…' }
    mappingStrategy: 'asr_mediated',
    asr: {
      hypothesisTextBuffer: asrHypothesisOut,
    },
  },
});
```

**Row 4b — `accurate` + chunked forced CTC (`mappingStrategy: 'chunked_forced_ctc'`)**

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'accurate',
  modelPath: { type: 'file', path: '/path/to/wav2vec2-alignment' },
  granularity: 'word',
  language: 'en',
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: anchorRef,
    mappingStrategy: 'chunked_forced_ctc',
  },
});
```

**Row 5 — `vad` (anchor timing only, no CTC)**

```typescript
await engine.alignTextToAudio(textIn, audioIn, segmentOut, {
  mode: 'vad',
  granularity: 'word',
  language: 'en',
  segmentation: {
    source: 'vad',
    segmentBuffer: anchorRef,
    minAnchors: 2,
  },
});
```

---

## What stays unchanged

### `proportional`

- No alignment model, no segmentation engine requirement.
- Same inputs/outputs as today (`docs/alignment.md`).

### `estimated`

- No alignment model, no segmentation engine requirement.
- Same chunk timeline contract as today.

---

## `accurate` — segmentation off (row 3)

- **Behavior:** read full offline PCM once (as today), run **single** CTC alignment over full transcript.
- **SegmentationEngine:** not involved.
- **Rationale:** simplest and strongest mapping when the audio length is acceptable for memory and runtime.
- **Long-form caveat:** for multi-hour sources, callers should prefer row **4a** or **4b** instead of relying on full-buffer CTC.

---

## `accurate` — segmentation on: Strategy A (ASR-mediated, Path 3 linker)

**Goal:** Robust, data-driven assignment of **which substring of the reference transcript** belongs to **which speech anchor window**, without length-only heuristics — implemented so the **same building block** can serve alignment today and **subtitles / karaoke / indexing** tomorrow.

**Ownership:**

- **SegmentationEngine:** produces `speech` anchors only (unchanged contract).
- **Caller / STT:** produces hypothesis **H** by **`transcribe(audio → OfflineTextBuffer)`** (or equivalent) **before** alignment — **full control** over STT model, `modelOptions`, and `SttTranscribeOptions`. **`AlignmentEngine#alignTextToAudio` must not call STT** for ASR-mediated.
- **Linker module (new, reusable):** reference ↔ hypothesis alignment + **slice assignment** per anchor (outputs spans and/or `SegmentLink`-style artifacts). **Does not** live inside SegmentationEngine as a policy.
- **Alignment:** consumes linker output; runs **only** `AlignAccurateFromPcm` per anchor slice + assigned substring.

**High-level pipeline:**

1. **Anchors (audio side):** SegmentationEngine produces `speech` segments (e.g. `speech_vad_model` on offline audio). Processing can be **streamed/chunked** at the engine/native layer so memory stays bounded.
2. **Hypothesis H (caller):** Caller runs STT so **`H`** is an **`OfflineTextBuffer`** with text + **token-level timestamps** (`timestampCount > 0` when required). Pass **`hypothesisTextBuffer`** (or final field name) into **`engine.alignTextToAudio`** **only** as this pre-filled buffer.
3. **Linker — reference ↔ hypothesis alignment:** Align reference transcript **R** to ASR output **H** with a standard sequence alignment (token-level edit distance / DTW-style). This yields, for spans of **R**, approximate **audio time ranges** (via H’s timestamps).
4. **Linker — slice assignment:** For each anchor `[t_start, t_end)` in samples, select the **reference text span** whose aligned time overlap falls into that window (policy TBD: overlap maximization, midpoint rules, minimum span).
5. **Alignment — fine alignment:** For each anchor, run **existing** `AlignAccurateFromPcm` on **PCM slice ∩ anchor** with **only** the assigned reference substring; emit `alignment` segments as today.

**Public API note:** the **`segmentation.asr`** (or equivalent) block contains **`hypothesisTextBuffer`** only — **no** `sttInstanceId` / internal transcribe for ASR-mediated.

**Properties:**

- **Does not** depend on total audio size for holding full PCM in a single alignment tensor beyond **per-anchor** windows (plus ASR/VAD streaming budgets).
- **Dependency:** ASR model and config are **chosen by the app** when calling `transcribe`; the linker depends on **H**’s buffer metadata, not on owning STT.

**Failure modes (to document in implementation spec):** ASR/language mismatch, empty hypothesis, pathological repeats — mapped to explicit error or warning codes.

**Hypothesis must carry token timestamps (deterministic, no fallback):**

- ASR-mediated requires the STT hypothesis **H** (`OfflineTextBuffer` after `transcribe`) to expose **token-level timestamps** via the existing text-buffer metadata (e.g. **`timestampCount > 0`** from `getPipelineTextBufferInfo`, consistent with `getOfflineTextBufferTimestampsSlice`). Not every sherpa-onnx STT model populates `r.timestamps`; that is **model- and configuration-dependent**.
- If **`timestampCount === 0`** (or timestamps cannot be paired with tokens for linking), implementations **must reject** with a dedicated error — **no silent fallback** to Strategy B, monotonic weight mapping, or other heuristics inside ASR-mediated.
- **Suggested code:** **`ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`**. Error text should instruct the caller to use an STT pack/settings that emit token timestamps (per model docs), or to choose another **`mappingStrategy`** / **`accurate`** variant / mode (`chunked_forced_ctc`, full-buffer `accurate`, `proportional`, `estimated`, `vad`, etc.).

**Codebase + target TS call site:** see [alignment-asr-mediated-ts-example.md](alignment-asr-mediated-ts-example.md) (verified STT → `OfflineTextBuffer` + token/timestamp slices; `segmentOfflineBuffer` anchors; **`createAlignment` + `engine.alignTextToAudio`** after implementation; timestamp requirement and error code).

---

## `accurate` — segmentation on: Strategy B (chunked forced CTC + token cursor, Alignment only)

**Goal:** Long-form safe path **without** requiring ASR on the alignment route.

**Ownership:** **Alignment engine / native alignment implementation only** — no standalone linker; not intended as a shared subtitle/index primitive.

**High-level pipeline:**

1. **Anchors:** Same as A — `speech` segments from SegmentationEngine (streaming-friendly).
2. **Text cursor:** Maintain a cursor into the reference **R** (token or character index).
3. **Per anchor:** Take a **window of text** starting at the cursor (width policy: anchor-duration estimate, max char cap, safety overlap).
4. **Forced CTC** on anchor PCM slice + text window; use **alignment confidence / path** to decide how much of **R** is **consumed** for this anchor (advance cursor).
5. **Overlap / backtrack policy** between anchors to recover from boundary errors (implementation detail in native/core).

**Properties:**

- No ASR dependency for this strategy.
- **More fragile** than A under silence, repetitions, or large speed mismatch; requires careful scoring thresholds and tests.

---

## `vad` mode (row 5)

- **No CTC model:** text units mapped to **speech** anchor time ranges only (buffer-anchored timing; same public **`mode: 'vad'`** in **`engine.alignTextToAudio(..., options)`**).
- SegmentationEngine remains the **recommended** producer of `speech` anchors for consistency across features.

---

## Pre-implementation decisions (locked)

These decisions are agreed before implementation to avoid ambiguity and late API churn.

### Confirmed product/engineering choices

- **No silent fallback (global):** when a selected strategy cannot run (invalid config/data), fail explicitly with deterministic error codes. This applies to ASR-mediated and all other alignment paths.
- **Hard cut immediately:** no compatibility alias for old naming (`alignmentModelPath`, `vadModelId`) in public SDK paths.
- **Tests without E2E:** current scope uses unit + integration-style tests around JS orchestration, option parsing, and bridge/native behavior; no dedicated E2E environment is required for this phase.
- **OOM policy:** do not add extra memory guardrail warnings at API level. OOM errors from onnxruntime/sherpa-onnx should propagate transparently (`OFFLINE_OOM` / mapped error) without fallback.
- **Breaking-change migration notes:** not required for this phase.

### Linker output shape (Path 3): choose rich model

Path 3 linker should output a **rich link-map + confidence** model internally (not just minimal span assignments), so the same artifacts can power future features (karaoke, subtitle tooling, indexing/search) without redesign.

**Implementation guidance:**

- Alignment row **4a** may consume only the subset needed for per-anchor CTC in v1.
- Internally, linker stores/emits richer artifacts from day 1 to keep forward compatibility.
- Public linker API can remain deferred; internal shape should already be public-API-ready.

### Internal linker result schema (v0, proposed)

```typescript
type LinkerWarningCode =
  | 'LINKER_LOW_CONFIDENCE'
  | 'LINKER_AMBIGUOUS_MAPPING'
  | 'LINKER_SPARSE_TIMESTAMPS';

type LinkerErrorCode =
  | 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS'
  | 'LINKER_EMPTY_HYPOTHESIS'
  | 'LINKER_TOKEN_TIMESTAMP_MISMATCH'
  | 'LINKER_ALIGNMENT_FAILED';

type LinkerMappingUnit = {
  anchorSegmentId: string; // seg_off_* speech anchor id
  anchorStartSample: number;
  anchorEndSample: number;
  referenceStartToken: number; // inclusive
  referenceEndToken: number; // exclusive
  confidence: number; // 0..1
  overlapRatio?: number; // optional diagnostics
};

type LinkerResultV0 = {
  status: 'ok' | 'warning';
  mappingUnits: LinkerMappingUnit[]; // primary input for per-anchor CTC
  linkMapId?: string; // optional SegmentLinkMap id when materialized
  warnings?: Array<{
    code: LinkerWarningCode;
    message: string;
    anchorSegmentId?: string;
  }>;
  diagnostics?: {
    medianConfidence?: number;
    minConfidence?: number;
    ambiguousAnchorCount?: number;
    unassignedAnchorCount?: number;
    unmatchedReferenceTokenCount?: number;
  };
};
```

**v0 invariants:**

- `mappingUnits` must be ordered by `anchorStartSample`.
- Token ranges must be monotonic and non-overlapping unless an explicit overlap mode is introduced later.
- `confidence` must be normalized to `0..1` across platforms.
- Fatal linker failures return explicit `LinkerErrorCode`; no fallback path is auto-selected.

---

## Implementation sequencing (suggested)

1. **`AlignmentEngine` public surface:** Introduce **`createAlignment`**, **`AlignmentEngine`** with **`alignTextToAudio`**, **`destroy`**. **Remove** exported freestanding **`alignTextToAudio`**; update `src/alignment/index.ts`, tests, and examples. Optional split methods only if option types become unwieldy.
2. **Types & public contract:** Add strategy discriminator for `accurate` + segmentation on (e.g. `mappingStrategy: 'asr_mediated' | 'chunked_forced_ctc'`). Keep standalone timing mode as **`mode: 'vad'`** (row 5). Register **`ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`** for ASR-mediated when `timestampCount === 0` (deterministic; document in `docs/alignment.md`).
3. **Linker (Path 3):** Define module boundary, inputs/outputs (buffers + link map / span list), ASR + DTW integration; unit tests independent of alignment.
4. **Strategy A:** Wire `mappingStrategy: 'asr_mediated'` → linker → per-anchor CTC in alignment; **remove** monotonic weight mapping from this path. Validate hypothesis timestamps before DTW; **fail fast** if missing.
5. **Strategy B:** Implement **only** inside alignment; wire `mappingStrategy: 'chunked_forced_ctc'`; remove heuristic from this path when ready.
6. **Tests:** long-audio fixtures (synthetic + real), mismatch cases, empty anchors, `minAnchors` thresholds; linker tests without full alignment where possible.
7. **Docs:** update `docs/alignment.md` and retire/supersede paragraphs that mandate `vadMonotonicWeightDP` for constrained accurate.
8. **Future:** expose linker APIs for non-alignment features (subtitles, karaoke, indexing) when product-ready — **without** moving linker logic into SegmentationEngine.

---

## Non-goals (this plan)

- Public **streaming** `alignLive…` API (live text/audio buffers) — tracked separately if product revives it.
- Guaranteeing **character** granularity inside **segmentation-on** `accurate` for strategies A/B until explicitly specified (today constrained accurate is `sentence` \| `word`).
- Extending **SegmentationEngine** with ASR-mediated or DTW policies — **rejected** in favor of Path 3 linker + lean engine.
- **Silent fallback** when ASR-mediated is selected but the hypothesis buffer lacks token timestamps — **rejected**; use **`ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`** instead.
- **`AlignmentEngine#alignTextToAudio` invoking STT internally** for ASR-mediated — **rejected**; hypothesis buffer must be **caller-filled** via `transcribe` (or equivalent).
- **Freestanding `alignTextToAudio` export** — **rejected** for public SDK; use **`createAlignment` + instance method** only.

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-29 | Initial high-level plan: public modes table + strategies A/B + scope |
| 2026-04-30 | Architecture decision: **B** = alignment-only; **A** = Path 3 **linker** module + alignment; SegmentationEngine not extended for ASR-mediated mapping |
| 2026-04-30 | ASR-mediated: require token timestamps in H; **`ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`** if absent; no silent fallback; other strategies remain available |
| 2026-04-30 | ASR-mediated public API: **caller-provided** `hypothesisTextBuffer` only; **`AlignmentEngine#alignTextToAudio` does not invoke STT** |
| 2026-04-30 | Public modes table row 5: **`vad`** (not `anchors`) for anchor-only timing without CTC |
| 2026-04-30 | Public API: **`AlignmentEngine`** via **`createAlignment`**, **`engine.alignTextToAudio`**, **`destroy`**; **remove** freestanding **`alignTextToAudio`** |
| 2026-04-30 | Public modes table: column **Target `options` sketch** + subsection **expanded TypeScript** per row |
| 2026-04-30 | Public modes table: HTML + `<colgroup>` so column **#** stays narrow |
| 2026-04-30 | Accurate alignment + engine defaults: **`modelPath: ModelPathConfig`** (STT/VAD shape), not `alignmentModelPath: string` |
| 2026-04-30 | Pre-implementation decisions locked: **no silent fallbacks**, **hard cut now**, **tests without E2E**, **OOM passthrough**, and **Path 3 rich linker model (`link-map + confidence`)** with v0 schema |
