# SegmentBuffer Alignment Hard-Cut High-Level Plan

## Goal

Establish a strict buffer-first public contract for alignment, with a hard/cold cut:

- alignment no longer exposes result-object outputs
- alignment writes output into `SegmentBuffer`
- `SegmentBuffer` is extended to represent both speech and alignment segments
- remove public `AlignTextToAudioResult` and `SubtitleTimingItem` types

This removes the current pipeline inconsistency where alignment has input buffers but no output buffer.

---

## Why now

- SDK is not published yet, so breaking changes are acceptable.
- A hard/cold cut avoids long-term dual APIs and compatibility complexity.
- Future pipeline composition (e.g. alignment output consumed by downstream features) requires stable buffer contracts.

---

## Target architecture

Pipeline contract stays role-based:

- `AudioBuffer`: waveform source and sample timeline
- `TextBuffer`: transcript/text stream
- `SegmentBuffer`: segment metadata transport (speech + alignment)

Alignment becomes:

- input: `OfflineTextBuffer` + `OfflineAudioBuffer` (+ optional VAD `SegmentBuffer` anchors)
- output: `OfflineSegmentBuffer` containing alignment/subtitle segments

No public API path should rely on subtitle result objects.

---

## High-level API direction

1. Extend segment semantics:
   - broaden `SegmentKind` from speech-only to multi-kind (`speech`, `alignment`).
   - define canonical, strict, versioned payload shape for alignment segments (text and timing metadata).

2. Make alignment output buffer-based:
   - alignment API must accept an explicit caller-provided output segment buffer handle.
   - no internal auto-create output buffer behavior.
   - remove result-object success contract from public API.
   - remove `AlignTextToAudioResult` and `SubtitleTimingItem` from public alignment exports.

3. Keep mode model orthogonal (per VAD integration plan):
   - timing mode (`proportional`, `estimated`, `accurate`, `vad`)
   - optional segmentation source (`segmentBuffer` as VAD anchors)

4. Optional helper policy (non-contract, app-layer only):
   - no SDK-level subtitle result helpers are part of the core alignment contract.
   - app-side mapping from segment entries to UI subtitle structures is allowed, but remains outside the alignment public API surface.

---

## Implementation phases

Implement the 3 high-level decisions as separate, reviewable slices (A -> B -> C), then finalize docs and regression.

### Phase 1 (Slice A): Extend segment semantics (`alignment` kind)

Scope:
- Extend `SegmentKind` to include `alignment` (keep `speech` unchanged).
- Define strict `AlignmentSegmentPayloadV1` contract:
  - required: `schemaVersion`, `text`, `timingMode`, `granularity`
  - optional: `confidence`, token/word metadata, language hints
- Add kind-specific runtime validation entry points (JS + native stubs if needed), but do not change alignment API shape yet.

Must-not-change in this slice:
- No alignment output ownership changes yet.
- No alignment mode behavior changes yet.

Acceptance criteria:
- TS compile-time contract supports `alignment` segments.
- Segment serialization/deserialization paths accept/reject `alignment` payload deterministically.
- Existing `speech` segment behavior remains unchanged.

Suggested PR boundary:
- SegmentBuffer types + validators + focused tests only.

### Phase 2 (Slice B): Make alignment output buffer-based (caller-owned only, Variant A)

Scope:
- Change alignment API contract to require caller-provided output `OfflineSegmentBuffer`.
- Remove public result-object contract:
  - remove `AlignTextToAudioResult`
  - remove `SubtitleTimingItem`
- Remove result-object-based exports/flows from `src/alignment`.
- Enforce output buffer lifecycle/state checks with stable error mapping.

Must-not-change in this slice:
- Do not add auto-create output behavior.
- Do not couple this slice to new mode semantics beyond what is already shipping.

Acceptance criteria:
- Alignment can only succeed by writing to caller-provided output segment buffer.
- Public alignment types/exports no longer include removed result-object types.
- Deterministic errors for invalid/missing/wrong-kind output buffer.

Suggested PR boundary:
- Alignment TS API + bridge contract updates + minimal runtime wiring + tests.

### Phase 3 (Slice C): Keep mode model orthogonal (VAD integration alignment)

Scope:
- Implement orthogonal mode semantics exactly as planned in `docs/migration/vad/vad-integration-plan.md`:
  - timing mode: `proportional` | `estimated` | `accurate` | `vad`
  - optional segmentation source: VAD segment buffer anchors
- Enforce invalid combination rejection at type-level and runtime.
- Ensure `accurate + vad segmentation source` remains composable without mode explosion.

Must-not-change in this slice:
- No reintroduction of result-object outputs.
- No hidden VAD coupling into non-alignment engines.

Acceptance criteria:
- Allowed combinations run and write canonical `alignment` segments to output buffer.
- Disallowed combinations fail with stable error codes.
- Cross-feature composition path is valid: STT/Text + Audio + optional VAD segments -> alignment segment buffer output.

Suggested PR boundary:
- Alignment option types + validation + mode runtime changes + tests.

### Phase 4: Docs/examples hard cut

Scope:
- Rewrite `docs/alignment.md` with buffer-only output examples.
- Update related docs/examples to consume `alignment` segments from `SegmentBuffer`.
- Remove all public references to removed result-object types.

Acceptance criteria:
- No user-facing docs/snippets reference `AlignTextToAudioResult` or `SubtitleTimingItem`.
- Examples reflect caller-owned output buffer lifecycle.

### Phase 5: Regression, hardening, and release gate

Scope:
- Add/execute full matrix tests:
  - kind/payload schema validation (`alignment` v1)
  - output buffer ownership/state errors
  - mode/segmentation-source combination matrix
  - native parity (Android/iOS) for success + failure mapping
- Run composition smoke tests on representative flows.

Acceptance criteria:
- Deterministic behavior across JS/native boundaries.
- No legacy contract leak in exports, docs, or examples.
- All three slices are shippable together as one hard-cut release milestone.

---

## Key design decisions to lock early

1. Segment kind naming:
   - hard decision: use `alignment` as segment kind name.
   - reserve `subtitle` for potential future features with distinct semantics.

2. Output buffer ownership:
   - hard decision: caller-provided output buffer only (Variant A).
   - alignment API never auto-creates output segment buffers.
   - lifecycle ownership (create/release) remains fully with caller for consistency with other pipeline APIs.

3. Payload schema strictness:
   - hard decision: strict, versioned payload schema with required fields and deterministic validation.
   - required fields must be validated in JS and native layers.
   - unknown/invalid payload values must fail with stable alignment/segment error codes (no silent coercion).

4. Result object fate:
   - hard decision: remove `AlignTextToAudioResult` and `SubtitleTimingItem` from public SDK contract.

5. Alignment payload v1 baseline:
   - required: `schemaVersion`, `text`, `timingMode`, `granularity`.
   - optional: extended metadata (`confidence`, token/word metadata, language hints) only when schema-compatible.
   - all future payload changes must be additive and version-gated.

---

## Risks and mitigations

- Risk: SegmentBuffer becomes too generic and loosely validated.
  - Mitigation: enforce kind-specific payload schema and runtime guards.

- Risk: Breaking changes spread across docs/examples in inconsistent ways.
  - Mitigation: complete hard cut in one migration slice, then run full doc/example sweep.

- Risk: Native/JS contract drift during transition.
  - Mitigation: freeze API signatures first, then implement bridge and runtime changes against locked types.

---

## Non-goals

- No backward compatibility layer for previous alignment result-based output.
- No duplication of subtitle timing storage in a second dedicated buffer type.
- No coupling of VAD internals into alignment implementation beyond segment buffer contract usage.

---

## Recommended execution order

1. Slice A: Extend segment semantics (`alignment` kind + payload v1).
2. Slice B: Buffer-only alignment output (Variant A, caller-owned).
3. Slice C: Orthogonal mode model + VAD segmentation source composition.
4. Docs/examples hard cut.
5. Regression matrix + release gate.

This order minimizes rework and keeps the hard/cold cut coherent.
