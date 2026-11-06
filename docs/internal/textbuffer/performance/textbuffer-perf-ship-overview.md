# TextBuffer perf — ship overview (final)

**Date:** 2026-11-06  
**Umbrella:** `perf/improve-textbuffer-from-benchmarks` (base `refactor/refactor-before-release-1-0`)  
**Measure source:** `exp/textbuffer-perf` @ `/Volumes/SSD/dev/react-native-sherpa-onnx-textbuffer-perf`  
**Evidence:** [`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md), [`textbuffer-perf-plan.md`](./textbuffer-perf-plan.md) §10  
**Policy:** Android A142P SoT; dual wall+RSS; ≥~2× or clear wall+flat RSS → keep. Jetsam Adaptive = TextBuffer-only (not Audio/Video/Image).

Keeps below are **landed as individual commits** on the umbrella branch. Merge to `refactor/refactor-before-release-1-0` is still outstanding until the umbrella PR lands.

---

## 1. Already in product (pre–measure phase)

| Item | Notes |
|------|--------|
| UTF-8 SoT + UTF-16 public indexing | axiom |
| Live/offline TextRegistry, spool TXT2 | axiom |
| `partialEventMinIntervalMs` throttle | product API; D-A4 batches *on top* |
| Fixed create defaults (`windowMaxChars` / `maxSegments`) | product; D-I3 Adaptive clamps under known low memory |

---

## 2. Measured **keep** — landed on umbrella

Portable C++ / thin wrappers. Tag: `Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (<ID>)`.

| ID | What | Evidence (A142P unless noted) |
|----|------|-------------------------------|
| **C1** | Delta journal `PARTIAL_APPEND` when suffix-extends | `C_spool_delta` |
| **C2** | Checkpoint + journal rotate (bounded `.txtj`) | `C_spool_checkpoint` |
| **C3** | Deferred `fflush` (64 KiB / 32 records) | `C_spool_fflush` ~2.1× |
| **C8** | Cache `currentUtf16Len_` (no double UTF-16 scan) | `C_utf16_len` ~1.9× |
| **C12** | Commit: no eager full spool snap when spool off | `C_commit_copies` ~28× |
| **D-A4** | Android `pipelineLiveTextPartial` latest-wins `mainHandler` batch | `D_partial_emit` ~6.6× |
| **D-I3** | iOS Adaptive Jetsam clamp on create caps (Text **only**) | `D_jetsam_caps`; ForceTight ~28× less RSS Δ |

---

## 3. Hygiene retained — landed with keeps

| ID | What | Action |
|----|------|--------|
| **C4** | Spool I/O after `stateMutex` unlock | landed with C12 |
| **C5** | Short `g_txt_mutex` around registry | landed |
| **C6** | Unlock-before listeners | already in product SoT |
| **D-A2** | One-pass `txt_utf16_slice_units` → `NewString` | landed (~1.3× hygiene) |

---

## 4. Measured **skip** — not enabled

| ID | What | Production state |
|----|------|------------------|
| **C13** | Streaming long replay | not ported |
| **C14** | Skip crc on hot journal | crc kept |
| **D-A1** | `GetStringCritical` | `GetStringChars` kept |
| **D-I1** | CFString UTF-16 → our codec | UTF8String kept |
| **D-A3** | `posix_fallocate` / `KEEP_SIZE` | not ported |
| **D-I2** | `madvise` / `MAP_POPULATE` | N/A (no text mmap) |

---

## 5. Deferred — not shipping now

| Item | Why |
|------|-----|
| **C7** spool coalesce / last-wins | keep lossless partial durability |
| **C9** bridge full-string audit | reopen if product wall shows bridge bound |
| **C10 / C11 / C15–C18** | wall not demanded |
| External libs (simdutf, …) | only if C10/C11/C14 reopen |
| Physical iPhone re-baseline | deferred; Adaptive safety net only |
| Partial-driven pipeline wakes | future-work; stay opt-in |
| Jetsam Adaptive on Audio/Video/Image | out of scope — TextBuffer only |

---

## 6. Throwaway — stays in exp worktree

Example TextBuffer Bench UI, auto-suite, ForceTight/Sync harness benches, device JSON dumps (summaries live in ranking/results md).

---

## 7. Host coverage (`textbuffer_host_test`)

Behavior / parity only (no wall gates). Tags: `Perf keep: …/textbuffer-perf-plan.md (<ID>)`.

| Keep | GTest |
|------|-------|
| B — utf16 slice | `Utf16Slice_*`, `OfflineUtf16Slice_*`, `LiveSnapshotUtf16Slice_*` |
| B — notify-only partial | `PartialEmit_PassesUtf16LengthNotFullString` (D-A4 Batched = device) |
| B — spool lossless | `OptInSpool_SkippedWithoutEnv` (+ C1/C2/C3) |
| B — offline text view | `OfflineTextView_ParityWithRead` |
| C1 | `OptInSpool_DeltaParityGrowRewriteCommit` |
| C2 | `OptInSpool_CheckpointRotateParity` |
| C3 | `OptInSpool_DeferredFlushParityMidSession` |
| C4 | `OptInSpool_ConcurrentAppendWithLookup_NoDeadlock` |
| C5 | `OfflinePopulate_ConcurrentSecondFails_NoDeadlock` |
| C6 | `SegEngineHooks_FireOnWriteFinalizeRelease` |
| C8 | `LivePartialUtf16Length_MatchesWindow` |
| C12 | `CommitWithSpoolOff_NoJournalFiles` |
| D-A2 | `Utf16SliceUnits_ParityWithSliceReencode` |
| D-I3 | `JetsamCaps_OffForceTightAdaptiveOverride` (Apple host only) |
| D-A4 | device-only (Kotlin); emit contract under B notify-only |

Opt-in spool cases need `SHERPA_HOST_TEXT_SPOOL=1`.

---

## 8. Remaining

1. Merge umbrella PR into `refactor/refactor-before-release-1-0`.
2. Optional: physical iPhone Adaptive smoke (D-I3); C9 only if bridge wall returns.

---

## 9. One-line scoreboard

| Bucket | Closed? | Keeps on umbrella | Skips |
|--------|---------|-------------------|-------|
| B baselines | yes | — (measurement) | spool-as-speed |
| C | yes | C1 C2 C3 C8 C12 (+ C4/C5 hygiene) | C13/C14; C7 defer |
| D | yes | D-A4, D-I3, D-A2 hygiene | D-A1/I1/A3/I2 |
