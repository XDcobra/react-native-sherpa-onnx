# AudioBuffer — performance

| Doc | Role |
|-----|------|
| [`audiobuffer-perf-plan.md`](./audiobuffer-perf-plan.md) | **SOT** — methodology, dual wall+RSS gates, Host→Android→iOS matrix (§M.6), Buckets A–D (portable C + platform/API D) |
| [`audiobuffer-host-bench-results.md`](./audiobuffer-host-bench-results.md) | Host B-bucket baselines from `audiobuffer_bench` (wall + RSS; spool labeled lossless-not-speed) |
| [`audiobuffer-device-bench-results.md`](./audiobuffer-device-bench-results.md) | Device B + post–C #1/#2 cold pulls (A142P); iOS sim; iPhone deferred |
| [`audiobuffer-android-ios-ranking.md`](./audiobuffer-android-ios-ranking.md) | In-platform ratios; **C #1/#2 keep**; next steps |
| [`audiobuffer-bench-android-a142p/`](./audiobuffer-bench-android-a142p/) | Raw Android B baseline JSON / ndjson |
| [`audiobuffer-bench-android-a142p-c12/`](./audiobuffer-bench-android-a142p-c12/) | Raw Android cold `B_ring` + isolated `B_offline_mmap` post–C #1/#2 |
| [`audiobuffer-bench-android-a142p-c34/`](./audiobuffer-bench-android-a142p-c34/) | Raw Android C #3/#4 JNI + portable int16 |
| [`audiobuffer-bench-ios-sim-iphone17pro/`](./audiobuffer-bench-ios-sim-iphone17pro/) | Raw iOS Simulator B (pre-C) |
| [`audiobuffer-bench-ios-sim-c34/`](./audiobuffer-bench-ios-sim-c34/) | Raw iOS Simulator post–C #1/#2 ring + #4 |
| [`audiobuffer-bench-android-a142p-c5/`](./audiobuffer-bench-android-a142p-c5/) | Raw Android `C_resample_44k_to_16k` |
| [`audiobuffer-bench-ios-sim-c5/`](./audiobuffer-bench-ios-sim-c5/) | Raw iOS Simulator resample baseline |
| [`audiobuffer-bench-android-a142p-d/`](./audiobuffer-bench-android-a142p-d/) | Bucket D Android cold pulls (`D_a*`) |
| [`audiobuffer-bench-ios-sim-d/`](./audiobuffer-bench-ios-sim-d/) | Bucket D iOS sim cold pulls (`D_i*`) — sim≠Ship? |
| [`audiobuffer-bench-android-a142p-stress/`](./audiobuffer-bench-android-a142p-stress/) | Stress 5–60 min: Ring / Spool / `D_a4_prod` + `D_a4_perf` |
| [`audiobuffer-bench-ios-sim-stress/`](./audiobuffer-bench-ios-sim-stress/) | Stress 5–60 min: Ring / Spool / `D_i4` |

**Measure order:** Host B → Android device smoke → iOS **device** smoke → portable C → Bucket D only if bridge/capture/platform is the bound (floors: minSdk 24 / iOS 15.1 + fallback). See plan §M.5–M.7 and §6.2–6.4.

**Device harness (THROW AWAY):** Example **Debug → AudioBuffer Bench** — B / C / D smoke (10–60 s) + **Stress** (5/15/60 min: `B_ring`, `B_spool_append`, capture only). Writes `audiobuffer-bench-all.json` / `.ndjson` (Android `files/`, iOS Documents).

Architecture: [`../offlineaudiobuffer-internal.md`](../offlineaudiobuffer-internal.md), [`../liveaudiobuffer-internal.md`](../liveaudiobuffer-internal.md).

Method mirrors [`../../videobuffer/performance/`](../../videobuffer/performance/) and [`../../imagebuffer/performance/`](../../imagebuffer/performance/), with **RAM as a first-class gate** and **portable C++ SoT** (no Android-only Offline path).
