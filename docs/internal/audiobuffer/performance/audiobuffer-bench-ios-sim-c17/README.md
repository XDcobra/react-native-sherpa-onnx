# iOS Simulator — C #17 A/B

**Sim:** iPhone 17 Pro. Pulled 2026-11-05.

| Suite | Wall ms | RSS Δ | Notes |
|-------|--------:|------:|-------|
| `C_jsi_pool` | 1162.6 | −43.4 MiB* | **hitPct=100** hits=4500 misses=0 pooled=4500 iters=1500 |

\*Resident size noise / reclaim during run — dual gate uses hitPct + no miss growth.

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.
