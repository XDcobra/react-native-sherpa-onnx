# Android A142P — C #16 cold A/B

**Device:** Nothing A142P. Pulled 2026-11-05 ~11:22 +07.

First taps hit `ERR_AUDIO_BENCH_UNKNOWN_SUITE` (Kotlin allowlist). After allowlist fix + rebuild:

| Suite | loggedAt (+07) | Wall ms | RSS Δ | Notes |
|-------|----------------|--------:|------:|-------|
| `C_append_offline_to_live` | 11:21:33 | **0.35** | 0 | n=480000 floatPtr chunked |
| `C_clone_offline` | 11:22:24 | **4.80** | +1.92 MiB | n=480000 kindSrc=ram (one PCM copy ≈1.83 MiB) |

Raw: `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson`.
