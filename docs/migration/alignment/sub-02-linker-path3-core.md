# Sub-Plan 02 — Linker Core (Path 3, ASR-mediated)

## Status
- **Completed (2026-04-30)**
- Depends on: sub-01
- Prerequisite for: sub-03, sub-05 (parts), sub-06

---

## 1. Scope

Implement the **reusable transcript↔audio linker** that powers `asrMediated`. It produces a **rich result model** (`LinkerResultV0` = link map + confidence + diagnostics) consumable by alignment v1 and reusable by future features (subtitles, karaoke, search highlight). The linker takes:

- `audioIn: OfflineAudioBufferRef`
- `anchors: OfflineSegmentBufferRef` (speech anchors)
- `referenceText: OfflineTextBufferRef` (R) — what should be aligned
- `hypothesisTextBuffer: OfflineTextBufferRef` (H) — ASR text **with timestamps**

…and returns mapping units that connect tokens/words of R to anchor + audio time ranges.

---

## 2. Non-Goals

- No CTC inside linker (CTC happens in sub-03 per anchor).
- No `chunkedForcedCtc` logic.
- No model loading inside linker — pure DSP/text alignment over inputs.
- No public `Linker` SDK surface; v1 is internal-only and consumed by `AlignmentEngine`.

---

## 3. Current State (Ist)

- No linker module exists (TS, Kotlin, or C++).
- ASR pipeline already produces hypotheses with token timestamps when configured (`stt_produced` SegmentLink path lives in `src/stt/__tests__/transcribe-segmented.test.ts`).
- Anchors today are produced via `segmentOfflineBuffer({ policy: { evaluator: 'speech_vad_model', modelPath: <FileSource> } })` (JS **`detectVadModel`** on `modelPath`).

---

## 4. Target State (Soll)

### 4.1 TS API (internal)

```typescript
// src/alignment/linker/types.ts
export interface LinkerInput {
  audioIn: OfflineAudioBufferRef;
  anchors: OfflineSegmentBufferRef;
  referenceText: OfflineTextBufferRef;
  hypothesisTextBuffer: OfflineTextBufferRef;
  granularity: 'token' | 'word';
  language?: string;
}

export interface LinkerResultV0 {
  version: 0;
  mappingUnits: LinkerMappingUnit[];
  globalConfidence: number; // [0,1]
  warnings: LinkerWarning[];
  diagnostics: {
    refTokenCount: number;
    hypTokenCount: number;
    anchorCount: number;
    coveragePercent: number; // R chars covered by mapping
    elapsedMs: number;
  };
}

export interface LinkerMappingUnit {
  refRange: { startCharIndex: number; endCharIndex: number }; // half-open
  hypRange: { startCharIndex: number; endCharIndex: number }; // half-open
  anchorIndex: number;       // index into anchors
  audioRangeMs: { startMs: number; endMs: number };
  confidence: number; // [0,1]
}

export type LinkerWarningCode =
  | 'PARTIAL_COVERAGE'
  | 'LOW_CONFIDENCE_UNIT'
  | 'HYP_TIMESTAMP_GAP'
  | 'ANCHOR_HYP_MISMATCH';

export interface LinkerWarning {
  code: LinkerWarningCode;
  message: string;
  unitIndex?: number;
  anchorIndex?: number;
}

// src/alignment/linker/linker.ts
export async function runLinker(input: LinkerInput): Promise<LinkerResultV0>;
```

### 4.2 Algorithm (overview)

1. Load R as token/word stream.
2. Load H token list with each token's `[startMs, endMs]` timestamps.
3. Compute weighted DTW between R and H (lowercased / normalized) using token-level edit cost.
4. Each R-token gets an aligned H-token (or gap → `LOW_CONFIDENCE_UNIT`).
5. Map each R-token's H-time range onto the **anchor list**:
   - Choose anchor whose `[startMs, endMs]` contains the H-token midpoint.
   - If no anchor contains it → choose nearest, emit `HYP_TIMESTAMP_GAP`.
6. Group consecutive R-tokens with the same anchor and contiguous time range into a `LinkerMappingUnit`.
7. Compute per-unit confidence = `f(DTW edit distance, anchor coverage, hyp gap)`.
8. Compute global confidence = weighted mean of unit confidences (weights = unit duration).

### 4.3 Native split

| Native part | Why native |
|-------------|-----------|
| Token timestamp loading from `hypothesisTextBuffer` slices | already native data |
| Anchor lookup map | small but invoked per token |
| Optional DTW kernel | hot path on long inputs |

> Implementation may stay TypeScript-only in v1 if benchmarks confirm acceptable overhead. The Spec **requires** the surface; the kernel placement is a measured choice. If kept in TS, `runLinker` calls native `linkTranscriptToAudio` only to fetch timestamped tokens efficiently.

---

## 5. Public Contract / API Changes

- **No public** TS export. Internal module only.
- New TurboModule call (optional, behind feature flag at native level):
  - `linkTranscriptToAudio(opts) → LinkerResultV0`
  - Default: TS-only path; if native variant enabled, output schema is identical.

---

## 6. Native + JS Implementation Tasks (Checklist)

### TypeScript

- [x] `src/alignment/linker/types.ts` — types per §4.1.
- [x] `src/alignment/linker/normalize.ts` — text normalization (locale-aware).
- [x] `src/alignment/linker/dtw.ts` — DTW pass with bounded band; cost function for token swaps/inserts/deletes.
- [x] `src/alignment/linker/anchorMap.ts` — anchor lookup, midpoint mapping, gap detection.
- [x] `src/alignment/linker/confidence.ts` — per-unit + global confidence formulas (documented constants).
- [x] `src/alignment/linker/linker.ts` — orchestrator returning `LinkerResultV0`.
- [x] Strict input validation (anchors non-empty, hypothesis token count > 0, R length > 0).

### Native (optional kernel; required only if benchmark fails TS path)

- [ ] Android: `android/src/main/java/com/sherpaonnx/alignment/linker/LinkerKernel.kt` + `LinkerBridge.kt` exposed via `SherpaOnnxModule.kt`.
- [ ] iOS: `ios/alignment/linker/LinkerKernel.{h,mm}` + bridge in `SherpaOnnx+Alignment.mm`.
- [ ] `NativeSherpaOnnx.ts`: add `linkTranscriptToAudio(opts)` entry mirroring TS shape.
  - Optional path deferred: TS implementation meets P2 DoD without native kernel changes.

### Hypothesis ingestion

- [x] Define a typed read for hypothesis tokens with timestamps.
- [x] Reject inputs missing per-token timestamps with `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`.

---

## 7. Error Codes / Diagnostics

| Code | Origin | Meaning |
|------|--------|---------|
| `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` | linker | H lacks token timestamps |
| `ALIGNMENT_LINKER_INPUT_INVALID` | linker | Empty anchors / R / H |
| `ALIGNMENT_LINKER_FAILED` | linker | DTW failed unrecoverably (rare; surfaced with cause) |

Warnings (non-fatal, on `LinkerResultV0.warnings`):
- `PARTIAL_COVERAGE`
- `LOW_CONFIDENCE_UNIT`
- `HYP_TIMESTAMP_GAP`
- `ANCHOR_HYP_MISMATCH`

---

## 8. Test Plan (Jest, no E2E)

### Unit

- `src/alignment/linker/__tests__/normalize.test.ts` — case folding, punctuation stripping, locale.
- `src/alignment/linker/__tests__/dtw.test.ts` — synthetic R/H pairs:
  - identical → cost 0, confidence 1.
  - one insertion / deletion / swap → expected paths.
  - heavy noise → costs reflected in confidence.
- `src/alignment/linker/__tests__/anchorMap.test.ts` — midpoint & nearest mapping; gap detection.
- `src/alignment/linker/__tests__/confidence.test.ts` — formulas with known inputs.

### Integration

- `src/alignment/linker/__tests__/runLinker.test.ts` — uses fixtures:
  - `fixtures/linker/short-en.json`: R, H tokens with timestamps, 3 anchors.
  - asserts snapshot of `LinkerResultV0`.
  - asserts deterministic output across runs.
- `src/alignment/linker/__tests__/runLinker-missing-timestamps.test.ts` — H without timestamps → throws `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Token normalization differs across locales | Locale param + dedicated tests per locale |
| DTW O(n·m) blows up on long inputs | Banded DTW; optional native kernel |
| Anchor gaps cause empty units | Emit `HYP_TIMESTAMP_GAP` warning; nearest-anchor mapping |
| ASR token timestamps drift from audio | Confidence formula penalizes high gap; warning emitted |
| Schema drift over future SDK use cases | `version: 0` + locked v0 fields; future fields in v1+ |

---

## 10. Exit Criteria (DoD)

- [x] `LinkerResultV0` shape matches `alignment-public-modes-plan.md` Linker schema.
- [x] All Jest tests in §8 green.
- [x] Snapshot tests show stable, deterministic output.
- [x] Validation produces correct codes from §7.
- [x] No public re-exports for linker; only `AlignmentEngine` consumes it.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| `OfflineSegmentBufferRef` reads | sub-segments runtime | Anchor iteration |
| `OfflineTextBufferRef` token + timestamp reads | text buffer + STT timestamp output | H ingestion |
| Engine option contract | sub-01 | Caller wiring |

| Blocks | Reason |
|--------|--------|
| sub-03 | `asrMediated` consumes `LinkerResultV0` |
| sub-05 | Native parity for optional linker kernel |
| sub-06 | Test matrix references linker fixtures |

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | P2 completed: internal linker core (`types/normalize/dtw/anchorMap/confidence/linker`) implemented in TS, input validation + error codes wired, deterministic Jest suite added, and engine now consumes linker for ASR-mediated preflight before deferred `asrMediated` CTC integration |
