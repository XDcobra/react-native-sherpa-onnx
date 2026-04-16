# STT Online Guard — Implementation Spec

> Extends: [stt-online-guard-problem-statement.md](./stt-online-guard-problem-statement.md)  
> Reference implementation: Enhancement online guard (`sherpa-onnx-enhancement-online-guard.{h,cpp}`)

## Summary

Move `isStreaming` computation from TypeScript heuristic (type ∈ `ONLINE_STT_MODEL_TYPES`) into the C++ detection layer, backed by safe ONNX Runtime metadata/shape inspection. This mirrors the enhancement guard pattern but must handle **5 distinct online model families** instead of 2.

---

## Architecture: Multi-Family Guard with Per-Family Modules

### Why multiple files

Enhancement has 2 streaming families (GTCRN, DPDFNet) with relatively uniform graph signatures. STT has **5 online families** with very different metadata schemas, tensor counts, and graph shapes:

| Family | Config key | Model files | Metadata schema | I/O signature |
|--------|-----------|-------------|-----------------|---------------|
| **Transducer** (Icefall) | `transducer.encoder` | encoder + decoder + joiner | `model_type` → conformer/lstm/zipformer/zipformer2; per-type metadata | 3 sessions; decoder output_count == 1 |
| **NeMo Transducer** | `transducer.encoder` | encoder + decoder + joiner | `window_size`, `chunk_shift`, `pred_rnn_layers`, cache dims | 3 sessions; decoder output_count > 1 |
| **Paraformer** | `paraformer.encoder` | encoder + decoder | `lfr_window_size`, `lfr_window_shift`, `encoder_output_size`, `neg_mean`, `inv_stddev` | 2 sessions |
| **CTC** (Zipformer2/WeNet/NeMo/T-One) | `*_ctc.model` | single model.onnx | family-specific (zip2: vector metadata; wenet: `head`/`num_blocks`; nemo: cache dims; t-one: `frame_length_ms`) | 1 session; multiple families |
| **WeNet CTC** | `wenet_ctc.model` | single model.onnx | `head`, `num_blocks`, `output_size`, `cnn_module_kernel`, `right_context`, `subsampling_factor`, `vocab_size` | 1 session |

A single guard function would be 2000+ lines. Instead, split per family:

```
stt/
  sherpa-onnx-model-detect-stt.cpp          ← existing detect (calls guard)
  sherpa-onnx-validate-stt.cpp              ← existing path validation
  sherpa-onnx-stt-online-guard.h            ← public guard interface
  sherpa-onnx-stt-online-guard.cpp          ← dispatcher + IsStreamingCandidate()
  sherpa-onnx-stt-online-guard-transducer.cpp   ← transducer family guard
  sherpa-onnx-stt-online-guard-paraformer.cpp   ← paraformer guard
  sherpa-onnx-stt-online-guard-ctc.cpp          ← CTC family guard (zip2/wenet/nemo/t-one)
```

---

## Detailed Design

### 1. Header: `sherpa-onnx-stt-online-guard.h`

```cpp
#ifndef SHERPA_ONNX_STT_ONLINE_GUARD_H
#define SHERPA_ONNX_STT_ONLINE_GUARD_H

#include "sherpa-onnx-model-detect.h"
#include <string>

namespace sherpaonnx::stt::online_guard {

struct OnlineGuardResult {
    bool passed = true;
    std::string error;
};

/**
 * Returns true if the given SttModelKind is a candidate for online/streaming
 * use (i.e. sherpa-onnx has an OnlineRecognizer path for it).
 */
bool IsStreamingCandidate(SttModelKind kind);

/**
 * Run safe, non-fatal online-compatibility guard for the given STT model.
 *
 * @param kind       Detected model kind (must be a streaming candidate).
 * @param paths      Resolved model paths (encoder, decoder, joiner, ctcModel, etc.).
 * @param modelDir   Root model directory (for path resolution).
 * @return           Guard result: passed=true if model is online-compatible,
 *                   passed=false with error string if not.
 *
 * When ORT is not available at compile time, returns {passed=true} (optimistic fallback).
 */
OnlineGuardResult RunOnlineCompatibilityGuard(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
);

// Per-family guards (internal, called by RunOnlineCompatibilityGuard)
// exposed in header for unit testing
OnlineGuardResult GuardTransducerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& modelDir
);

OnlineGuardResult GuardParaformerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& modelDir
);

OnlineGuardResult GuardCtcOnlineCompatibility(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
);

}  // namespace sherpaonnx::stt::online_guard

#endif
```

### 2. Dispatcher: `sherpa-onnx-stt-online-guard.cpp`

Responsibilities:
- Defines `IsStreamingCandidate(SttModelKind)` — returns true for: `kTransducer`, `kNemoTransducer`, `kParaformer`, `kNemoCtc`, `kWenetCtc`, `kZipformerCtc`, `kToneCtc`
- Defines `RunOnlineCompatibilityGuard()` — dispatches to per-family guard functions
- Contains shared utility forward declarations and the `SHERPA_ONNX_STT_ONLINE_GUARD_HAS_ORT` compile-time feature detection (same `__has_include("onnxruntime_cxx_api.h")` pattern as enhancement)

### 3. Per-Family Guards

#### 3a. Transducer Guard (`sherpa-onnx-stt-online-guard-transducer.cpp`)

Validates both **Icefall transducers** (conformer, lstm, zipformer, zipformer2) and **NeMo transducers**.

**Step 1 — Encoder session inspection:**
- Open ORT session for `paths.encoder`
- Read `model_type` metadata key
- Validate it is one of: `conformer`, `ebranchformer`, `lstm`, `zipformer`, `zipformer2`
- Read family-specific metadata keys:
  - Conformer/Ebranchformer: `num_encoder_layers`, `T`, `decode_chunk_len`, `left_context`, `encoder_dim`, `pad_length`, `cnn_module_kernel`
  - LSTM: `num_encoder_layers`, `T`, `decode_chunk_len`, `rnn_hidden_size`, `d_model`
  - Zipformer: `num_encoder_layers`, `T`, `decode_chunk_len`, etc.
  - Zipformer2: `encoder_dims` (vector), `query_head_dims`, `value_head_dims`, `num_heads`, `num_encoder_layers` (vector), `cnn_module_kernels`, `left_context_len`, `T`, `decode_chunk_len`
- Validate all required metadata exists and has sane values (> 0, non-empty vectors, vector lengths match)

**Step 2 — Decoder output count (Icefall vs NeMo discrimination):**
- Open ORT session for `paths.decoder`
- Count output nodes:
  - `output_count == 1` → Icefall transducer
  - `output_count > 1` → NeMo transducer
- For NeMo: additionally read encoder metadata for `window_size`, `chunk_shift`, `pred_rnn_layers`, `pred_hidden`, cache dimension keys
- Read `vocab_size` and `context_size` from decoder metadata

**Step 3 — Joiner existence:**
- Verify `paths.joiner` file exists (non-empty path, file on disk)

**Fatal paths prevented:**
- `SHERPA_ONNX_READ_META_DATA` in upstream → replaced by safe `LookupMetadataValue` + `ParseInt32Strict`
- `SHERPA_ONNX_EXIT(-1)` in `online-transducer-model.cc::GetModelType()` → caught by our metadata check
- `SHERPA_ONNX_CHECK_NE(feature_dim_, 0)` in zipformer2 → caught by dimension validation

#### 3b. Paraformer Guard (`sherpa-onnx-stt-online-guard-paraformer.cpp`)

**Encoder inspection:**
- Open ORT session for `paths.encoder`
- Read metadata: `vocab_size`, `lfr_window_size`, `lfr_window_shift`, `encoder_output_size`, `decoder_num_blocks`, `decoder_kernel_size`
- Read vector metadata: `neg_mean`, `inv_stddev`
- Validate: all int32 keys > 0, vectors non-empty, `neg_mean.size() == inv_stddev.size()`

**Decoder inspection:**
- Verify `paths.decoder` file exists
- Open ORT session, verify input/output count is reasonable (> 0)

**Fatal paths prevented:**
- `SHERPA_ONNX_READ_META_DATA` / `SHERPA_ONNX_READ_META_DATA_VEC_FLOAT` in `online-paraformer-model.cc` → safe alternatives

#### 3c. CTC Guard (`sherpa-onnx-stt-online-guard-ctc.cpp`)

Handles all CTC sub-families via internal dispatch on `SttModelKind`.

**Common:**
- Open ORT session for `paths.ctcModel`
- Read `vocab_size` from output tensor shape (last dim) or metadata

**Sub-family specific:**

**Zipformer2 CTC** (`kZipformerCtc`):
- Read vector metadata: `encoder_dims`, `query_head_dims`, `value_head_dims`, `num_heads`, `num_encoder_layers`, `cnn_module_kernels`, `left_context_len`
- Read scalar metadata: `T`, `decode_chunk_len`
- Validate all vectors have equal length, all values > 0

**WeNet CTC** (`kWenetCtc`):
- Read metadata: `head`, `num_blocks`, `output_size`, `cnn_module_kernel`, `right_context`, `subsampling_factor`, `vocab_size`
- Validate all > 0

**NeMo CTC** (`kNemoCtc`):
- Read metadata: `window_size`, `chunk_shift`, `subsampling_factor`, `vocab_size`
- Read cache dimension metadata (9 keys): `cache_last_channel_dim1/2/3`, `cache_last_time_dim1/2/3`
- Validate dimensions > 0

**T-One CTC** (`kToneCtc`):
- Read metadata: `frame_length_ms`, `state_dim`, `sample_rate`
- Validate all > 0

**Fatal paths prevented:**
- `SHERPA_ONNX_EXIT(-1)` in `online-ctc-model.cc::Create()` when no model specified → caught by file existence check
- `SHERPA_ONNX_READ_META_DATA` in all CTC models → safe alternatives
- `SHERPA_ONNX_EXIT(-1)` in `online-wenet-ctc-model.cc` for batch_size > 1 → not relevant at guard time (no inference)

---

### 4. C++ Struct Change: Add `isStreaming` to `SttDetectResult`

In `sherpa-onnx-model-detect.h`:

```cpp
struct SttDetectResult {
    bool ok = false;
    /** True when online-streaming compatibility is confirmed
     *  (or heuristically inferred in name-only mode). */
    bool isStreaming = false;
    std::string error;
    // ... existing fields ...
};
```

### 5. Integration into `sherpa-onnx-model-detect-stt.cpp`

After `ResolveSttKind()` succeeds and `ApplyPathsForSttKind()` populates paths, before returning:

```cpp
#include "sherpa-onnx-stt-online-guard.h"

// ... in DetectSttModelFromFiles(), after validation passes:

using namespace sherpaonnx::stt::online_guard;

result.isStreaming = IsStreamingCandidate(result.selectedKind);

if (result.isStreaming) {
    const auto guard = RunOnlineCompatibilityGuard(
        result.selectedKind, result.paths, modelDir);
    if (!guard.passed) {
        result.isStreaming = false;
        // Don't fail the overall detect — paths are still valid for offline use.
        // But append a warning about online incompatibility.
        if (!guard.error.empty()) {
            result.error = "Online guard failed for " +
                std::string(KindToName(result.selectedKind)) +
                ": " + guard.error;
        }
    }
}
```

**Name-only detection (asset-only, no filesystem):**

In `DetectSttModel()` when `!has_dir && has_asset`:
- Use the existing name-based kind inference
- Set `isStreaming` heuristically via `IsStreamingCandidate(inferredKind)`
- Keep `ok = false` (no filesystem validation)
- Append note about heuristic result

### 6. Expected Behavior Matrix

| Detection input | Guard execution | `isStreaming` | `ok` |
|---|---|---|---|
| Filesystem-backed streaming model + guard pass | Full ORT inspection | `true` | `true` |
| Filesystem-backed streaming model + guard fail | Full ORT inspection | `false` | `true` ¹ |
| Filesystem-backed offline model (whisper, moonshine, etc.) | None | `false` | `true` |
| AssetName-only inferred streaming type | Heuristic only | `true` (best effort) | `false` |
| AssetName-only unknown/offline type | Heuristic only | `false` | `false` |

¹ **Design decision**: Unlike enhancement, STT detect succeeding (`ok=true`) with `isStreaming=false` is valid because the model can still be used with the offline recognizer. The `error` field carries the guard failure reason. Enhancement differs here because all enhancement models are either online or offline — there's no fallback.

---

## Bridge Layer Changes

### 7. Android JNI Wrapper (`sherpa-onnx-stt-wrapper.cpp`)

Add `isStreaming` to the HashMap:

```cpp
PutBoolean(env, map, mapPut, "isStreaming", result.isStreaming);
```

### 8. iOS Bridge (`SherpaOnnx+STT.mm`)

Add to the NSDictionary:

```objc
resultDict[@"isStreaming"] = @(result.isStreaming);
```

### 9. TypeScript TurboModule Signature (`NativeSherpaOnnx.ts`)

Add `isStreaming?: boolean` to the `detectSttModel` return type.

### 10. TypeScript STT detect (`src/stt/index.ts`)

Replace the current client-side heuristic:

```typescript
// BEFORE:
const isStreaming =
  normalizedType != null &&
  (ONLINE_STT_MODEL_TYPES as readonly string[]).includes(normalizedType);

// AFTER:
const isStreaming = raw.isStreaming === true;
```

### 11. TypeScript Type Docs (`src/types/modelDetect.ts`)

Update `isStreaming` JSDoc on `ModelDetectResultBase` to note that STT (like enhancement) is now native-sourced.

### 12. `ONLINE_STT_MODEL_TYPES` Update

Add `wenet_ctc` to `ONLINE_STT_MODEL_TYPES` in `src/stt/streamingTypes.ts`. WeNet CTC is supported by upstream `online-wenet-ctc-model.cc` but was never listed. Since `isStreaming` is now native-sourced, this list becomes informational (for UI/type guards) rather than the source of truth.

```typescript
export type OnlineSTTModelType =
  | 'transducer'
  | 'paraformer'
  | 'zipformer2_ctc'
  | 'wenet_ctc'      // ← add
  | 'nemo_ctc'
  | 'tone_ctc';
```

---

## Build System Changes

### 13. Android `CMakeLists.txt`

Add new source files:

```cmake
jni/model_detect/stt/sherpa-onnx-stt-online-guard.cpp
jni/model_detect/stt/sherpa-onnx-stt-online-guard-transducer.cpp
jni/model_detect/stt/sherpa-onnx-stt-online-guard-paraformer.cpp
jni/model_detect/stt/sherpa-onnx-stt-online-guard-ctc.cpp
```

### 14. iOS `SherpaOnnx.podspec`

New `.cpp` files in the `stt/` directory are already covered by the existing glob pattern (`**/*.cpp`). No changes needed unless the podspec uses explicit file lists.

### 15. Host Test `CMakeLists.txt`

Add new guard source files to the test target.

---

## Shared ORT Utilities

The enhancement guard has a set of metadata/shape parsing helpers (`ParseInt32Strict`, `ReadRequiredMetadataString`, `ReadTensorShape`, `CreateOrtSession`, etc.) that are duplicated within `sherpa-onnx-enhancement-online-guard.cpp`.

### Option A: Duplicate helpers in STT guard files

- Pro: no cross-feature coupling, each guard is self-contained
- Con: ~200 lines of duplicated parsing code

### Option B: Extract shared guard utils

Move common ORT helpers into a shared file:

```
common/
  sherpa-onnx-ort-guard-utils.h
  sherpa-onnx-ort-guard-utils.cpp
```

Contents: `ParseInt32Strict`, `ParseInt64Strict`, `ParseFloatStrict`, `ParseCsvInt64`, `ParseCsvFloat`, `LookupMetadataValue`, `ReadRequiredMetadata{String,Int32,Int64Vec,FloatVec}`, `ReadOptionalMetadataInt32`, `ReadTensorShape`, `CreateOrtSession`, `TrimAsciiInPlace`, `ShapeToString`, `LooksLikeAbsolutePath`

Both enhancement guard and STT guard files `#include` this shared header.

**Recommendation: Option B** — the STT guard has 3 implementation files that all need these helpers. Duplication across 4+ files (enhancement + 3 STT) is unmaintainable.

---

## Test Strategy

### 16. C++ Unit Tests (`test/cpp/model_detect/model_detect_test.cpp`)

Add tests for each streaming family:

```
SttNameOnlyTransducerIsHeuristicStreaming
SttNameOnlyParaformerIsHeuristicStreaming
SttNameOnlyWhisperIsNotStreaming
SttNameOnlyMoonshineIsNotStreaming
SttFileListTransducerMarksStreaming        // needs encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt
SttFileListZipformerCtcMarksStreaming      // needs model.onnx, tokens.txt
SttFileListWhisperIsNotStreaming           // offline → isStreaming=false
SttGuardMissingEncoder                    // streaming kind but encoder missing → isStreaming=false
```

For filesystem-backed tests: create minimal test fixture directories with properly-shaped ONNX models (can be tiny 1-layer models exported for testing).

### 17. TypeScript Tests

Update any existing `detectSttModel` test mocks to include `isStreaming` from native.

---

## Implementation Order

| Phase | Files | Dependency |
|-------|-------|-----------|
| **Phase 0** | Extract shared ORT utils from enhancement guard → `common/sherpa-onnx-ort-guard-utils.{h,cpp}` | None |
| **Phase 1** | `sherpa-onnx-stt-online-guard.h` + `sherpa-onnx-stt-online-guard.cpp` (dispatcher + `IsStreamingCandidate`) | Phase 0 |
| **Phase 2a** | `sherpa-onnx-stt-online-guard-transducer.cpp` | Phase 1 |
| **Phase 2b** | `sherpa-onnx-stt-online-guard-paraformer.cpp` | Phase 1 |
| **Phase 2c** | `sherpa-onnx-stt-online-guard-ctc.cpp` | Phase 1 |
| **Phase 3** | Add `isStreaming` to `SttDetectResult` + integrate guard in `sherpa-onnx-model-detect-stt.cpp` | Phase 2 |
| **Phase 4** | Bridge propagation: JNI wrapper, iOS bridge, Kotlin mapper | Phase 3 |
| **Phase 5** | TypeScript: TurboModule signature, `src/stt/index.ts`, types, `streamingTypes.ts` | Phase 4 |
| **Phase 6** | Build system: CMakeLists (Android + test), verify podspec | Phase 2 |
| **Phase 7** | Tests: C++ unit tests + TS test updates | Phase 3 |

Phases 2a/2b/2c can be implemented in parallel.

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| ORT not available on iOS simulator builds | Same `__has_include` pattern as enhancement; guard returns `{passed=true}` when ORT unavailable |
| Transducer encoder model_type metadata missing (very old models) | Guard fails gracefully → `isStreaming=false`, model still usable offline |
| Performance: opening ORT sessions during detect adds latency | Session creation with no inference is fast (~5-50ms); acceptable for one-time detect |
| NeMo transducer vs Icefall transducer confusion | Decoder output count inspection (same logic as upstream `online-recognizer-impl.cc`) |
| WeNet CTC batch_size limitation (upstream `SHERPA_ONNX_EXIT(-1)`) | Not triggered at guard time; guard only inspects metadata/shapes, no inference |

---

## Out of Scope

- Offline STT model guards (not needed — no fatal exits in offline paths that aren't already caught by path validation)
- RKNN-specific guards (hardware-specific, already blocked by `isHardwareSpecificUnsupported`)
- Changes to upstream sherpa-onnx source (we guard around their exits, not patch them)
- TTS/Alignment online guards (no online TTS/alignment in sherpa-onnx)
