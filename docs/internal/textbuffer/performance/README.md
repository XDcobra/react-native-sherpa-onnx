# TextBuffer — performance

| Doc | Role |
|-----|------|
| [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md) | **Final ship matrix** — keeps on umbrella vs skip vs deferred |
| [`textbuffer-perf-plan.md`](./textbuffer-perf-plan.md) | Methodology, dual wall+RSS gates, Host→Android→iOS matrix, Buckets A–D |
| [`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md) | B/C/D evidence — **Buckets C + D closed** |
| [`textbuffer-host-bench-results.md`](./textbuffer-host-bench-results.md) | Host B baselines from `textbuffer_bench` |
| [`textbuffer-device-bench-results.md`](./textbuffer-device-bench-results.md) | Device B: Android A142P + Stress; iOS sim B + Stress (physical iOS deferred) |

**Phase status:** Measure/opt closed in `exp/textbuffer-perf`. Keeps **ported** onto `perf/improve-textbuffer-from-benchmarks` (one commit per keep). Merge to `refactor/refactor-before-release-1-0` via umbrella PR.

**Keeps landed:** C1, C2, C3, C8, C12, D-A4 (Batched), D-I3 (Adaptive Jetsam, TextBuffer only). Hygiene: C4–C5, D-A2 (C6 already product).

Architecture: [`../offlinetextbuffer-internal.md`](../offlinetextbuffer-internal.md), [`../livetextbuffer-internal.md`](../livetextbuffer-internal.md), [`../textbuffer-spool-v2-format.md`](../textbuffer-spool-v2-format.md).

Method mirrors [`../../audiobuffer/performance/`](../../audiobuffer/performance/), [`../../videobuffer/performance/`](../../videobuffer/performance/), and [`../../imagebuffer/performance/`](../../imagebuffer/performance/), with **RAM as a first-class gate** and **portable C++ SoT** (`TextRegistry` / `TxtLiveEntry` / `TxtOfflineEntry`).
