# Sub-Plan 04 — Accurate / chunkedForcedCtc Integration (Chunked Forced CTC)

## Status
- **Completed (2026-04-30)**
- Depends on: sub-01
- Prerequisite for: sub-05 (parity), sub-06 (test matrix), sub-07 (docs)

> Note: independent of sub-02 (linker is **not** used in `chunkedForcedCtc`).

---

## 1. Scope

Wire **row 4b** end-to-end:

```
mode: 'accurate'
segmentation: { mode: 'auto' }
mappingStrategy: 'chunked_forced_ctc'
```

Pipeline (alignment-only, no ASR dependency):

1. Anchors are produced by the SegmentationEngine upstream (caller).
2. Drive a **token cursor** over R while iterating anchors in order.
3. For each anchor:
   - Slice PCM.
   - Hand the next chunk of R (windowed around the cursor) plus PCM to native `AlignAccurateForcedCtc` (new or extended).
   - Native returns: aligned tokens with local timestamps + `consumedTokenCount`.
   - Driver advances cursor by `consumedTokenCount`.
4. If native returns "anchor under-consumed" (cannot fit remaining text within anchor) → emit `AlignedSegment`s for what was consumed; carry residual to next anchor.
5. If native reports CTC blank-only or model rejects → driver emits `ALIGNMENT_FORCED_CTC_FAILED` for that anchor; depending on `recovery`-policy (see below), driver either skips or aborts.

---

## 2. Non-Goals

- No ASR / linker dependency (intentional: `chunkedForcedCtc` is alignment-only).
- No anchor production logic; depends on caller providing anchors via `audioIn` / segmentation engine attachment.
- No silent fallback to row 3.
- No backtracking across anchors (a token consumed by anchor `n` is final for that anchor).

---

## 3. Current State (Ist)

- Native `AlignAccurateFromPcm` operates on full audio + full text.
- No chunked driver, no cursor, no per-anchor force.
- Engine path for `accurate + auto + chunked_forced_ctc` rejects with `ALIGNMENT_NOT_IMPLEMENTED` after sub-01.

---

## 4. Target State (Soll)

### 4.1 Driver location

```
src/alignment/chunkedForcedCtc/
  driver.ts
  cursor.ts        // R token/char cursor + window heuristics
  types.ts
  __tests__/
```

### 4.2 Driver outline

```typescript
async function runAccurateChunkedForcedCtc(opts: {
  textIn: OfflineTextBufferRef;
  audioIn: OfflineAudioBufferRef;
  anchors: OfflineSegmentBufferRef;
  segmentOut: OfflineSegmentBufferRef;
  modelPath: string;          // resolved
  granularity: 'token' | 'word';
  language?: string;
}): Promise<AlignTextToAudioWriteResult>;
```

Steps:

1. Build `cursor` over `referenceText`.
2. For `i in 0..anchors.length-1`:
   - Slice PCM.
   - Compute window of R around cursor: `[cursor, cursor + windowMaxTokens)`. Windowing accounts for `language` and average tokens-per-second × anchor length.
   - Native call: `AlignAccurateForcedCtc(slicePcm, windowText, granularity, modelPath)`:
     - Returns `tokens[]` (each with local `startMs/endMs`) and `consumedTokenCount`.
   - Append `AlignedSegment` to `segmentOut` with global timestamps.
   - `cursor += consumedTokenCount`.
   - If `consumedTokenCount === 0`:
     - Emit warning `ALIGNMENT_ANCHOR_NO_PROGRESS`.
     - If three consecutive anchors have zero progress → fail with `ALIGNMENT_FORCED_CTC_STUCK`.
3. After loop: if `cursor < refTokenCount` → emit warning `ALIGNMENT_RESIDUAL_TOKENS_REMAINING`. No silent fix.

### 4.3 Native function

Either extend `AlignAccurateFromPcm` with a "forced + windowed" mode flag, or add `AlignAccurateForcedCtcFromPcm`. Recommended: **new function** `AlignAccurateForcedCtcFromPcm` to keep contracts crisp.

Inputs:
- `pcmFloat32 (samples, sampleRate=16000)`
- `windowText (UTF-8)`
- `granularity`
- `modelPath`
- `language?`

Outputs:
- `tokens: { text, startMs, endMs }[]` (local)
- `consumedTokenCount: number`
- `diagnostics: { ctcBlankRatio: number; framesProcessed: number }`

Failure: throws/rejects with structured error including `code: 'FORCED_CTC_FAILED'` and message.

---

## 5. Public Contract / API Changes

- Engine path enables `mappingStrategy: 'chunked_forced_ctc'` for accurate auto.
- Result `AlignTextToAudioWriteResult.warnings` (introduced in sub-03 § 5) extended with new codes.
- `NativeSherpaOnnx.ts` adds `AlignAccurateForcedCtcFromPcm` spec entry.

---

## 6. Native + JS Implementation Tasks (Checklist)

### TypeScript

- [x] `src/alignment/chunkedForcedCtc/driver.ts` per §4.2.
- [x] `src/alignment/chunkedForcedCtc/cursor.ts`:
  - [x] Token-aware cursor (token + word granularity).
  - [x] Window sizing rule documented as constants.
- [x] `src/alignment/alignTextToAudio.ts`:
  - [x] Route `mode === 'accurate' && segmentation?.mode === 'auto' && mappingStrategy === 'chunked_forced_ctc'` → `runAccurateChunkedForcedCtc`.

### Native

#### Android (C++ + JNI)

- [x] `android/src/main/cpp/alignment/sherpa_onnx_alignment_engine.cpp`:
  - [x] Implement `AlignAccurateForcedCtcFromPcm` (separate function next to `AlignAccurateFromPcm`).
  - [x] Reuse existing CTC graph builder; force-decode against `windowText`.
  - [x] Produce `consumedTokenCount` based on emitted/forced path.
- [x] `android/src/main/java/com/sherpaonnx/alignment/facade/SherpaOnnxAlignmentHelper.kt`:
  - [x] Add Kotlin facade method `alignAccurateForcedCtc(...)`.
- [x] `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt`:
  - [x] Bridge new method.

#### iOS

- [x] `ios/alignment/core/AlignmentBridgeUtils.{h,mm}` — parsing + result mapping.
- [x] `ios/alignment/bridge/SherpaOnnx+Alignment.mm` — bridge new method.
- [x] Reuse C++ kernel via shared sources where possible.

#### NativeSherpaOnnx.ts

- [x] Add typed entry for `AlignAccurateForcedCtcFromPcm`.

---

## 7. Error Codes / Diagnostics

| Code | Layer | Meaning |
|------|-------|---------|
| `ALIGNMENT_FORCED_CTC_FAILED` | native/driver | Native rejected slice or text |
| `ALIGNMENT_FORCED_CTC_STUCK` | driver | Three consecutive anchors with zero progress |
| `ALIGNMENT_ANCHOR_OUT_OF_RANGE` | driver | Anchor extends past audio length |

Warnings on result:

| Code | Severity | Cause |
|------|----------|-------|
| `ALIGNMENT_ANCHOR_NO_PROGRESS` | warn | Single anchor consumed 0 tokens |
| `ALIGNMENT_RESIDUAL_TOKENS_REMAINING` | warn | Cursor did not reach end of R after final anchor |

---

## 8. Test Plan (Jest, no E2E)

### Unit

- `src/alignment/chunkedForcedCtc/__tests__/cursor.test.ts` — advancement, window math, granularity.
- `src/alignment/chunkedForcedCtc/__tests__/driver-options.test.ts` — invalid options.
- `src/alignment/chunkedForcedCtc/__tests__/driver-progress.test.ts` — warning vs error transitions.

### Integration (mocked native)

- `src/alignment/chunkedForcedCtc/__tests__/driver-pipeline.test.ts`:
  - Mocks `AlignAccurateForcedCtcFromPcm` to consume known token counts per anchor.
  - Asserts cursor advancement.
  - Asserts global timestamps.
  - Asserts residual warning when last anchor under-consumes.
- `src/alignment/chunkedForcedCtc/__tests__/driver-stuck.test.ts`:
  - Mock returns 0 consumed three times → throws `ALIGNMENT_FORCED_CTC_STUCK`.

### Contract

- `src/alignment/chunkedForcedCtc/__tests__/native-spec.test.ts`:
  - Asserts the JS-side `NativeSherpaOnnx` spec includes `AlignAccurateForcedCtcFromPcm`.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Window sizing too small → constant under-consumption | Document constants + add unit tests for boundary cases |
| Window sizing too large → memory pressure | Hard cap window in tokens; document limit |
| Greedy cursor commits wrong tokens early | Window includes some look-ahead tokens but only the consumed prefix is emitted |
| Native CTC rejects exotic text | Surface `ALIGNMENT_FORCED_CTC_FAILED` with native cause string; no silent skip |
| Inconsistent token granularity definitions iOS vs Android | Shared C++ tokenizer; parity test in sub-05/sub-06 |

---

## 10. Exit Criteria (DoD)

- [x] Native function on both platforms; identical inputs/outputs.
- [x] Driver passes all tests in §8.
- [x] Engine path returns `AlignTextToAudioWriteResult` for row 4b.
- [x] No call to `AlignAccurateFromPcm` (full audio) on this path.
- [x] Overview tracking flipped to `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| Engine entrypoint | sub-01 | Public surface |
| Slice-aware PCM read | sub-05 | Per-anchor PCM |
| Anchor production | SegmentationEngine (existing) | Caller-provided |
| Granularity rules | sub-01 / public modes plan | Validation |

| Blocks | Reason |
|--------|--------|
| sub-05 | Parity test for row 4b |
| sub-06 | Test matrix |
| sub-07 | Docs |

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | P4 completed: `chunkedForcedCtc` (`chunked_forced_ctc`) wired with cursor+window driver, native forced-CTC bridge entry added on Android/iOS, and `chunkedForcedCtc` Jest suite added (`cursor`, `driver-options`, `driver-progress`, `driver-pipeline`, `driver-stuck`, `native-spec`) |
