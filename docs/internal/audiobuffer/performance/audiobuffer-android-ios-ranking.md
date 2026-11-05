# AudioBuffer ranking: Host vs Android device vs iOS simulator

**Date:** 2026-11-05 (through C #17).  
**Raw:** [`-c12/`](./audiobuffer-bench-android-a142p-c12/), [`-c34/`](./audiobuffer-bench-android-a142p-c34/), [`-c5/`](./audiobuffer-bench-android-a142p-c5/), [`-c911/`](./audiobuffer-bench-android-a142p-c911/), [`-c13/`](./audiobuffer-bench-android-a142p-c13/), [`-c16/`](./audiobuffer-bench-android-a142p-c16/), [`-c17/`](./audiobuffer-bench-android-a142p-c17/), iOS sim [`-c34/`](./audiobuffer-bench-ios-sim-c34/), [`-c5/`](./audiobuffer-bench-ios-sim-c5/), [`-c911/`](./audiobuffer-bench-ios-sim-c911/), [`-c13/`](./audiobuffer-bench-ios-sim-c13/), [`-c16/`](./audiobuffer-bench-ios-sim-c16/), [`-c17/`](./audiobuffer-bench-ios-sim-c17/).  
**Method:** dual wall+RSS; in-platform ratios. iOS = **simulator** (device deferred).

| Layer | Status |
|-------|--------|
| Host B + C hooks | done |
| Android A142P B + C #1–#5/#9/#11/#13/#16/#17 | done |
| iOS Simulator B + C #1/#2/#4/#5/#9/#11/#13/#16/#17 | done (ratios) |
| iOS JNI (#3) | n/a |
| iOS **device** | deferred |

---

## C #1 / #2 — block ring memcpy

| Platform | before | after | Wall |
|----------|-------:|------:|------|
| Host | 1.74 ms | 0.12 ms | ~14.5× |
| Android cold | 7.96 ms | 4.09 ms | ~1.94× |
| iOS sim | 6.21 ms | **1.37 ms** | ~4.5× (direction confirm) |

**Ship?** **keep** — product SoT on `perf/improve-audiobuffer-from-benchmarks` now matches (`writeRingContiguous` / `readRingContiguous` in `PaLiveEntry.h` + host wrap/parity tests).

---

## C #3 / D-A1 — JNI float Critical (Android only)

| Suite | Wall ms | RSS Δ (PSS) |
|-------|--------:|------------:|
| `C_jni_float_append` | 8.06 | +1.34 MiB |

No pre-Critical JNI baseline on device. Wall for 30 s @20 ms chunks is small; PSS Δ likely dominated by live ring residency, not the pin. iOS correctly has no JNI path (buttons hidden; native returns `skipped: android_jni_only`).

**Ship?** **keep on Android** (parity with Int16 Critical). Re-check PSS on a real mic session if Jetsam appears.

Product SoT on `perf/improve-audiobuffer-from-benchmarks`: `nativeAppendSamplesToLive` uses `GetPrimitiveArrayCritical` (no Region + heap vector); DirectByteBuffer not preferred / not added.

---

## C #4 — portable int16→f32 chunked convert

| Platform | Suite | Wall ms | RSS Δ |
|----------|-------|--------:|------:|
| Host | `C_int16_append` | ~0.4 | flat* |
| Android | `C_int16_append` | 5.39 | 0 |
| Android | `C_jni_int16_append` | 11.39 | +1.45 MiB |
| iOS sim | `C_int16_append` | 4.84 | +80 KiB |

\*Host after mmap peak. Removes full-length float vector per append.

**Ship?** **keep** (portable). JNI int16 wrapper stays Critical + #4.

Product SoT on `perf/improve-audiobuffer-from-benchmarks`: `pa_append_int16_samples_to_live` uses 4096-sample stack-chunk convert + single live resolve (no full-length float vector).

---

## Isolated mmap RSS

Android cold `B_offline_mmap` ~+180 KiB; iOS sim ~+160 KiB. Host +48 MiB create peak **not** reproduced on devices → **C #10 prefault = skip**.

---

## Keep / skip summary

| Candidate | Decision |
|-----------|----------|
| Threshold ram/mmap | **keep** |
| Spool speed | **skip** |
| Spool lossless | **keep** |
| Live→offline mmap adopt | **keep** |
| C #1/#2 block memcpy | **keep** (product SoT landed) |
| C #3 JNI float Critical | **keep (Android)** (product SoT landed; DB not preferred) |
| C #4 chunked int16 convert | **keep** (product SoT landed) |
| C #5 faster resample lib | **skip for now** — baseline cheap (A142P 26 ms / iOS sim 18 ms for 30 s @44.1k) |
| C #6 prefer matched SR | **keep as policy** |
| C #10 prefault | **skip** |
| C #7/#8 spool I/O | **defer** — A142P spool 9.5 vs ring ~3.4–4.1 ms / 30 s; behind 1.2 ms (no lag pain) |
| C #9 kill WAV→`.f32` double copy | **keep** (product SoT landed) — helper removed; iOS fullIfSpooled → `pa_transfer_offline_from_live` |
| C #11 shorten `g_pa_mutex` | **keep (hygiene)** — A142P `C_int16` ~flat; microbench convert-bound, not mutex-bound |
| C #13 unlock-before listeners | **keep (hygiene)** (product SoT landed) — snapshot then invoke after unlock |
| C #14 coalesce seg hook | **defer** — needs attached-engine pipeline telemetry |
| C #16 kill `readAllSamples` hot paths | **keep** (product SoT landed) — `pa_clone_offline` / `pa_append_offline_to_live` + Android/iOS wire |
| C #17 JSI ByteBufferPool hit rate | **keep** — A142P/iOS sim **hitPct=100** (4500/4500); capacity-tolerant release |

### C #5 baseline (no lib change)

| Platform | `C_resample_44k_to_16k` wall | RSS Δ |
|----------|-----------------------------:|------:|
| Android A142P | 25.95 ms | +268 KiB |
| iOS sim | 17.74 ms | +416 KiB |

### C #9 / #11 device/sim

| Platform | Suite | before | after | Notes |
|----------|-------|-------:|------:|-------|
| Android | `B_live_to_offline_transfer` | 1.19 cold / 0.24 warm | 0.29 | `kind=mmap`; suite was already adopt |
| Android | `C_int16_append` | 5.39 | 5.05 | ~flat |
| Android | `C_jni_int16_append` | 11.39 | 13.61 | noise |
| iOS sim | `B_live_to_offline_transfer` | 0.80 | 0.24 | `kind=mmap` |
| iOS sim | `C_int16_append` | 4.84 | 6.31 | sim noise |

---

### C #16 device/sim

Product SoT on `perf/improve-audiobuffer-from-benchmarks`: C APIs + Android Kotlin/JNI + iOS bridge off `readAllSamples` for same-SR clone / offline→live append.

| Platform | Suite | Wall ms | RSS Δ |
|----------|-------|--------:|------:|
| Android | `C_append_offline_to_live` | 0.35 | 0 |
| Android | `C_clone_offline` | 4.80 | +1.92 MiB |
| iOS sim | `C_append_offline_to_live` | 0.39 | +192 KiB |
| iOS sim | `C_clone_offline` | 3.31 | +1.91 MiB |

---

### C #17 device/sim

| Platform | hitPct | hits/misses | RSS Δ |
|----------|-------:|------------:|------:|
| Android A142P | **100** | 4500 / 0 | +1.73 MiB |
| iOS sim | **100** | 4500 / 0 | reclaim noise |

---

---

## Bucket D — Ship? (filled 2026-11-05)

Full Wall/RSS columns: plan §M.7. Raw: [`audiobuffer-bench-android-a142p-d/`](./audiobuffer-bench-android-a142p-d/), [`audiobuffer-bench-ios-sim-d/`](./audiobuffer-bench-ios-sim-d/), stress [`audiobuffer-bench-android-a142p-stress/`](./audiobuffer-bench-android-a142p-stress/), [`audiobuffer-bench-ios-sim-stress/`](./audiobuffer-bench-ios-sim-stress/).

| ID | Suite-ID(s) | Ship? | Notes |
|----|-------------|-------|-------|
| D-A1 | `D_a1_jni_float`, `D_a1_direct_bb` | **keep Critical** | DB ~1.6× slower; skip preferring DirectByteBuffer |
| D-A2 | `D_a2_ashmem_view` | **skip** | walk 607 vs readAll 103 ms; +48 MiB |
| D-A3 | `D_a3_mmap_populate` | **skip** | cold_xor ≈ `B_offline_mmap` |
| D-A4 | `D_a4_audiorecord_prod`, `D_a4_audiorecord_perf` | **keep prod; skip PERF** | 15 min stress parity (~15995/s, errors=0); PERF no win |
| D-I1 | `D_i1_vdsp_int16` | **keep** (product SoT landed; sim-backed) | sim ~2.4×; API + iOS mic vDSP; optional iPhone re-check |
| D-I2 | `D_i2_madvise_willneed` | **pending iPhone** | sim no cold win → lean skip |
| D-I3 | `D_i3_jetsam_threshold` | **pending iPhone** | sim `availableBytes=0` inconclusive |
| D-I4 | `D_i4_avaudio_capture` | **pending iPhone** | sim 15 min OK; keep current product mic path |

**Ship? for D-I\***: D-I1 landed on sim evidence; physical iPhone remains optional re-check for D-I1 and still required for D-I2/I3/I4 verdicts.

---

## Next steps

1. Optional physical iPhone re-check for D-I1; D-I2/I3/I4 still open if pursued.  
2. Optional **#12** lock-free only if contention remains; **#15/#18** later.  
3. Retire throwaway AudioBuffer Bench when the epic closes.  
4. Do **not** vendor SpeexDSP/soxr/Oboe/AAudio unless new product pain appears.
