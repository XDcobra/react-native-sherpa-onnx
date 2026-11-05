# iOS Simulator — Bucket D cold pulls

**Device:** iPhone 17 Pro sim (26.3.1). Pulled 2026-11-05 ~12:17 +07.  
**Ship?:** sim = ratio/smoke only — physical iPhone required for D-I\* Ship?.

| Suite-ID | Plan | Wall ms | RSS Δ | Notes |
|----------|------|--------:|------:|-------|
| `D_i1_vdsp_int16` | D-I1 | **2.20** (vdsp) | +112 KiB | portable 5.21 ms → ~2.4× faster on sim |
| `D_i2_madvise_willneed` | D-I2 | 98.4 | +112 KiB | cold_xor≈27.8 / warm≈28.2 |
| `D_i3_jetsam_threshold` | D-I3 | 22.5 | +8.9 MiB | availableBytes=**0** on sim; phys 16 GiB → file/heap thresholds logged; edgeCreate=ok |
| `D_i4_avaudio_capture` | D-I4 | 5777 | reclaim noise | appended=79740 errors=0 @5 s (sim mic) |

`run_all_D` in all.json is a **stale** UNKNOWN from 05:08 (pre-reinstall); suites themselves succeeded — re-tap marker optional.

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.

Stress pulls (Ring/Spool/Capture 5–60 min) → sibling folder [`../audiobuffer-bench-ios-sim-stress/`](../audiobuffer-bench-ios-sim-stress/).
