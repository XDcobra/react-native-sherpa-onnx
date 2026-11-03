# Post–Buffer-in-C copy / performance backlog

**When:** after **Audio + Text + Segment** SoT are all in shared C++ (umbrella Buffer-in-C complete).  
**End goal:** Kotlin/ObjC hold **only** Handle + Bridge (IDs, JS events, thin token listeners). Read / write / cursor / drain go **directly** to C (`pa_*` / `txt_*` / `seg_*`) — **no local Kotlin copy of the data structure**. SoT-done is **not** that end state.  
**How:** focused follow-up PR(s) from the updated umbrella; instrument first (Android logcat); **behavior parity via host buffer tests** (no inference models required).

Append new rows on every buffer migration. Do not delete resolved items — set **Status** `open` → `done` with a short note.

## Priority order (work top → bottom)

| Phase | IDs | Why this order |
|-------|-----|----------------|
| **0 — Cutover cleanup** | **A5** | Dead JNI only; unblocks clearer Audio surface; no behavior change if callers are gone |
| **1 — Audio: C is the only sample SoT for Kotlin consumers** | **A4 → A1 → A3** | A4 restores mmap-friendly `readInto` (encode/viz). A1 rewires features off full `FloatArray` materialize onto shared C readers. A3 removes mic heap hop into the same append path. Together: Kotlin audio handles stop owning sample arrays |
| **2 — Audio: JS boundary polish** | **A2** | After native readers exist, fix JSI double-copy into `OwnedBuffer`. One JS-boundary copy remains OK |
| **3 — Text: drop storage mirrors** | **T3 → T5 → T1 → T2** | T3 first (live mirror/cursors = dual SoT). T5 moves offline spans into C. T1 drops full-string default for features. T2 UTF-16 JNI after readers exist |
| **4 — Segment: drop storage mirrors** | **S8 → S6 → S1 → S4** | S8 mirrors T3 (cursor/log in C). S6/S1 stop full snapshot/getter dumps. S4 single validator in C |
| **5 — Optional event contracts** | **T4, S5** | May change JS payload shape; do after storage mirrors are gone; keep or version public contract |
| **6 — Engine in C (separate epic)** | **S7 → S2** | S7 is the dual-hook symptom; S2 is full SegEngine port. **Not** buffer-handle work — schedule after A/T/S mirrors |

**Skip / already done:** A5, A4, A1, A3, A2, A6, A7, S3.

## Per-ID notes (open)

| ID | Role toward end goal | Risk / test focus |
|----|----------------------|-------------------|
| A5 | Cleanup | Grep for callers; assembleDebug |
| A4 | Handle no longer rebuilds FloatArray from mmap slice | Host: mmap offline `readInto` / slice length/offset parity |
| A1 | Features use shared copy-into-dest readers (chunked); offline one-shot engines still `readAllSamples` until bufferId handoff | Host drain-into parity; assembleDebug |
| A3 | Mic writes C ring without Kotlin `FloatArray` | Host int16↔float append parity; assembleDebug |
| A2 | JSI one copy into ArrayBuffer | Host live/offline copy-into parity; assembleDebug |
| T3 | Live text: no Kotlin window/segment-log mirror | Host: partial/commit/cursor/finalize UTF-16 |
| T5 | Offline text metadata SoT in C | Host: populate + span slice |
| T1 | Features don’t default to full-string JNI | Compile + host length/slice |
| T2 | UTF-16 across JNI without UTF-8 hop | Host: emoji/surrogate indices |
| S8 | Live segment: cursor/drain from C only | Host: append/cursor/eviction/spool |
| S6 | No full vector copy for offline-from-live default | Host: fullIfSpooled / windowSnapshot |
| S1 | Getters don’t dump entire arrays by default | Host + TurboModule contract |
| S4 | One validator | Host: invalid payload reject codes |
| T4/S5 | Event payload size | Contract tests; optional |
| S7/S2 | Engine SoT in C | Engine epic; device smoke after host |

## Test gate (mandatory per closed ID)

Buffer behavior must stay as today (append/drain/cursor/finalize/spool/overflow/UTF-16/SEG2/TXT2). Prefer **host GTests under `test/cpp/{audiobuffer,textbuffer,segmentbuffer}/`** — **no ORT / no feature model**. Extend always-on coverage for the touched contract; opt-in only for large spool/mmap fixtures. `assembleDebug` still required after Android JNI/Kotlin changes.

## Living backlog

| ID | Buffer | Bottleneck / deferred copy | Why it remained | Target improvement | Status |
|----|--------|----------------------------|-----------------|--------------------|--------|
| A1 | Audio | Feature Kotlin still `drainCursor` / `readAllSamples` / `InMemory.samples` → JNI `jfloatArray` → `FloatArray` (STT, TTS, encode, viz, player) | SoT PR kept helper APIs compiling; engine `const float*` rewires out of scope | Shared C readers / `const float*` (or pinned view) into feature workers; drop full materialize as default | **done** (`readInto` + `pa_drain_cursor_into` / workers; residual offline feature `readAllSamples` until bufferId engine handoff) |
| A2 | Audio | JSI slice path: `pa_get_*_slice` → `std::vector` → memcpy → `OwnedBuffer` ArrayBuffer (also iOS) | Same pattern as pre-migration iOS; necessary JS boundary copy, but double native copy | Write slice directly into `OwnedBuffer` / reuse buffer pool | **done** (`pa_copy_live_samples_slice` + JSI direct OwnedBuffer; host parity test) |
| A3 | Audio | Mic: Int16→`FloatArray` in Kotlin then JNI `GetFloatArrayRegion` into C ring | Capture stays platform; SoT moved to C | Append via critical JNI / short native capture path without intermediate heap `FloatArray` | **done** (`pa_append_int16_samples_to_live` + `nativeAppendInt16SamplesToLive`; host parity test) |
| A4 | Audio | `MmapBacked.readInto` now `readSlice`→new `FloatArray`→`arraycopy` (was closer to mmap `ByteBuffer`) | Thin handle over C without exposing mmap pointer to Kotlin | JNI `readInto(out, offset, max)` or C pointer path for encode/viz | **done** (`pa_copy_offline_samples` + `nativeReadOfflineInto`; host parity test) |
| A5 | Audio | Dead `PipelineAudioRegistry.*Jni` sample methods (JSI no longer calls them) | Left for compatibility during cutover | Delete once no callers | **done** (`refactor/close-audiobuffer-copy-backlog`, `*Jni` helpers removed) |
| A6 | Audio | Video live-tap → C append | — | Already fixed in Audio SoT PR (`pa_append_samples_to_live`) | **done** |
| A7 | Audio | Android JSI → Kotlin `PipelineAudioRegistry` hop | — | Already fixed; JSI → `AudioRegistry` like iOS | **done** |
| T1 | Text | Feature/Kotlin helpers still materialize full strings via JNI `txt_read_*` / `nativeReadOfflineText` / live `currentText` mirror (TTS, STT, punctuation, OCR populate) | SoT PR kept TurboModule + worker APIs compiling; no text JSI | Shared UTF-16 views / length-bounded readers into feature workers; drop full-string default where safe | **open** |
| T2 | Text | JNI text path uses modified UTF-8 `GetStringUTFChars`/`NewStringUTF` round-trips (not UTF-16 code units) across TurboModule | RN string boundary; SoT preserved UTF-16 index semantics inside C via `TxtUtf16` | Critical JNI UTF-16 (`GetStringCritical` / `jchar`) or direct UTF-16 storage without UTF-8 hop | **open** |
| T3 | Text | Kotlin `LiveTextEntry` still mirrors segment log + window for listeners/cursors alongside C spool/window | Preserve token listeners + `drainSegments` without rewriting every worker | Drain/commit cursor from C segment store; Kotlin handle only | **open** |
| T4 | Text | Live JS events still pack full partial / segment text into WritableMap | Event contract unchanged | Optional truncated/delta events or shared handle id without payload dump | **open** |
| T5 | Text | Offline spatial spans / tokens / timestamps remain Kotlin-side mirrors (C holds primary text + metaJson) | Spans not required for TXT2 SoT cutover | Move spans/tokens into `TxtOfflineEntry` SoT + JNI slice APIs | **open** |
| S1 | Segment | TurboModule getters materialize full segment arrays (`WritableArray` / JSON snapshots via JNI) | SoT PR kept TurboModule packing in Kotlin/ObjC | Slice/cursor native views; optional truncated getters | **open** |
| S2 | Segment | Dual segmentation engine orchestration (`SegmentationEngineRegistry.kt` vs iOS `SegEngine` in `.mm`) | Buffer SoT PR deliberately deferred full engine C port | Shared C++ SegEngine + thin platform facades | **open** |
| S3 | Segment | Link-map dual SoT | — | Shared `SegmentLinkMapRegistry` in `cpp/segmentbuffer/` | **done** (this branch) |
| S4 | Segment | Duplicate payload validation (TS + iOS ObjC strict speech schema) | C append validates kind/samples only; bridge keeps ObjC strict checks | Single shared validator in C++ | **open** |
| S5 | Segment | `pipelineLiveSegmentAppended` ships full segment payloads | Event contract unchanged | Optional truncated/delta events or handle id without payload dump | **open** |
| S6 | Segment | Offline-from-live / snapshots copy full `vector`/`List` of records | SoT cutover preserved snapshot APIs | Shared readers / bounded drain without full materialize | **open** |
| S7 | Segment | Android text/audio still notify Kotlin `SegmentationEngineRegistry` while C `seg_engine_on_*` are weak no-ops | Engine remains Kotlin on Android; iOS strong SegEngine overrides weak | Single-path hooks when engine SoT moves to C (S2) | **open** |
| S8 | Segment | Kotlin `LiveSegmentEntry` mirrors segment log + cursors/listeners alongside C spool/window | Preserve worker drain/listener APIs without rewriting every consumer | Cursor/drain from C store; Kotlin handle only | **open** |

## Rules

1. Do **not** start this epic until Audio + Text + Segment SoT are merged to the Buffer-in-C umbrella (unless a single-buffer hot path is explicitly prioritized).
2. After each buffer SoT migration: scan for new materialize / bridge / JSI double-copy paths and add rows here.
3. Prefer fixing at the lowest layer (C registry / shared reader) over more Kotlin/JS workarounds.
4. Keep public TurboModule / TS contracts stable unless an explicit breaking change is requested.
5. When closing a row: set Status **done**, note the PR/branch, and leave the row for history.
6. Follow the **Priority order** table unless the user overrides; one ID (or tightly coupled pair) per focused change.
7. **Behavior parity + host tests:** every closed ID must keep buffer semantics unchanged and ship/extend **model-free** host GTests for the touched path.
