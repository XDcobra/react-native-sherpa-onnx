# TextBuffer ranking: Host vs Android device vs iOS simulator

**Date:** 2026-11-06 (Bucket B + Stress + **Bucket C closed** + **Bucket D closed**).  
**Raw:** [`textbuffer-host-bench-results.md`](./textbuffer-host-bench-results.md), [`textbuffer-device-bench-results.md`](./textbuffer-device-bench-results.md), [`textbuffer-device-bench-a142p.ndjson`](./textbuffer-device-bench-a142p.ndjson), [`textbuffer-device-bench-c1-a142p.json`](./textbuffer-device-bench-c1-a142p.json), [`textbuffer-device-bench-c2-a142p.json`](./textbuffer-device-bench-c2-a142p.json), [`textbuffer-device-bench-c3-a142p.json`](./textbuffer-device-bench-c3-a142p.json), [`textbuffer-device-bench-c4-a142p.json`](./textbuffer-device-bench-c4-a142p.json), [`textbuffer-device-bench-c5-a142p.json`](./textbuffer-device-bench-c5-a142p.json), [`textbuffer-device-bench-c6-a142p.json`](./textbuffer-device-bench-c6-a142p.json), [`textbuffer-device-bench-c8-a142p.json`](./textbuffer-device-bench-c8-a142p.json), [`textbuffer-device-bench-c12-a142p.json`](./textbuffer-device-bench-c12-a142p.json), [`textbuffer-device-bench-c13-a142p-baseline.json`](./textbuffer-device-bench-c13-a142p-baseline.json), [`textbuffer-device-bench-c13-a142p.json`](./textbuffer-device-bench-c13-a142p.json), [`textbuffer-device-bench-c14-a142p.json`](./textbuffer-device-bench-c14-a142p.json), [`textbuffer-device-bench-da1-a142p-baseline.json`](./textbuffer-device-bench-da1-a142p-baseline.json), [`textbuffer-device-bench-da1-a142p-critical.json`](./textbuffer-device-bench-da1-a142p-critical.json), [`textbuffer-device-bench-da2-a142p-baseline.json`](./textbuffer-device-bench-da2-a142p-baseline.json), [`textbuffer-device-bench-da2-a142p.json`](./textbuffer-device-bench-da2-a142p.json), [`textbuffer-device-bench-di1-ios-sim-baseline.json`](./textbuffer-device-bench-di1-ios-sim-baseline.json), [`textbuffer-device-bench-di1-ios-sim.json`](./textbuffer-device-bench-di1-ios-sim.json), [`textbuffer-device-bench-da4-a142p-baseline.json`](./textbuffer-device-bench-da4-a142p-baseline.json), [`textbuffer-device-bench-da4-a142p.json`](./textbuffer-device-bench-da4-a142p.json), [`textbuffer-device-bench-da3-a142p-baseline.json`](./textbuffer-device-bench-da3-a142p-baseline.json), [`textbuffer-device-bench-da3-a142p-posix-corrupt.json`](./textbuffer-device-bench-da3-a142p-posix-corrupt.json), [`textbuffer-device-bench-da3-a142p.json`](./textbuffer-device-bench-da3-a142p.json), [`textbuffer-device-bench-di3-ios-sim-baseline.json`](./textbuffer-device-bench-di3-ios-sim-baseline.json), [`textbuffer-device-bench-di3-ios-sim.json`](./textbuffer-device-bench-di3-ios-sim.json), [`textbuffer-device-bench-ios-sim.ndjson`](./textbuffer-device-bench-ios-sim.ndjson).  
**Method:** dual wall+RSS; **in-platform** ratios. Android A142P = SoT. iOS = **simulator** only (physical device deferred; sim ≥2× vs Android may justify Ship *consideration*, not sole Ship?).

| Layer | Status |
|-------|--------|
| Host B | done |
| Android A142P B + Stress 300/900/3600 | done |
| iOS Simulator B + Stress 300/900/3600 | done (ratios) |
| iOS **device** | deferred (no phone) |
| Bucket **C1** (`C_spool_delta`) | **keep** |
| Bucket **C3** (`C_spool_fflush`) | **keep** — A142P B-fixture ≥2× wall |
| Bucket **C2** (`C_spool_checkpoint`) | **keep** — bounded journal + parity |
| Bucket **C12** (`C_commit_copies`) | **keep** — A142P ~28× wall vs B commit |
| Bucket **C4** (`C_spool_unlock`) | **skip** (wall) — hygiene retained |
| Bucket **C5** (`C_registry_unlock`) | **skip** (wall) — hygiene retained |
| Bucket **C6** (`C_listener_unlock`) | **skip** (wall) — unlock-before already correct; hygiene retained |
| Bucket **C8** (`C_utf16_len`) | **keep** — A142P ~1.9× nospool wall, flat RSS |
| Bucket **C13** (`C_spool_replay_long`) | **skip** — long replay already ~0.17 ms (C2); streaming no ≥2× |
| Bucket **C14** (`C_crc_optional`) | **skip** — no ≥2× vs C3; production crc retained |
| Bucket **C** | **closed** |
| Bucket **D-A1** (`D_jni_write_partial`) | **skip** — GetStringCritical no win vs GetStringChars; suite kept |
| Bucket **D-A2** (`D_jni_slice_out`) | **skip** wall (~1.3×); one-pass UTF-16 units retained (hygiene); suite kept |
| Bucket **D-I1** (`D_ios_write_partial`) | **skip** — CfUtf16 worse vs UTF8String; suite kept |
| Bucket **D-A4** (`D_partial_emit`) | **keep** — Batched ~6.6× vs Sync; fewer Binder emits; flat RSS |
| Bucket **D-A3** (`D_spool_fallocate`) | **skip** — KEEP_SIZE no win; raw posix_fallocate corrupts TXT2 size |
| Bucket **D-I2** | **skip** — no text mmap backing (MAP_POPULATE / madvise N/A) |
| Bucket **D-I3** (`D_jetsam_caps`) | **keep** — Adaptive clamp; ForceTight proved ~28× less RSS Δ on flood |
| Bucket D | **closed** |

---

## In-platform spool tax (partial SET storm)

Fixture B30 = 600 ops @ 20 Hz as-fast. Stress = same rate, longer durationSec.

| Layer | Dur | nospool wall | spool wall | Tax (spool÷nospool) | Disk (spool) |
|-------|----:|-------------:|-----------:|--------------------:|-------------:|
| Host | 30 | 0.17 ms | 1.73 ms | **~10×** | 0.089 MiB |
| Android A142P | 30 | 1.15 ms | 5.02 ms | **~4.4×** | 0.089 MiB |
| Android A142P | 300 | 20.99 ms | 33.69 ms | **~1.6×** | 0.89 MiB |
| Android A142P | 900 | 25.48 ms | 91.96 ms | **~3.6×** | 2.68 MiB |
| Android A142P | 3600 | 143.66 ms | 309.01 ms | **~2.2×** | 10.71 MiB |
| iOS sim | 30 | 3.21 ms | 11.69 ms | **~3.6×** | 0.089 MiB |
| iOS sim | 300 | 9.80 ms | 57.52 ms | **~5.9×** | 0.89 MiB |
| iOS sim | 900 | 16.65 ms | 96.18 ms | **~5.8×** | 2.68 MiB |
| iOS sim | 3600 | 41.78 ms | 351.78 ms | **~8.4×** | 10.71 MiB |

**Read:** Spool never beats nospool on wall. Tax is real but absolute walls stay small vs STT/OCR (hundreds of ms for 72k ops). Disk scales ~linear with snapshot count. Label spool **lossless**, not **speed**.

---

## Bucket B suite snapshot (Android SoT + iOS sim ratio)

B30 walls. iOS column = sim÷Android (1.0 = same; &lt;1 = sim faster).

| Suite | Host ms | Android ms | iOS sim ms | sim÷And | Notes |
|-------|--------:|-----------:|-----------:|--------:|-------|
| `B_live_partial_nospool` | 0.17 | **1.15** | 3.21 | 2.8× | baseline RAM path |
| `B_live_partial_spool` | 1.73 | **5.02** | 11.69 | 2.3× | full `PARTIAL_SET`+fflush |
| `B_live_commit_storm` | 10.76 | **159.4** | 47.59 | 0.30× | +2.39 MiB RSS on Android |
| `B_spool_replay` | 0.09 | **0.62** | 0.90 | 1.4× | fillOps=120 — cheap |
| `B_utf16_slice` | 0.31 | **7.52** | 5.65 | 0.75× | Android slice/full **~12.9×**; Host ~1.85× |
| `B_offline_populate_ocr` | 0.03 | **0.23** | 1.12 | 5.0× | +0.57 MiB RSS Android |

No iOS-sim cell is ≥2× **faster than Android** on a product-hot path in a way that changes Ship? (commit_storm sim-faster is absolute still small; UTF-16 friendlier ratio on sim is platform artifact).

---

## Keep / skip (Bucket B — shipped, now measured)

| Candidate | Decision | Why |
|-----------|----------|-----|
| Spool on (**lossless**) | **keep** | Correctness / late `fullIfSpooled`; Android tax 1.6–4.4× with predictable disk; not optional for durable live |
| Spool as **speed** | **skip** | Never faster than nospool on Host/Android/sim |
| Full-snapshot journal (shipped shape) | **keep** + **C1 deltas on grow** | Still used for non-prefix SET; APPEND path lands C1 |
| Delta journal (**C1**) | **keep** | See C1 section below |
| Doc checkpoint rotate (128 / 1 MiB) | **keep (C2)** | Bound `.txtj`; see C2 section |
| `fullIfSpooled` replay (short) | **keep** | Android ~0.62 ms @ fillOps=120 |
| `fullIfSpooled` replay (long / C13) | **skip** (streaming) | A142P ~0.17 ms @ 6k grow after C2; no product wall |
| UTF-16 mid-slice vs full read (speed) | **skip as speed** | Android ~13× slower than full on this fixture; **keep as axiom** for bridge (don’t ship full strings to JS) |
| Commit storm / offline OCR baselines | **C12 keep** on commit | Was O(n) spool snap while spool=off; see C12 |
| Partial-event coalescing / unlock-before listeners | **C6 skip** (hygiene) | Unlock-before already correct; suite `C_listener_unlock` |

### Plan §10 matrix (filled for B)

| Candidate | Decision |
|-----------|----------|
| Spool on (lossless) | **keep** |
| Spool as speed | **skip** |
| Full-snapshot journal | **keep (shipped)**; optimize via C1–C3 |
| Delta journal (C1) | **keep** |
| Checkpoint rotate (C2) | **keep** |
| Buffered fflush (C3) | **keep** |
| Spool outside stateMutex (C4) | **skip** wall; code kept as hygiene |
| Short `g_txt_mutex` (C5) | defer |
| Unlock-before listeners (C6) | hygiene / defer |
| Spool coalesce (C7) | defer (lossless tension) |
| Bridge full-string audit (C9) | defer (axiom path; profile if JS bound) |
| Offline mmap (C16) | **skip for now** — B OCR RSS +0.57 MiB, no RAM crisis |
| D-A1 / D-I1 string pin | **skip** both (Critical / CfUtf16 no win) |

---

## C1 — delta journal (`PARTIAL_APPEND` on prefix grow)

**Code:** `TxtLiveEntry::appendDeltaOrSetLocked` — equal skip / APPEND suffix / SET full. Replay applies SET as full replace. Suite `C_spool_delta` (B-fixture + grow).

| Platform | Row | Wall ms | Disk MiB | vs B spool disk | Parity |
|----------|-----|--------:|---------:|----------------:|--------|
| Host | `C_spool_delta_b_fixture` | 1.64 | 0.089 | ~1.0× (SET-heavy) | ok |
| Host | `C_spool_delta_grow` | 1.95 | **0.010** | **~8.6× less** | ok |
| Android A142P | `C_spool_delta_b_fixture` | 5.78 | 0.089 | ~1.0× vs B 5.02 ms / 0.089 | ok |
| Android A142P | `C_spool_delta_grow` | 4.88 | **0.010** | **~8.6× less** | ok |
| iOS sim | `C_spool_delta_b_fixture` | 7.08 | 0.089 | ~1.0× (SET-heavy) | ok |
| iOS sim | `C_spool_delta_grow` | 3.75 | **0.010** | **~8.6× less** | ok |

**Ship?** **keep** — clear disk win on append-grow on Host + A142P + iOS sim (RSS flat / tiny); B-fixture disk unchanged as expected; wall not ≥2× yet (fflush-bound → **C3**).

Raw: [`textbuffer-device-bench-c1-a142p.json`](./textbuffer-device-bench-c1-a142p.json), [`textbuffer-device-bench-c1-ios-sim.json`](./textbuffer-device-bench-c1-ios-sim.json).

---

## C3 — buffered fflush (64 KiB / 32 records)

**Code:** `appendSnapshotRecordLocked` tracks unflushed bytes/records; `fflush` on budget, FINALIZE, `snapshotFullTextIfSpooled`, close. Suite `C_spool_fflush` (same shape as C1).

| Platform | Row | Wall ms | vs C1 wall | Disk MiB | Parity |
|----------|-----|--------:|-----------:|---------:|--------|
| Host | `C_spool_fflush_b_fixture` | 1.35 | ~1.2× vs C1 1.64 | 0.089 | ok |
| Host | `C_spool_fflush_grow` | 1.59 | ~1.2× vs C1 1.95 | 0.010 | ok |
| Android A142P | `C_spool_fflush_b_fixture` | **2.78** | **~2.1×** vs C1 5.78 | 0.089 | ok |
| Android A142P | `C_spool_fflush_grow` | 4.56 | ~1.1× vs C1 4.88 | 0.010 | ok |
| iOS sim | `C_spool_fflush_b_fixture` | 4.06 | ~1.7× vs C1 7.08 | 0.089 | ok |
| iOS sim | `C_spool_fflush_grow` | 6.71 | (noise / no win) | 0.010 | ok |

**Ship?** **keep** — Android SoT B-fixture ≥~2× wall, RSS flat, disk unchanged; Host/iOS directional. Grow wall not the win path (already APPEND-cheap after C1).

Raw: [`textbuffer-device-bench-c3-a142p.json`](./textbuffer-device-bench-c3-a142p.json), [`textbuffer-device-bench-c3-ios-sim.json`](./textbuffer-device-bench-c3-ios-sim.json).

---

## C2 — checkpoint 128 events / 1 MiB + journal rotate

**Code:** after journal thresholds, `writeCheckpointSnapshotLocked(lastJournaledFull_)` then truncate/reopen `.txtj`. Suite `C_spool_checkpoint` (6k grow @ durationSec=30).

| Platform | Row | Wall ms | Disk MiB | journalPre B | Parity | Bound |
|----------|-----|--------:|---------:|-------------:|--------|-------|
| Host | `C_spool_checkpoint_grow` | 38.4 | 0.013 | 1980 | ok | ok |
| Android A142P | `C_spool_checkpoint_grow` | 316.7 | 0.013 | 1998 | ok | ok |
| iOS sim | `C_spool_checkpoint_grow` | 114.4 | 0.013 | 1980 | ok | ok |

Without rotate, 6k APPEND records ≈ ~108 KiB journal; measured residual journal ~2 KiB. Replay wall ≪ write wall.

**Ship?** **keep (policy)** — lossless + bounded disk; wall not a ≥2× claim (product need is bound long sessions).

Raw: [`textbuffer-device-bench-c2-a142p.json`](./textbuffer-device-bench-c2-a142p.json), [`textbuffer-device-bench-c2-ios-sim.json`](./textbuffer-device-bench-c2-ios-sim.json).

---

## C12 — commit path (skip eager spool snapshot when off)

**Code:** `commitSegment` / `writePartial` / `appendText` only call `maybeWriteSnapshotToSpool` when `spoolEnabled()`; push segment then one notify copy.

| Platform | Row | Wall ms | vs B commit | RSS Δ | Notes |
|----------|-----|--------:|------------:|------:|-------|
| Host | `C_commit_copies` | 0.29 | ~37× vs B 10.76 | +0.02 MiB | ok |
| Android A142P | `C_commit_copies` | **5.62** | **~28×** vs B 159.4 | +0.67 MiB (was +2.39) | ok |
| iOS sim | `C_commit_copies` | 2.71 | ~18× vs B 47.59 | +1.1 MiB | ok |

**Ship?** **keep** — clear ≥2× wall + lower RSS on Android SoT.

Raw: [`textbuffer-device-bench-c12-a142p.json`](./textbuffer-device-bench-c12-a142p.json), [`textbuffer-device-bench-c12-ios-sim.json`](./textbuffer-device-bench-c12-ios-sim.json).

---

## C4 — spool I/O outside `stateMutex`

**Code:** `writePartial` / `appendText` / `commitSegment` copy snapshot under `stateMutex`, then `maybeWriteSnapshotToSpool` after unlock. Suite `C_spool_unlock` (B-fixture + concurrent `snapshotText` reader).

| Platform | Row | Wall ms | vs C3 B-fixture | Reader hits | Parity |
|----------|-----|--------:|----------------:|------------:|--------|
| Host | `C_spool_unlock` | 5.25 | (contended; C3 alone ~1.7) | ~119k | ok |
| Android A142P | `C_spool_unlock` | 16.8 | not ≥2× vs C3 2.78 | ~55k | ok |
| iOS sim | `C_spool_unlock` | 5.95 | not ≥2× vs C3 4.06 | ~28k | ok |

**Ship?** **skip** as wall/RSS dual-gate win — writer wall under reader contention is not ≥2× better than post-C3 spool. **Code retained** as lock hygiene (readers progress during spool I/O; parity green; single-writer journal order assumed).

Raw: [`textbuffer-device-bench-c4-a142p.json`](./textbuffer-device-bench-c4-a142p.json), [`textbuffer-device-bench-c4-ios-sim.json`](./textbuffer-device-bench-c4-ios-sim.json).

---

## C5 — short `g_txt_mutex`

**Code:** `txt_populate_offline_if_empty` resolves `shared_ptr` under `g_txt_mutex`, then `tryPopulate` under entry `populateMutex`. Suite `C_registry_unlock` (OCR populate + 8× multilive + lookup noise).

| Platform | Row | Wall ms | vs B | Notes |
|----------|-----|--------:|-----:|-------|
| Host | `C_registry_unlock_populate` | 0.01 | ~B 0.03 (noise) | ok |
| Host | `C_registry_unlock_multilive` | 0.24 | (new harness) | ok |
| Android A142P | `C_registry_unlock_populate` | 0.26 | ~B 0.23 (no win) | ok |
| Android A142P | `C_registry_unlock_multilive` | 4.99 | (new; live path already unlocked) | ok |
| iOS sim | `C_registry_unlock_populate` | 0.55 | vs B 1.12 (not SoT) | ok |
| iOS sim | `C_registry_unlock_multilive` | 0.48 | (new) | ok |

**Ship?** **skip** as wall/RSS dual-gate — Android SoT populate unchanged; live writes already mutated without `g_txt_mutex`. **Code retained** as hygiene (map lock short; concurrent double-populate safe via `tryPopulate`).

Raw: [`textbuffer-device-bench-c5-a142p.json`](./textbuffer-device-bench-c5-a142p.json), [`textbuffer-device-bench-c5-ios-sim.json`](./textbuffer-device-bench-c5-ios-sim.json).

---

## C8 — reuse UTF-16 lengths on live write

**Code:** `currentUtf16Len_` cache; `writePartial` / `appendText` / commit strip / `partialUtf16Length` reuse it (no second scan for snaps). Suite `C_utf16_len` = `B_live_partial_nospool` shape.

| Platform | Row | Wall ms | vs B nospool | RSS Δ | Notes |
|----------|-----|--------:|-------------:|------:|-------|
| Host | `C_utf16_len` | 0.07 | ~B 0.07 (noise) | 0 | ok |
| Android A142P | `C_utf16_len` | **0.61** | **~1.9×** vs B 1.15 | 0 | ok |
| iOS sim | `C_utf16_len` | 0.38 | ~8× vs B 3.21 | +0.1 MiB | ok |

**Ship?** **keep** — clear wall win at flat RSS on Android SoT (≈2× gate); sim directional.

Raw: [`textbuffer-device-bench-c8-a142p.json`](./textbuffer-device-bench-c8-a142p.json), [`textbuffer-device-bench-c8-ios-sim.json`](./textbuffer-device-bench-c8-ios-sim.json).

---

## C14 — optional integrity (skip crc32 on hot journal)

**Code tried:** hot `PARTIAL_*` / `SEGMENT_COMMIT` journal records write `checksum=0` (no `computeSpoolChecksum`); `CHECKPOINT` / `FINALIZE` keep crc; replay skips verify when stored checksum is 0. Suite `C_crc_optional` = same shape as `C_spool_fflush`. **Reverted** after gate (not hygiene — integrity tradeoff without wall win).

| Platform | Row | Wall ms | vs C3 B-fixture | RSS Δ | Notes |
|----------|-----|--------:|----------------:|------:|-------|
| Host | `C_crc_optional_b_fixture` | 2.13 | ~1.65× vs C3 ~3.51 | 0 | parity=ok |
| Host | `C_crc_optional_grow` | 2.83 | ~1.6× vs C3 ~4.57 | +0.06 | parity=ok |
| Android A142P | `C_crc_optional_b_fixture` | **3.14** | **no win** vs C3 **2.78** | +0.23 MiB | parity=ok |
| Android A142P | `C_crc_optional_grow` | 3.08 | ~1.5× vs C3 4.56 | 0 | parity=ok |
| iOS sim | — | — | — | — | blocked (StatusBar NativeModule RedBox); SoT skip stands |

**Ship?** **skip** — A142P B-fixture not ≥2× vs post-C3 spool wall (slightly worse / noise); production keeps full journal crc. Suite harness retained for re-measure.

Raw: [`textbuffer-device-bench-c14-a142p.json`](./textbuffer-device-bench-c14-a142p.json).

---

## C13 — long-session `fullIfSpooled` streaming replay

**Suite:** `C_spool_replay_long` — 6000 C2-grow appends (spool on → ckpt/rotate), wall = one `snapshotFullTextIfSpooled` only; parity vs expected.

**Tried:** streaming reconstruct (reserve + fread into `latest` for ckpt/SET/APPEND). **Reverted** after gate (no ≥2×; absolute wall already tiny thanks to C2).

| Platform | Phase | Wall ms | vs pre | RSS Δ | Notes |
|----------|-------|--------:|-------:|------:|-------|
| Host | baseline | 0.11 | — | 0 | parity=ok |
| Host | streaming | 0.06 | ~1.8× noise | 0 | parity=ok |
| Android A142P | baseline | **0.17** | — | 0 | journal~2 KiB ckpt~12 KiB |
| Android A142P | streaming | **0.22** | no win | 0 | parity=ok |
| iOS sim | — | — | — | — | blocked (StatusBar RedBox); SoT skip stands |

**Ship?** **skip** — no product-bound wall after C2 (A142P ~0.17 ms); streaming not ≥2×. Suite retained as regression.

Raw: [`textbuffer-device-bench-c13-a142p-baseline.json`](./textbuffer-device-bench-c13-a142p-baseline.json), [`textbuffer-device-bench-c13-a142p.json`](./textbuffer-device-bench-c13-a142p.json) (post-streaming measure before revert).

---

## C6 — unlock-before listeners (hygiene confirm)

**Code:** `notifyAppendListeners` / `notifyCommitListeners` already snapshot under listener mutex and invoke **outside**; `commitSegment` / `finalize_` call notify after `stateMutex` release. Suite `C_listener_unlock`: 8 append + 8 commit listeners with nested `txt_get_live_entry`.

| Platform | Row | Wall ms | vs related B/C | RSS Δ | Notes |
|----------|-----|--------:|---------------:|------:|-------|
| Host | `C_listener_unlock_partial` | 0.25 | vs C8 ~0.07–0.11 (noise) | 0 | appendHits=0 (idle on writePartial) |
| Host | `C_listener_unlock_commit` | 0.58 | N=500×8 hits | +0.08 | parity=ok |
| Android A142P | `C_listener_unlock_partial` | 2.80 | not ≥2× vs C8 0.61 | 0 | ok |
| Android A142P | `C_listener_unlock_commit` | 9.87 | listener tax expected | 0 | parity=ok (4000/4000) |
| iOS sim | — | — | — | — | blocked (StatusBar RedBox); SoT skip stands |

**Ship?** **skip** (wall) — unlock-before already correct; hygiene retained (comments + suite). No production behavior change.

Raw: [`textbuffer-device-bench-c6-a142p.json`](./textbuffer-device-bench-c6-a142p.json).

---

## Bucket C — **closed** (summary)

| Decision | Items |
|----------|-------|
| **keep** | C1 delta journal, C2 checkpoint/rotate, C3 deferred fflush, C8 utf16 len cache, C12 commit skip spool snap |
| **skip** (hygiene retained) | C4 spool unlock, C5 registry unlock, C6 unlock-before listeners |
| **skip** (reverted) | C13 streaming replay, C14 optional crc |
| **deferred (product)** | **C7** coalesce — text RAM is fine; keep spool **lossless** (every partial durable); no last-wins without a later explicit policy change |
| **deferred (wall)** | C9/C10/C11/C15–C18 — reopen only on measured product wall |

**External libs (§5):** no vendor now. simdutf / RapidJSON|simdjson / xxhash only if C10 / C11 / C14 reopen with a dual-gate wall.

---

## D-A1 — JNI hot-write string pin

**Path:** Kotlin `nativeWritePartial` → `jstringToContentUtf8` (`GetStringChars` + `txt_utf8_from_utf16`) → C++ `writePartial`. Suite `D_jni_write_partial` (real JNI; Host N/A).

| Platform | Phase | Wall ms | vs | RSS Δ | Notes |
|----------|-------|--------:|----|------:|-------|
| Android A142P | baseline (GetStringChars) | **4.25** | ~7× vs native C8 0.61 | +1.5 MiB PSS | ok |
| Android A142P | GetStringCritical | **12.7** | **worse** vs baseline | +1.7 MiB PSS | ok |
| Host | — | — | — | — | JNI N/A |
| iOS | — | — | — | — | D-I1 later |

**Ship?** **skip** — Critical not ≥2× (regression); keep `GetStringChars`. Suite retained. JNI tax vs native C still real (~4 ms) → convert shape / D-A2, not Critical.

Raw: [`textbuffer-device-bench-da1-a142p-baseline.json`](./textbuffer-device-bench-da1-a142p-baseline.json), [`textbuffer-device-bench-da1-a142p-critical.json`](./textbuffer-device-bench-da1-a142p-critical.json).

---

## D-A2 — JNI UTF-16 slice out (`NewString`)

**Path:** Kotlin `nativeReadOfflineTextSlice` → mid UTF-16 window → `NewString`. Suite `D_jni_slice_out` (200× start=500 max=2048 on ~50 KiB offline). Native `B_utf16_slice` ~**7.52** ms (same window class).

| Platform | Phase | Wall ms | vs | RSS Δ | Notes |
|----------|-------|--------:|----|------:|-------|
| Android A142P | baseline (utf8 slice + re-encode + NewString) | **19.77** | ~2.6× vs native 7.52 | +2.7 MiB PSS | ok |
| Android A142P | one-pass `txt_utf16_slice_units` + NewString | **15.14** | **~1.31×** vs baseline | +2.3 MiB PSS | ok |
| Host | — | — | — | — | JNI N/A |
| iOS | — | — | — | — | D-I1 later |

**Ship?** **skip** wall (not ≥2× / not clear). **Retain** one-pass units path (hygiene: no UTF-8 intermediate for slice). Suite retained. Remaining tax is mostly `NewString` / JNI — not further slice encode micro-opts unless product wall shows slice-out bound.

Raw: [`textbuffer-device-bench-da2-a142p-baseline.json`](./textbuffer-device-bench-da2-a142p-baseline.json), [`textbuffer-device-bench-da2-a142p.json`](./textbuffer-device-bench-da2-a142p.json).

---

## D-I1 — iOS NSString hot-write convert

**Path:** NSString → content UTF-8 → C++ `writePartial`. Suite `D_ios_write_partial` (600 ops @ 20Hz×30s; iOS sim). Native `C_utf16_len` ~**0.38** ms.

| Platform | Phase | Wall ms | vs | RSS Δ | Notes |
|----------|-------|--------:|----|------:|-------|
| iOS sim | baseline (`UTF8String`) | **0.71** | ~1.9× vs native 0.38 | +16 KiB | ok |
| iOS sim | CfUtf16 (`CFStringGetCharacters` → `txt_utf8_from_utf16`) | **2.61** | **worse** (~0.27×) | +96 KiB | ok |
| Android | — | — | — | — | D-A1 covered |
| Host | — | — | — | — | ObjC N/A |

**Ship?** **skip** — CfUtf16 not ≥2× (regression); keep `UTF8String`. Helper + mode switch retained for harness; production default UTF8String. Suite retained.

Raw: [`textbuffer-device-bench-di1-ios-sim-baseline.json`](./textbuffer-device-bench-di1-ios-sim-baseline.json), [`textbuffer-device-bench-di1-ios-sim.json`](./textbuffer-device-bench-di1-ios-sim.json).

---

## D-A4 — partial JS emit batching (Binder)

**Path:** `LiveTextEntry.writePartial` → `pipelineLiveTextPartial` via `LiveTextPartialEmitPolicy`. Suite `D_partial_emit` (600 ops, emit on, interval=0). Compare to D-A1 no-emit ~4.25 ms (emit tax).

| Platform | Phase | Wall ms | vs | RSS Δ | Notes |
|----------|-------|--------:|----|------:|-------|
| Android A142P | Sync (immediate emit) | **137.4** | — | +2.7 MiB PSS | emits=600 |
| Android A142P | Batched (latest-wins mainHandler) | **20.9** | **~6.6×** | +1.6 MiB PSS | emits=69 |
| Host | — | — | — | — | JS bridge N/A |
| iOS | — | — | — | — | Android-first; CFRunLoop coalesce later if needed |

**Ship?** **keep** — ≥2× wall + flatter RSS. Default `LiveTextPartialEmitPolicy.Mode.Batched`. `partialEventMinIntervalMs` still applies before schedule. Suite retained.

Raw: [`textbuffer-device-bench-da4-a142p-baseline.json`](./textbuffer-device-bench-da4-a142p-baseline.json), [`textbuffer-device-bench-da4-a142p.json`](./textbuffer-device-bench-da4-a142p.json).

---

## D-A3 / D-I2 — spool fallocate / mmap hints

**Path:** TXT2 journal/checkpoint still `fopen`/`fwrite` (no text mmap). Suite `D_spool_fallocate` = C2 grow (6000 appends).

| Platform | Phase | Wall ms | vs | RSS Δ | Notes |
|----------|-------|--------:|----|------:|-------|
| Android A142P | baseline (no fallocate) | **28.4** | — | +0.5 MiB | parity ok; disk 13.8 KiB |
| Android A142P | `posix_fallocate` (grows st_size) | **30.8** | worse + **corrupt** | +1.0 MiB | TXT2 reader sees 2 MiB ckpt |
| Android A142P | `fallocate(KEEP_SIZE)` | **29.8** | **~0.95×** | +0.9 MiB | parity ok; no ≥2× |
| Host / iOS | — | — | — | — | D-I2 N/A (no mmap) |

**Ship?** **skip** — KEEP_SIZE not ≥2×; raw `posix_fallocate` unsafe for size-based TXT2. Flag default **off**; gated helper retained for harness. **D-I2 skip** (no mmap backing → no `madvise`/`MAP_POPULATE`).

Raw: [`textbuffer-device-bench-da3-a142p-baseline.json`](./textbuffer-device-bench-da3-a142p-baseline.json), [`textbuffer-device-bench-da3-a142p-posix-corrupt.json`](./textbuffer-device-bench-da3-a142p-posix-corrupt.json), [`textbuffer-device-bench-da3-a142p.json`](./textbuffer-device-bench-da3-a142p.json).

---

## D-I3 — Jetsam-aware live caps

**Path:** iOS `createLiveTextBuffer` → `txt_ios_apply_jetsam_caps` (`os_proc_available_memory`). Suite `D_jetsam_caps` floods req window=1M / segs=8k.

| Platform | Phase | Wall ms | RSS Δ | Notes |
|----------|-------|--------:|------:|-------|
| iOS sim | Off (fixed huge caps) | **185** | **+22.8 MiB** | clamped=0; finalUtf16≈1M; segs=2000 |
| iOS sim | ForceTight (harness pressure) | **5.4** | **+0.8 MiB** | →16k/512; ~**28×** less RSS Δ; ~**34×** wall |
| iOS sim | Adaptive (avail=0 unknown) | — | — | no clamp (avail≤0 treated unknown) |
| Physical iPhone | Adaptive under real Jetsam | — | — | deferred; safety net only when avail known+low |

**Ship?** **keep Adaptive** as default — clamps only when available memory is known and low; ForceTight harness-only. Sim cannot supply real Jetsam pressure (`availBytes=0`). Suite retained.

Raw: [`textbuffer-device-bench-di3-ios-sim-baseline.json`](./textbuffer-device-bench-di3-ios-sim-baseline.json), [`textbuffer-device-bench-di3-ios-sim.json`](./textbuffer-device-bench-di3-ios-sim.json).

---

## Bucket D — **closed**

| ID | Ship? |
|----|-------|
| D-A1 | skip |
| D-A2 | skip (hygiene units retained) |
| D-I1 | skip |
| D-A4 | **keep** (Batched) |
| D-A3 / D-I2 | skip |
| D-I3 | **keep** (Adaptive) |

C9 full-string audit remains deferred (pairs with bridge reads if product wall returns).

**Ship / land matrix:** [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md) — product vs exp keeps vs skip vs still-to-land.
