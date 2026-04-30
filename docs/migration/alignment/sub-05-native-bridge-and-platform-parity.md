# Sub-Plan 05 — Native Bridge & Platform Parity

## Status
- **Completed (2026-04-30)**
- Depends on: sub-01 (surface), sub-02 (linker), sub-03 (Strategy A), sub-04 (Strategy B)
- Prerequisite for: sub-06 (parity tests), sub-07 (docs / cutover)

---

## 1. Scope

Make the native side correct and **identical between Android and iOS** for:

- Slice-based PCM reads from `OfflineAudioBuffer` for per-anchor processing (Strategy A and B).
- Native bridge methods registered in `NativeSherpaOnnx.ts` for:
  - `AlignAccurateFromPcm` (existing; revisit for slice support).
  - `AlignAccurateForcedCtcFromPcm` (new in sub-04).
  - `linkTranscriptToAudio` (optional native kernel from sub-02).
- Error mapping: native errors must surface to JS with the documented codes; OOM is passthrough.
- Granularity / language / modelPath plumbing identical on both platforms.

---

## 2. Non-Goals

- No new TS-facing options.
- No engine logic; only plumbing.
- No legacy compatibility code paths.

---

## 3. Current State (Ist)

- Android:
  - `android/src/main/cpp/alignment/sherpa_onnx_alignment_engine.cpp` runs `AlignAccurateFromPcm` over a single PCM blob.
  - Bridge: `SherpaOnnxModule.kt` + `SherpaOnnxAlignmentHelper.kt` + `AlignmentOptionParsers.kt` + `AlignmentResultMapper.kt` + `AlignmentErrorCodes.kt`.
- iOS:
  - `ios/alignment/core/AlignmentBridgeUtils.{h,mm}` parses options.
  - `ios/alignment/bridge/SherpaOnnx+Alignment.mm` bridges to TurboModule.
  - C++ kernel shared with Android via vendored sherpa-onnx.
- No slice read API exposed for alignment; current path passes whole PCM.

---

## 4. Target State (Soll)

### 4.1 Slice-aware PCM read API (alignment-internal)

Bridge **does not** require new public TS API. Internal request shape (TS → native):

```
AlignAccurateFromPcm({
  modelPath: string,
  granularity: 'token' | 'word',
  language?: string,
  pcm: { audioBufferId: string; startSample: number; sampleCount: number },
  text: string,
})
```

For Strategy B:

```
AlignAccurateForcedCtcFromPcm({
  modelPath: string,
  granularity: 'token' | 'word',
  language?: string,
  pcm: { audioBufferId: string; startSample: number; sampleCount: number },
  windowText: string,
})
```

Native sides MUST resolve the buffer handle by `audioBufferId` and read `[startSample, startSample + sampleCount)` directly without copying through JS.

### 4.2 Result mapping

Both native methods return:

```
{
  tokens: [{ text, startMs, endMs }],
  consumedTokenCount?: number,        // forced CTC only
  diagnostics?: {
    ctcBlankRatio?: number,
    framesProcessed?: number
  }
}
```

`AlignmentResultMapper.kt` and the iOS equivalent format JSON dictionaries identically.

### 4.3 Error mapping

| Native source | Bridge error code |
|---------------|-------------------|
| `modelPath` resolution failure | `ALIGNMENT_MODEL_LOAD_FAILED` |
| ONNX runtime OOM | `OFFLINE_OOM` (passthrough; **no extra warnings**) |
| CTC graph build failure | `ALIGNMENT_NATIVE_ACCURATE_FAILED` |
| Forced CTC rejected window | `ALIGNMENT_FORCED_CTC_FAILED` |
| Slice out of buffer range | `ALIGNMENT_ANCHOR_OUT_OF_RANGE` |
| Unknown internal exception | `ALIGNMENT_NATIVE_UNKNOWN` (with `cause` message) |

### 4.4 Linker kernel (optional)

If sub-02 elects to ship a native linker kernel:
- Spec exposes `linkTranscriptToAudio` returning a `LinkerResultV0`-shaped JSON.
- JNI/Obj-C++ wrappers MUST produce identical numerics within documented tolerance.

---

## 5. Public Contract / API Changes

- `NativeSherpaOnnx.ts`:
  - Add `AlignAccurateForcedCtcFromPcm` typed entry (sub-04).
  - Confirm `AlignAccurateFromPcm` accepts `pcm` slice descriptor.
  - Optional: `linkTranscriptToAudio` (off by default in v1).
- No public TS API changes (sub-01 already locked the surface).

---

## 6. Native + JS Implementation Tasks (Checklist)

### TypeScript

- [x] Update `src/NativeSherpaOnnx.ts`:
  - [x] Add slice descriptor for `AlignAccurateFromPcm`.
  - [x] Add `AlignAccurateForcedCtcFromPcm` slice descriptor shape.
  - [ ] (Optional) Add `linkTranscriptToAudio`.
- [x] Drivers from sub-03 / sub-04 always pass slice descriptors; no full-PCM read.

### Android

- [x] `SherpaOnnxModule.kt`:
  - [x] Register descriptor-based bridge methods.
  - [x] Resolve `audioBufferId` to `OfflineAudioBuffer` instance via existing registry.
- [x] `SherpaOnnxAlignmentHelper.kt`:
  - [x] Method `alignAccurateForcedCtc(pcmSlice, windowText, modelPath, granularity, language?)`.
  - [x] Method `alignAccurateFromPcm(pcmSlice, text, modelPath, granularity, language?)`.
  - [x] Slice read is resolved inside native bridge layer (no JS full-PCM transfer).
- [x] `sherpa_onnx_alignment_engine.cpp`:
  - [x] `AlignAccurateForcedCtcFromPcm` in place.
  - [x] Slice variant of `AlignAccurateFromPcm` is exercised through descriptor bridge path.
- [x] `AlignmentOptionParsers.kt`:
  - [x] Parse `pcm` slice descriptor.
- [x] `AlignmentErrorCodes.kt`:
  - [x] Add codes per §4.3.
- [x] `AlignmentResultMapper.kt`:
  - [x] Emit unified result shape for accurate and forced-CTC responses.

### iOS

- [x] `SherpaOnnx+Alignment.mm`:
  - [x] Register descriptor-based `alignAccurateFromPcm` and `alignAccurateForcedCtcFromPcm`.
  - [x] Resolve `audioBufferId` via existing registry.
- [x] `AlignmentBridgeUtils.{h,mm}`:
  - [x] Parse slice descriptor.
  - [x] Result mapper parity for descriptor-based calls.
- [x] Reuse C++ kernel from `sherpa_onnx_alignment_engine.cpp` (shared sources).

### Diagnostics

- [x] Ensure native side surfaces an explicit error string for each documented code; no untyped `Error('Unknown')`.

---

## 7. Error Codes / Diagnostics

See §4.3. New codes registered in:
- `AlignmentErrorCodes.kt`
- iOS equivalent constants (string codes are identical).
- `src/alignment/types.ts` (TS-side enum-like union for `AlignmentWarning.code` and error mapping helpers).

---

## 8. Test Plan (Jest, no E2E)

### Unit (TS)

- `src/alignment/__tests__/native-spec-shape.test.ts` — asserts `NativeSherpaOnnx` spec exposes the expected method signatures (snapshot).

### Integration (TS, with native mocks)

- `src/alignment/__tests__/native-bridge-slice-call.test.ts`:
  - Driver invocation for row 4a/4b passes `pcm` slice descriptor (not full PCM).
  - Asserts call payload schema.
- `src/alignment/__tests__/native-bridge-error-mapping.test.ts`:
  - For each native error path (mocked), correct JS error code is surfaced.

### Native parity (manual at first, later automated in sub-06)

- Shared JSON fixture `fixtures/alignment/parity/case-01.json`:
  - Expected token counts, expected ms ranges within tolerance ±10 ms (TBD per case).
  - Sub-06 wires the parity harness; this sub-plan provides the fixture format and assertions list.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Buffer handle resolution differs by platform | Reuse same registry abstraction already used by STT/TTS; assert in tests |
| Different floating-point behavior iOS vs Android | Use shared C++ kernel; documented tolerance per metric |
| Slice descriptor parsing drift | Single TS spec + parity test asserts schema both sides |
| OOM masked by extra layers | Strict passthrough; sub-06 verifies via mocked OOM throw |
| Granularity / language differences | Single source of truth in TS option type; parsers map directly |

---

## 10. Exit Criteria (DoD)

- [x] All bridge entries registered and callable on both platforms.
- [x] No alignment call path uses full-PCM reads in rows 4a/4b.
- [x] Native errors surface with documented JS codes (asserted in tests).
- [x] Result schema is byte-equivalent at bridge-contract level between Android and iOS (fixture tolerance harness continues in sub-06).
- [x] Overview tracking flipped to `Completed`.

---

## 11. Dependency Matrix

| Needs | From | Why |
|-------|------|-----|
| Driver call shapes | sub-03, sub-04 | Defines what bridge needs |
| Engine surface | sub-01 | Single entrypoint to drivers |
| Linker schema | sub-02 | Optional native kernel |

| Blocks | Reason |
|--------|--------|
| sub-06 | Parity tests rely on this surface |
| sub-07 | Docs reference final native shape |

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | P5 completed: descriptor-based `alignAccurateFromPcm` + `alignAccurateForcedCtcFromPcm` wired in TS/Android/iOS, row-4a/4b drivers switched to PCM slice descriptors, native error mapping aligned (`ALIGNMENT_MODEL_LOAD_FAILED`, `ALIGNMENT_NATIVE_ACCURATE_FAILED`, `ALIGNMENT_FORCED_CTC_FAILED`, `ALIGNMENT_ANCHOR_OUT_OF_RANGE`, `ALIGNMENT_NATIVE_UNKNOWN`, `OFFLINE_OOM`), and Jest suites added (`native-spec-shape`, `native-bridge-slice-call`, `native-bridge-error-mapping`) |
