# Post–Buffer-in-C copy / performance backlog

**When:** after **Audio + Text + Segment** SoT are all in shared C++ (umbrella Buffer-in-C complete).  
**What:** revisit copy/handoff performance — SoT-done is **not** zero-copy-done.  
**How:** focused follow-up PR(s) from the updated umbrella; instrument first (Android logcat).

Append new rows on every buffer migration. Do not delete resolved items — set **Status** `open` → `done` with a short note.

## Living backlog

| ID | Buffer | Bottleneck / deferred copy | Why it remained | Target improvement | Status |
|----|--------|----------------------------|-----------------|--------------------|--------|
| A1 | Audio | Feature Kotlin still `drainCursor` / `readAllSamples` / `InMemory.samples` → JNI `jfloatArray` → `FloatArray` (STT, TTS, encode, viz, player) | SoT PR kept helper APIs compiling; engine `const float*` rewires out of scope | Shared C readers / `const float*` (or pinned view) into feature workers; drop full materialize as default | **open** |
| A2 | Audio | JSI slice path: `pa_get_*_slice` → `std::vector` → memcpy → `OwnedBuffer` ArrayBuffer (also iOS) | Same pattern as pre-migration iOS; necessary JS boundary copy, but double native copy | Write slice directly into `OwnedBuffer` / reuse buffer pool | **open** |
| A3 | Audio | Mic: Int16→`FloatArray` in Kotlin then JNI `GetFloatArrayRegion` into C ring | Capture stays platform; SoT moved to C | Append via critical JNI / short native capture path without intermediate heap `FloatArray` | **open** |
| A4 | Audio | `MmapBacked.readInto` now `readSlice`→new `FloatArray`→`arraycopy` (was closer to mmap `ByteBuffer`) | Thin handle over C without exposing mmap pointer to Kotlin | JNI `readInto(out, offset, max)` or C pointer path for encode/viz | **open** |
| A5 | Audio | Dead `PipelineAudioRegistry.*Jni` sample methods (JSI no longer calls them) | Left for compatibility during cutover | Delete once no callers | **open** |
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
