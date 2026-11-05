# AudioBuffer — performance analysis and bench plan

**Status:** scoreboards filled (Host + Android A142P + iOS Simulator). Keep/skip in §2 + §M.7 and [`audiobuffer-android-ios-ranking.md`](./audiobuffer-android-ios-ranking.md). External resample libs **not** needed. Physical iPhone still required for D-I\* Ship?.  
**Branch:** `perf/improve-audiobuffer-from-benchmarks` (from `refactor/refactor-before-release-1-0`). Measurement evidence copied from `exp/audiobuffer-perf`; implement keep set here.  
**SOT:** C++ `AudioRegistry` / `PaOfflineEntry` / `PaLiveEntry` (`android/src/main/cpp/audiobuffer/`, shared with iOS). JNI / JSI / ObjC are thin wrappers.  
**Floors:** Android `minSdkVersion = 24`; iOS deployment **15.1**. Platform opts must run on these floors or use a runtime check + portable fallback.  
**Video / image analogs:** [`docs/internal/videobuffer/performance/`](../../videobuffer/performance/), [`docs/internal/imagebuffer/performance/`](../../imagebuffer/performance/). Do **not** copy GOP/demux/JPEG items.  
**Existing notes (point here for measurement):**  
[`docs/future-work/live-audio-buffer-lock-free-ring-future-work.md`](../../../future-work/live-audio-buffer-lock-free-ring-future-work.md),  
[`docs/future-work/live-audio-buffer-mmap-spool-future-work.md`](../../../future-work/live-audio-buffer-mmap-spool-future-work.md).  
**Architecture:** [`../offlineaudiobuffer-internal.md`](../offlineaudiobuffer-internal.md), [`../liveaudiobuffer-internal.md`](../liveaudiobuffer-internal.md).  
**Host results:** [`audiobuffer-host-bench-results.md`](./audiobuffer-host-bench-results.md).  
**Device / ranking:** [`audiobuffer-device-bench-results.md`](./audiobuffer-device-bench-results.md), [`audiobuffer-android-ios-ranking.md`](./audiobuffer-android-ios-ranking.md).

Correctness: `test/cpp/audiobuffer/audiobuffer_registry_test.cpp` (`SHERPA_HOST_AUDIO_MMAP=1` for large mmap). Timed host bench: `audiobuffer_bench` (§6.1).

---

## M. Methodology (read before changing code)

### M.1 Principle

```
candidate
  → architecture axiom?  → keep (do not re-litigate on a scoreboard)
  → else measure (host + device)
       → dual gate: wall/CPU **and** RSS/peak
            → CPU win + RSS blowup → skip / revert policy
            → both pass, or RSS win with flat CPU → keep / ship
```

- **Shipped ≠ proven.** mmap thresholds, live spool, ring window, transfer-mmap, ByteBufferPool were implemented without a filled scoreboard. Treat them as **Bucket B** hypotheses to re-baseline, not as gospel.
- **RAM is a gate, not a footnote.** Feature models already dominate RSS. Paying hundreds of MB of audio backing for a small buffer-CPU win is a **skip** (same lesson as Video eager-RGB OOM / Image lazy keep).
- **Do not “prove” axioms with benches.** Poll/cursor + native registry vs materializing full PCM over the JS bridge, and engine `pa_acquire_offline_sample_view` / `floatPtr`, are robustness + bridge avoidance. They stay.
- **Portable C++ SoT first.** Like Image/Video: no Android-only or iOS-only buffer SoT that breaks host tests. Bucket **D** platform opts are measured add-ons with fallbacks — never the only path.

### M.2 Dual gate (every scoreboard row)

| Metric | What | Gate idea |
|--------|------|-----------|
| Wall / samples·s⁻¹ | Host micro + device smoke | Ship only if ≥ ~**2×** on the hot path **or** a clear RSS win at flat CPU |
| Process RSS / peak | Before/after; prefer isolating buffer growth | Skip if peak audio backing ≫ benefit (no large RAM trade for ~10% buffer CPU) |
| Disk / I/O | Spool size, write rate | Spool “wins” for **lossless** or measured lag-drain — not because theory says fsync is free |

Report columns: **Result wall ×**, **Result RSS Δ**, **Ship?** (and for spool: **Label** = `lossless` / `speed` / `optional`).

**Ranking:** compare **speedup ratios inside one platform**, not absolute ms across Host vs Phone vs iPhone (Video lesson). **Keep on both** only when Android **device** and iOS **device** show the same direction. iOS Simulator is CPU-ratio only — never sole ship evidence.

### M.3 Buckets

| Bucket | Meaning | Action |
|--------|---------|--------|
| **A — Axioms** | Must keep; no perf scoreboard | Document only |
| **B — Shipped, unproven** | Present in tree; no measured keep | **Re-baseline first** (latency + RSS + disk) on Host → Android → iOS |
| **C — New portable candidates** | Plan §2 numbered rows (`Pa*` / shared C++) | After B baselines; Host then devices |
| **D — Platform / API-version** | JNI, SharedMemory, Accelerate, Jetsam, capture attrs | Device-only (mostly); runtime fallback under floor |

### M.4 Spool special case

Do **not** market spool as a “perf optimization” until numbers exist. Separate questions:

1. **Correctness:** cursor lag without data loss — yes/no.  
2. **Perf:** append wall, drain-behind-ring, RSS (ring + page cache), disk growth.  
3. **Ship label:** `keep for lossless` vs `keep for speed` vs `optional / trim`.

mmap spool reads (C #8) only if B shows `seek+read` is material on **device** (not only Host).

### M.5 Measurement order

1. Methodology + dual-gate + matrix (this doc).  
2. Host `audiobuffer_bench` with RSS (`getrusage`) — **B done** on Host.  
3. **Android device** B-smoke (RSS always logged).  
4. **iOS device** B-smoke (real iPhone; sim optional for ratios only).  
5. Portable **C** candidates one-at-a-time when Host+Android dual-gate is clear; confirm on iOS.  
6. **Bucket D** only if portable is exhausted **or** bridge/capture is clearly the bound — always with fallback under minSdk 24 / iOS 15.1.

Capture (`AudioRecord` / AVAudio*) stays **outside** buffer-core scoreboards unless Append-Ingest is proven bound; then use D-A4 / D-I4 as labeled capture rows, not as PaLive-ring rewrites.

### M.6 Test matrix (Host → Android → iOS)

```
Host_audiobuffer_bench
  → Android_device_smoke
    → iOS_device_smoke
      → Ranking_keep_skip
```

| Layer | What | Metrics | May decide ship? |
|-------|------|---------|------------------|
| **Host** | `audiobuffer_bench` + `audiobuffer_host_test` | wall, samples/s, RSS Δ, disk | Prepares portable B/C; **not** final for Bucket D; alone insufficient for “keep on both” |
| **Android device** | Example / VoiceLab smokes on phone (A142P-class) | wall, RSS/approx, disk, logcat tags | Yes for portable + **D-A\*** rows |
| **iOS device** | Same scenarios on **physical iPhone** | wall, RSS / Jetsam risk, Instruments | Yes for portable + **D-I\*** rows; **sim is not enough** |

**Shared smoke scenarios** (Android and iOS devices):

1. Mic → Live 60 s (S16 / platform capture → append).  
2. File ingest → Live + slow consumer (force behind-ring / spool).  
3. Live pipeline with dual cursors (e.g. enhancement).  
4. Offline path on clip **above** mmap threshold (cold start).  
5. Live finalize → offline transfer (`fullIfSpooled`).

Always log RSS (or platform equivalent). Prefer the same fixture durations on both platforms so **ratios** rank cleanly.

### M.7 Bucket D — platform / API-version candidates

Explicitly separate from portable C (#1–#18). Each row: platform, **min API / iOS version**, fallback, which layers are required. Dual gate still applies (wall **and** RSS).

#### Android (`minSdkVersion = 24`)

Smoke suite IDs (AudioBuffer Bench screen): `D_a1_jni_float`, `D_a1_direct_bb`, `D_a2_ashmem_view`, `D_a3_mmap_populate`, `D_a4_audiorecord_prod`, `D_a4_audiorecord_perf`. Raw pull target: [`audiobuffer-bench-android-a142p-d/`](./audiobuffer-bench-android-a142p-d/).

| ID | Suite-ID(s) | Candidate | Version note | Fallback | Host? | Device? | Wall × | RSS Δ | Ship? |
|----|-------------|-----------|--------------|----------|-------|---------|--------|-------|-------|
| D-A1 | `D_a1_jni_float`, `D_a1_direct_bb` (+ alias `C_jni_float_append`) | Float append via `GetPrimitiveArrayCritical` / direct `ByteBuffer` | JNI, API ≥24 | Keep `GetFloatArrayRegion` path | approx only | **yes** | Critical 8.91 / DB 13.89 ms (~1.6× Critical faster) | +1.33 / +0.91 MiB | **keep Critical** (product SoT landed; skip preferring DB) |
| D-A2 | `D_a2_ashmem_view` | `android.os.SharedMemory` for large offline views into Java | API **27+** | mmap-file / RAM copy on API 24–26 (`api27_required` skip) | no | **yes** | ashmem walk **607** vs readAll **103** ms | +48.3 MiB | **skip** (slower + RSS blowup vs readAll fixture) |
| D-A3 | `D_a3_mmap_populate` | `posix_fallocate` before `.f32` write; `MAP_POPULATE` where available | NDK/Linux; page-cache ≠ macOS Host | Current write+mmap without populate (`B_offline_mmap`) | weak | **yes** | 184.5 ms; cold_xor≈49 ≈ `B_offline_mmap` | +0.56 MiB | **skip** (no cold-walk win; same lesson as C #10) |
| D-A4 | `D_a4_audiorecord_prod`, `D_a4_audiorecord_perf` | Mic→live: **prod** = `VOICE_RECOGNITION` classic (`MicToLiveBufferSink`); **perf** = +`PERFORMANCE_MODE_LOW_LATENCY`. Separate full-`durationSec` suites. | API 24+; OEM variance on PERF | Keep prod path (`RECORD_AUDIO` skip) | no | **yes** (capture) | Stress 15 min: both ~900094 ms; ~14.4M samples; ~15995/s; errors=0 | prod −13.5 / perf −15.3 MiB (reclaim) | **keep prod**; **skip PERF** (parity, no win; one transient SIGSEGV on first try) |

#### iOS (deployment **15.1**)

Smoke suite IDs: `D_i1_vdsp_int16`, `D_i2_madvise_willneed`, `D_i3_jetsam_threshold`, `D_i4_avaudio_capture`. Sim pull: [`audiobuffer-bench-ios-sim-d/`](./audiobuffer-bench-ios-sim-d/). **Ship? for D-I\*** only after physical iPhone pull (sim = ratio/smoke).

| ID | Suite-ID | Candidate | Version note | Fallback | Host? | Device? | Wall × | RSS Δ | Ship? |
|----|----------|-----------|--------------|----------|-------|---------|--------|-------|-------|
| D-I1 | `D_i1_vdsp_int16` | Accelerate **vDSP** Int16→F32 | 15.1+ | Scalar / portable convert (`C_int16_append`) | no | **yes** | sim: vdsp **2.20** vs portable 5.21 (~2.4×) | +112 KiB | **pending iPhone** (sim promising) |
| D-I2 | `D_i2_madvise_willneed` | `madvise(MADV_WILLNEED)` after mmap | POSIX; **≠** Linux `MAP_POPULATE` | No hint / fault-on-touch (`B_offline_mmap`) | weak | **yes** | sim: 98.4; cold≈warm (~28 ms) | +112 KiB | **pending iPhone** (sim: no cold win → lean skip) |
| D-I3 | `D_i3_jetsam_threshold` | `os_proc_available_memory` / Jetsam-aware threshold | iOS 13+ | Current RAM-class multipliers from total RAM | no | **yes** | sim: 22.5 ms; `availableBytes=0` on sim | +8.9 MiB | **pending iPhone** (sim inconclusive) |
| D-I4 | `D_i4_avaudio_capture` | AudioQueue capture → live append | 15.1+ | Current product mic path; permission skip | no | **yes** (capture) | sim smoke 5.8 s; stress **900027** ms; ~14.4M; errors=0 | reclaim noise | **pending iPhone** (sim capture OK; keep current product path) |

**Do not start until the scoreboard demands it:**

- AAudio / Oboe as a **replacement** for the PaLive PCM ring.  
- Android-only or iOS-only Offline SoT.  
- iOS-only ring without Android parity.  
- API splits that break portable host tests.

---

## 0. Bucket A — axioms (do not re-litigate)

| Item | Why it is an axiom |
|------|--------------------|
| Native `AudioRegistry` SoT (C++) | Shared Android/iOS; engines stay in-process; host-testable |
| Poll / cursor drain vs shipping full PCM over JS bridge | Bridge bandwidth + GC; robustness under load |
| `pa_acquire_offline_sample_view` / `floatPtr` for engines | Zero-copy into STT/enhancement/TTS/VAD |

---

## 0b. Bucket B — shipped, unproven (re-baseline)

Required layers: **Host** (done) → **Android device** → **iOS device**.

| Item | Where | What to characterize | Host | Android | iOS |
|------|--------|----------------------|------|---------|-----|
| RAM vs mmap `.f32` + dynamic threshold | `pa_create_entry_with_threshold`, `PaMmapRegion` | Create wall, cold/warm walk, RSS vs file size | done | **done** (A142P) | sim done; device pending |
| Live fixed ring | `PaLiveEntry::ring` | Append/drain wall vs `windowSec`; RSS ≈ `4 × sr × windowSec` | done | **done** (+15 min stress flat RSS) | sim done (+15 min stress) |
| Live F32 WAV spool | spool + `readFromSpool` | Append tax; behind-ring drain; disk; page-cache RSS | done (lossless≠speed) | **done** (+15 min stress) | sim done (+15 min stress) |
| Live → offline transfer mmap | `pa_create_offline_from_transferred_wav_spool` | vs ring snapshot / WAV→`.f32` copy | done | **done** | sim done; device pending |
| Int16 Critical JNI | `nativeAppendInt16SamplesToLive` | Still full float temp in C — measure | hook | **done** (C #4 / JNI int16) | n/a (no JNI) |
| Drain-into-dest APIs | `pa_drain_cursor_into`, `pa_copy_*` | vs allocating `drainCursor` | done (via B/C) | **done** | sim done |
| JSI `ByteBufferPool` | `ByteBufferPool` | Hit rate / RSS churn | later | **done** (hitPct=100) | sim done (hitPct=100) |
| Append-event coalescing | `appendEventMinIntervalMs` | JS bridge rate | n/a | product e2e (not buffer micro) | product e2e |

Inference still dominates e2e wall for STT/TTS/enhancement. This plan is about **buffer** CPU, copies, locks, I/O, and **RSS**.

---

## 1. Current hot path

### Live

```
producer samples (float or int16)
  → [Android JNI] GetFloatArrayRegion → heap vector   // float path still copies
  → [optional] pa_resampleLinear → new vector
  → ringMutex: per-sample ring[writePos] = …; writePos = (writePos+1) % N
  → spoolFile.write (fstream, every append)
  → dispatchFramesAppended / notifyAppendListeners / seg_engine_on_audio_append
consumer:
  → drainCursorInto: ring = per-sample modulo; lag = seekg+read → temp vector → memcpy
```

### Offline

```
create / adopt
  → RAM vector<float>  OR  write .f32 + mmap(MAP_PRIVATE)
  → engines: pa_acquire_offline_sample_view
  → some JNI/JS: readAllSamples / slice copy
live→offline transfer: mmap WAV @ offset 44 when large
older path: WAV → copy .f32 → mmap   // double disk write
```

---

## 2. Scoreboard — Bucket C (portable; fill after B device smokes)

Hypothesis × is **not** a ship number. Dual gate applies. **Host / Android / iOS** = which layers are required before Ship?.

| # | Candidate | Hypothesis | Host | Android | iOS | Wall × | RSS Δ | Ship? |
|---|-----------|------------|------|---------|-----|--------|-------|-------|
| 1 | Block ring write (≤2 `memcpy`) | Cut lock hold on 10–40 ms chunks | yes | yes | deferred | Host ~14.5× / A142P ~1.94× vs pre | neutral | **keep** (product SoT: `writeRingContiguous`) |
| 2 | Block ring drain / peek | Same on cursor path | yes | yes | deferred | (same suite; paired with #1) | neutral | **keep** (product SoT: `readRingContiguous`) |
| 3 | JNI float Critical / DirectByteBuffer | Drop intermediate vector | approx | **yes** | n/a | A142P `C_jni_float` 8.06 ms | +1.34 MiB PSS (ring likely) | **keep (Android)** (product SoT: Critical; DB not added) |
| 4 | Int16→F32 chunked convert (portable) | Mic S16 without full float temp | yes | yes | sim* | A142P 5.39 / iOS sim 4.84 ms | ~0 / +80 KiB | **keep** (product SoT: chunked) |
| 5 | Faster resample lib | Only if rates mismatch | yes | yes | sim | A142P 26 ms / iOS sim 18 ms (30 s @44.1k) | +268 / +416 KiB | **skip lib for now** |
| 6 | Avoid resample (match SR) | Policy | n/a | e2e | e2e | — | — | **keep policy** |
| 7 | Spool write buffering | Long ingest | yes | yes | yes | A142P spool 9.5 vs ring 3.4–4.1 ms / 30 s | small | **defer** (absolute cheap; lossless path OK) |
| 8 | mmap chunked live spool reads | Only if B lag I/O hurts on device | yes | yes | yes | `B_spool_behind` 1.2 ms | ~0 | **defer** (no lag drain pain) |
| 9 | Kill WAV→`.f32` double copy | Transfer path only | yes | yes | yes | transfer still mmap; A142P 0.29 / iOS sim 0.24 ms | ~0 | **keep** (product SoT: helper removed + iOS transfer) |
| 10 | mmap ingest prefault | **Strict RSS gate** — may raise peak | yes | yes | yes | device mmap RSS ≪ host | device OK | **skip** |
| 11 | Shorten `g_pa_mutex` across append | Contention | yes | yes | yes | A142P `C_int16` 5.05 (~flat); JNI int16 13.6 | +128 KiB / noise | **keep (hygiene)** — convert-bound in microbench |
| 12 | Lock-free / SPSC ring | Only if #1+#11 still contend | later | yes | yes | — | — | — |
| 13 | Unlock-before listener callbacks | Nested work | yes | yes | yes | A142P 3.41 / iOS sim 2.22 (~flat vs 4.09 / 1.37) | ~0 | **keep (hygiene)** (product SoT landed) |
| 14 | Coalesce `seg_engine_on_audio_append` | Hook cost | yes | pipeline | pipeline | no attached-engine bench bound | — | **defer** (needs pipeline telemetry) |
| 15 | Retention trim | RSS/disk product | later | yes | yes | — | — | — |
| 16 | Audit remaining `readAllSamples` | Copy avoidance | yes | yes | yes | A142P append 0.35 / clone 4.80; iOS sim 0.39 / 3.31 | clone ~+1.9 MiB (=PCM) | **keep** (product SoT: clone + append APIs) |
| 17 | JSI pool hit rate | Churn | yes | yes | yes | A142P/iOS sim **hitPct=100** (4500/4500) | A142P +1.7 MiB / iOS noise | **keep** |
| 18 | 64 B aligned slabs | Only with a real F32 SIMD kernel | yes | later | later | — | — | — |

\*iOS may prefer **D-I1** (vDSP) over a portable SIMD lib for the same convert — still dual-gate both; portable fallback required.

Bucket **D** scoreboard: §M.7 tables (same Wall × / RSS Δ / Ship? columns).

---

## 3. Candidates (detail) — Bucket C

### 3.1 Live ring copy shape — **#1 / #2**

**Status:** implemented on product SoT (`perf/improve-audiobuffer-from-benchmarks`) — `writeRingContiguous` / `readRingContiguous` in [`PaLiveEntry.h`](../../../../android/src/main/cpp/audiobuffer/PaLiveEntry.h); host wrap/parity coverage in `audiobuffer_registry_test.cpp`.

**Was:** per-sample `% windowCapacity` in `tryAppendSamples` / `drainCursorInto` / `copySamplesSliceIntoLocked`.

**Change:** contiguous `memcpy` spans per transfer (≤2 for a single wrap).

**Validate:** Host chunk sizes 256 / 1600 / 4800 / 16000; Android + iOS device mic / dual cursor. Dual gate: wall and RSS (expect RSS-neutral).

### 3.2 JNI / bridge — **#3 / #4**

**#3 / D-A1 status:** product SoT float live append uses `GetPrimitiveArrayCritical` in [`sherpa-onnx-audiobuffer-jni.cpp`](../../../../android/src/main/cpp/jni/audiobuffer/sherpa-onnx-audiobuffer-jni.cpp) (no Region + heap vector; DirectByteBuffer not preferred).

**#4 status:** product SoT `pa_append_int16_samples_to_live` in [`AudioRegistry.cpp`](../../../../android/src/main/cpp/audiobuffer/AudioRegistry.cpp) uses 4096 stack-chunk convert + single live resolve (no full-length float vector). D-I1 vDSP still deferred.

**Validate:** Android device RSS peak during 60 s ingest. Overlaps **D-A1** for the JNI float pin; keep portable convert logic in C for iOS/host.

### 3.3 Resample — **#5 / #6**

`pa_resampleLinear` allocates + scalar lerp. Prefer rate match; new libs only if dual gate clears on devices.

### 3.4 Spool I/O — **#7 / #8 / #9**

See §M.4. Buffer writes; chunked mmap reads only after **device** B. **#9 status:** `pa_create_offline_from_f32_wav_spool` removed; iOS same-SR `fullIfSpooled` uses `pa_transfer_offline_from_live`.

### 3.5 Offline mmap prefault — **#10**

`MADV_WILLNEED` / populate raises **peak RSS**. Related to **D-A3** / **D-I2** (platform hint flavor). Ship only if cold-walk win is large **and** peak remains acceptable beside model RSS on **both** devices.

### 3.6 Locking / callbacks — **#11–#14**

Shorten registry critical sections; unlock-before-notify; profile seg hook. Lock-free last. **#13 status:** `PaLiveEntry::notifyAppendListeners` snapshots callbacks under lock then invokes after unlock (TxtLiveEntry parity).

### 3.7 Product RSS — **#15–#18**

Retention trim, copy audits, pool hit rate; no align-without-SIMD. **#16 status:** `pa_clone_offline` / `pa_append_offline_to_live` landed; Android + iOS same-SR hot paths wired off `readAllSamples`.

---

## 4. Architecture snapshot (C level)

```
                 AudioRegistry (g_pa_offline / g_pa_live + g_pa_mutex)
          ┌────────────────────────────┬────────────────────────────────┐
          │ PaOfflineEntry             │ PaLiveEntry                      │
          │  RAM vector<float>         │  ring[windowCapacity] + mutex    │
          │  or PaMmapRegion (.f32)    │  optional F32 WAV spool          │
          │  floatPtr / sample view    │  cursors + behind-ring spool I/O │
          └────────────────────────────┴────────────────────────────────┘
                    ↑ portable SoT (Host + Android + iOS)
         JNI / JSI / ObjC / capture  →  Bucket D wrappers only
```

| Mode | Backing | Notes |
|------|---------|--------|
| Offline small | RAM | Under dynamic threshold (B: measure on device) |
| Offline large | One mmap `.f32` | Prefer single file |
| Live | Fixed ring ± spool | Spool = lossless authority until device says otherwise |

---

## 5. External libraries (measure before vendor)

Portable / optional — not Android- or iOS-only SoT:

| Library | License | Replaces | Notes |
|---------|---------|----------|--------|
| SpeexDSP resampler | BSD | `pa_resampleLinear` | Only if #5 needed |
| libsamplerate | BSD-2 | same | Heavier |
| Highway / hand NEON | Apache-2 / inline | int16→f32 | Only with a real kernel; iOS may use vDSP (D-I1) instead |

Do not start with PortAudio rewrite or Opus-in-ring as default PCM cursor backing. Do not start with AAudio/Oboe as PaLive replacement (§M.7).

---

## 6. Bench plan

### 6.1 Host — `audiobuffer_bench`

| Suite | Fixture | Metrics |
|-------|---------|---------|
| `B_offline_ram` | Under heap threshold | create ms, xor walk, RSS Δ |
| `B_offline_mmap` | Over heap threshold | create ms, cold xor, warm xor, RSS Δ |
| `B_ring_append_drain` | 16 kHz, 20 ms chunks × 30–60 s, no spool | wall, samples/s, RSS Δ |
| `B_spool_append` | Same + spool file | wall vs ring-only, disk bytes, RSS Δ |
| `B_spool_behind` | Tiny ring + spool, cursor from 0 after wrap | drain ms, RSS Δ |
| `B_live_to_offline_transfer` | fullIfSpooled mmap adopt | wall, RSS Δ, offline `storageKind` |
| `B_live_to_offline_ring` | no spool / snapshot | wall, RSS Δ |
| `C_int16_append` / `C_resample_*` | C micro hooks | wall (+ RSS) |

RSS: macOS/Linux `getrusage(RUSAGE_SELF).ru_maxrss` (bytes on macOS, KiB on Linux — normalize in harness). Max RSS only rises for process lifetime — isolate suites when RSS Δ matters.

**Preferred build** (standalone; avoids full `test/cpp` submodule deps):

```bash
cmake -S test/cpp/audiobuffer -B test/cpp/audiobuffer/build -DCMAKE_BUILD_TYPE=Release
cmake --build test/cpp/audiobuffer/build --target audiobuffer_bench -j
./test/cpp/audiobuffer/build/audiobuffer_bench \
  --out docs/internal/audiobuffer/performance/audiobuffer-host-bench-results.md
```

Correctness: `audiobuffer_host_test` in the same standalone tree.

### 6.2 Android device smoke

**First** device layer for ranking (existing rule). Real phone (A142P-class), not emulator alone.

**Harness (THROW AWAY):** Example screen **Debug → AudioBuffer Bench** (`AudioBufferBenchScreen`). Calls `runAudioBufferBench(suite)` → C++ `AudioBufferBench` (same B suites as host) → `AudioBenchLog` writes:

- `files/audiobuffer-bench-latest.json`
- `files/audiobuffer-bench.ndjson`
- `files/audiobuffer-bench-all.json`

Logcat tag: `AudioBufferBench`.

```bash
adb logcat -d -s AudioBufferBench:I
adb exec-out run-as com.xdcobra.voicelab cat files/audiobuffer-bench-all.json
adb exec-out run-as com.xdcobra.voicelab cat files/audiobuffer-bench.ndjson
```

**Ranking protocol:** one suite per cold start (force-stop between). **Run all B** is smoke only. Optional `durationSec` (10/30/60) for ring/spool suites (default 30).

Product §M.6 mic/pipeline scenarios remain separate e2e smokes; Buffer-core scoreboard uses the synthetic B suites above.

Fill [`audiobuffer-device-bench-results.md`](./audiobuffer-device-bench-results.md) from the first A142P pull.

### 6.3 iOS device smoke

**Physical iPhone** required for ship ranking. Simulator may collect CPU ratios only — same caveat as VideoBuffer.

Same throwaway screen + `runAudioBufferBench`. JSON lands in app Documents:

- `audiobuffer-bench-latest.json` / `.ndjson` / `-all.json`

Sim pull (ratios only): `xcrun simctl get_app_container <UDID> com.xdcobra.voiceexample data` then read `Documents/audiobuffer-bench-all.json`.

Do **not** declare “keep on both” from Host + Android alone without this layer for portable C; Bucket **D-I\*** is device-only by definition.

### 6.4 Ranking artifact

Filled: [`audiobuffer-android-ios-ranking.md`](./audiobuffer-android-ios-ranking.md) — keep/skip with **in-platform ratios** (Android A142P + iOS Simulator; physical iPhone still open for D-I\*).

---

## 7. Suggested order — status

1. ~~Android device B-smoke~~ **done**.  
2. iOS **device** B/D — **pending** (sim done as ratio/smoke).  
3. ~~Portable C #1/#2~~ **keep** (landed in product SoT).  
4. ~~C #3 / D-A1~~ **keep Critical** (product SoT landed); ~~C #4~~ **keep** (product SoT landed).  
5. ~~C #9/#10 / D-A3~~ #9 **keep** (product SoT landed); #10 / D-A3 **skip**. ~~C #16~~ **keep** (product SoT landed).  
6. ~~C #7/#8~~ **defer** (no lag pain).  
7. ~~C #11/#13~~ **keep (hygiene)** (#13 product SoT landed); #12 only if contention appears.  
8. ~~Bucket D Android~~ filled (§M.7); D-I\* pending iPhone.  
9. ~~C #5 external lib~~ **skip for now**.

---

## 8. Out of scope for this wave

- Public TS API redesign (except existing flags).  
- ONNX / sherpa inference kernels.  
- Video/Image buffer work.  
- Shipping lock-free ring, mmap spool, or Bucket D APIs **without** scoreboard evidence.  
- Replacing PaLive with AAudio/Oboe.  
- Merge to `fix/post-c-api-migration` before keep set.
