# Android A142P — Bucket D cold pulls

**Device:** Nothing A142P. Pulled 2026-11-05 ~12:14 +07 (D_a2 re-run after ashmem fix).

| Suite-ID | Plan | Wall ms | RSS Δ | Notes |
|----------|------|--------:|------:|-------|
| `D_a1_jni_float` | D-A1 | 8.91 | +1.33 MiB | Critical float |
| `D_a1_direct_bb` | D-A1 | 13.89 | +0.91 MiB | DirectByteBuffer ~1.6× Critical |
| `D_a2_ashmem_view` | D-A2 | **607** (walk) | +48.3 MiB | readAll 103 ms; fill 17 ms; ashmem walk 607 ms; xor both 0 |
| `D_a3_mmap_populate` | D-A3 | 184.5 | +0.56 MiB | cold_xor≈49 ms (≈ B_offline_mmap) |
| `D_a4_audiorecord_perf` | D-A4 | 5263 / 5256 | +1.22 / +0.35 MiB | *legacy smoke A/B* @5 s; see stress folder for 15 min prod vs PERF |
| `D_a4_audiorecord_prod` / stress PERF | D-A4 | see stress | see stress | 15 min: both ~900 s realtime, ~14.4M, errors=0 → **keep prod; skip PERF** |

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.

Stress pulls (Ring/Spool/Capture 5–60 min) → sibling folder [`../audiobuffer-bench-android-a142p-stress/`](../audiobuffer-bench-android-a142p-stress/).
