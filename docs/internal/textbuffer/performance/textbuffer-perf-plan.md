# TextBuffer — performance analysis and bench plan

**Status:** Host B + Android A142P B/Stress + iOS sim B/Stress filled; **Bucket C + Bucket D closed**. Measured keeps landed on umbrella `perf/improve-textbuffer-from-benchmarks`: **C1 C2 C3 C8 C12**, **D-A4** Batched, **D-I3** Adaptive Jetsam (Text only), hygiene C4/C5/D-A2. C7 deferred (lossless). External libs: no vendor. **Ship overview:** [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md). Ranking: [`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md). Physical iOS deferred.  
**Measure clone:** `/Volumes/SSD/dev/react-native-sherpa-onnx-textbuffer-perf` (`exp/textbuffer-perf`). Product land: this repo umbrella branch.  
**Base:** `refactor/refactor-before-release-1-0` (includes landed AudioBuffer keep PR).  
**SOT:** C++ `TextRegistry` / `TxtOfflineEntry` / `TxtLiveEntry` (`android/src/main/cpp/textbuffer/`, shared with iOS). JNI / Kotlin / ObjC are thin wrappers.  
**Floors:** Android `minSdkVersion = 24`; iOS deployment **15.1**. Platform opts need a runtime check + portable fallback.  
**Audio / video / image analogs:** [`../../audiobuffer/performance/`](../../audiobuffer/performance/), [`../../videobuffer/performance/`](../../videobuffer/performance/), [`../../imagebuffer/performance/`](../../imagebuffer/performance/). Do **not** copy PCM ring / GOP / JPEG items blindly — TextBuffer is UTF-8 storage + UTF-16 indexing + journal spool.  
**Existing notes (point here for measurement):**  
[`docs/future-work/live-text-pipeline-append-partial-channel.md`](../../../future-work/live-text-pipeline-append-partial-channel.md),  
[`docs/future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md`](../../../future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md).  
**Architecture:** [`../offlinetextbuffer-internal.md`](../offlinetextbuffer-internal.md), [`../livetextbuffer-internal.md`](../livetextbuffer-internal.md), [`../textbuffer-spool-v2-format.md`](../textbuffer-spool-v2-format.md).  
**Host results:** [`textbuffer-host-bench-results.md`](./textbuffer-host-bench-results.md) (Host B filled).  
**Device / ranking / ship:** [`textbuffer-device-bench-results.md`](./textbuffer-device-bench-results.md), [`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md), [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md) (B + C + D closed).

Correctness today: `test/cpp/textbuffer/textbuffer_registry_test.cpp` (`SHERPA_HOST_TEXT_SPOOL=1` for spool opt-in). Timed host bench: `test/cpp/textbuffer/textbuffer_bench.cpp` (§6.1).

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

- **Shipped ≠ proven.** Spool-on-by-default, checkpoint policy in docs, window/segment caps, partial-event coalescing, unlock-before listeners were shipped without a filled TextBuffer scoreboard. Treat them as **Bucket B** until Host+device numbers exist.
- **RAM is a gate, not a footnote.** Feature models dominate RSS. Paying large text/spool page-cache for a small buffer-CPU win is a **skip** (same lesson as Audio spool-as-speed and Image lazy keep).
- **Do not “prove” axioms with benches.** Native registry + UTF-16 slice / `txt_acquire_offline_text_view` vs shipping full strings over the JS bridge stay.
- **Portable C++ SoT first.** No Android-only or iOS-only TextBuffer core that breaks host tests. Bucket **D** is measured add-on with fallback.

### M.2 Dual gate (every scoreboard row)

| Metric | What | Gate idea |
|--------|------|-----------|
| Wall / chars·s⁻¹ / ops·s⁻¹ | Host micro + device smoke | Ship only if ≥ ~**2×** on the hot path **or** a clear RSS/disk win at flat CPU |
| Process RSS / peak | Before/after; isolate buffer growth | Skip if peak text/spool backing ≫ benefit |
| Disk / I/O | Journal + checkpoint size, write rate, fflush cost | Spool “wins” for **lossless** or measured lag-replay — not because fsync feels free |

Report columns: **Result wall ×**, **Result RSS Δ**, **Ship?** (and for spool: **Label** = `lossless` / `speed` / `optional`).

**Ranking:** compare **speedup ratios inside one platform**. **Keep on both** only when Android **device** and iOS **device** agree. iOS Simulator is CPU-ratio only — never sole ship evidence.

### M.3 Buckets

| Bucket | Meaning | Action |
|--------|---------|--------|
| **A — Axioms** | Must keep; no perf scoreboard | Document only |
| **B — Shipped, unproven** | Present in tree; no measured keep | **Re-baseline first** (latency + RSS + disk) on Host → Android → iOS |
| **C — New portable candidates** | Plan §2 numbered rows (`Txt*` / shared C++) | After B baselines; Host then devices |
| **D — Platform / API-version** | JNI string pin, CFString, Jetsam | Device-only (mostly); runtime fallback under floor |

### M.4 Spool special case

Do **not** market spool as a “perf optimization” until numbers exist. Separate questions:

1. **Correctness:** `fullIfSpooled` reconstructs committed + partial history — yes/no.  
2. **Perf:** writePartial / commit wall, journal growth, checkpoint/replay wall, RSS (page cache).  
3. **Ship label:** `keep for lossless` vs `keep for speed` vs `optional / trim`.

Doc + exp SoT (post-C keeps): checkpoint every **128 events** or **1 MiB** then journal rotate ([`livetextbuffer-internal.md`](../livetextbuffer-internal.md) §2.3); suffix-grow uses **`TEXT_PARTIAL_APPEND`** (C1); deferred `fflush` (C3). Full **`TEXT_PARTIAL_SET`** remains for non-prefix SET. Product base before land may still be full-SET-every-write — see [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md).

### M.5 Measurement order

1. Methodology + dual-gate + matrix (this doc).  
2. Host `textbuffer_bench` with RSS (`getrusage`) — Bucket B.  
3. **Android device** B-smoke (RSS always logged).  
4. **iOS device** B-smoke (real iPhone; sim optional for ratios only).  
5. Portable **C** one-at-a-time when Host+Android dual-gate is clear; confirm on iOS.  
6. **Bucket D** only if portable is exhausted **or** bridge string convert is clearly the bound — always with fallback under minSdk 24 / iOS 15.1.

STT decode / OCR inference stay **outside** buffer-core scoreboards unless Append-Ingest / bridge is proven bound.

### M.6 Test matrix (Host → Android → iOS)

```
Host_textbuffer_bench
  → Android_device_smoke
    → iOS_device_smoke
      → Ranking_keep_skip
```

| Layer | What | Metrics | May decide ship? |
|-------|------|---------|------------------|
| **Host** | `textbuffer_bench` + `textbuffer_host_test` | wall, ops/s, RSS Δ, disk | Prepares portable B/C; **not** final for Bucket D |
| **Android device** | Example / VoiceLab smokes (A142P-class) | wall, RSS/approx, disk, logcat | Yes for portable + **D-A\*** |
| **iOS device** | Same on **physical iPhone** | wall, RSS / Jetsam, Instruments | Yes for portable + **D-I\***; **sim ≠ Ship?** |

**Shared smoke scenarios** (Android and iOS devices):

1. Streaming-STT-shaped live: rapid `writePartial` (10–30 Hz) for 60–300 s + endpoint `commitSegment`.  
2. Live + spool `on` with slow consumer / late `fullIfSpooled` transfer.  
3. Live `spool off` vs `on` vs `auto` (same partial rate) — dual gate wall + disk.  
4. Offline populate with large OCR payload (text + many `spatialSpans`).  
5. Live finalize → `createOfflineTextBufferFromLive(fullIfSpooled)` replay cost.  
6. Dual cursors / segment drain under append.

Always log RSS (or platform equivalent). Prefer matched fixture sizes so **ratios** rank cleanly.

### M.7 Bucket D — platform / API-version candidates

Separate from portable C. Dual gate still applies.

#### Android (`minSdkVersion = 24`)

| ID | Candidate | Version note | Fallback | Host? | Device? | Wall × | RSS Δ | Ship? |
|----|-----------|--------------|----------|-------|---------|--------|-------|-------|
| D-A1 | JNI UTF-16 pin (`GetStringCritical` / `GetStringChars`) into C without UTF-8 round-trip on hot write | JNI, API ≥24 | Keep `GetStringChars` | approx | **yes** (1st) | Critical worse (12.7 vs 4.25) | +PSS | **skip** |
| D-A2 | Direct `jchar` / `ByteBuffer` UTF-16 for slice out | JNI | `NewString` from UTF-16 units (one-pass) | approx | **yes** (2nd) | ~1.31× vs utf8+reencode | flat PSS | **skip** (hygiene retained) |
| D-A3 | `posix_fallocate` / `MAP_POPULATE` for large spool files | NDK/Linux | Current `fopen`/`fwrite` | weak | **yes** (5th) | KEEP_SIZE ~0.95×; posix corrupt | +RSS | **skip** |
| D-A4 | Binder / event batching for partial JS emits (product path) | API 24+ | Sync emit | no | e2e (4th) | ~6.6× Batched | flat PSS | **keep** |

#### iOS (deployment **15.1**)

| ID | Candidate | Version note | Fallback | Host? | Device? | Wall × | RSS Δ | Ship? |
|----|-----------|--------------|----------|-------|---------|--------|-------|-------|
| D-I1 | `CFString` / `NSString` bridge without UTF-8 hop on hot write | 15.1+ | UTF-8 `std::string` SoT | no | **yes** (3rd) | CfUtf16 worse (2.61 vs 0.71) | +RSS | **skip** |
| D-I2 | `madvise(MADV_WILLNEED)` if any mmap text backing appears | POSIX | No hint | weak | **yes** (w/ D-A3) | N/A (no mmap) | — | **skip** |
| D-I3 | Jetsam-aware caps for `windowMaxChars` / `maxSegments` | iOS 13+ | Fixed defaults (Off) | no | **yes** (6th) | ForceTight ~34× wall | RSS Δ ~28× less | **keep** (Adaptive) |

**D order:** D-A1 → D-A2 → D-I1 → D-A4 → D-A3/D-I2 → D-I3.

**Do not start until the scoreboard demands it:**

- Android-only or iOS-only Offline Text SoT.  
- Replacing UTF-8 internal storage with UTF-16-only SoT without host parity.  
- Partial-driven **pipeline** wakes as default (see future-work — remains opt-in).

---

## 0. Bucket A — axioms (do not re-litigate)

| Item | Why it is an axiom |
|------|--------------------|
| Native `TextRegistry` SoT (C++) | Shared Android/iOS; engines stay in-process; host-testable |
| Dual-track partial + segment log | Streaming STT contract; UI + stable commits |
| UTF-16 indices at the public/bridge edge | Matches JS string semantics; avoids codepoint surprises |
| Slice / view APIs (`txt_copy_*_utf16_slice`, `txt_acquire_offline_text_view`) vs full-string bridge storms | Bridge bandwidth + GC |
| Pipeline append wakes on **segment** (not every partial) by default | Predictable downstream work; see future-work for opt-in partial channel |

---

## 0b. Bucket B — shipped, unproven (re-baseline)

Required layers: **Host** → **Android device** → **iOS device**.

| Item | Where | What to characterize | Host | Android | iOS |
|------|--------|----------------------|------|---------|-----|
| Spool `on` / `auto` / `off` | `TxtLiveEntry::configureSpooling`, journal `.txtj` + checkpoint `.txtc` | Append wall vs off; disk growth; `fullIfSpooled` replay wall; RSS | — | — | — |
| Full-snapshot journal writes | `maybeWriteSnapshotToSpool` → always `TEXT_PARTIAL_SET` + `fflush` | Cost per partial at 10–30 Hz; journal size after 5–15 min | — | — | — |
| Partial window `windowMaxChars` | `writePartial` / `appendText` | Cap RSS; suffix trim cost | — | — | — |
| Segment log `maxSegments` eviction | `commitSegment` + cursors | Eviction correctness; RSS bound | — | — | — |
| Partial-event coalescing | `partialEventMinIntervalMs` + `txt_dispatch_pipeline_live_text_partial` | JS/native emit rate vs wall | — | e2e | e2e |
| Unlock-before listeners | `notifyAppendListeners` / `notifyCommitListeners` (snapshot then invoke) | Nested deadlock hygiene; wall ~flat expected | — | — | — |
| Offline always-RAM | `TxtOfflineEntry` (no mmap) | Confirm still true for large OCR + spatialSpans; RSS vs create wall | — | — | — |
| UTF-16 codec / length | `TxtUtf16.h`, `TxtUtf16Codec.h` | Hot-path scan cost on emoji / CJK | — | — | — |
| Live←offline seed | `txt_create_live_from_offline` | One-copy seed vs JS hop | — | — | — |
| Spatial-span JSON | `TxtSpatialSpanJson.h` | Encode/decode wall + RSS for dense OCR pages | — | — | — |

Inference (STT/OCR) still dominates e2e wall. This plan is about **buffer** CPU, copies, locks, I/O, bridge shape, and **RSS**.

---

## 1. Current hot path

### Live

```
producer (STT / JS / OCR)
  → [Android JNI] jstring → UTF-8 std::string (GetStringUTFChars or UTF-16→UTF-8)
  → stateMutex:
       update currentText (SET or APPEND; maybe utf16 suffix trim)
       revision++
       currentFullSnapshotLocked()          // segments + partial remainder
       maybeWriteSnapshotToSpool(snapshot)  // spoolMutex: PARTIAL_SET + crc32 + fwrite + fflush
  → unlock
  → seg_engine_on_text_write / optional partial dispatch (throttled)
  → on commit: segment deque + notifyAppend/CommitListeners (unlock-before)
consumer:
  → segment cursor drain / getSegments
  → fullIfSpooled: load .txtc + replay .txtj (PARTIAL_SET / APPEND / COMMIT) → OfflineTextEntry
```

### Offline

```
create / populate
  → RAM std::string text + tokens/timestamps/durations + spatialSpans
  → engines: txt_acquire_offline_text_view (UTF-8 pointer)
  → bridge: UTF-16 slice copy APIs (preferred) or full read
```

---

## 2. Scoreboard — Bucket C (portable; fill after B device smokes)

Hypothesis × is **not** a ship number. Dual gate applies. Empty Result / Ship? until measured.

| # | Candidate | Hypothesis | Host | Android | iOS | Wall × | RSS Δ | Ship? |
|---|-----------|------------|------|---------|-----|--------|-------|-------|
| 1 | Spool **delta** records (`PARTIAL_APPEND` on prefix grow; SET fallback) | Cut journal bytes on append-heavy partials | yes | yes | yes | Host/A142P/iOS-sim grow **~8.6× disk**; wall flat | flat | **keep** |
| 2 | Implement doc **checkpoint + journal rotate** (128 events / 1 MiB) | Bound replay wall and disk; match published format policy | yes | yes | yes | policy (journal ~2 KiB @6k ops) | flat-ish | **keep** |
| 3 | Buffered spool writes (defer `fflush`; group headers) | Cut syscall tax on 10–30 Hz partials | yes | yes | yes | A142P B-fix ~**2.1×** | flat | **keep** |
| 4 | Spool I/O **outside** `stateMutex` | Shorter critical section under STT write storms | yes | yes | yes | no ≥2× writer wall | flat | **skip** (hygiene kept) |
| 5 | Shorten `g_txt_mutex` (resolve entry, release, then mutate) | Registry contention under multi-buffer pipelines | yes | yes | yes | no ≥2× (live already short) | flat | **skip** (hygiene kept) |
| 6 | Confirm / harden unlock-before listeners | Nested work hygiene (Audio C13 analog) | yes | yes | blocked | no ≥2× (already unlock-before) | flat | **skip** (hygiene kept) |
| 7 | Coalesce spool writes under partial storm (last-wins snapshot per interval) | Disk + CPU; label carefully vs lossless | yes | yes | yes | — | — | **defer** (product: keep lossless) |
| 8 | Avoid repeated `txt_utf16_length` on same string in one write | Micro win on hot SET | yes | yes | yes | A142P ~**1.9×** nospool | flat | **keep** |
| 9 | Kill remaining full-string materialize on hot paths (JS/native) | Bridge/GC; prefer length+slice | yes | yes | yes | — | — | — |
| 10 | Faster UTF-8↔UTF-16 (SIMD / lookup) for emoji/CJK | Only if codec shows up in profiles | yes | yes | yes | — | — | — |
| 11 | Spatial-span encode: binary / pooled JSON | OCR page dump wall + RSS | yes | yes | yes | — | — | — |
| 12 | Commit path: skip eager spool snap when off; fewer segment copies | Segment storm CPU | yes | yes | yes | A142P ~**28×** | lower | **keep** |
| 13 | `fullIfSpooled` replay: streaming reconstruct / fewer rescans | Transfer wall after long sessions | yes | yes | blocked | A142P ~0.17→0.22 ms (no ≥2×; C2) | flat | **skip** (suite kept) |
| 14 | Optional integrity mode (skip or weaken crc32 hot path) | Write wall; keep checksum for durable export | yes | yes | blocked | A142P 3.14 vs C3 2.78 (no ≥2×) | tiny | **skip** (crc kept) |
| 15 | Policy: default `spool: auto/off` for UI-only short sessions | Disk + CPU without losing lossless when needed | n/a | e2e | e2e | — | — | — |
| 16 | Offline mmap / file-backed text for huge OCR+spans | Only if B shows RAM pain (docs currently say always-RAM) | yes | yes | yes | — | — | — |
| 17 | Temp buffer pool for UTF-16 vectors / journal payloads | Churn (Audio ByteBufferPool analog) | yes | yes | yes | — | — | — |
| 18 | Rope / chunked `currentText` for very large SET | Only if partial windows grow large in product | later | yes | yes | — | — | — |

Bucket **D** scoreboard: §M.7 tables (same Wall × / RSS Δ / Ship? columns).

---

## 3. Candidates (detail) — Bucket C

### 3.1 Spool write shape — **#1 / #2 / #3 / #7 / #14**

**Was:** every `writePartial` / `appendText` / `commitSegment` builds a full snapshot string and appends `TEXT_PARTIAL_SET` + `crc32` + `fwrite` + `fflush`. Replay already understands APPEND/COMMIT deltas.

**Change candidates:** emit true deltas; implement checkpoint rotate as documented; buffer flushes; optional coalesce; optional lighter integrity on hot journal (still checksum checkpoints / export).

**Validate:** Host suite at 20 Hz partial × 5–15 min; compare journal bytes, write wall, `fullIfSpooled` parity golden. Dual gate: wall **and** disk/RSS.

### 3.2 Locking — **#4 / #5 / #6**

Hold `stateMutex` only for in-memory mutate; do spool I/O after snapshot copy under `spoolMutex`. Registry map lock only for lookup. Listeners already snapshot-then-invoke — re-baseline as B/C hygiene.

### 3.3 Bridge / codec — **#8 / #9 / #10** + D-A1 / D-I1

Prefer UTF-16 length + slice; avoid UTF-8 round-trips on Android/iOS hot writes when profiling shows convert bound. Portable UTF-8 SoT remains unless a measured keep justifies dual representation.

### 3.4 OCR / offline payload — **#11 / #12 / #16**

Spatial spans and token arrays can dominate large offline buffers. Measure before inventing mmap for text (Audio/Image lesson: structure first, then backing).

### 3.5 Transfer / replay — **#13**

Long spool sessions: replay wall may exceed write wall. Streaming reconstruct + fewer payload copies.

### 3.6 Product policy — **#15**

Default spool `on` is a product correctness choice. Scoreboard may keep it for lossless while recommending `auto`/`off` for ephemeral UI buffers.

---

## 4. Architecture snapshot (C level)

```
                 TextRegistry (g_txt_offline / g_txt_live + g_txt_mutex)
          ┌────────────────────────────┬────────────────────────────────┐
          │ TxtOfflineEntry            │ TxtLiveEntry                     │
          │  RAM UTF-8 text            │  currentText + revision          │
          │  tokens / ts / durations   │  deque segments + cursors        │
          │  spatialSpans              │  optional TXT2 journal+checkpoint│
          │  txt_acquire_*_view        │  partial coalesce + listeners    │
          └────────────────────────────┴────────────────────────────────┘
                    ↑ portable SoT (Host + Android + iOS)
         JNI / JSI / ObjC / STT-OCR workers  →  Bucket D wrappers only
```

| Mode | Backing | Notes |
|------|---------|--------|
| Offline | RAM (today) | Revisit only if OCR+spans blow RSS on device |
| Live | RAM window + optional spool | Spool = lossless authority until measured otherwise |

---

## 5. External libraries (measure before vendor)

| Library / approach | License | Replaces | Notes |
|--------------------|---------|----------|--------|
| simdutf / similar | Apache-2 / MIT | UTF-8↔UTF-16 loops | Only if #10 clears dual gate |
| RapidJSON / simdjson | MIT | Spatial JSON | Only if #11 bound |
| Custom CRC / xxhash | — | zlib `crc32` on hot journal | Integrity trade — product decision |

**Bucket C close:** no vendor — C10/C11/C14 did not clear dual gate. Revisit only if those reopen with a measured wall.

Do not start with rewriting TextBuffer on top of a database or mmap-everything.

---

## 6. Bench plan

### 6.1 Host — `textbuffer_bench` (Host B filled — see results doc)

| Suite | Fixture | Metrics |
|-------|---------|---------|
| `B_live_partial_nospool` | 20 Hz SET, 60–300 s, spool off | wall, ops/s, RSS Δ |
| `B_live_partial_spool` | Same + spool on | wall vs nospool, disk bytes, RSS Δ |
| `B_live_commit_storm` | N commits with tokens/timestamps | wall, RSS Δ |
| `B_spool_replay` | After long spool, `fullIfSpooled` | replay ms, RSS Δ |
| `B_offline_populate_ocr` | Large text + K spatial spans | create ms, RSS Δ |
| `B_utf16_slice` | Mid-slice copy vs full materialize | wall |
| `C_*` | Isolated hooks for §2 rows after B | wall (+ RSS) |

RSS: macOS/Linux `getrusage` (normalize units). Isolate suites when RSS Δ matters.

### 6.2 Android device

Example **Debug → TextBuffer Bench** (`TextBufferBenchScreen` + `runTextBufferBench` → `TextBufferBench.cpp`). Bucket B suite IDs match Host; JSON/ndjson under app `files/textbuffer-bench-*`. Always log RSS/PSS. Numbers: [`textbuffer-device-bench-results.md`](./textbuffer-device-bench-results.md) (TBD).

### 6.3 iOS device

Same scenarios on physical iPhone. Sim = ratio/smoke only for D-I\*.

### 6.4 Ranking doc

After pulls, fill `textbuffer-android-ios-ranking.md` with in-platform × and a keep/skip table (AudioBuffer ranking shape). Prefer **C1/C2** spelling in PR text (no `#N` GitHub autolinks).

---

## 7. Suggested measure order

1. Host B: nospool partial / spool partial / commit / replay / offline OCR.  
2. Android A142P B smoke (+ stress 5–15 min partial+spool).  
3. iOS device B smoke.  
4. Ranking: spool lossless vs speed; whether full-snapshot journal is already “good enough”.  
5. Portable C starting with **#1/#2/#3** if spool write dominates; else **#4/#5** if locks dominate; else **#9** if bridge dominates.  
6. Bucket D only if string convert is the remaining bound.

---

## 8. Constraints

- minSdk 24 / iOS 15.1 + fallback for any D row.  
- Host tests must keep passing (`textbuffer_registry_test`).  
- Spool format v2: delta writes must remain replay-compatible with existing readers.  
- Default pipeline append trigger stays **segment** (future-work partial channel is opt-in, not a silent default).  
- Do not break UTF-16 public indexing.

---

## 9. Out of this phase

- Changing STT/OCR model performance.  
- Shipping partial-driven pipeline wakes as default.  
- Merging throwaway bench UI to product before keep set.  
- Copying Audio ring-memcpy items that do not apply to text.

---

## 10. Keep / skip matrix

Filled from B Host + A142P + iOS sim ([`textbuffer-android-ios-ranking.md`](./textbuffer-android-ios-ranking.md)). Canonical land list: [`textbuffer-perf-ship-overview.md`](./textbuffer-perf-ship-overview.md).

| Candidate | Decision |
|-----------|----------|
| Spool on (lossless) | **keep** |
| Spool as speed | **skip** |
| Full-snapshot journal | **keep (shipped)**; SET fallback + C1 APPEND |
| Delta journal (#1) | **keep** (Host + A142P `C_spool_delta`) |
| Checkpoint rotate (#2) | **keep** (bounded `.txtj` + parity; `C_spool_checkpoint`) |
| Buffered fflush (#3) | **keep** (A142P B-fixture ~2.1× wall; `C_spool_fflush`) |
| Commit path (#12) | **keep** (A142P ~28×; `C_commit_copies`) |
| Spool outside stateMutex (#4) | **skip** wall (`C_spool_unlock`); hygiene retained |
| Short `g_txt_mutex` (#5) | **skip** wall (`C_registry_unlock`); hygiene retained |
| Unlock-before listeners (#6) | **skip** wall (`C_listener_unlock`); hygiene retained |
| Spool coalesce (#7) | **defer** — keep lossless; text RAM fine; no last-wins without policy change |
| Reuse utf16 lengths (#8) | **keep** (A142P ~1.9×; `C_utf16_len`) |
| Long replay streaming (#13) | **skip** wall (`C_spool_replay_long` ~0.17 ms); suite kept |
| Optional crc skip (#14) | **skip** wall (`C_crc_optional`); production crc retained |
| Bridge full-string audit (#9) | defer |
| Offline mmap (#16) | **skip for now** |
| D-A1 string pin (Critical) | **skip** (`D_jni_write_partial`); GetStringChars kept |
| D-A2 slice NewString | **skip** wall (`D_jni_slice_out` ~1.31×); one-pass units retained |
| D-I1 string pin | **skip** (`D_ios_write_partial`); UTF8String kept |
| D-A4 emit batching | **keep** (`D_partial_emit` ~6.6×); Batched default |
| D-A3 fallocate | **skip** (`D_spool_fallocate`); KEEP_SIZE no win; posix corrupt |
| D-I2 madvise | **skip** — no text mmap |
| D-I3 Jetsam caps | **keep** (`D_jetsam_caps`); Adaptive default; ForceTight harness |

Product landings use compact code comments:

```text
Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (<ID>).
```
