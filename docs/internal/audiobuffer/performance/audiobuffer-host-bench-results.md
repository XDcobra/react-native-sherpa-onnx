# AudioBuffer host bench results (Bucket B + C #1/#2)

**Host:** AppleClang arm64, `CMAKE_BUILD_TYPE=Release`, `test/cpp/audiobuffer/build/audiobuffer_bench`.  
**RSS:** `getrusage(RUSAGE_SELF).ru_maxrss` normalized to bytes. **Max RSS only rises** for the process lifetime — Δ after the first large suite is often `0`; interpret early rows for RSS, later rows for wall/disk.  
**Method:** [`audiobuffer-perf-plan.md`](./audiobuffer-perf-plan.md) §M.

Harness:

```bash
cmake -S test/cpp/audiobuffer -B test/cpp/audiobuffer/build -DCMAKE_BUILD_TYPE=Release
cmake --build test/cpp/audiobuffer/build --target audiobuffer_bench -j
./test/cpp/audiobuffer/build/audiobuffer_bench \
  --out docs/internal/audiobuffer/performance/audiobuffer-host-bench-results-c12-raw.md
```

Correctness after C #1/#2: `audiobuffer_host_test` — 17 passed / 1 skipped (mmap opt-in).

---

## Pre–C #1/#2 baselines (2026-11-05 morning)

| Suite | Wall ms | Samples/s | RSS Δ MiB | Disk MiB | Notes |
|-------|--------:|----------:|----------:|---------:|-------|
| `B_offline_ram` | 2.42 | 216424355 | **+2.05** | 0 | n=524288 kind=**ram** |
| `B_offline_mmap` | 36.33 | 173170265 | **+48.02** | 0 | n=6291456 kind=**mmap**; cold≈28.3 warm≈27.4 |
| `B_ring_append_drain` | **1.74** | 275499170 | 0* | 0 | chunk=320 (20 ms), 30 s, no spool |
| `B_spool_append` | 3.30 | 145544607 | 0* | **1.83** | spool tax ~1.9× vs ring |
| `B_spool_behind` | 0.14 | 572450805 | 0* | 0.30 | drain_from_0 OK |
| `B_live_to_offline_transfer` | 0.12 | — | 0* | — | kind=**mmap** |
| `B_live_to_offline_ring` | 0.01 | — | 0* | — | kind=ram |
| `C_int16_append` | 1.56 | 307560806 | 0* | 0 | pre-block-memcpy path |
| `C_resample_44k_to_16k` | 0.62 | 714990977 | 0* | 0 | |

\*RSS Δ flattened by prior `B_offline_mmap` peak.

---

## Post–C #1/#2 (same host, 2026-11-05)

Block `memcpy` spans in `PaLiveEntry` append / drain / peek / slice.

| Suite | Wall ms | Samples/s | RSS Δ MiB | Notes |
|-------|--------:|----------:|----------:|-------|
| `B_offline_ram` | 2.42 | 2.17e8 | +2.03 | unchanged path |
| `B_offline_mmap` | 42.35 | 1.49e8 | **+48.02** | create peak still the story |
| `B_ring_append_drain` | **0.12** | 3.92e9 | 0* | vs 1.74 → **~14.5× wall** (same fixture) |
| `B_spool_append` | 1.66 | 2.90e8 | 0* | still spool tax vs ring; absolute smaller |
| `B_spool_behind` | 0.13 | 6.03e8 | 0* | OK |
| `C_ring_chunk_256` | 0.14 | 3.46e9 | 0* | plan §3.1 sweep |
| `C_ring_chunk_1600` | 0.08 | 6.32e9 | 0* | |
| `C_ring_chunk_4800` | 0.05 | 9.85e9 | 0* | |
| `C_ring_chunk_16000` | 0.05 | 1.06e10 | 0* | larger chunks → fewer wraps |
| `C_int16_append` | 0.12 | 3.87e9 | 0* | benefits from #1 on append |
| `C_resample_44k_to_16k` | 0.14 | 3.21e9 | 0* | |

Raw dump: [`audiobuffer-host-bench-results-c12-raw.md`](./audiobuffer-host-bench-results-c12-raw.md).

---

## Post–C #9 / #11 smoke (same host, 2026-11-05)

Removed WAV→`.f32` double-copy helper; int16 append resolves live once + combined miss/invalidated lock.

| Suite | Wall ms | Notes |
|-------|--------:|-------|
| `B_live_to_offline_transfer` | 0.15 | kind=**mmap** still (already on adopt path) |
| `C_int16_append` | 0.30 | sub-ms host noise; device cold A/B decides Ship? |

Correctness: `audiobuffer_host_test` — 17 passed / 1 skipped.

---

## Interpretation

### C #1 / #2 (block ring memcpy)

- Host wall on `B_ring_append_drain` dropped **1.74 → 0.12 ms**; chunk sweep stays RSS-flat (after mmap peak).  
- Dual-gate with Android cold pull: see ranking doc — **Ship? keep** (Host + Android; iOS device deferred).

### Offline mmap create RSS

- Host still **+48 MiB** peak on create+first touch.  
- Android **isolated** cold `B_offline_mmap` reports only **~180 KiB** RSS Δ — not the host spike. Prefer device numbers for C #10 / prefault; **do not ship prefault** from host alone.

### Spool

- Still **lossless-not-speed** (tax remains; absolute ms small after #1/#2).

---

## Not done yet

- Per-suite process isolation for clean host RSS Δ on every row.  
- Physical iPhone confirm for C #1/#2 (deferred).  
- C #3+ only if product telemetry shows a remaining bound.
