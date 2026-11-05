# iOS Simulator — Stress pulls

**Pulled:** 2026-11-05 ~12:59 +07. Preset **15 min** (`dur=900`).

| Suite | Wall ms | RSS Δ | Notes |
|-------|--------:|------:|-------|
| `B_ring_append_drain` | 34 | +10.5 MiB | CPU burst 900 s equiv; rss_kib 312256→322976 (slow climb) |
| `B_spool_append` | 800 | −1.9 MiB | disk 54.9 MiB; rss peak ~329024 then reclaim |
| `D_i4_avaudio_capture` | **900027** (~15 min realtime) | reclaim noise | appended≈14.4M errors=0; rss_kib 355504→~62k (sim reclaim) |

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.
