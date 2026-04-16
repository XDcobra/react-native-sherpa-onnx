# Dynamic mmap threshold — implementation plan

**Status:** Implemented.  
**Depends on:** [`perf-offline-audio-buffer-mmap-impl-spec.md`](./perf-offline-audio-buffer-mmap-impl-spec.md) (current static 10 MB mmap policy)  
**Audience:** Native contributors (Kotlin, Objective-C++), SDK maintainers.  
**Breaking changes:** No public API change required.

---

## 0. Decision summary

Replace the current **static 10 MB** mmap threshold with a **deterministic native policy** derived from exactly three inputs:

1. **Platform** (`android` vs `ios`)
2. **Total device RAM class**
3. **Path type** (`file-origin` vs `heap-origin`)

The policy remains intentionally simple:

- No user-facing configuration
- No sampling of volatile "free RAM right now" values
- No battery / thermal / CPU heuristics
- No dependence on audio semantics beyond the already-known raw PCM size

The goal is to keep behavior **predictable**, **testable**, and **better aligned with device class and data origin** than a global fixed threshold.

---

## 1. Motivation

The current implementation hard-codes **10 MB raw PCM** as the cutoff for `InMemory` vs `mmap`-backed offline buffers on both platforms.

That is a solid conservative default, but it ignores two realities:

1. **Platform differences**  
   Android devices are more heterogeneous and often benefit from earlier file-backing on lower-memory devices. iOS devices are typically more uniform and can tolerate a somewhat higher in-memory cutoff.

2. **Device class differences**  
   A 10 MB heap allocation is much more significant on a 3 GB device than on a 12 GB device.

3. **Creation-path differences**  
   File-derived buffers are already close to a file-backed flow, so mmap is attractive earlier. Heap-derived buffers have often already paid the materialization cost, so upgrading to mmap should require a somewhat larger payload.

This plan introduces those distinctions without turning threshold selection into an opaque runtime heuristic.

---

## 2. Scope

### In scope

- Introduce a shared threshold policy model based on:
  - platform
  - total device RAM class
  - path type
- Replace hard-coded threshold constants in Android and iOS offline-buffer creation paths
- Use the dynamic threshold consistently for:
  - file decode → offline buffer
  - live spool → offline buffer
  - in-memory sample creation / upgrade paths
  - enhancement / TTS post-adopt mmap upgrades
- Surface the effective threshold in debug logging for easier validation
- Add focused tests for threshold selection and representative call sites
- Update mmap documentation to reflect the new policy

### Out of scope

- Public TypeScript API for tuning the threshold
- Dynamic decisions based on current free memory
- Battery / low power mode / thermal state inputs
- Storage-pressure-aware threshold changes
- Per-model or per-feature threshold specialization

---

## 3. Policy model

### 3.1 Inputs

#### Platform

- `android`
- `ios`

#### Total device RAM class

Use coarse buckets derived from total physical memory:

- `LOW` = `<= 3 GB`
- `MID` = `4 GB .. 6 GB`
- `HIGH` = `8 GB .. 12 GB`
- `VERY_HIGH` = `> 12 GB`

These classes should be computed once and reused. Exact byte boundaries should be centralized in one place per platform.

#### Path type

- `file-origin`
  - `createOfflineAudioBufferFromFile`
  - `createOfflineFromLive(... fullIfSpooled ...)`
  - any future path where samples are still primarily represented as file data
- `heap-origin`
  - `createOfflineAudioBufferFromSamples`
  - `createEntryWithThreshold(samples)`
  - `upgradeToMmapIfNeeded()`
  - enhancement / TTS outputs after samples already exist in RAM

### 3.2 Threshold formula

The threshold should be computed as:

```text
thresholdBytes = clamp(platformBase(pathType) * ramMultiplier(ramClass), min=4 MB, max=32 MB)
```

### 3.3 Recommended base thresholds

| Platform | Path type | Base threshold |
|---|---|---:|
| Android | file-origin | 6 MB |
| Android | heap-origin | 10 MB |
| iOS | file-origin | 8 MB |
| iOS | heap-origin | 12 MB |

### 3.4 Recommended RAM multipliers

| RAM class | Multiplier |
|---|---:|
| `LOW` (`<= 3 GB`) | `0.75x` |
| `MID` (`4..6 GB`) | `1.0x` |
| `HIGH` (`8..12 GB`) | `1.5x` |
| `VERY_HIGH` (`> 12 GB`) | `2.0x` |

### 3.5 Example outcomes

| Platform | RAM class | Path type | Computed threshold |
|---|---|---|---:|
| Android | `LOW` | file-origin | 4.5 MB |
| Android | `MID` | heap-origin | 10 MB |
| Android | `HIGH` | heap-origin | 15 MB |
| iOS | `MID` | file-origin | 8 MB |
| iOS | `HIGH` | file-origin | 12 MB |
| iOS | `VERY_HIGH` | heap-origin | 24 MB |

### 3.6 Rationale for path-type split

`file-origin` should mmap earlier because the flow is already file-centric:

- decode/file/spool paths already touch disk
- mmap avoids growing the Java / C++ heap unnecessarily
- these buffers are more likely to benefit from lazy paging and zero-copy reads

`heap-origin` should require a somewhat larger payload before switching:

- the heap materialization cost has often already been paid
- small-to-medium buffers are simpler to keep in memory
- late upgrade-to-mmap mainly helps with retention / downstream access, not initial creation

---

## 4. Implementation design

### 4.1 Shared conceptual model

Both native implementations should define the same concepts:

- `DeviceRamClass`
- `ThresholdPathType`
- `computeMmapThresholdBytes(pathType)`

The code does not need to be literally shared across platforms, but the behavior should remain aligned and documented in one place.

### 4.2 Android design

Introduce a small policy helper, for example:

- `android/src/main/java/com/sherpaonnx/audio/pipeline/MmapThresholdPolicy.kt`

Responsibilities:

- Read total physical memory using Android APIs
- Map device memory to `DeviceRamClass`
- Compute threshold bytes from `platform + ramClass + pathType`
- Expose simple call sites such as:
  - `forFileOrigin()`
  - `forHeapOrigin()`

Preferred memory source:

- `ActivityManager.MemoryInfo.totalMem`

This is stable, cheap, and available on supported Android API levels.

### 4.3 iOS design

Introduce an Objective-C++ / C++ helper near pipeline bridging code, for example:

- static functions in `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm`, or
- a small dedicated helper file if that keeps the bridge cleaner

Responsibilities mirror Android:

- Read total physical memory
- Map to `DeviceRamClass`
- Compute threshold bytes for `file-origin` / `heap-origin`

Preferred memory source:

- `[NSProcessInfo processInfo].physicalMemory`

This is stable and sufficient for the coarse RAM-class model.

### 4.4 Determinism and caching

Threshold computation should be cached after first use per process:

- total device RAM does not change during runtime
- RAM class does not change during runtime
- computed thresholds are pure functions of stable inputs

Suggested approach:

- compute RAM class once lazily
- precompute:
  - `fileOriginThresholdBytes`
  - `heapOriginThresholdBytes`

This avoids repeated platform calls and keeps logs stable.

---

## 5. File-by-file change plan

### 5.1 Android

#### `android/src/main/java/com/sherpaonnx/audio/pipeline/OfflineEntry.kt`

- Remove the hard-coded `PA_FILE_BACKED_THRESHOLD_BYTES` constant
- Keep raw-size calculation local to each decision point
- If helpful, move only the policy-free entry helpers here and keep threshold selection in the new policy file

#### `android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt`

Update threshold call sites:

- `createFromDecodedFile(...)`
  - use `file-origin` threshold
- `createOfflineFromF32WavSpoolFile(...)`
  - use `file-origin` threshold if there is a threshold gate before mmap adoption
- `createEntryWithThreshold(...)`
  - rename mentally to "createEntryWithPolicy" even if method name stays as-is
  - use `heap-origin` threshold
- `upgradeToMmapIfNeeded(...)`
  - use `heap-origin` threshold

#### `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt`

Update large-file decode path:

- any direct comparison against `PA_FILE_BACKED_THRESHOLD_BYTES` must use the policy helper
- file decode paths should use `file-origin`

#### `android/src/main/java/com/sherpaonnx/enhancement/facade/SherpaOnnxEnhancementHelper.kt`

- confirm post-adopt upgrade path uses `heap-origin`

#### `android/src/main/java/com/sherpaonnx/tts/service/TtsBatchGenerationService.kt`

- confirm post-adopt upgrade path uses `heap-origin`

### 5.2 iOS

#### `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm`

- Replace `kPaFileBackedThreshold`
- Add:
  - RAM-class computation
  - `file-origin` threshold accessor
  - `heap-origin` threshold accessor
- Update all threshold comparisons:
  - decoded file path → `file-origin`
  - live spool path → `file-origin`
  - `pa_createEntryWithThreshold(...)` → `heap-origin`
  - `pa_upgradeToMmapIfNeeded(...)` → `heap-origin`

#### `ios/enhancement/bridge/SherpaOnnx+EnhancementOffline.mm`

- confirm post-adopt upgrade path uses `heap-origin`

#### `ios/tts/bridge/SherpaOnnx+TTSBatch.mm`

- confirm post-adopt upgrade path uses `heap-origin`

---

## 6. Recommended code shape

### 6.1 Android pseudocode

```kotlin
internal enum class DeviceRamClass { LOW, MID, HIGH, VERY_HIGH }
internal enum class ThresholdPathType { FILE_ORIGIN, HEAP_ORIGIN }

internal object MmapThresholdPolicy {
  private const val MB = 1024L * 1024L

  fun thresholdBytes(pathType: ThresholdPathType): Long {
    val baseMb = when (pathType) {
      ThresholdPathType.FILE_ORIGIN -> 6.0
      ThresholdPathType.HEAP_ORIGIN -> 10.0
    }
    val multiplier = when (deviceRamClass()) {
      DeviceRamClass.LOW -> 0.75
      DeviceRamClass.MID -> 1.0
      DeviceRamClass.HIGH -> 1.5
      DeviceRamClass.VERY_HIGH -> 2.0
    }
    val platformAdjustedBaseMb = baseMb // Android values already baked in
    return (platformAdjustedBaseMb * multiplier * MB)
      .toLong()
      .coerceIn(4L * MB, 32L * MB)
  }
}
```

### 6.2 iOS pseudocode

```cpp
enum class PaDeviceRamClass { LOW, MID, HIGH, VERY_HIGH };
enum class PaThresholdPathType { FILE_ORIGIN, HEAP_ORIGIN };

static long pa_computeThresholdBytes(PaThresholdPathType pathType) {
  double baseMb = 0.0;
  switch (pathType) {
    case PaThresholdPathType::FILE_ORIGIN: baseMb = 8.0; break;
    case PaThresholdPathType::HEAP_ORIGIN: baseMb = 12.0; break;
  }

  double multiplier = 1.0;
  switch (pa_deviceRamClass()) {
    case PaDeviceRamClass::LOW: multiplier = 0.75; break;
    case PaDeviceRamClass::MID: multiplier = 1.0; break;
    case PaDeviceRamClass::HIGH: multiplier = 1.5; break;
    case PaDeviceRamClass::VERY_HIGH: multiplier = 2.0; break;
  }

  long bytes = (long)(baseMb * multiplier * 1024.0 * 1024.0);
  return std::min(32L * 1024L * 1024L, std::max(4L * 1024L * 1024L, bytes));
}
```

### 6.3 Logging

At first threshold use in a process, log something like:

```text
[PipelineAudio] mmap threshold policy: platform=android ramClass=MID fileOrigin=6291456 heapOrigin=10485760
```

This helps verify device classification during development without spamming per-buffer logs.

---

## 7. Testing plan

### 7.1 Unit-level policy tests

Add focused tests that validate:

- RAM byte values map to the expected RAM class
- `file-origin` threshold is lower than `heap-origin` threshold on the same platform
- thresholds clamp correctly at 4 MB / 32 MB

Where direct unit testing is awkward, structure helpers so the pure mapping logic is testable separately from platform API calls.

### 7.2 Integration checks

Validate representative boundaries:

1. Android low-RAM simulation
   - file-origin buffer just below computed threshold → `ram`
   - just above → `mmap`

2. Android high-RAM simulation
   - heap-origin upgrade threshold increases as expected

3. iOS mid/high-RAM simulation
   - file-origin and heap-origin select different thresholds

4. Existing creation paths still behave correctly
   - `createOfflineAudioBufferFromFile`
   - `createOfflineFromLive`
   - `createOfflineAudioBufferFromSamples`
   - enhancement output
   - TTS output

### 7.3 Regression checks

- No public TypeScript API changes
- `storageKind` remains `ram` or `mmap`
- Temp file lifecycle remains unchanged
- Small buffers do not regress to unnecessary file I/O

---

## 8. Rollout plan

### Phase 1: Policy helpers

- Add Android threshold policy helper
- Add iOS threshold policy helper
- Hard-code the initial policy values from this document

### Phase 2: Replace static constants

- Remove direct use of `10 MB` constants
- Update all call sites to choose `file-origin` vs `heap-origin`

### Phase 3: Validation

- Build Android
- Build iOS
- Run representative manual tests around threshold boundaries
- Confirm debug logs report expected RAM class and thresholds

### Phase 4: Documentation cleanup

- Update `perf-offline-audio-buffer-mmap-impl-spec.md`
  - replace the resolved question entry that still says "10 MB"
  - move dynamic policy out of "future plan" wording
- Add references from other mmap migration docs if needed

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Thresholds are too aggressive on some Android devices | Medium | Medium | Keep coarse conservative bases, clamp to minimum 4 MB, validate on low-memory emulator/device |
| Thresholds are too lenient on high-memory devices | Low | Low | Policy can be retuned centrally without API changes |
| Inconsistent path-type selection across call sites | Medium | Medium | Centralize path-type naming and document each call site explicitly |
| Platform drift between Android and iOS implementations | Medium | Medium | Keep both policies derived from this single spec and log computed values |
| Hard-to-reproduce behavior near threshold boundaries | Low | Medium | Add boundary-focused tests and one-time startup logging |

---

## 10. Final recommendation

Implement the dynamic threshold now using only:

- platform
- total device RAM class
- path type

Do **not** add volatile runtime signals in this iteration.

This yields a threshold policy that is:

- meaningfully smarter than a global 10 MB cutoff
- still deterministic and easy to reason about
- aligned with your current mmap architecture
- cheap to implement on both native platforms

If future tuning is needed, the next step should be **retuning the base values**, not expanding the number of inputs.
