# Sub-Plan 05 — Native Bridge & Platform Parity

## Status
- **Planned**
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

- [ ] Update `src/NativeSherpaOnnx.ts`:
  - [ ] Add slice descriptor for `AlignAccurateFromPcm` (or accept legacy + new shape with type discrimination).
  - [ ] Add `AlignAccurateForcedCtcFromPcm`.
  - [ ] (Optional) Add `linkTranscriptToAudio`.
- [ ] Drivers from sub-03 / sub-04 always pass slice descriptors; no full-PCM read.

### Android

- [ ] `SherpaOnnxModule.kt`:
  - [ ] Register new method(s).
  - [ ] Resolve `audioBufferId` to `OfflineAudioBuffer` instance via existing registry.
- [ ] `SherpaOnnxAlignmentHelper.kt`:
  - [ ] Method `alignAccurateForcedCtc(pcmSlice, windowText, modelPath, granularity, language?)`.
  - [ ] Slice read uses zero-copy view into the buffer's float array.
- [ ] `sherpa_onnx_alignment_engine.cpp`:
  - [ ] Implement `AlignAccurateForcedCtcFromPcm`.
  - [ ] Confirm slice variant of `AlignAccurateFromPcm` works without copies.
- [ ] `AlignmentOptionParsers.kt`:
  - [ ] Parse `pcm` slice descriptor.
- [ ] `AlignmentErrorCodes.kt`:
  - [ ] Add codes per §4.3 not yet present.
- [ ] `AlignmentResultMapper.kt`:
  - [ ] Emit unified result shape.

### iOS

- [ ] `SherpaOnnx+Alignment.mm`:
  - [ ] Register new method(s).
  - [ ] Resolve `audioBufferId` via existing registry.
- [ ] `AlignmentBridgeUtils.{h,mm}`:
  - [ ] Parse slice descriptor.
  - [ ] Result mapper parity.
- [ ] Reuse C++ kernel from `sherpa_onnx_alignment_engine.cpp` (shared sources).

### Diagnostics

- [ ] Ensure native side surfaces an explicit error string for each documented code; no untyped `Error('Unknown')`.

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

- [ ] All bridge entries registered and callable on both platforms.
- [ ] No alignment call path uses full-PCM reads in rows 4a/4b.
- [ ] Native errors surface with documented JS codes (asserted in tests).
- [ ] Result schema is byte-equivalent between Android and iOS for shared fixtures (within tolerance).
- [ ] Overview tracking flipped to `Completed`.

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
