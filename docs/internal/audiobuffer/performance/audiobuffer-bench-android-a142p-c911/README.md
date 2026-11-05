# Android A142P — C #9 / #11 cold A/B

**Device:** Nothing A142P, SDK 36.  
**Pulled:** 2026-11-05 ~10:33 +07 from `com.xdcobra.voicelab` files/.

| Suite | loggedAt (+07) | Wall ms | RSS Δ | vs prior cold |
|-------|----------------|--------:|------:|---------------|
| `B_live_to_offline_transfer` | 10:31:47 | **0.29** | 0 | prior cold 1.19 / warm 0.24 — still `kind=mmap` (#9 already on adopt path) |
| `C_int16_append` | 10:32:38 | **5.05** | +128 KiB | prior 5.39 → ~flat (#11) |
| `C_jni_int16_append` | 10:33:24 | **13.61** | +1.65 MiB | prior 11.39 → noise / flat-worse |

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.
