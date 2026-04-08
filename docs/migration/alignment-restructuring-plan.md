# Alignment API — Restructuring Plan

> Goal: Make alignment **standalone** (like PCM player), eliminate unnecessary JS↔native round-trips, consolidate duplicated segmentation code into C++, and provide ergonomic TTS/STT integration hooks that read directly from native sinks.

---

## 1  Current State — Mode-by-Mode Analysis

### 1.1  Proportional

| Layer | What happens |
|-------|-------------|
| **JS** `alignTextToAudio()` | Splits text into sentences/words (`textSegments.ts`) |
| **JS** | If audio is a path: calls `SherpaOnnx.getAlignmentAudioMetrics(path)` or `decodeAudioFileToFloatSamples(path)` |
| **Native** `getAlignmentAudioMetrics` | Fast parse of 16-bit mono PCM WAV header → `{ sampleRate, totalSamples }` |
| **JS** | `distributeSamplesByTextWeight()` + `buildSubtitlesFromChunks()` → `SubtitleTimingItem[]` |

**Data flow (file path input):**
```
JS ─getAlignmentAudioMetrics→ Native(C++: WAV header parse) ─{sr,total}→ JS
JS: text split + proportional math → subtitles
```

**Data flow (TTS integration — `generateSpeechWithTimestamps` proportional):**
```
JS ─generateTts→ Native(C++ synth → sink)
Native ─{sampleRate, numSamples, generation}→ JS
JS: creates dummy Array(numSamples), calls alignTextToAudio(proportional)
alignTextToAudio: splits text, distributeSamplesByTextWeight → subtitles
```

**Bottlenecks:**
- Text segmentation runs in JS only — duplicated in Kotlin/ObjC++ for estimated mode inside `generateTtsWithTimestamps` but **not shared**.
- `decodeAudioFileToFloatSamples` for non-WAV files decodes the entire file into JS memory just to get `samples.length` — massive waste.
- TTS path creates a dummy `new Array(numSamples)` just to satisfy the function signature, which allocates empty memory pointlessly.
- Pure math — zero reason to involve native beyond getting `(sampleRate, totalSamples)`.

**Possible improvements:**
- Proportional mode is **pure JS math**. Keep it in JS but fix the API signature so it takes `{ sampleRate, totalSamples }` directly instead of requiring an audio path/samples object. No bridge call needed when called from TTS (metadata already available).
- Add a native `getAudioDuration(path)` → `{ sampleRate, totalSamples }` that works for **all** formats (not just 16-bit mono WAV) by decoding just the header/metadata natively.

---

### 1.2  Estimated

| Layer | What happens |
|-------|-------------|
| **JS** `alignTextToAudio()` | Receives `chunks: { sampleRate, segmentSampleCounts }` |
| **JS** | Splits text, `alignChunkCountsToSegments()`, `buildSubtitlesFromChunks()` → subtitles |

**Data flow (standalone):**
```
JS: text split + math on chunk counts → subtitles
(Zero native calls)
```

**Data flow (TTS integration — `generateSpeechWithTimestamps` estimated):**
```
JS ─generateTtsWithTimestamps(exportChunkTimelineOnly)→ Native
Native: synth with callback → collects sentenceChunkSizes per sentence
Native ─{sampleRate, numSamples, generation, segmentSampleCounts}→ JS
JS: calls alignTextToAudio(estimated) with segmentSampleCounts
alignTextToAudio: text split + buildSubtitlesFromChunks → subtitles
```

**Bottlenecks:**
- **Triple text segmentation!** Text is segmented:
  1. By the native TTS engine (C++ `generateStream` callback = one chunk per sentence)
  2. By native subtitle code (`SherpaOnnxTextSegmenter.kt` / `TtsSubtitleSegmentation.mm`) — to build subtitles natively when NOT using `exportChunkTimelineOnly`
  3. By JS `textSegments.ts` when using `exportChunkTimelineOnly` → `alignTextToAudio(estimated)`
- Three separate implementations of the SAME sentence/word splitting algorithm (JS, Kotlin, ObjC++). ~1300 lines of duplicated logic.
- When NOT using `exportChunkTimelineOnly`, native already computes subtitles BUT also sends them over the bridge as an array of objects. Then if JS also wants to do alignment, it calls `alignTextToAudio` again.
- `exportChunkTimelineOnly` was a workaround: native does synthesis → sends chunk counts to JS → JS re-splits text → JS computes subtitles. Redundant because native already HAS all the information needed.

**Possible improvements:**
- Move text segmentation to C++ (single source of truth). All three platforms call the same C++ implementation.
- When called from TTS, compute estimated subtitles entirely on native side (C++ synthesis callback gives chunks, C++ segmenter splits text, C++ math builds subtitles → return final `SubtitleTimingItem[]` over bridge). Zero JS alignment code needed.
- Kill `exportChunkTimelineOnly` in the TTS path — native produces finished subtitles directly.
- Keep JS `alignTextToAudio(estimated)` as standalone API for callers who have their own chunk data (e.g. future STT integration).

---

### 1.3  Accurate (CTC)

| Layer | What happens |
|-------|-------------|
| **JS** `alignTextToAudio()` | Sends `modelPath + text + vocabJson + samples/path` to native |
| **Native (Android)** | `SherpaOnnxAlignmentHelper.kt` → JNI → `sherpa_onnx_ctc_alignment.cpp` |
| **Native (iOS)** | `SherpaOnnx+Alignment.mm` → `sherpa_onnx_ctc_alignment.cpp` |
| **C++** | Resample to 16kHz → normalize → ONNX inference → log-softmax → Viterbi backtrack → word/char intervals |
| **Native→JS** | Returns `{ words: [...], chars: [...] }` with times in seconds |
| **JS** | Granularity post-processing: character/word/sentence grouping |

**Data flow (standalone, file path):**
```
JS ─alignAccurateFromPath(modelPath, audioPath, text, vocabJson)→ Native
Native: WaveReader → C++ CTC pipeline → words/chars
Native ─{words, chars}→ JS
JS: granularity post-processing → subtitles
```

**Data flow (TTS integration — `generateSpeechWithTimestamps` accurate):**
```
JS ─generateTts→ Native(C++ synth → sink) ─{sr, numSamples, gen}→ JS
JS ─getTtsSamples(gen)→ Native ─{samples: number[], sr}→ JS          ← BIGGEST BOTTLENECK
JS: Array.from(samples) → alignAccurateFromFloat32(modelPath, samples, sr, text, vocab)
JS ─all samples as number[]→ Native                                   ← SECOND ROUND-TRIP
Native: C++ CTC pipeline → words/chars
Native ─{words, chars}→ JS
JS: granularity post-processing → subtitles
```

**Bottlenecks:**
- **Double native round-trip for TTS!** PCM is synthesized in native, pulled to JS via `getTtsSamples()` (entire `FloatArray` → `number[]` over bridge), then pushed BACK to native via `alignAccurateFromFloat32()` (`number[]` → `FloatArray` over bridge). For a 10-second clip at 22050Hz that's 220,500 floats marshalled twice over the RN bridge.
- `vocabJson` (~32 chars vocabulary) is sent from JS every call. It's static and could be baked into native.
- Sentence-level granularity post-processing happens in JS using the JS text segmenter (yet another split).
- The ONNX alignment model is loaded and unloaded per call — no session caching.

**Possible improvements:**
- **Critical:** Add `alignAccurateFromSink(instanceId, generation, modelPath, text, granularity)` — native reads PCM directly from TTS sink (zero JS memory allocation, zero bridge PCM transfer).
- Bake the vocabulary into C++ or load from model directory (eliminate `vocabJson` parameter).
- Move granularity post-processing (sentence grouping from word intervals) to C++.
- Add optional ONNX session caching (keep loaded model across calls for same `modelPath`).

---

## 2  Core Problems Summary

| Problem | Impact | Solution |
|---------|--------|----------|
| **3× duplicated text segmenter** (JS, Kotlin, ObjC++) | Maintenance hell, potential drift | Single C++ implementation |
| **PCM round-trip in TTS+accurate** | ~440k floats over bridge for 10s audio | `alignFromSink()` reads native PCM directly |
| **vocabJson sent from JS** | Unnecessary bridge payload | Bake into C++ or load from model dir |
| **No ONNX model caching** | Re-loads ~100MB model per alignment call | Session pool with key = modelPath |
| **exportChunkTimelineOnly workaround** | Estimated subtitles computed partly native, partly JS | Native computes final subtitles directly |
| **Proportional needs audio decode for non-WAV** | Full decode to get `totalSamples` | Native `getAudioDuration()` for any format |
| **Alignment tightly coupled to TTS in types.ts** | Not truly standalone | Decouple; provide integration helpers |

---

## 3  Proposed New Architecture

### 3.1  Native Layer: `AlignmentEngine` (C++)

Single C++ module shared by Android (JNI) and iOS (direct call):

```
alignment/
├── text_segmenter.cpp          ← single source of truth for sentence/word/character splitting
├── proportional_alignment.cpp  ← distributeSamplesByTextWeight (pure math)
├── estimated_alignment.cpp     ← chunk→segment mapping + subtitle building
├── ctc_alignment.cpp           ← existing ONNX CTC pipeline (kept)
├── alignment_engine.hpp        ← public API surface
└── alignment_vocab.hpp         ← baked-in wav2vec2 vocabulary
```

**Key new C++ functions:**
```cpp
// Proportional (pure math, no ONNX)
AlignmentResult AlignProportional(
    const std::string& text,
    int32_t totalSamples,
    int32_t sampleRate,
    const std::string& granularity  // "sentence" | "word"
);

// Estimated (pure math, no ONNX)
AlignmentResult AlignEstimated(
    const std::string& text,
    const std::vector<int32_t>& segmentSampleCounts,
    int32_t sampleRate,
    const std::string& granularity  // "sentence" | "word"
);

// Accurate CTC — from raw PCM
AlignmentResult AlignAccurate(
    const std::string& modelPath,
    const std::string& text,
    const float* samples,
    int32_t numSamples,
    int32_t sampleRate,
    const std::string& granularity  // "sentence" | "word" | "character"
);

// Accurate CTC — from file
AlignmentResult AlignAccurateFromFile(
    const std::string& modelPath,
    const std::string& text,
    const std::string& audioPath,
    const std::string& granularity
);

// Accurate CTC — from TTS sink (zero-copy)
AlignmentResult AlignAccurateFromSink(
    const std::string& modelPath,
    const std::string& text,
    const float* sinkSamples,       // pointer into native sink
    int32_t sinkNumSamples,
    int32_t sinkSampleRate,
    const std::string& granularity
);
```

All functions return the same `AlignmentResult`:
```cpp
struct SubtitleItem { std::string text; double start_s; double end_s; };
struct AlignmentResult {
    std::vector<SubtitleItem> subtitles;
    std::string timingMode;  // "proportional" | "estimated" | "aligned"
};
```

### 3.2  Native Bridge: New TurboModule Methods

```ts
// --- Standalone alignment (decoupled from TTS) ---

/** Align text to audio from a file path. All modes. */
alignTextToAudioFromPath(
  text: string,
  audioPath: string,
  mode: 'proportional' | 'estimated' | 'accurate',
  granularity: 'sentence' | 'word' | 'character',
  options: {
    alignmentModelPath?: string;        // required for accurate
    segmentSampleCounts?: number[];     // required for estimated
  }
): Promise<{ subtitles: SubtitleTimingItem[]; timingMode: string }>;

/** Align text to in-memory PCM. All modes. */
alignTextToAudioFromPcm(
  text: string,
  samples: number[],
  sampleRate: number,
  mode: 'proportional' | 'estimated' | 'accurate',
  granularity: 'sentence' | 'word' | 'character',
  options: {
    alignmentModelPath?: string;
  }
): Promise<{ subtitles: SubtitleTimingItem[]; timingMode: string }>;

// --- TTS-integrated alignment (reads from sink, zero JS PCM) ---

/** Align text to TTS sink audio. All modes. */
alignTextToTtsSink(
  generatedAudio: { generation: number; _instanceId: string },
  text: string,
  mode: 'proportional' | 'estimated' | 'accurate',
  granularity: 'sentence' | 'word' | 'character',
  options: {
    alignmentModelPath?: string;        // required for accurate
    segmentSampleCounts?: number[];     // for estimated (from generateTtsWithTimestamps)
  }
): Promise<{ subtitles: SubtitleTimingItem[]; timingMode: string }>;
```

### 3.3  JS Layer: Standalone `alignment` Module

Stays as a separate import (`react-native-sherpa-onnx/alignment`), thin wrappers:

```ts
// Main entry — unchanged public API with refined internals
async function alignTextToAudio(
  text: string,
  audio: string | { samples: Float32Array; sampleRate: number },
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;

// NEW: convenience for TTS sink
async function alignTextToTtsSink(
  text: string,
  audio: GeneratedAudio,
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

**Changes:**
- `alignTextToAudio` delegates ALL modes to native (no more JS text splitting, no JS proportional/estimated math).
- `samples` type changes from `number[]` to `Float32Array` (aligns with TTS PCM changes — **breaking**).
- `alignTextToTtsSink` reads directly from native sink — **zero** PCM over bridge; callers pass `GeneratedAudio` (no raw `instanceId`/`generation` arguments in the public API).
- Remove `textSegments.ts` entirely (logic moves to C++).
- Remove `vocab.ts` entirely (baked into C++).
- Remove `tempAudio.ts` if no longer needed.

### 3.4  TTS Integration: `generateSpeechWithTimestamps`

**Before (current):**
```
JS: generateTts → getTtsSamples → alignTextToAudio(accurate)
    ↑ 3 bridge calls, 220k+ floats marshalled twice
```

**After (proposed):**
```
JS: generateTts → alignTextToTtsSink(audio, ...)
    ↑ 2 bridge calls, ZERO float marshalling for alignment
```

For estimated mode integration in TTS, we explicitly implement **Option A**:
- `generateTtsWithTimestamps` returns `segmentSampleCounts` as before, then JS calls `alignTextToTtsSink(estimated)` which sends counts to native → native computes subtitles.
- We do **not** add a monolithic `generateTtsWithTimestampsAndAlign` method in this plan.

### 3.5  Removing Kotlin/ObjC++ Text Segmenters

| Current file | Action |
|-------------|--------|
| `SherpaOnnxTextSegmenter.kt` (330 lines) | Delete — replace with JNI call to C++ |
| `TtsSubtitleSegmentation.mm` (513 lines) | Delete — replace with direct C++ call |
| `textSegments.ts` (446 lines) | Delete — replaced by native |
| `vocab.ts` | Delete — baked into C++ |
| `tempAudio.ts` | Delete if unused after refactor |

---

## 4  Migration Path (Breaking Changes)

| Change | Impact | Migration |
|--------|--------|-----------|
| `alignTextToAudio` audio samples: `number[]` → `Float32Array` | **Breaking** | Callers use `Float32Array` (aligns with TTS changes) |
| Remove `exportChunkTimelineOnly` from TTS options | **Breaking** | Use `alignTextToTtsSink(estimated)` with `segmentSampleCounts` |
| `vocabJson` parameter removed from native methods | **Internal** | No public API change |
| Text segmentation may have minor behavioral differences | **Minor** | C++ rewrite tested against JS golden outputs |
| `getAlignmentAudioMetrics` → replaced by `getAudioDuration` (all formats) | **Breaking** | Remove the old method; no compatibility alias |

---

## 5  Implementation Order

### Phase 1: C++ Text Segmenter (foundation)
1. Port `splitTextIntoSentences`, `splitTextIntoWords` to C++
2. Port `distributeSamplesByTextWeight`, `buildSubtitlesFromChunks` to C++
3. Unit-test against JS implementation golden outputs
4. Wire into Android (JNI) and iOS (direct call)

### Phase 2: Native Alignment Functions
5. Implement `AlignProportional()`, `AlignEstimated()` in C++ using new segmenter
6. Add native bridge methods: `alignTextToAudioFromPath`, `alignTextToAudioFromPcm`
7. Add `alignTextToTtsSink` — reads from TTS sink, dispatches to correct mode

### Phase 3: CTC Improvements
8. Bake vocabulary into C++ (remove `vocabJson` parameter)
9. Move sentence-grouping from JS to C++ `AlignAccurate`
10. Wire `alignTextToTtsSink(accurate)` to read sink PCM directly

### Phase 4: JS Layer Cleanup
11. Rewrite `alignTextToAudio` to delegate entirely to native
12. Add `alignTextToTtsSink` JS wrapper
13. Delete `textSegments.ts`, `vocab.ts`, `tempAudio.ts`
14. Delete `SherpaOnnxTextSegmenter.kt`, `TtsSubtitleSegmentation.mm`
15. Update `generateSpeechWithTimestamps` to use `alignTextToTtsSink`

### Phase 5: Docs & Migration
16. Update `alignment.md`, `tts-offline.md`, `migration.md`, `CHANGELOG.md`
17. Update example app

---

## 6  Performance Gains

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| **TTS + accurate (10s, 22kHz)** | 3 bridge calls, 440k floats | 2 bridge calls, 0 floats | Eliminates ~880KB bridge transfer |
| **TTS + estimated** | 2 bridge calls + JS text split | 1–2 bridge calls, native text split | Removes JS computation |
| **TTS + proportional** | 1 bridge call + JS text split | 1 bridge call, native text split | Removes JS computation |
| **Standalone + accurate (file path)** | 1 bridge call + JS granularity grouping | 1 bridge call (all in native) | Removes JS post-processing |
| **Model loading** | Load per call | Cached session | ~100ms+ saved on repeat calls |

---

## 7  Open Questions

1. **Vocab from model dir?** Some alignment model packs include a `vocab.json`. Should C++ auto-detect and load it from the model directory, or keep the baked-in default?
   → Recommendation: Baked-in default + optional override from model dir if present.

2. **ONNX session caching strategy?** LRU with max 1–2 sessions? Or explicit `loadAlignmentModel()` / `unloadAlignmentModel()`?
   → Recommendation: Automatic LRU (max 1 session) keyed by `modelPath`. Re-load on path change.

3. **Streaming alignment?** Should `generateSpeechStream` support on-the-fly subtitle generation?
   → Recommendation: Defer to future. Current use case is batch generation + alignment. Streaming subtitles would need a very different (incremental) approach.

4. **STT integration shape?** When STT ships, it could provide `AlignmentChunkTimeline` from token timestamps. The estimated mode should accept this.
   → Recommendation: Keep estimated mode's standalone API (`segmentSampleCounts` input) as-is. Add STT helper that converts STT result → `AlignmentChunkTimeline` (future work, out of scope here).
