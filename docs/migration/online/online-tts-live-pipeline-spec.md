# Streaming TTS: `LiveTextBuffer` → `LiveAudioBuffer` pipeline

**Status:** Specification — all design decisions resolved; ready for implementation.  
**Scope:** Replace the current per-chunk JS bridge event model for streaming TTS with a **native-native streaming pipeline**. A `TtsPipelineWorker` reads committed text segments from a `LiveTextBuffer` and writes synthesized PCM samples into a `LiveAudioBuffer`. **All legacy bridge-based streaming TTS methods are removed** (`generateTtsStream`, `generateTtsStreamToFile`, `cancelTtsStream`, TTS-bound playback). **Breaking change** — pipeline-only, same approach as the [STT pipeline migration](./online-stt-live-text-pipeline-spec.md).  
**Prerequisite:** The `LiveTextBuffer` segment log + cursor + append-listener infrastructure (from the [STT pipeline spec](./online-stt-live-text-pipeline-spec.md)) and the `StreamingPipelineWorker` / `StreamingPipelineRegistry` infrastructure (from the [enhancement pipeline spec](./online-enhancement-live-pipeline-spec.md)) are already implemented.  
**Design reference:** This spec follows the same pattern and resolved design decisions from the [STT pipeline spec](./online-stt-live-text-pipeline-spec.md) (section 14), adapted for the TTS direction.

---

## 1. Problem statement

The current streaming TTS API forces **every audio chunk** through the JS ↔ native bridge:

```ts
// Current: per-chunk base64 bridge events
const controller = await tts.generateSpeechStream(
  'Hello world',
  { sid: 0, speed: 1.0 },
  {
    onChunk: (chunk) => {
      // chunk.samples = Float32Array (base64-decoded from native)
      // ~31 events/sec at 16384-frame coalescing / 500ms latency
    },
    onEnd: () => {},
  },
  { playback: true, emitChunks: true }
);
```

**Current data flow:**
```
sherpa-onnx C++ generateWithCallback  →  per-chunk callback
  → ChunkCoalescer (16384 frames / 500ms)
  → base64-encode FloatArray
  → emit JS DeviceEventEmitter("ttsStreamChunk")
  → JS: base64-decode → Float32Array
  → Optional: writePcmChunk to native player (another bridge crossing)
```

Problems:
1. **Base64 encoding/decoding overhead** — every chunk is serialized/deserialized.
2. **Two bridge crossings for playback** — native → JS (chunk event) → native (PCM player).
3. **No native-native pipeline chaining** — downstream stages (enhancement, STT) cannot consume TTS audio without JS mediation.
4. **Text input is monolithic** — `generateSpeechStream(text)` takes the full text upfront. No native-level incremental text feeding.

### Goal

Replace with a **native-native streaming pipeline** where:

1. A **`LiveTextBuffer`** (input) provides text segments — either committed incrementally by an upstream pipeline (STT, translation) or pushed from JS.
2. A **native TTS pipeline worker** continuously drains committed segments via a text cursor, runs `generateWithCallback` per segment, and writes PCM samples to an **output `LiveAudioBuffer`**.
3. **Downstream consumers** (enhancement, STT, PCM playback, WAV export) independently read audio from the output buffer — **in parallel** while TTS is still producing.

JS only orchestrates **start / stop / status**. Audio data never crosses the bridge during steady-state operation.

### Full pipeline example

```text
Text input ──→ LiveTextBuffer₁ ──→ [Streaming TTS] ──→ LiveAudioBuffer₁ ──→ [Enhancement] ──→ LiveAudioBuffer₂ ──→ [Streaming STT] ──→ LiveTextBuffer₂
                                     (native worker)                          (native worker)                         (native worker)
```

Each stage starts processing as soon as its input buffer has data. TTS starts synthesizing the first text segment while more text is still being pushed. Enhancement starts denoising while TTS is still producing audio. STT starts transcribing while enhancement is still processing. **True streaming parallelism across all stages.**

---

## 2. Current state (as-is)

### 2.1 Streaming TTS architecture

| Component | Description |
| --- | --- |
| **TurboModule** | `generateTtsStream(instanceId, requestId, text, options)` — single text blob, JS event emission |
| **Android `TtsStreamingService`** | Background thread → `OfflineTts.generate()` with JNI callback → `ChunkCoalescer` (16384 frames / 500ms) → base64-encode → emit `ttsStreamChunk` event |
| **iOS `SherpaOnnx+TTSStream.mm`** | `dispatch_async(global_queue)` → `wrapper->generateStream()` callback → coalesce buffer → `pcmToBase64()` → emit event |
| **sherpa-onnx C++ API** | `OfflineTts::Generate(text, sid, speed, callback)` — callback receives `(const float*, int32_t numSamples, float progress)`, returns `int32_t` (0 = cancel, >0 = continue) |
| **JS facade** | `createStreamingTTS()` → `StreamingTtsEngine` with `generateSpeechStream()` / `generateSpeechStreamToFile()` |
| **Incremental TTS** | JS-layer wrapper (`createIncrementalTTS`) that segments text via `pushText()` and queues `generateSpeechStream()` calls per segment |

### 2.2 Key observations

1. **sherpa-onnx generates synchronously per call** — `Generate(text, ...)` blocks until the full text is synthesized (with incremental callbacks for chunks). The native engine does **not** have a "feed text token-by-token" API.
2. **Chunk coalescing already exists** — both platforms batch small sherpa callbacks into larger chunks (16384 frames / 500ms). This reduces bridge traffic but doesn't eliminate it.
3. **"Online TTS" is a misnomer** — sherpa-onnx's TTS is always offline (full text → full audio). "Streaming" means chunked delivery during generation, not incremental text input.
4. **Incremental TTS is JS-level** — `IncrementalStreamingTtsEngine` splits text into segments in JS and queues separate `generateSpeechStream()` calls. This is the closest analog to "text segment input → audio output" but runs entirely in JS with bridge traffic.
5. **Voice cloning** requires reference audio + text; this is per-generation config, not per-pipeline config (can be set at pipeline start or per-segment).

### 2.3 Existing batch TTS (buffer-to-buffer, already done)

```ts
// Already implemented: offline text buffer → TTS → offline audio buffer
const tts = await createTTS({ modelPath, modelType });
await tts.synthesize(textBuffer, audioBuffer, { sid: 0, speed: 1.0 });
```

This uses `OfflineTextBuffer` → `OfflineAudioBuffer`. **Not suitable for pipeline chaining** because offline buffers are non-streaming (must complete before downstream can read).

---

## 3. Target architecture

### 3.1 `TtsPipelineWorker` — the core new component

```text
LiveTextBuffer (input)          TtsPipelineWorker              LiveAudioBuffer (output)
┌────────────────────┐    ┌───────────────────────────┐    ┌─────────────────────────┐
│ segments:          │    │ textCursor → drainSegments │    │ appendSamples(pcm)      │
│  #0: "Hello world."│───→│                            │───→│ [ring buffer of floats] │
│  #1: "How are you?"│    │ for each segment:          │    │                         │
│                    │    │   resolve sid/speed from   │    │ Downstream consumers:   │
│ partial: "I'm..."  │    │   segment.meta ?? defaults │    │  - Enhancement worker   │
│                    │    │   tts.Generate(text, cb)   │    │  - PCM Player consumer  │
│ appendListeners ───│────│→ CV wakeup when new segment│    │  - STT worker           │
└────────────────────┘    └───────────────────────────┘    └─────────────────────────┘
```

**Key design:**
- Worker creates a **text segment cursor** on the input `LiveTextBuffer`.
- Worker blocks (condition variable, via append listener) until new committed segments arrive.
- For each drained segment, worker resolves synthesis options from **per-segment metadata** (falls back to pipeline defaults), then calls `tts.Generate(segmentText, sid, speed, callback)`.
- The per-chunk callback from sherpa-onnx directly calls `outputEntry.appendSamples(pcm)` — **zero bridge traffic**.
- When input text buffer is finalized and all segments are drained, worker auto-stops.

### 3.2 Data flow: segments vs. partials (from STT spec decisions)

Following the resolved decisions from the STT spec (Q3, section 14):

| Text buffer path | Writer | Reader | TTS pipeline uses? |
| --- | --- | --- | --- |
| **Partial** (`writePartial`) | STT worker, JS | JS UI display | ❌ **No** — TTS only reads committed segments |
| **Segment log** (`commitSegment`) | STT worker endpoint, JS `appendLiveTextSegment` | TTS worker via cursor | ✅ **Yes** — each committed segment triggers synthesis |

**Rationale:** TTS should only synthesize finalized text, not in-progress hypotheses. A partial like "I'm curr" would produce garbled audio; only the committed "I'm currently at the store." should be synthesized. This matches STT spec decision Q3: append listeners fire **only on `commitSegment` and `finalize_`**.

### 3.3 Per-segment synthesis with metadata overrides

Since sherpa-onnx `Generate()` is a blocking call per text input, the TTS pipeline worker processes **one committed segment at a time**. Each segment can carry optional **synthesis hints** that override pipeline defaults:

```
while running:
  segments = drainSegments(cursorId, 1)
  if segments.empty:
    if input.finalized && no more segments: break
    wait on CV (append listener)
    continue

  segment = segments[0]
  if segment.text.isBlank(): continue

  // Resolve per-segment overrides (fall back to pipeline defaults)
  effectiveSid   = segment.meta?.sid   ?? pipelineDefaults.sid
  effectiveSpeed = segment.meta?.speed ?? pipelineDefaults.speed

  tts.Generate(segment.text, effectiveSid, effectiveSpeed, chunkCallback)
  // chunkCallback writes PCM to output LiveAudioBuffer
```

This enables use cases like narrator vs. character dialogue with different voices/speeds within a single pipeline.

### 3.4 Per-segment metadata: `LiveTextSegment.meta`

The existing `LiveTextSegment` type is extended with an optional `meta` field carrying an opaque JSON-serializable dictionary. The TTS pipeline worker interprets TTS-specific keys; other pipelines ignore them.

```ts
/** A committed text segment from a live text buffer segment log. */
export interface LiveTextSegment {
  text: string;
  source: LiveTextBufferPartialSource;
  segmentIndex: number;
  tokens?: string[];
  timestamps?: number[];
  /**
   * Opaque metadata dictionary attached to this segment.
   * Pipeline workers interpret feature-specific keys.
   * For TTS: { sid?: number; speed?: number; extra?: Record<string, string> }
   */
  meta?: Record<string, unknown>;
}
```

**Native representation:**
- **Android:** `TextSegment.meta: Map<String, Any?>?` — nullable map, serialized/deserialized as `ReadableMap` when crossing the bridge.
- **iOS:** `TextSegment.meta: std::optional<std::unordered_map<std::string, id>>` — nullable map.

**TurboModule extension:**
```ts
/** Commit a text segment to a live text buffer, with optional metadata. */
appendLiveTextSegment(
  liveBufferId: string,
  text: string,
  tokens?: string[],
  timestamps?: number[],
  meta?: Object,            // ← NEW: opaque metadata dictionary
): Promise<{ segmentIndex: number }>;

/** Read segments: meta is included when present. */
getLiveTextBufferSegments(
  liveBufferId: string,
  startIndex: number,
  maxCount: number,
  options?: {
    includeTokens?: boolean;
    includeTimestamps?: boolean;
    includeMeta?: boolean;    // ← NEW: default false
  },
): Promise<{
  segments: Array<{
    text: string;
    source: string;
    segmentIndex: number;
    tokens?: string[];
    timestamps?: number[];
    meta?: Object;            // ← NEW: present when includeMeta: true
  }>;
}>;
```

**TTS-specific meta keys** (interpreted by `TtsPipelineWorker`):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sid` | `number` | Pipeline default | Speaker ID for this segment |
| `speed` | `number` | Pipeline default | Speed multiplier for this segment |
| `extra` | `Record<string, string>` | `undefined` | Model-specific extra params |

**Usage example (per-segment speaker switching):**
```ts
await appendLiveTextSegment(textBuf, 'Narrator: The story begins.', [], [], { sid: 0, speed: 1.0 });
await appendLiveTextSegment(textBuf, 'Hello! said the character.', [], [], { sid: 3, speed: 1.2 });
```

### 3.5 TypeScript API

```ts
import {
  createStreamingTTS,
  createLiveTextBuffer,
  createLiveAudioBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx';

// 1. Create TTS engine (pipeline-only, no legacy streaming methods)
const tts = await createStreamingTTS({
  modelPath: { type: 'asset', path: 'models/vits-piper-en' },
  modelType: 'vits',
});

// 2. Create buffers
const textIn = await createLiveTextBuffer({ maxSegments: 100 });
const audioOut = await createLiveAudioBuffer({ sampleRate: 22050 });

// 3. Start native pipeline (voice cloning set once at pipeline start)
const pipeline = await tts.synthesize(textIn, audioOut, {
  sid: 0,
  speed: 1.0,
  // voiceClone: { kind: 'pocket', referenceAudio: offlineBuffer }  // optional
});

// 4. Feed text (from JS or upstream pipeline)
await appendLiveTextSegment(textIn, 'Hello world.');
await appendLiveTextSegment(textIn, 'How are you?');
// Per-segment override:
await appendLiveTextSegment(textIn, 'I am a different voice.', [], [], { sid: 3, speed: 0.8 });

// TTS worker synthesizes each segment as it arrives,
// writing PCM directly to audioOut.
// Downstream enhancement/playback can start immediately.

// 5. Stop
await finalizeLiveTextBuffer(textIn.bufferId);  // TTS worker drains remaining, then auto-stops
await pipeline.stop();                           // Or wait for auto-stop

// 6. Finalize audio output (caller decides when)
await finalizeLiveAudioBuffer(audioOut.bufferId);
```

### 3.6 Full STT → TTS pipeline

```ts
const micBuf  = await createLiveAudioBuffer({ sampleRate: 16000 });
const textBuf = await createLiveTextBuffer();
const ttsBuf  = await createLiveAudioBuffer({ sampleRate: 22050 });

const stt = await createStreamingSTT({ modelPath, modelType: 'transducer', enableEndpoint: true });
const tts = await createStreamingTTS({ modelPath: ttsModelPath, modelType: 'vits' });

const p1 = await stt.transcribe(micBuf, textBuf);
const p2 = await tts.synthesize(textBuf, ttsBuf, { sid: 0, speed: 1.0 });

await startMicToLiveAudioBuffer(micBuf.bufferId);
// Mic → STT → textBuf (committed segments) → TTS → ttsBuf (PCM audio)
// STT writes committed segments on endpoint → TTS starts synthesizing immediately.
// True parallel processing: TTS produces audio while STT is still recognizing.
```

### 3.7 Full pipeline: STT → TTS → Enhancement → STT round-trip

```ts
const micBuf      = await createLiveAudioBuffer({ sampleRate: 16000 });
const textBuf1    = await createLiveTextBuffer();
const ttsBuf      = await createLiveAudioBuffer({ sampleRate: 22050 });
const enhancedBuf = await createLiveAudioBuffer({ sampleRate: 22050 });
const textBuf2    = await createLiveTextBuffer();

const stt1    = await createStreamingSTT({ ... });
const tts     = await createStreamingTTS({ ... });
const denoiser = await createStreamingEnhancement({ ... });
const stt2    = await createStreamingSTT({ ... });

const p1 = await stt1.transcribe(micBuf, textBuf1);
const p2 = await tts.synthesize(textBuf1, ttsBuf, { sid: 0 });
const p3 = await denoiser.enhance(ttsBuf, enhancedBuf);
const p4 = await stt2.transcribe(enhancedBuf, textBuf2);

await startMicToLiveAudioBuffer(micBuf.bufferId);
// Five native threads in parallel, zero JS bridge traffic for data.
```

---

## 4. `LiveTextSegment.meta` extension (both platforms)

### 4.1 Android: `LiveTextEntry.TextSegment`

```kotlin
data class TextSegment(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val source: String,
  val segmentIndex: Int,
  val meta: Map<String, Any?>? = null,  // ← NEW
)
```

**`commitSegment` updated:**
```kotlin
fun commitSegment(
  text: String,
  tokens: Array<String> = emptyArray(),
  timestamps: FloatArray = floatArrayOf(),
  source: String = "unknown",
  meta: Map<String, Any?>? = null,   // ← NEW
)
```

### 4.2 iOS: `TxtLiveEntry::TextSegment`

```cpp
struct TextSegment {
  std::string text;
  std::vector<std::string> tokens;
  std::vector<float> timestamps;
  std::string source;
  int segmentIndex;
  NSDictionary *meta = nil;   // ← NEW: nullable ObjC dictionary for bridge compat
};
```

**`commitSegment` updated:**
```cpp
void commitSegment(const std::string &text,
                   const std::vector<std::string> &tokens = {},
                   const std::vector<float> &timestamps = {},
                   const std::string &source = "unknown",
                   NSDictionary *meta = nil);
```

---

## 5. Breaking changes: removed legacy streaming TTS APIs

### 5.1 TurboModule methods removed

The following TurboModule methods are **removed entirely** (same approach as STT migration):

```ts
// ==================== REMOVE ====================
generateTtsStream(instanceId, requestId, text, options): Promise<void>;
generateTtsStreamToFile(instanceId, requestId, text, options, fileOptions): Promise<void>;
cancelTtsStream(instanceId): Promise<void>;
```

### 5.2 Native code removed

| Platform | Removed |
| --- | --- |
| **Android** | `TtsStreamingService.kt` (ChunkCoalescer, base64 encoding, event emission), streaming methods in `SherpaOnnxOnlineTtsHelper.kt`, `TtsJniCallbackFactory.ttsStreamChunkCallbackForJni()` (legacy JNI boxing shim) |
| **iOS** | `so_generateTtsStream:`, `so_generateTtsStreamToFile:`, `so_cancelTtsStream:` in `SherpaOnnx+TTSStream.mm`, `pcmToBase64()` helper, coalesce buffer logic |

### 5.3 TypeScript types / interfaces removed

```ts
// ── REMOVED from src/tts/types.ts ──
TtsStreamChunk
TtsStreamEnd
TtsStreamError
TtsStreamHandlers
TtsStreamController           // incl. player: PcmPlayer | null
TtsStreamOptions              // playback, emitChunks, autoDestroy
TtsStreamToFileOptions
TtsStreamToFileHandlers
TtsStreamFileController
TtsStreamFileEnd
TtsStreamFileError

// ── REMOVED from src/tts/streamingTypes.ts ──
StreamingTtsEngine            // replaced by StreamingTtsEngine (pipeline-only, renamed type)
```

### 5.4 TTS-bound playback removed

The TTS-specific playback orchestration is removed:
- `playback: true` option in `generateSpeechStream*`
- TTS-bound `PcmPlayer` proxy on `TtsStreamController`
- `autoDestroy` lifecycle
- event-based chunk → player forwarding

**Playback is now a separate pipeline consumer.** The existing `PcmPlayer` / PCM player infrastructure remains in the SDK, but is decoupled from TTS. A dedicated spec for `LiveAudioBuffer → PcmPlayer` (buffer-draining playback consumer) is a separate task.

### 5.5 JS event emission removed

The following `DeviceEventEmitter` event types are no longer emitted by native:
- `ttsStreamChunk`
- `ttsStreamEnd`
- `ttsStreamError`
- `ttsStreamFileEnd`
- `ttsStreamFileError`

### 5.6 Base64 encoding path removed

The entire base64 PCM encoding/decoding path (`pcmToBase64` on iOS, base64-encode on Android, `decodeBase64ToPcm` / `base64ToBytes` in JS) is no longer needed for TTS streaming. Audio stays native.

---

## 6. `IncrementalStreamingTtsEngine` — pipeline-adapted

The `IncrementalStreamingTtsEngine` is adapted to use the pipeline internally. The JS-level text segmentation (`pushText()` → boundary detection → commit) remains, but audio output goes to a `LiveAudioBuffer` instead of JS events. No bridge traffic for audio data.

### 6.1 Updated interface

```ts
// ── src/tts/incremental/types.ts (updated) ──

import type { LiveTextBufferIdSource } from '../../textbuffer/types';
import type { LiveAudioBufferIdSource } from '../../audiobuffer/types';
import type { TtsPipelineHandle, TtsPipelineOptions } from '../streamingTypes';

export interface IncrementalStreamingTtsFactoryOptions {
  /** Existing streaming engine or options to create one. */
  source: IncrementalStreamingTtsSource;
  /** Default segmentation policy (can be overridden per request). */
  segmentation?: SegmentationPolicy;
  /** Default queue policy (can be overridden per request). */
  queue?: QueuePolicy;
}

export interface IncrementalStreamingTtsEngine {
  readonly instanceId: string;

  /**
   * Start an incremental speech synthesis session.
   *
   * Internally creates (or accepts) a LiveTextBuffer, starts a TTS pipeline to the
   * given audioOut buffer, and returns a controller for pushing text incrementally.
   *
   * Text segmentation happens in JS (pushText → boundary detection → commitSegment).
   * Audio synthesis happens entirely in native (TTS pipeline worker → LiveAudioBuffer).
   * Zero bridge traffic for audio data.
   *
   * @param audioOut - Target live audio buffer for synthesized PCM
   * @param ttsOptions - Pipeline-level TTS options (sid, speed, voiceClone)
   * @param incrementalOptions - Segmentation and queue policies
   */
  startSession(
    audioOut: LiveAudioBufferIdSource,
    ttsOptions?: TtsPipelineOptions,
    incrementalOptions?: IncrementalRequestOptions,
  ): Promise<IncrementalStreamController>;

  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;
  destroy(): Promise<void>;
}
```

### 6.2 Updated controller

```ts
export interface IncrementalStreamController {
  /**
   * Push incremental text. May trigger auto-segmentation.
   * Detected segments are committed to the internal LiveTextBuffer
   * via appendLiveTextSegment() — the TTS pipeline worker picks them up natively.
   */
  pushText(text: string): void;

  /**
   * Push text with per-segment synthesis hints.
   * When a segment boundary is detected, the provided meta is attached
   * to the committed segment for the TTS worker to use.
   */
  pushText(text: string, meta?: { sid?: number; speed?: number }): void;

  /** Force-commit the current buffer as a segment. */
  commit(options?: CommitOptions): void;

  /** Commit remainder and wait until all segments are synthesized. */
  flush(options?: FlushOptions): Promise<void>;

  /** Cancel: stop pipeline, discard queued segments. */
  cancel(options?: CancelOptions): Promise<void>;

  /** Current metrics snapshot (segments queued, completed, dropped, etc.). */
  getMetrics(): IncrementalMetrics;

  /** The underlying TTS pipeline handle (for getStatus(), etc.). */
  readonly pipeline: TtsPipelineHandle;

  /** The internal LiveTextBuffer used for segmented text input. */
  readonly textBuffer: { bufferId: string };

  /** Current session state. */
  readonly state: SessionState;
}
```

### 6.3 Internal data flow

```text
pushText("Hello world. How are you?")
  ↓ JS segmentation (boundary detection)
  → commitSegment("Hello world.") ──→ LiveTextBuffer (native)
  → commitSegment("How are you?") ──→ LiveTextBuffer (native)
                                          ↓
                                    TtsPipelineWorker (native thread)
                                          ↓ drainSegments → Generate() → callback
                                    LiveAudioBuffer (native)
                                          ↓
                                    [downstream: PCM Player, Enhancement, STT, ...]
```

Only the `pushText()` calls and `commitSegment()` bridge calls cross JS ↔ native. Audio data stays entirely native. The `commitSegment` calls are lightweight (text string + optional metadata, no binary audio data).

### 6.4 Removed from IncrementalStreamingTtsEngine

| Removed | Reason |
| --- | --- |
| `generateIncrementalSpeechStream()` | Replaced by `startSession(audioOut)` |
| `generateIncrementalSpeechStreamToFile()` | Use pipeline + WAV export from `LiveAudioBuffer` instead |
| `onChunk` / `TtsStreamChunk` handlers | No chunk events; audio stays native |
| `player: PcmPlayer` on controller | No TTS-bound playback; use separate PCM Player consumer |
| `TtsStreamOptions` (playback, emitChunks, autoDestroy) | No longer applicable |

---

## 7. Migration plan (phases)

| Phase | Work | Depends on |
| --- | --- | --- |
| **P0** | This spec (done). | — |
| **P1** | **`LiveTextSegment.meta` extension:** Add optional `meta` field to `TextSegment` on Android (`LiveTextEntry.kt`) and iOS (`TxtLiveEntry`). Update `commitSegment()` to accept `meta`. Update `appendLiveTextSegment` TurboModule method to accept `meta` parameter. Update `getLiveTextBufferSegments` to support `includeMeta` option. Update TypeScript `LiveTextSegment` type. | — |
| **P2** | **`TtsPipelineWorker` (Android):** New `TtsPipelineWorker.kt` implementing `StreamingPipelineWorker`. Text segment cursor on input `LiveTextEntry`, resolve per-segment `sid`/`speed` from `segment.meta` with pipeline defaults as fallback, `tts.Generate()` per segment with chunk callback writing to output `LiveEntry` (audio). Command queue for flush/reset. Register in `StreamingPipelineRegistry`. Wire `startTtsPipeline` into `SherpaOnnxModule`. | P1 |
| **P3** | **`TtsPipelineWorker` (iOS):** Mirror P2 — `TtsPipelineWorker.h/.mm` implementing `StreamingPipelineWorker`. `std::thread` + `std::condition_variable`. Same segment-by-segment approach with per-segment meta resolution. | P1 |
| **P4** | **TurboModule:** Add `startTtsPipeline(instanceId, textInLiveBufferId, audioOutLiveBufferId, options?)` → `{ pipelineId }`. **Remove** `generateTtsStream`, `generateTtsStreamToFile`, `cancelTtsStream`. Reuse generic `stop/flush/reset/getStreamingPipelineStatus`. | P2, P3 |
| **P5** | **TypeScript types + facade:** `StreamingTtsEngine` interface (pipeline-only, replaces old `StreamingTtsEngine`). `TtsPipelineHandle` extends `StreamingPipelineHandle`. `TtsPipelineOptions`. Update `createStreamingTTS()` return type. Remove legacy streaming types (`TtsStreamChunk`, `TtsStreamController`, `TtsStreamOptions`, etc.). Remove base64 decode helpers. Remove `DeviceEventEmitter` subscriptions for TTS events. | P4 |
| **P6** | **IncrementalStreamingTtsEngine rewrite:** Adapt `createIncrementalTTS()` to use pipeline internally. `startSession(audioOut)` creates internal `LiveTextBuffer` + starts pipeline. `pushText()` → segmentation → `appendLiveTextSegment()`. Remove chunk/player/event handlers. | P5 |
| **P7** | **Native cleanup:** Remove `TtsStreamingService.kt` (Android), `ChunkCoalescer`, `TtsJniCallbackFactory.ttsStreamChunkCallbackForJni()`, base64 encoding. Remove `so_generateTtsStream:` / `so_generateTtsStreamToFile:` / `so_cancelTtsStream:` from iOS. Remove `pcmToBase64()` and coalesce buffer logic. Remove TTS-bound `PcmPlayer` proxy logic. | P4, P5 |
| **P8** | **Example app:** Update TTS screen to pipeline mode (text input → live text buffer → TTS pipeline → live audio buffer). Remove legacy streaming UI. | P6 |
| **P9** | **Documentation:** Rewrite `docs/tts-streaming.md` for pipeline model. | P8 |

---

## 8. `TtsPipelineWorker` — detailed design

### 8.1 Android: `TtsPipelineWorker.kt`

```kotlin
class TtsPipelineWorker(
  override val pipelineId: String,
  private val ttsInstance: TtsEngineInstance,
  private val inputEntry: LiveTextEntry,           // LiveTextBuffer (text input)
  private val outputEntry: LiveEntry,              // LiveAudioBuffer (audio output)
  private val defaultSid: Int = 0,
  private val defaultSpeed: Float = 1.0f,
  private val voiceClone: VoiceCloneConfig? = null, // Set once at pipeline start
) : StreamingPipelineWorker {

  private val executor = Executors.newSingleThreadExecutor()
  override var isRunning: Boolean = false

  private var chunksProcessed = 0L
  private var unitsRead = 0L       // characters consumed
  private var unitsWritten = 0L    // audio samples produced
  private var error: String? = null

  private var textCursorId: Int = -1
  private var appendListenerToken: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable: Condition = lock.newCondition()
  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  override fun start() {
    isRunning = true
    textCursorId = inputEntry.createSegmentCursor()

    appendListenerToken = inputEntry.addAppendListener {
      lock.withLock { dataAvailable.signal() }
    }

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val sampleRate = ttsInstance.dispatchSampleRate()
    try {
      while (isRunning) {
        processCommands()

        val segments = inputEntry.drainSegments(textCursorId, 1)
        if (segments.isEmpty()) {
          if (inputEntry.state == LiveTextEntry.State.FINISHED) {
            isRunning = false
            break
          }
          lock.withLock { dataAvailable.await(50, TimeUnit.MILLISECONDS) }
          continue
        }

        val segment = segments[0]
        if (segment.text.isBlank()) continue

        unitsRead += segment.text.length

        // Resolve per-segment overrides from meta, fall back to pipeline defaults
        val effectiveSid = (segment.meta?.get("sid") as? Number)?.toInt() ?: defaultSid
        val effectiveSpeed = (segment.meta?.get("speed") as? Number)?.toFloat() ?: defaultSpeed

        // Chunk callback: write PCM directly to output buffer (zero bridge traffic)
        val chunkCallback = TtsJniCallbackFactory.ttsStreamChunkCallbackForJni(
          cancelled = AtomicBoolean(false).also { flag ->
            // Link to isRunning: when worker stops, callback returns 0
          }
        ) { samples ->
          if (!isRunning) return@ttsStreamChunkCallbackForJni
          outputEntry.appendSamples(samples, sampleRate, LIVE_APPEND_SOURCE_TTS)
          unitsWritten += samples.size
        }

        // Dispatch synthesis (blocking per segment)
        if (voiceClone != null) {
          val config = GenerationConfig(
            sid = effectiveSid,
            speed = effectiveSpeed,
            referenceAudio = voiceClone.referenceAudio,
            referenceSampleRate = voiceClone.referenceSampleRate,
            referenceText = voiceClone.referenceText,
            silenceScale = voiceClone.silenceScale,
            numSteps = voiceClone.numSteps,
            extra = (segment.meta?.get("extra") as? Map<String, String>) ?: emptyMap(),
          )
          ttsInstance.tts?.generateWithConfig(segment.text, config, chunkCallback)
        } else {
          ttsInstance.tts?.generate(segment.text, effectiveSid, effectiveSpeed, chunkCallback)
        }

        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message
      isRunning = false
    } finally {
      inputEntry.releaseSegmentCursor(textCursorId)
      inputEntry.removeAppendListener(appendListenerToken)
      executor.shutdown()
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            // Drain and synthesize all remaining segments
            while (true) {
              val remaining = inputEntry.drainSegments(textCursorId, 1)
              if (remaining.isEmpty()) break
              val seg = remaining[0]
              if (seg.text.isBlank()) continue
              val sid = (seg.meta?.get("sid") as? Number)?.toInt() ?: defaultSid
              val spd = (seg.meta?.get("speed") as? Number)?.toFloat() ?: defaultSpeed
              // ... synthesize as in runLoop ...
            }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            // Advance cursor past all available segments (discard unprocessed)
            while (inputEntry.drainSegments(textCursorId, 100).isNotEmpty()) { /* skip */ }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  override fun stop() {
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    executor.shutdown()
    executor.awaitTermination(5, TimeUnit.SECONDS)
  }

  override fun flush(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Flush(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Reset(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun getStatus() = StreamingPipelineStatus(
    isRunning = isRunning,
    chunksProcessed = chunksProcessed,
    unitsRead = unitsRead,
    unitsWritten = unitsWritten,
    error = error,
  )

  override fun release() { stop() }
}
```

### 8.2 iOS: `TtsPipelineWorker`

Mirror Android using `std::thread` + `std::condition_variable`:

```cpp
class TtsPipelineWorker : public StreamingPipelineWorker {
  std::shared_ptr<sherpaonnx::TtsWrapper> wrapper;
  std::shared_ptr<TxtLiveEntry> inputEntry;     // LiveTextBuffer (text input)
  std::shared_ptr<PaLiveEntry> outputEntry;     // LiveAudioBuffer (audio output)
  int32_t defaultSid;
  float defaultSpeed;
  std::optional<VoiceCloneOptions> voiceClone;  // Set once at pipeline start

  std::thread workerThread;
  std::mutex mtx;
  std::condition_variable cv;
  int textCursorId = -1;
  int appendListenerToken = -1;

  // Command queue
  std::deque<std::variant<FlushCmd, ResetCmd>> commandQueue;
  std::mutex cmdMutex;

  void runLoop() {
    int sampleRate = wrapper->getSampleRate();
    while (running.load()) {
      processCommands();

      auto segments = inputEntry->drainSegments(textCursorId, 1);
      if (segments.empty()) {
        if (inputEntry->state == TxtLiveEntry::FINISHED) {
          running.store(false);
          break;
        }
        std::unique_lock<std::mutex> lk(mtx);
        cv.wait_for(lk, std::chrono::milliseconds(50));
        continue;
      }

      auto &seg = segments[0];
      if (seg.text.empty()) continue;

      unitsRead += seg.text.size();

      // Resolve per-segment meta overrides
      int32_t effectiveSid = defaultSid;
      float effectiveSpeed = defaultSpeed;
      if (seg.meta) {
        if (NSNumber *sidVal = seg.meta[@"sid"]) effectiveSid = sidVal.intValue;
        if (NSNumber *spdVal = seg.meta[@"speed"]) effectiveSpeed = spdVal.floatValue;
      }

      // Chunk callback: write PCM directly to audio output buffer
      auto callback = [this, sampleRate](const float *samples, int32_t n, float) -> int32_t {
        if (!running.load()) return 0;
        outputEntry->appendSamples(samples, n, sampleRate, "tts");
        unitsWritten += n;
        return n;
      };

      if (voiceClone.has_value()) {
        wrapper->generateStream(seg.text, effectiveSid, effectiveSpeed, callback, voiceClone);
      } else {
        wrapper->generateStream(seg.text, effectiveSid, effectiveSpeed, callback);
      }
      chunksProcessed++;
    }
    // Cleanup: release cursor, remove listener
  }
};
```

### 8.3 `StreamingPipelineStatus` field semantics for TTS

| Field | Meaning for TTS pipeline |
| --- | --- |
| `chunksProcessed` | Number of text segments fully synthesized |
| `unitsRead` | Total characters consumed from text segments |
| `unitsWritten` | Total audio samples written to output buffer |
| `error` | Error message if worker crashed |

### 8.4 New source constant

```kotlin
// Android
const val LIVE_APPEND_SOURCE_TTS = "tts"
```

```cpp
// iOS
static const char *kLiveAppendSourceTts = "tts";
```

```ts
// TypeScript (src/audiobuffer/types.ts)
export type LiveBufferAppendSource =
  | 'mic'
  | 'append'
  | 'append_offline'
  | 'enhancement'
  | 'tts'             // ← NEW
  | 'unknown'
  | 'mixed';
```

---

## 9. TurboModule changes

### 9.1 Added

```ts
// ── src/NativeSherpaOnnx.ts ──

/**
 * Start a streaming TTS pipeline worker.
 * Reads committed segments from a LiveTextBuffer, synthesizes each one
 * (using per-segment meta overrides where available), and writes PCM
 * samples to a LiveAudioBuffer.
 */
startTtsPipeline(
  instanceId: string,
  textInLiveBufferId: string,
  audioOutLiveBufferId: string,
  options?: {
    sid?: number;
    speed?: number;
    // Voice cloning (set once for all segments)
    voiceCloneKind?: string;            // 'zipvoice' | 'pocket'
    referenceAudioBufferId?: string;    // OfflineAudioBuffer with reference audio
    referenceText?: string;
    silenceScale?: number;
    numSteps?: number;
  },
): Promise<{ pipelineId: string }>;
```

### 9.2 Updated (meta support on LiveTextBuffer)

```ts
appendLiveTextSegment(
  liveBufferId: string,
  text: string,
  tokens?: string[],
  timestamps?: number[],
  meta?: Object,                 // ← NEW parameter
): Promise<{ segmentIndex: number }>;

getLiveTextBufferSegments(
  liveBufferId: string,
  startIndex: number,
  maxCount: number,
  options?: {
    includeTokens?: boolean;
    includeTimestamps?: boolean;
    includeMeta?: boolean;       // ← NEW option
  },
): Promise<{
  segments: Array<{
    text: string;
    source: string;
    segmentIndex: number;
    tokens?: string[];
    timestamps?: number[];
    meta?: Object;               // ← present when includeMeta: true
  }>;
}>;
```

### 9.3 Removed

```ts
// ==================== REMOVE (legacy streaming TTS bridge methods) ====================
generateTtsStream(instanceId, requestId, text, options): Promise<void>;
generateTtsStreamToFile(instanceId, requestId, text, options, fileOptions): Promise<void>;
cancelTtsStream(instanceId): Promise<void>;
```

### 9.4 Reused (generic pipeline control)

```ts
stopStreamingPipeline(pipelineId: string): Promise<void>;
flushStreamingPipeline(pipelineId: string): Promise<void>;
resetStreamingPipeline(pipelineId: string): Promise<void>;
getStreamingPipelineStatus(pipelineId: string): Promise<{
  pipelineId: string;
  isRunning: boolean;
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  error: string | null;
}>;
```

---

## 10. TypeScript types (concrete)

### 10.1 `src/tts/streamingTypes.ts` — pipeline-only

```ts
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';
import type { TtsVoiceClone, TTSModelInfo, TTSInitializeOptions } from './types';

// Re-export types that are still needed
export type { TTSModelInfo } from './types';

/** TTS-specific pipeline handle. Extends generic StreamingPipelineHandle. */
export interface TtsPipelineHandle extends StreamingPipelineHandle {
  /** The TTS engine instance driving this pipeline. */
  readonly instanceId: string;
}

/** Options for starting a TTS pipeline (passed to synthesize()). */
export interface TtsPipelineOptions {
  /** Speaker ID. Default: 0. Overridable per-segment via meta.sid. */
  sid?: number;
  /** Speed multiplier. Default: 1.0. Overridable per-segment via meta.speed. */
  speed?: number;
  /**
   * Voice cloning configuration. Set once for the entire pipeline.
   * Applies to all segments (cloning reference audio is loaded once on pipeline start).
   * Uses OfflineAudioBuffer reference (same as batch synthesis).
   */
  voiceClone?: TtsVoiceClone;
}

/**
 * Streaming TTS engine returned by `createStreamingTTS()`.
 * Pipeline-only — no legacy event-based streaming methods.
 *
 * **Naming in docs:** **`tts`** is the value returned by `createStreamingTTS()`.
 * **`pipeline`** is the handle returned by `tts.synthesize(...)`.
 */
export interface StreamingTtsEngine {
  readonly instanceId: string;

  /**
   * Start a native streaming TTS pipeline.
   *
   * A dedicated background worker thread drains committed text segments from
   * `textIn` via cursor, resolves per-segment `sid`/`speed` from
   * `segment.meta` (falling back to `options` defaults), synthesizes each
   * segment via the TTS engine, and writes PCM samples to `audioOut`.
   *
   * - `textIn` must be a live text buffer in `recording` state.
   * - `audioOut` must be a live audio buffer in `recording` state.
   * - `audioOut.sampleRate` must equal the TTS model's output sample rate (strict).
   * - Only one pipeline per TTS instance at a time.
   *
   * Returns a handle to control and inspect the running pipeline.
   */
  synthesize(
    textIn: LiveTextBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options?: TtsPipelineOptions,
  ): Promise<TtsPipelineHandle>;

  /** Model sample rate and number of speakers. */
  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;

  /**
   * Destroy the engine. Stops any running pipeline first.
   * Do not use the engine after this.
   */
  destroy(): Promise<void>;
}
```

### 10.2 `src/textbuffer/types.ts` — updated `LiveTextSegment`

```ts
/** A committed text segment from a live text buffer segment log. */
export interface LiveTextSegment {
  text: string;
  source: LiveTextBufferPartialSource;
  segmentIndex: number;
  tokens?: string[];
  timestamps?: number[];
  /**
   * Opaque metadata dictionary attached to this segment.
   * Pipeline workers interpret feature-specific keys and fall back to pipeline defaults.
   *
   * TTS worker keys: { sid?: number; speed?: number; extra?: Record<string, string> }
   */
  meta?: Record<string, unknown>;
}
```

### 10.3 `src/audiobuffer/types.ts` — updated `LiveBufferAppendSource`

```ts
export type LiveBufferAppendSource =
  | 'mic'
  | 'append'
  | 'append_offline'
  | 'enhancement'
  | 'tts'               // ← NEW: audio produced by TTS pipeline worker
  | 'unknown'
  | 'mixed';
```

---

## 11. Behavioral contracts

### 11.1 One pipeline per engine instance

Same as STT: `synthesize()` rejects with `TTS_PIPELINE_ALREADY_RUNNING` if a pipeline is active on this engine instance. `destroy()` calls `stop()` on any running pipeline first.

### 11.2 Sample rate validation

`startTtsPipeline` validates that `outputBuffer.sampleRate === ttsModel.sampleRate`. Rejects with `TTS_PIPELINE_SAMPLE_RATE_MISMATCH` on mismatch. Same strict approach as STT/Enhancement. No hidden resampling.

### 11.3 Input finalization → auto-drain + auto-stop

When the input text buffer transitions to `FINISHED`:
1. Worker drains all remaining committed segments.
2. Worker synthesizes each remaining segment.
3. Worker exits its loop (`isRunning = false`).
4. Output audio buffer is **not** auto-finalized (caller decides when).

### 11.4 Flush semantics (blocking)

`flush()` on the TTS pipeline handle:
- If a segment is currently being synthesized, wait for it to complete.
- Drain and synthesize all remaining queued segments.
- Promise resolves when all current segments are processed.
- Pipeline **continues running** after flush.

### 11.5 Reset semantics (blocking)

`reset()` on the TTS pipeline handle:
- Discards any queued (unprocessed) segments by advancing the cursor past all available.
- If a segment is currently being synthesized, it completes (no mid-generation cancel on reset).
- Pipeline **continues running** — subsequent segments are processed normally.

### 11.6 Worker wait strategy (condition variable)

Same as STT/Enhancement:
- Worker waits on CV when no committed segments available.
- `LiveTextEntry.commitSegment()` + `finalize_()` signal via append listener.
- 50ms safety timeout (slightly higher than STT's 10ms since TTS segments arrive less frequently).
- Zero-latency wakeup on new committed segment.

### 11.7 Cancellation mid-generation

When `stop()` is called while a segment is being synthesized:
- The chunk callback checks `isRunning` and returns `0` (cancel signal to sherpa-onnx).
- sherpa-onnx aborts the current generation.
- Partial audio already written to the output buffer remains (it's a valid prefix of the segment's audio).
- Worker thread exits cleanly.

### 11.8 Voice cloning: set once at pipeline start

Voice cloning reference audio (`referenceAudioBufferId`) is resolved once when `startTtsPipeline` is called. The worker loads the reference samples from the `OfflineAudioBuffer` into memory and reuses them for every `Generate()` call. This avoids re-reading reference audio per segment.

If `voiceClone` is set in `TtsPipelineOptions`, all segments are synthesized with cloning. Per-segment `meta.sid` / `meta.speed` still apply as overrides.

### 11.9 Per-segment metadata resolution

For each committed segment, the worker resolves synthesis options:

```
effectiveSid   = segment.meta.sid   ?? pipelineOptions.sid   ?? 0
effectiveSpeed = segment.meta.speed ?? pipelineOptions.speed ?? 1.0
extra          = segment.meta.extra ?? {}
```

The `meta` field is **opaque** at the buffer level — the TTS worker interprets known keys, ignores unknown ones. Other pipeline workers (STT, Enhancement) never read `meta`.

### 11.10 Progress tracking

The TTS pipeline does **not** emit JS events during steady-state. Progress is observable via:
- `getStatus()` → `unitsRead` (chars consumed), `unitsWritten` (samples produced), `chunksProcessed` (segments completed).
- JS polling interval.
- Native downstream consumers observe data arrival on the output `LiveAudioBuffer` via append listeners.

---

## 12. Errors

| Code | Meaning |
| --- | --- |
| `TTS_PIPELINE_ALREADY_RUNNING` | `synthesize()` called while a pipeline on this engine is already active |
| `TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND` | Input live text buffer ID not found in text pipeline registry |
| `TTS_PIPELINE_AUDIO_BUFFER_NOT_FOUND` | Output live audio buffer ID not found in audio pipeline registry |
| `TTS_PIPELINE_BUFFER_KIND_MISMATCH` | Non-live buffer passed (must be `live_*` / `txt_live_*`) |
| `TTS_PIPELINE_BUFFER_NOT_RECORDING` | Buffer already finalized; cannot start pipeline on it |
| `TTS_PIPELINE_SAMPLE_RATE_MISMATCH` | Output buffer's `sampleRate` ≠ TTS model's output sample rate |
| `TTS_PIPELINE_VOICE_CLONE_REF_NOT_FOUND` | `referenceAudioBufferId` not found in offline audio registry |
| `TTS_PIPELINE_VOICE_CLONE_UNSUPPORTED` | Voice cloning requested but model type does not support it |
| `STREAMING_PIPELINE_NOT_FOUND` | Generic: `pipelineId` not found (stop/flush/reset/status) |
| `STREAMING_PIPELINE_ERROR` | Generic: worker thread crashed |

---

## 13. Resolved design decisions

All questions have been resolved. Decisions are documented here for traceability.

### Q1: Voice cloning in pipeline mode → **Set once at pipeline start (Option A)**

Reference audio is resolved once from an `OfflineAudioBuffer` when `startTtsPipeline` is called. Worker holds reference samples in memory and reuses them for every `Generate()` call. Per-segment voice switching is not supported (would require different reference audio per segment, which is a fundamentally different use case — use separate pipeline instances for different voices if needed).

### Q2: Factory function and API surface → **Remove all legacy methods. Keep `createStreamingTTS()` name.**

Same approach as STT migration: `createStreamingTTS()` returns a `StreamingTtsEngine` that is **pipeline-only**. All legacy bridge-based methods (`generateSpeechStream`, `generateSpeechStreamToFile`, `cancelTtsStream`) are removed entirely — from TypeScript types, TurboModule spec, and native implementations on both platforms. Users must use the pipeline API (`synthesize(textIn, audioOut)`). No data flows through JS for audio during steady-state.

### Q3: Per-segment synthesis options → **Per-segment overrides via `LiveTextSegment.meta` (Option B)**

`LiveTextSegment` is extended with an optional `meta: Record<string, unknown>` field. The TTS worker reads `meta.sid`, `meta.speed`, `meta.extra` and falls back to pipeline defaults. This enables use cases like multi-voice narration or per-segment speed control within a single pipeline. The `meta` field is opaque at the buffer level — pipeline workers interpret their own keys.

### Q4: IncrementalStreamingTtsEngine → **Adapt to pipeline internally (Option B)**

`IncrementalStreamingTtsEngine` is rewritten to use the pipeline API internally. `pushText()` → JS segmentation → `appendLiveTextSegment()` → native TTS worker synthesizes → `LiveAudioBuffer`. Audio never crosses the bridge. The old event-based methods (`generateIncrementalSpeechStream`, chunk handlers, player proxy) are removed. New entry point: `startSession(audioOut, ttsOptions?, incrementalOptions?)`.

### Q5: Output audio buffer finalization → **No auto-finalize (Option A)**

Same as STT. The caller explicitly finalizes the output audio buffer. This gives callers control over when downstream consumers see the "finished" state — essential for pipeline chains where one stage's output feeds the next stage's input.

### Q6: Legacy streaming APIs → **Remove entirely (Option B)**

All legacy streaming TTS bridge methods are removed. Pipeline-only, same as STT migration. This eliminates:
- Base64 PCM encoding/decoding overhead
- `DeviceEventEmitter` event emission for TTS chunks
- TTS-bound playback orchestration (`playback: true`, player proxy, `autoDestroy`)
- Dual code paths (legacy + pipeline)

### Q7: Playback integration → **TTS is strictly a producer; playback is a separate consumer**

TTS contains no built-in playback orchestration. The pipeline model is:
`LiveTextBuffer → StreamingTTS → LiveAudioBuffer → [PCM Player consumer]`

The existing `PcmPlayer` infrastructure remains in the SDK but is decoupled from TTS. A dedicated `LiveAudioBuffer → PcmPlayer` draining consumer is a separate spec/task that benefits all pipeline stages (not just TTS).

### Q8: chunkSize equivalent → **No chunkSize parameter (Option A)**

The natural processing unit is one text segment per worker iteration. Sherpa-onnx's internal callback granularity is model-dependent and not externally configurable. No `chunkSize`-equivalent parameter is needed.

---

## 14. Acceptance criteria

- [ ] `LiveTextSegment.meta` extension on both platforms (Android `LiveTextEntry`, iOS `TxtLiveEntry`). `commitSegment()` accepts optional `meta`. `appendLiveTextSegment` TurboModule updated. `getLiveTextBufferSegments` supports `includeMeta`.
- [ ] `TtsPipelineWorker` exists on both platforms, implementing `StreamingPipelineWorker`.
- [ ] Worker creates text segment cursor on input `LiveTextBuffer` and writes audio to output `LiveAudioBuffer`.
- [ ] Worker drains committed segments (not partials) and synthesizes each one via sherpa-onnx.
- [ ] Worker resolves per-segment `sid`/`speed` from `segment.meta`, falling back to pipeline defaults.
- [ ] PCM chunks from synthesis callback are written directly to output `LiveAudioBuffer` (zero bridge traffic).
- [ ] `startTtsPipeline` validates `outputBuffer.sampleRate === ttsModel.sampleRate`; rejects with `TTS_PIPELINE_SAMPLE_RATE_MISMATCH`.
- [ ] Voice cloning config set once at pipeline start; reference audio resolved from `OfflineAudioBuffer`.
- [ ] `stop()` cancels mid-generation synthesis via callback return value `0`.
- [ ] `flush()` completes current + remaining segments before resolving. Pipeline continues running.
- [ ] `reset()` discards unprocessed segments by advancing cursor. Pipeline continues running.
- [ ] Input text buffer finalization → auto-drain remaining segments → auto-stop.
- [ ] Output audio buffer is **not** auto-finalized.
- [ ] Generic `stopStreamingPipeline` / `flushStreamingPipeline` / `resetStreamingPipeline` / `getStreamingPipelineStatus` work for TTS pipelines via `pipelineId`.
- [ ] `StreamingTtsEngine.synthesize(textIn, audioOut, options?)` returns `Promise<TtsPipelineHandle>`.
- [ ] `StreamingPipelineStatus` reports: `unitsRead` = chars consumed, `unitsWritten` = samples produced, `chunksProcessed` = segments synthesized.
- [ ] Legacy TTS streaming methods fully removed: `generateTtsStream`, `generateTtsStreamToFile`, `cancelTtsStream` (TurboModule + native + TypeScript).
- [ ] Legacy TTS streaming types fully removed: `TtsStreamChunk`, `TtsStreamController`, `TtsStreamOptions`, base64 decode helpers, `DeviceEventEmitter` TTS event subscriptions.
- [ ] TTS-bound playback removed: no `playback: true`, no player proxy, no `autoDestroy`.
- [ ] `IncrementalStreamingTtsEngine` adapted to pipeline: `startSession(audioOut)`, `pushText()` → `appendLiveTextSegment()`, no chunk/event handlers.
- [ ] `LiveBufferAppendSource` includes `'tts'` value.
- [ ] Worker uses condition variable signaling (zero-latency wakeup on new committed segment).
- [ ] Example app TTS screen updated to pipeline model.
- [ ] Documentation `docs/tts-streaming.md` rewritten for pipeline model.

---

## 15. Related documents

- [Online STT live text pipeline spec](./online-stt-live-text-pipeline-spec.md) — the reverse-direction pipeline (audio → text) that this spec mirrors
- [Online enhancement live pipeline spec](./online-enhancement-live-pipeline-spec.md) — the base streaming pipeline pattern
- [TTS streaming performance migration](../tts-streaming-performance-migration.md) — performance roadmap for TTS streaming
- [Pipeline text buffer types (`src/textbuffer/types.ts`)](../../../src/textbuffer/types.ts)
- [Pipeline audio buffer types (`src/audiobuffer/types.ts`)](../../../src/audiobuffer/types.ts)
