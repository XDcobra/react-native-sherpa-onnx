# VAD Integration Plan

## Goal

Define a clean, pipeline-contract-aligned way to reuse VAD knowledge (`SegmentBuffer`) across other SDK features without coupling VAD into places where it does not belong.

Core idea:

- VAD is primarily a **segmentation signal** provider.
- Pipeline buffers define data ownership and transport:
  - `AudioBuffer` = audio source/frames
  - `TextBuffer` = transcript/text stream
  - `SegmentBuffer` = speech-boundary/segment metadata

---

## Architecture principles

1. Keep feature engines focused:
   - STT engine does STT
   - TTS engine does TTS
   - VAD engine does speech activity segmentation

2. Reuse VAD outputs via buffer contracts, not hidden coupling.

3. Prefer composable post-/side-processing (alignment, incremental orchestration) over embedding VAD logic directly into every feature.

4. Avoid duplicated segmentation logic across modules.

---

## Integration opportunities (decision matrix)

## 1) Alignment: add a new `vad` mode

### Decision

Implement a new alignment mode (alongside `proportional`, `accurate`, etc.) that uses VAD segments as boundary anchors.

### Why

- Existing modes answer "how to distribute timing over text."
- VAD answers "where natural speech boundaries are."
- Combining both improves subtitle-like segmentation quality.

### Scope

- Add new mode in alignment API/types.
- Consume `SegmentBuffer` + text input.
- Keep timing refinement logic in alignment module (not in VAD).

### API design recommendation

Prefer separating **timing engine mode** from **segmentation source**.

- Keep `mode` focused on timing strategy:
  - `proportional`
  - `estimated`
  - `accurate`
  - `vad`
- Add a separate optional segmentation config instead of combined mode strings:
  - do **not** introduce values like `accurate+vad`
  - use something like `segmentation: { source: 'vad', segmentBuffer: ... }`

Rationale:

- avoids mode explosion (`accurate+vad`, `estimated+vad`, etc.)
- keeps API orthogonal and composable
- makes constraints explicit in types and runtime validation

### Concrete semantics

1. `mode: 'vad'`
   - Requires `segmentBuffer`
   - `segmentBuffer` is offline-only (`seg_off_*`) in current offline alignment API
   - Must not require `alignmentModelPath`
   - Produces segment-anchored subtitle timing without wav2vec2 forced alignment
   - Intended for robust speech-boundary-aware timing when no alignment model is available

2. `mode: 'accurate'` + `segmentation.source: 'vad'`
   - Requires `alignmentModelPath` and `segmentBuffer`
   - Uses VAD boundaries as constraints/anchors
   - Uses wav2vec2 alignment for intra-segment fine timing
   - Intended as highest-quality subtitle mode
   - Implemented as constrained offline path (sequential per mapped anchor)
   - `segmentation.minAnchors?: number` (default `2`, valid `1..10`)
   - If anchor count is below threshold: success with `segmentsWritten=0` (warning in diagnostics), no hard reject

3. `mode: 'accurate'` without VAD segmentation
   - Keeps current accurate behavior (wav2vec2-only path)
   - No `segmentBuffer` required

### Priority

**P1 (highest)**, because it creates a reusable foundation for downstream features.

---

## 2) STT (streaming + offline): no direct VAD coupling in STT core

### Decision

Do **not** directly integrate VAD behavior into STT engine internals.

### Why

- STT already has clear responsibility: transcription.
- Segmenting final text can be handled by alignment with `vad` mode.
- Avoids duplicated/implicit segmentation paths and extra complexity in STT runtime.

### Scope

- Keep STT pipeline contract unchanged.
- Encourage composition:
  1. STT writes `TextBuffer`
  2. Alignment (`vad` mode) derives segment-aware structure

### Priority

**P3** (mostly documentation/usage guidance once alignment `vad` mode exists).

---

## 3) TTS streaming incremental: optional `SegmentBuffer`-driven segmentation

### Decision

Add an optional segmentation source for incremental streaming TTS:

- default: existing synthetic auto-segmentation
- optional: segment boundaries from `LiveSegmentBuffer`

### Why

- Incremental TTS is internally batch-per-segment.
- Segment quality strongly affects perceived latency/prosody.
- Users can choose:
  - synthetic segmentation when no VAD model is available
  - VAD-driven segmentation when VAD pipeline is present

### Scope

- Extend incremental TTS API with optional segment source input.
- When provided, segmentation boundaries come from `LiveSegmentBuffer`.
- Keep synthetic strategy as fallback/default.

### Priority

**P2**, after alignment `vad` mode, as it gives immediate UX quality benefits.

---

## 4) TTS offline + classic streaming: no active VAD embedding

### Decision

No direct active VAD integration in:

- TTS offline (batch synthesis)
- classic streaming TTS where user is already responsible for text segmentation

### Why

- Offline TTS processes full input in one call; no internal segmentation loop needed.
- Classic streaming path intentionally leaves segmentation control to user/app logic.

### Priority

**P4** (no implementation change required).

---

## Recommended implementation order

1. **Alignment `vad` mode** (P1)
2. **Incremental TTS optional `SegmentBuffer` segmentation** (P2)
3. STT composition guidance/docs updates (P3)
4. Keep TTS offline/classic streaming unchanged (P4)

---

## Contract consistency check

This plan is consistent with the pipeline contract:

- data flows through buffers (`AudioBuffer`, `TextBuffer`, `SegmentBuffer`)
- lifecycle/control remains on pipeline handles
- engines remain single-responsibility and composable

---

## Non-goals

- No hard coupling of VAD internals into STT/TTS core decode/synthesis loops.
- No forced VAD dependency for users who do not need VAD.
- No parallel segmentation logic that conflicts with alignment/incremental orchestrators.

---

## Next planning artifacts (suggested)

1. `alignment-vad-mode-plan.md` (API + native + tests)
2. `tts-incremental-segmentbuffer-plan.md` (API surface + runtime behavior + fallback rules)
3. examples/docs update checklist after both integrations land
