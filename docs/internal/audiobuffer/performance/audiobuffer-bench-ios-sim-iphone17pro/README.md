# iOS Simulator raw AudioBuffer bench pull

- **Device:** iPhone 17 Pro Simulator (`5AA4921C-010A-48AA-ACE5-7E5AEF43D48D`), iOS 26.3.1, bundle `com.xdcobra.voiceexample`
- **Pulled:** 2026-11-05 from Documents via `simctl get_app_container`
- **Files:** `audiobuffer-bench-all.json`, `audiobuffer-bench.ndjson` (7 lines — one per B suite), `audiobuffer-bench-latest.json`
- **Caveat:** Simulator CPU ratios only — **not** ship ranking (plan §6.3). No `run_all_B` marker in this pull (suites run individually).

Summary + next steps: [`../audiobuffer-device-bench-results.md`](../audiobuffer-device-bench-results.md), [`../audiobuffer-android-ios-ranking.md`](../audiobuffer-android-ios-ranking.md).
