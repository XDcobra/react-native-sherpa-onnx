# Android A142P — Stress pulls

**Device:** Nothing A142P. Preset **15 min** (`dur=900`). Pull refreshed 2026-11-05 ~14:16 +07.

| Suite | Wall ms | RSS Δ | Notes |
|-------|--------:|------:|-------|
| `B_ring_append_drain` | 74 | +1.55 MiB | 900 s audio-equiv **CPU burst** (not realtime); rss_kib 464956→466544 (~flat); loggedAt 13:03 |
| `B_spool_append` | 538 | +2.65 MiB | disk 54.9 MiB; rss_kib 467756→469604 (~flat); loggedAt 13:04 |
| `D_a4_audiorecord_prod` | **900114** | −13.5 MiB | appended=14397440 errors=0; `VOICE_RECOGNITION_classic`; loggedAt 13:42 |
| `D_a4_audiorecord_perf` | **900093** | −15.3 MiB | appended=14397120 errors=0; `VOICE_RECOGNITION+PERF_LOW_LATENCY?`; loggedAt 14:15 |

## Capture compare (15 min)

| | prod | perf |
|--|-----:|-----:|
| wall | 900114 ms | 900093 ms |
| appended | 14397440 | 14397120 |
| samples/s | 15995.1 | 15995.1 |
| errors | 0 | 0 |
| RSS Δ | −13.5 MiB | −15.3 MiB |

Realtime capture parity; no wall/throughput win for PERF on A142P. RSS both reclaim mid-run (see `rss_samples_kib`).

## Earlier PERF crash (transient)

First PERF attempt **SIGSEGV** ~2.5 min in (tombstone_24, binder TLS destructor) while `runDa4AudioRecord` ran — no JSON written. Re-run completed full 900 s. Treat as flake until reproduced; not a Ship? blocker by itself, but also **no measured PERF benefit** vs prod.

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`, `audiobuffer-bench-latest.json`. Crash excerpt: `tombstone24-audiorecord-excerpt.txt`.
