# iOS Simulator — C #9 / #11 A/B

**Sim:** iPhone 17 Pro `5AA4921C-010A-48AA-ACE5-7E5AEF43D48D`, bundle `com.xdcobra.voiceexample`.  
**Pulled:** 2026-11-05 Documents/ (~03:28–03:29Z).

| Suite | Wall ms | RSS Δ | vs prior |
|-------|--------:|------:|----------|
| `B_live_to_offline_transfer` | **0.24** | −112 KiB | prior 0.80 — still `kind=mmap` (suite already adopt; #9 product path = iOS createOffline) |
| `C_int16_append` | **6.31** | +80 KiB | prior 4.84 — sim noise / flat-worse (#11) |
| `C_jni_*` | n/a | — | android_jni_only (skipped) |

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.
