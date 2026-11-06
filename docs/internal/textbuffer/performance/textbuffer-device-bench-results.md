# TextBuffer device bench results

**Status:** Android A142P Bucket B + Stress 300/900/3600 filled; iOS Simulator Bucket B + Stress 300/900/3600 filled (2026-11-06). Ranking: [`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md). Physical iPhone deferred.  
**Harness:** Example **Debug → TextBuffer Bench** → `runTextBufferBench` → C++ `TextBufferBench`.  
**Method:** [`textbuffer-perf-plan.md`](./textbuffer-perf-plan.md) §M / §6.2–6.3. Dual gate = wall **and** RSS/PSS.  
**Policy:** Android = SoT; iOS Simulator = ratio/smoke only (≥2× unusual wins may justify Ship consideration).

Raw pulls:
- Android: [`textbuffer-device-bench-all-a142p.json`](./textbuffer-device-bench-all-a142p.json), [`textbuffer-device-bench-a142p.ndjson`](./textbuffer-device-bench-a142p.ndjson)
- iOS sim: [`textbuffer-device-bench-all-ios-sim.json`](./textbuffer-device-bench-all-ios-sim.json), [`textbuffer-device-bench-ios-sim.ndjson`](./textbuffer-device-bench-ios-sim.ndjson), [`textbuffer-device-bench-ios-sim-oslog.txt`](./textbuffer-device-bench-ios-sim-oslog.txt)

**Note:** `textbuffer-bench-all.json` is last-wins per suite id — Stress 900 overwrote the 30s partial rows there. Prefer **ndjson** for history (B 30s + Stress).

## How to pull (Android)

```bash
adb logcat -d -s TextBufferBench:I
adb exec-out run-as com.xdcobra.voicelab cat files/textbuffer-bench-all.json
adb exec-out run-as com.xdcobra.voicelab cat files/textbuffer-bench.ndjson
```

## How to pull (iOS Simulator)

```bash
UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
DATA=$(xcrun simctl get_app_container "$UDID" com.xdcobra.voiceexample data)
cp "$DATA/Documents/textbuffer-bench-all.json" .
cp "$DATA/Documents/textbuffer-bench.ndjson" .
xcrun simctl spawn "$UDID" log show --last 3h --style compact \
  --predicate 'processImagePath CONTAINS "VoiceLab" AND eventMessage CONTAINS "[TextBufferBench]"'
```

## Android Bucket B — Nothing A142P (sdk 36)

Fixture: `durationSec=30` → partial ops = 600 (20 Hz × 30 s, as-fast). Suites run in one session (not one-per-cold-start); RSS Δ often flat after first suite — use PSS / absolute RSS notes carefully. Ship? deferred until cold A/B + physical iOS.

| Suite | Wall ms | Ops/s | RSS Δ MiB | Disk MiB | PSS KiB | Notes | Ship? |
|-------|--------:|------:|----------:|---------:|--------:|-------|-------|
| `B_live_partial_nospool` | **1.15** | 5.22e5 | 0* | 0 | 429593 | ops=600 spool=off | — |
| `B_live_partial_spool` | **5.02** | 1.20e5 | 0* | **0.089** | 425081 | ~**4.4×** wall vs nospool; journal+ckpt | — |
| `B_live_commit_storm` | **159.4** | 1.25e4 | **+2.39** | 0 | 426044 | N=2000 small token/ts | — |
| `B_spool_replay` | 0.62 | — | 0* | 0.018 | 425521 | fillOps=120 reconLen=199 | — |
| `B_utf16_slice` | 7.52 | 2.66e4 | 0* | 0 | 425434 | slice/full **ratio≈12.9** | — |
| `B_offline_populate_ocr` | 0.23 | — | **+0.57** | 0 | 424032 | 100 KiB + 2000 spans | — |

\*RSS Δ from `/proc/self/statm` resident; process already ~466 MiB before suite — mid-session flats common.

### First-pass Android notes (not Ship?)

- **Spool tax:** ~4.4× wall vs nospool on device (Host was ~10×); disk ~89 KiB for 600 SET snapshots — still a **lossless** story, not a speed keep.
- **Commit storm:** clearest RSS growth (+2.39 MiB) among B rows.
- **UTF-16 slice:** mid-slice path is **~13× slower** than full `txt_read_offline_text` on this fixture.
- Prefer **one suite per cold start** for ranking / Ship? decisions.

## iOS Simulator Bucket B — iPhone 17 Pro (iOS 26.3.1)

Fixture: same `durationSec=30` / ops=600. Simulator only — absolute ms not SoT; use for ratios vs Android.

| Suite | Wall ms | Ops/s | RSS Δ MiB | Disk MiB | Notes | vs A142P wall | Ship? |
|-------|--------:|------:|----------:|---------:|-------|--------------:|-------|
| `B_live_partial_nospool` | **3.21** | 1.87e5 | +1.80 | 0 | ops=600 spool=off | 2.8× slower | — |
| `B_live_partial_spool` | **11.69** | 5.13e4 | +0.42 | **0.089** | ~**3.6×** vs nospool | 2.3× slower | — |
| `B_live_commit_storm` | **47.59** | 4.20e4 | **+2.16** | 0 | N=2000 | **0.30×** (sim faster) | — |
| `B_spool_replay` | 0.90 | — | +0.11 | 0.018 | fillOps=120 | 1.4× slower | — |
| `B_utf16_slice` | 5.65 | 3.54e4 | +0.25 | 0 | slice/full **ratio≈2.45** | 0.75× | — |
| `B_offline_populate_ocr` | 1.12 | — | +0.61 | 0 | 100 KiB + 2000 spans | 5.0× slower | — |

No suite hits the ≥2× **faster-than-Android** sim bar for Ship consideration (commit_storm is sim-faster but absolute still small; UTF-16 ratio is friendlier on sim than device — treat as platform artifact).

## Stress (5 / 15 / 60 min → durationSec 300 / 900 / 3600)

UI Stress: `B_live_partial_nospool` / `B_live_partial_spool`. Table = **latest** complete set from ndjson (Android lines 08–14, iOS 08–14; earlier 900 runs kept in ndjson history). Ops = 20 Hz × duration (6000 / 18000 / 72000), as-fast wall.

| Platform | Dur | Suite | Wall ms | Ops/s | RSS Δ MiB | Disk MiB | Spool tax |
|----------|----:|-------|--------:|------:|----------:|---------:|----------:|
| Android A142P | 300 | nospool | **20.99** | 2.86e5 | +1.05 | 0 | — |
| Android A142P | 300 | spool | **33.69** | 1.78e5 | +0.95 | **0.89** | **1.61×** |
| Android A142P | 900 | nospool | **25.48** | 7.06e5 | +0.78 | 0 | — |
| Android A142P | 900 | spool | **91.96** | 1.96e5 | +2.08 | **2.68** | **3.61×** |
| Android A142P | 3600 | nospool | **143.66** | 5.01e5 | +0.92 | 0 | — |
| Android A142P | 3600 | spool | **309.01** | 2.33e5 | +0.46 | **10.71** | **2.15×** |
| iOS sim | 300 | nospool | **9.80** | 6.12e5 | −3.33* | 0 | — |
| iOS sim | 300 | spool | **57.52** | 1.04e5 | +1.89 | **0.89** | **5.87×** |
| iOS sim | 900 | nospool | **16.65** | 1.08e6 | +0.38 | 0 | — |
| iOS sim | 900 | spool | **96.18** | 1.87e5 | +2.33 | **2.68** | **5.78×** |
| iOS sim | 3600 | nospool | **41.78** | 1.72e6 | +1.91 | 0 | — |
| iOS sim | 3600 | spool | **351.78** | 2.05e5 | −2.33* | **10.71** | **8.42×** |

\*Negative RSS Δ on sim — allocator/compaction noise, not a win. Android 3600 nospool had a duplicate run; table uses the later one (143.66 ms).

### Stress notes

- Disk scales roughly with ops (~0.089 → 0.89 → 2.68 → 10.7 MiB for 600 / 6000 / 18000 / 72000 spool snapshots).
- Android SoT spool tax stays modest (1.6–3.6×). iOS sim spool tax is higher (5.8–8.4×) — ratio/smoke only.
- No sim stress cell is ≥2× **faster** than Android on spool; nospool sim is faster wall (0.3–0.65×) but absolute ms stay small and sim is not SoT.
- Android logcat has a short `TextBufferBench` slice from the re-run; full metrics still from ndjson.
