# AudioBuffer — device bench results (Bucket B + C)

**Status:** Android A142P + iOS **Simulator** through C #17. Physical iPhone deferred.  
**Ranking:** [`audiobuffer-android-ios-ranking.md`](./audiobuffer-android-ios-ranking.md).

## Pull

```bash
# Android
adb exec-out run-as com.xdcobra.voicelab cat files/audiobuffer-bench-all.json

# iOS Simulator
xcrun simctl get_app_container <UDID> com.xdcobra.voiceexample data
# Documents/audiobuffer-bench-all.json
```

---

## Android A142P

### Pre–C #1/#2 B (multi-suite) — [`audiobuffer-bench-android-a142p/`](./audiobuffer-bench-android-a142p/)

| Suite | Wall ms | RSS Δ |
|-------|--------:|------:|
| `B_ring_append_drain` | 7.96 | +292 KiB |
| `B_offline_mmap` | 161.48 | +144 KiB |

### Post–C #1/#2 cold — [`audiobuffer-bench-android-a142p-c12/`](./audiobuffer-bench-android-a142p-c12/)

| Suite | Wall ms | RSS Δ |
|-------|--------:|------:|
| `B_ring_append_drain` | **4.09** (~1.94×) | +144 KiB |
| `B_offline_mmap` isolated | 180.69 | +180 KiB |

### C #3 / #4 cold — [`audiobuffer-bench-android-a142p-c34/`](./audiobuffer-bench-android-a142p-c34/)

| Suite | loggedAt (+07) | Wall ms | RSS Δ | Notes |
|-------|----------------|--------:|------:|-------|
| `C_int16_append` | 10:07:13 | 5.39 | 0 | portable #4 |
| `C_jni_float_append` | 10:07:49 | 8.06 | +1.34 MiB | #3 / D-A1 Critical |
| `C_jni_int16_append` | 10:08:24 | 11.39 | +1.45 MiB | JNI + #4 |

---

## iOS Simulator (ratios only)

### Pre–C B — [`audiobuffer-bench-ios-sim-iphone17pro/`](./audiobuffer-bench-ios-sim-iphone17pro/)

`B_ring` 6.21 ms; `B_offline_mmap` 96.04 ms.

### Post–C #1/#2 + #4 — [`audiobuffer-bench-ios-sim-c34/`](./audiobuffer-bench-ios-sim-c34/)

| Suite | Wall ms | RSS Δ | Notes |
|-------|--------:|------:|-------|
| `B_ring_append_drain` | **1.37** | +992 KiB | ~4.5× vs pre-C sim row |
| `B_offline_mmap` | 100.7 | +160 KiB | no host +48 MiB |
| `C_int16_append` | **4.84** | +80 KiB | portable #4 |
| `C_jni_*` | n/a | — | Android-only; first pull showed `ERR_AUDIO_BENCH_UNKNOWN_SUITE` |

---

## C #5 resample baseline (`pa_resampleLinear`, 44.1→16 kHz, 30 s input)

| Platform | Wall ms | RSS Δ | Raw |
|----------|--------:|------:|-----|
| Android A142P | 25.95 | +268 KiB | [`audiobuffer-bench-android-a142p-c5/`](./audiobuffer-bench-android-a142p-c5/) |
| iOS Simulator | 17.74 | +416 KiB | [`audiobuffer-bench-ios-sim-c5/`](./audiobuffer-bench-ios-sim-c5/) |

Absolute cost is small (~1 ms per second of 44.1k input on phone). Prefer rate-match policy (#6) before a new resample lib.

---

## C #9 / #11 cold A/B

### Android — [`audiobuffer-bench-android-a142p-c911/`](./audiobuffer-bench-android-a142p-c911/)

| Suite | Wall ms | RSS Δ | vs prior cold |
|-------|--------:|------:|---------------|
| `B_live_to_offline_transfer` | 0.29 | 0 | prior cold 1.19 / warm 0.24; `kind=mmap` |
| `C_int16_append` | 5.05 | +128 KiB | prior 5.39 (~flat) |
| `C_jni_int16_append` | 13.61 | +1.65 MiB | prior 11.39 (noise) |

### iOS sim — [`audiobuffer-bench-ios-sim-c911/`](./audiobuffer-bench-ios-sim-c911/)

| Suite | Wall ms | RSS Δ | vs prior |
|-------|--------:|------:|----------|
| `B_live_to_offline_transfer` | 0.24 | −112 KiB | prior 0.80; `kind=mmap` |
| `C_int16_append` | 6.31 | +80 KiB | prior 4.84 (sim noise) |

---

## C #13 cold A/B (`notifyAppendListeners` unlock-before)

### Android — [`audiobuffer-bench-android-a142p-c13/`](./audiobuffer-bench-android-a142p-c13/)

| Suite | Wall ms | RSS Δ | vs c12 |
|-------|--------:|------:|--------|
| `B_ring_append_drain` | 3.41 | 0 | prior 4.09 (~flat) |

### iOS sim — [`audiobuffer-bench-ios-sim-c13/`](./audiobuffer-bench-ios-sim-c13/)

| Suite | Wall ms | RSS Δ | vs c34 |
|-------|--------:|------:|--------|
| `B_ring_append_drain` | 2.22 | +96 KiB | prior 1.37 (sim noise; suite has no listeners) |

---

## C #16 — kill `readAllSamples` hot paths

Portable APIs: `pa_append_offline_to_live`, `pa_clone_offline`. Inference bridges already use sample views.

### Android — [`audiobuffer-bench-android-a142p-c16/`](./audiobuffer-bench-android-a142p-c16/)

| Suite | Wall ms | RSS Δ |
|-------|--------:|------:|
| `C_append_offline_to_live` | **0.35** | 0 |
| `C_clone_offline` | **4.80** | +1.92 MiB (= one 30 s @16k F32 copy) |

### iOS sim — [`audiobuffer-bench-ios-sim-c16/`](./audiobuffer-bench-ios-sim-c16/)

| Suite | Wall ms | RSS Δ |
|-------|--------:|------:|
| `C_append_offline_to_live` | **0.39** | +192 KiB |
| `C_clone_offline` | **3.31** | +1.91 MiB |

---

## C #17 — JSI `ByteBufferPool` hit rate

### Android — [`audiobuffer-bench-android-a142p-c17/`](./audiobuffer-bench-android-a142p-c17/)

| Suite | Wall ms | RSS Δ | hitPct |
|-------|--------:|------:|-------:|
| `C_jsi_pool` | 1732.6 | +1.73 MiB | **100** (4500 hits / 0 misses) |

### iOS sim — [`audiobuffer-bench-ios-sim-c17/`](./audiobuffer-bench-ios-sim-c17/)

| Suite | Wall ms | RSS Δ | hitPct |
|-------|--------:|------:|-------:|
| `C_jsi_pool` | 1162.6 | reclaim noise | **100** (4500 hits / 0 misses) |

---

## Bucket D — cold pulls

Smoke pulls: [`audiobuffer-bench-android-a142p-d/`](./audiobuffer-bench-android-a142p-d/), [`audiobuffer-bench-ios-sim-d/`](./audiobuffer-bench-ios-sim-d/).  
Stress (5/15/60 min Ring/Spool/Capture only): [`audiobuffer-bench-android-a142p-stress/`](./audiobuffer-bench-android-a142p-stress/), [`audiobuffer-bench-ios-sim-stress/`](./audiobuffer-bench-ios-sim-stress/).

Micro = 30 s class; Stress = real wall-clock with `rss_samples_kib` every 30 s. D-I\* Ship? still needs physical iPhone.

---

## Cross-check

See ranking + plan §M.7: C #1/#2 **keep**; C #4 **keep**; C #3 / D-A1 **keep Critical**; C #5 lib **skip**; C #7/#8/#14 **defer**; C #9 **keep**; C #11 / #13 **keep (hygiene)**; C #10 / D-A3 **skip**; C #16 **keep**; C #17 **keep**. D-A2 **skip**; D-A4 **keep prod / skip PERF**; D-I\* **pending iPhone**.
