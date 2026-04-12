# Online STT: `LiveTextBuffer` streaming pipeline

**Status:** Specification — all design decisions resolved; ready for implementation.  
**Scope:** Extend `LiveTextBuffer` with cursor + append-listener infrastructure to support the generic streaming pipeline pattern. **Online STT** is the first consumer, but the infrastructure is reusable for all future text-producing/consuming pipelines (TTS input, Alignment, Translation, etc.).  
**Prerequisite:** The generic `StreamingPipelineWorker` / `StreamingPipelineRegistry` infrastructure from the [online enhancement pipeline spec](./online-enhancement-live-pipeline-spec.md) is already implemented.  
**Breaking changes in this spec:** `StreamingPipelineStatus` fields renamed (`samplesRead` → `unitsRead`, `samplesWritten` → `unitsWritten`). Generic pipeline types relocated from `src/enhancement/` to `src/audiobuffer/`. Per-chunk STT bridge methods (`acceptSttWaveform`, `decodeSttStream`, `getSttStreamResult`, `processSttAudioChunk`, etc.) removed entirely.

---

## 1. Problem statement

The current online STT API forces **every audio chunk** through the JS ↔ native bridge and returns structured results (text, tokens, timestamps) back to JS on every `processSttAudioChunk` call:

```ts
// Current: per-chunk round-trip
const { result, isEndpoint } = await stream.processAudioChunk(samples, 16000);
// result = { text, tokens[], timestamps[], isFinal }
```

For a pipeline such as **Mic → Enhancement → STT → TTS**, each stage adds bridge crossings. At 16 kHz with 512-sample chunks:
- Enhancement: ~31 round-trips/sec (already eliminated by enhancement pipeline)
- STT: ~31 round-trips/sec (still per-chunk bridge calls)
- TTS: cannot start until JS mediates text from STT → TTS

### Goal

Replace the per-chunk STT bridge approach with a **native-native streaming pipeline** where:

1. An **input `LiveAudioBuffer`** provides audio (from mic, enhancement output, or another stage).
2. A **native STT worker thread** continuously drains audio, runs `OnlineRecognizer` (acceptWaveform → decode → getResult), and writes results to an **output `LiveTextBuffer`**.
3. A **downstream consumer** (TTS, Alignment, UI, or another pipeline) independently reads committed text from the output buffer — **in parallel** while STT is still producing.

JS only orchestrates **start / stop / status**. Audio and text data never cross the bridge during steady-state operation.

### Secondary goal: `LiveTextBuffer` as generic pipeline building block

`LiveTextBuffer` currently stores a single mutable string (`currentText`) with no cursor system and no append listeners. This makes it unsuitable as a pipeline coordination buffer. The audio equivalent (`LiveAudioBuffer` / `LiveEntry`) has:
- Ring buffer with independent cursors (`createCursorHandle`, `drainCursor`, `releaseCursor`)
- Append listener list (condition variable wakeup for zero-latency downstream processing)
- Token-based listener removal (safe concurrent use)

`LiveTextBuffer` needs an analogous system — but adapted for **text segments** rather than PCM samples.

---

## 2. Relationship to the full streaming pipeline

```text
Mic ──→ LiveAudioBuffer₁ ──→ [Enhancement] ──→ LiveAudioBuffer₂ ──→ [Online STT] ──→ LiveTextBuffer₁ ──→ [Online TTS] ──→ LiveAudioBuffer₃
             (native worker)                         (native worker)                       (native worker)
```

| Stage | Input buffer | Output buffer | Worker drains via | Worker writes via |
| --- | --- | --- | --- | --- |
| Enhancement | `LiveAudioBuffer` | `LiveAudioBuffer` | Audio cursor (`drainCursor`) | `appendSamples()` |
| **Online STT (this spec)** | **`LiveAudioBuffer`** | **`LiveTextBuffer`** | **Audio cursor** | **`commitSegment()`** (new) |
| Online TTS (future) | `LiveTextBuffer` | `LiveAudioBuffer` | **Text cursor** (`drainSegments`, new) | `appendSamples()` |
| Online Alignment (future) | `LiveTextBuffer` + `LiveAudioBuffer` | result / `LiveTextBuffer` | Text cursor + audio cursor | TBD |

**Key property:** Each stage runs on its own native thread. The buffers (audio and text) are the coordination mechanism. Stage N+1 starts processing the moment stage N writes its first output.

---

## 3. Current state (as-is)

### 3.1 `LiveTextEntry` (Android)

```kotlin
class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0
) {
  enum class State { RECORDING, FINISHED }
  var state: State = State.RECORDING
  var currentText: String = ""        // Single mutable string (replaced on each writePartial)
  var totalCharsWritten: Long = 0
  val revision: Int                   // Monotonic via AtomicInteger

  fun writePartial(text: String)      // Replaces currentText entirely
  fun appendText(text: String)        // Appends to currentText
  fun finalize_()                     // RECORDING → FINISHED
  fun snapshotText(): String
}
```

**Missing for pipeline use:**
- ❌ No cursor system (no independent read positions for multiple consumers)
- ❌ No append listeners (no zero-latency wakeup for downstream workers)
- ❌ No structured segment log (only a single mutable string, no commit/drain semantics)
- ❌ No way for a native worker to write structured STT results (text + tokens + timestamps)

### 3.2 `TxtLiveEntry` (iOS)

Same structure as Android:
```cpp
struct TxtLiveEntry {
  enum State { RECORDING, FINISHED };
  std::string currentText;
  int64_t totalCharsWritten;
  std::atomic<int> revision;
  void writePartial(const std::string &text);
  void appendText(const std::string &text);
  void finalize_();
};
```

Same gaps: no cursors, no listeners, no segment log.

### 3.3 Online STT (current per-chunk bridge model)

**TurboModule:**
```ts
// Per-chunk calls (audio → bridge → native → bridge → JS):
acceptSttWaveform(streamId, samples: number[], sampleRate): Promise<void>
decodeSttStream(streamId): Promise<void>
getSttStreamResult(streamId): Promise<{ text, tokens[], timestamps[], isFinal }>
isSttStreamEndpoint(streamId): Promise<boolean>

// Convenience (one bridge call per chunk):
processSttAudioChunk(streamId, samples: number[], sampleRate):
  Promise<{ result: { text, tokens[], timestamps[], isFinal }, isEndpoint: boolean }>
```

**Native (both platforms):** `OnlineRecognizer` wraps sherpa-onnx C++ `OnlineRecognizer`.
- `recognizer.acceptWaveform(stream, samples, sampleRate)` → buffer audio
- `while (recognizer.isReady(stream)) recognizer.decode(stream)` → incremental decode
- `recognizer.getResult(stream)` → `{ text, tokens[], timestamps[] }`
- `recognizer.isEndpoint(stream)` → endpoint detection (3-rule VAD)
- `recognizer.reset(stream)` → clear state for next utterance

### 3.4 `LiveEntry` infrastructure (reference: audio pipeline)

The audio pipeline infrastructure already provides the pattern we need to replicate for text:

| Feature | `LiveEntry` (Audio) | `LiveTextEntry` (Text, current) |
| --- | --- | --- |
| Storage | Float ring buffer | Single mutable string |
| Cursors | `createCursorHandle()`, `drainCursor()`, `releaseCursor()` | ❌ None |
| Append listeners | Token-based, multi-listener, CV wakeup | ❌ None |
| Finalize behavior | State transition, notify listeners | State transition only |
| Producer → consumer | Continuous PCM flow, cursor-based drain | Only JS reads via bridge |

---

## 4. `LiveTextBuffer` data model extension

### 4.1 Core insight: text segments, not sample streams

Audio pipelines drain **continuous sample streams** in fixed-size chunks. Text pipelines are fundamentally different:

- STT produces **discrete hypotheses** — a partial text that is fully replaced on each decode cycle, until an endpoint commits it.
- Downstream consumers (TTS, Alignment) care about **committed segments** — finalized text that won't change anymore.
- Partial hypotheses are valuable for **UI display** but not for downstream pipeline processing.

Therefore, `LiveTextBuffer` does **not** need an audio-style ring buffer of characters. Instead, it needs an **append-only segment log** with independent cursors:

```
┌─────────────────────────────────────────────────────────┐
│ LiveTextBuffer                                          │
│                                                         │
│ segments: [                                             │
│   #0: { text: "Hello world.", tokens: [...], ... }      │  ← committed (STT endpoint)
│   #1: { text: "How are you?", tokens: [...], ... }      │  ← committed (STT endpoint)
│ ]                                                       │
│                                                         │
│ partial: "I'm currently"                                │  ← in-progress (may change)
│                                                         │
│ cursors: {                                              │
│   cursor_0: segmentReadPos = 2  (TTS worker, caught up) │
│   cursor_1: segmentReadPos = 0  (Alignment, behind)     │
│ }                                                       │
│                                                         │
│ appendListeners: [token_0 → fn, token_1 → fn]          │
│ state: RECORDING                                        │
└─────────────────────────────────────────────────────────┘
```

### 4.2 `LiveTextSegment` — the unit of pipeline data flow

Each committed segment carries structured STT result data:

```ts
/** A committed text segment in a LiveTextBuffer's segment log. */
interface LiveTextSegment {
  /** The committed hypothesis text. */
  text: string;
  /** Subword tokens (from STT recognizer). Empty if not available. */
  tokens: string[];
  /** Per-token timestamps in seconds (from STT recognizer). Empty if not available. */
  timestamps: number[];
  /** Source that produced this segment. */
  source: LiveTextBufferPartialSource;
  /** Monotonic segment index within the buffer. */
  segmentIndex: number;
}
```

**Rationale:** Carrying `tokens` and `timestamps` per segment avoids a separate bridge call to retrieve them later. For non-STT sources (manual `appendText`, translation), these arrays are simply empty.

### 4.3 Dual data paths

| Path | Writer | Reader | Purpose |
| --- | --- | --- | --- |
| **Partial** (`writePartial`) | STT worker on each decode | JS via `onPartial` event / `getLiveTextBufferPartialSlice` | Real-time UI display |
| **Segment log** (`commitSegment`) | STT worker on endpoint | Native pipeline workers via cursor / JS via getter | Downstream pipeline processing |

These two paths are independent:
- `writePartial` updates the mutable `currentText` and fires `onPartial` JS events (existing behavior, unchanged).
- `commitSegment` appends to the segment log and notifies append listeners (new, for native pipeline wakeup).

A downstream TTS worker only reads committed segments via cursor — it never sees or reacts to partial updates. This is correct: TTS should only synthesize finalized text, not in-progress hypotheses.

---

## 5. Target API (concrete)

### 5.1 `LiveTextEntry` extension (Android)

```kotlin
// ── New methods on LiveTextEntry (additions to existing class) ──

/** Committed segment stored in the append-only log. */
data class TextSegment(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val source: String,
  val segmentIndex: Int,
)

class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
  val maxSegments: Int = 1000,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0
) {
  // ── Existing (unchanged) ──
  var currentText: String              // Mutable partial text (for UI)
  fun writePartial(text: String)       // Updates partial (fires JS onPartial event)
  fun appendText(text: String)         // Appends to partial
  fun finalize_()                      // RECORDING → FINISHED

  // ── NEW: Segment log (ring with maxSegments capacity) ──
  private val segments = ArrayList<TextSegment>()
  private val segmentLock = ReentrantReadWriteLock()
  private var evictedCount: Long = 0   // Total segments evicted (for cursor adjustment)

  /** Commit a finalized text segment to the log. Thread-safe. */
  @Synchronized
  fun commitSegment(
    text: String,
    tokens: Array<String> = emptyArray(),
    timestamps: FloatArray = floatArrayOf(),
    source: String = "unknown",
  ) {
    if (state == State.FINISHED) throw IllegalStateException(...)
    val segment = TextSegment(text, tokens, timestamps, source, (evictedCount + segments.size).toInt())
    segments.add(segment)
    // Evict oldest if over capacity
    if (segments.size > maxSegments) {
      segments.removeAt(0)
      evictedCount++
      // Snap cursors forward
      for ((_, pos) in cursors) {
        val p = pos.get()
        if (p > 0) pos.decrementAndGet()
        else pos.set(0)
      }
    }
    totalCharsWritten += text.length
    _revision.incrementAndGet()
    notifyAppendListeners()    // Wake downstream workers
  }

  /** Total number of committed segments. */
  val segmentCount: Int get() = segments.size

  // ── NEW: Cursor system (for downstream pipeline workers) ──
  private val cursors = ConcurrentHashMap<Int, AtomicInteger>()  // cursorId → segmentReadPos
  private val nextCursorId = AtomicInteger(0)

  /** Create a new cursor starting at segment index 0. Returns cursor ID. */
  fun createSegmentCursor(): Int {
    val id = nextCursorId.getAndIncrement()
    cursors[id] = AtomicInteger(0)
    return id
  }

  /**
   * Drain up to maxSegments unread segments from this cursor's position.
   * Advances the cursor. Returns empty list if no unread segments available.
   */
  fun drainSegments(cursorId: Int, maxSegments: Int): List<TextSegment> {
    val pos = cursors[cursorId] ?: throw IllegalArgumentException(...)
    val currentPos = pos.get()
    val available = segments.subList(currentPos, minOf(currentPos + maxSegments, segments.size))
    val result = ArrayList(available)  // snapshot
    pos.addAndGet(result.size)
    return result
  }

  /** Release a cursor handle. */
  fun releaseSegmentCursor(cursorId: Int) {
    cursors.remove(cursorId)
  }

  // ── NEW: Append listeners (for condition variable wakeup) ──
  private val appendListeners = CopyOnWriteArrayList<Pair<Int, () -> Unit>>()
  private val nextListenerToken = AtomicInteger(0)

  fun addAppendListener(listener: () -> Unit): Int {
    val token = nextListenerToken.getAndIncrement()
    appendListeners.add(Pair(token, listener))
    return token
  }

  fun removeAppendListener(token: Int) {
    appendListeners.removeAll { it.first == token }
  }

  private fun notifyAppendListeners() {
    for ((_, listener) in appendListeners) {
      listener()
    }
  }

  // ── UPDATED: finalize_ also notifies listeners ──
  fun finalize_() {
    if (state == State.FINISHED) throw ...
    state = State.FINISHED
    notifyAppendListeners()  // Wake workers so they see FINISHED state
  }
}
```

### 5.2 `TxtLiveEntry` extension (iOS)

Mirror Android with C++ equivalents:

```cpp
struct TextSegment {
  std::string text;
  std::vector<std::string> tokens;
  std::vector<float> timestamps;
  std::string source;
  int segmentIndex;
};

struct TxtLiveEntry {
  // ── Existing (unchanged) ──
  std::string currentText;
  void writePartial(const std::string &text);
  void appendText(const std::string &text);
  void finalize_();

  // ── NEW: Segment log (ring with maxSegments capacity) ──
  int maxSegments = 1000;
  std::deque<TextSegment> segments;
  int64_t evictedCount = 0;
  std::mutex segmentMutex;

  void commitSegment(const std::string &text,
                     const std::vector<std::string> &tokens = {},
                     const std::vector<float> &timestamps = {},
                     const std::string &source = "unknown");
  // On overflow: segments.pop_front(), evictedCount++, snap cursors

  int segmentCount() const;

  // ── NEW: Cursor system ──
  struct SegmentCursor { int cursorId; std::atomic<int> readPos{0}; };
  std::unordered_map<int, std::unique_ptr<SegmentCursor>> segmentCursors;
  std::mutex cursorMutex;
  std::atomic<int> nextCursorId{0};

  int createSegmentCursor();
  std::vector<TextSegment> drainSegments(int cursorId, int maxSegments);
  void releaseSegmentCursor(int cursorId);

  // ── NEW: Append listeners (token-based, matching PaLiveEntry pattern) ──
  struct NativeAppendListener { int token; std::function<void()> callback; };
  std::vector<NativeAppendListener> appendListeners;
  std::mutex appendListenerMutex;
  std::atomic<int> nextListenerToken{0};

  int addAppendListener(std::function<void()> listener);
  void removeAppendListener(int token);
  void notifyAppendListeners();
};
```

### 5.3 Generic streaming pipeline types (relocated)

`StreamingPipelineStatus` and `StreamingPipelineHandle` are **generic pipeline orchestration types** — not enhancement-specific. They are currently exported from `src/enhancement/streaming.ts` but semantically belong to the audio buffer / pipeline infrastructure. As part of this spec, they are **relocated** to `src/audiobuffer/streamingPipelineTypes.ts` (new file). Enhancement and STT both import from there. This is a **breaking change** for consumers that import these types from `enhancement`.

```ts
// ── src/audiobuffer/streamingPipelineTypes.ts (NEW — relocated + renamed fields) ──

/**
 * Status snapshot of a running streaming pipeline.
 * Identical structure for all pipeline types (enhancement, STT, TTS, etc.).
 * Field names are generic ("units") because pipelines can produce audio samples,
 * text characters, or other unit types.
 */
export interface StreamingPipelineStatus {
  /** Whether the native worker loop is currently active. */
  isRunning: boolean;
  /** Number of processing invocations completed (chunks for enhancement, decode cycles for STT, etc.). */
  chunksProcessed: number;
  /** Total units read from the input buffer so far (audio samples, text chars, etc.). */
  unitsRead: number;
  /** Total units written to the output buffer so far (audio samples, text chars, segments, etc.). */
  unitsWritten: number;
  /** If the pipeline stopped due to an error, the message. Absent when healthy. */
  error?: string;
}

/**
 * Base handle for controlling a running streaming pipeline.
 * All feature-specific pipeline handles extend this.
 */
export interface StreamingPipelineHandle {
  /** Unique pipeline run identifier (generated by native registry). */
  readonly pipelineId: string;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<StreamingPipelineStatus>;
}
```

**Re-export from `src/audiobuffer/index.ts`** so consumers can import from `react-native-sherpa-onnx`. Remove re-exports from `src/enhancement/`.

### 5.4 STT-specific TypeScript types

```ts
// ── src/stt/streamingTypes.ts (new/updated) ──

import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { StreamingPipelineHandle, StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';

/**
 * STT-specific pipeline handle.
 * Extends the generic StreamingPipelineHandle.
 */
export interface SttPipelineHandle extends StreamingPipelineHandle {
  /** The STT engine instance driving this pipeline. */
  readonly instanceId: string;
}

/** Options for starting an STT pipeline. */
export interface SttPipelineOptions {
  /**
   * Number of audio samples to drain per worker iteration.
   * Determines the trade-off between latency (smaller = lower) and overhead (larger = fewer iterations).
   * Default: 3200 (200ms at 16kHz). Typical range: 1600–6400.
   */
  chunkSize?: number;
}

/**
 * Handle returned by `createStreamingStt`.
 * Represents a loaded online recognizer model instance.
 *
 * Two engine types:
 * - `SttEngine.transcribe(offline, offline)` → `Promise<void>` (batch, resolves when done).
 * - `LiveSttEngine.transcribe(live, live)` → `Promise<SttPipelineHandle>` (resolves when pipeline started).
 */
export interface LiveSttEngine {
  readonly instanceId: string;

  /**
   * Start a native streaming STT pipeline.
   * A dedicated background worker thread drains audio from `audioIn`, runs
   * the online recognizer (acceptWaveform → decode → getResult), and writes
   * committed segments to `textOut` on each endpoint.
   *
   * - `audioIn` must be a live audio buffer in `recording` state.
   * - `audioIn.sampleRate` must equal the recognizer's expected sample rate (strict validation).
   * - `textOut` must be a live text buffer in `recording` state.
   * - Only one pipeline per engine instance at a time (recognizer has internal state).
   *
   * Returns a handle to control and inspect the running pipeline.
   */
  transcribe(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options?: SttPipelineOptions,
  ): Promise<SttPipelineHandle>;

  /**
   * Destroy the engine. Stops any running pipeline first.
   */
  destroy(): Promise<void>;
}
```

### 5.5 TurboModule methods

```ts
// ── src/NativeSherpaOnnx.ts ──

// ==================== KEEP (from existing online STT) ====================
// initializeOnlineSttWithOptions(instanceId, options)
// unloadOnlineStt(instanceId)

// ==================== REMOVE (per-chunk bridge methods) ====================
// createSttStream(instanceId, streamId, hotwords?)
// acceptSttWaveform(streamId, samples, sampleRate)
// decodeSttStream(streamId)
// isSttStreamReady(streamId)
// getSttStreamResult(streamId)
// isSttStreamEndpoint(streamId)
// resetSttStream(streamId)
// releaseSttStream(streamId)
// processSttAudioChunk(streamId, samples, sampleRate)
//
// These are replaced by the pipeline API below. Breaking change — pipeline-only.
// Same approach as enhancement (removed feedEnhancementSamples).

// ==================== ADD: STT pipeline start ====================

/** Launch a streaming STT worker. */
startSttPipeline(
  instanceId: string,
  audioInLiveBufferId: string,
  textOutLiveBufferId: string,
  chunkSize?: number,
): Promise<{ pipelineId: string }>;

// ==================== REUSE: Generic pipeline control (already exists) ====================
// stopStreamingPipeline(pipelineId): Promise<void>;
// flushStreamingPipeline(pipelineId): Promise<void>;
// resetStreamingPipeline(pipelineId): Promise<void>;

// ==================== UPDATED: Generic pipeline status (renamed fields) ====================
getStreamingPipelineStatus(pipelineId: string): Promise<{
  isRunning: boolean;
  chunksProcessed: number;
  unitsRead: number;      // was: samplesRead
  unitsWritten: number;   // was: samplesWritten
  error?: string;
}>;
```

### 5.6 `StreamingPipelineStatus` field semantics per feature

The generic `StreamingPipelineStatus` uses `unitsRead` / `unitsWritten` — the semantic meaning depends on the pipeline type:

| Field | Enhancement (audio → audio) | STT (audio → text) | TTS (text → audio, future) |
| --- | --- | --- | --- |
| `chunksProcessed` | Denoiser frame invocations | Decode cycles completed | Synthesis invocations |
| `unitsRead` | Audio samples consumed | Audio samples consumed | Characters consumed |
| `unitsWritten` | Audio samples produced | Characters committed | Audio samples produced |
| `error` | Error message | Error message | Error message |

The field names `unitsRead` / `unitsWritten` are intentionally generic to avoid misleading names across heterogeneous pipeline types. This is a **breaking change** from the previous `samplesRead` / `samplesWritten` naming.

---

## 6. STT pipeline worker

### 6.1 Android: `SttPipelineWorker.kt`

```kotlin
class SttPipelineWorker(
  override val pipelineId: String,
  private val recognizer: OnlineRecognizer,
  private val stream: OnlineStream,
  private val inputEntry: LiveEntry,          // LiveAudioBuffer
  private val outputEntry: LiveTextEntry,     // LiveTextBuffer
  private val chunkSize: Int = 3200,          // Configurable; default ~200ms at 16kHz
) : StreamingPipelineWorker {

  private val executor = Executors.newSingleThreadExecutor()
  override var isRunning: Boolean = false

  private var chunksProcessed = 0L
  private var unitsRead = 0L
  private var unitsWritten = 0L
  private var error: String? = null
  private var audioCursorId: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable: Condition = lock.newCondition()
  private var appendListenerToken: Int = -1

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  override fun start() {
    isRunning = true
    audioCursorId = inputEntry.createCursorHandle()

    // Register append listener on audio input for CV wakeup
    appendListenerToken = inputEntry.addAppendListener { _ ->
      lock.withLock { dataAvailable.signal() }
    }

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val sampleRate = recognizer.sampleRate
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(audioCursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            // Input ended → commit remaining partial, then stop
            autoFlushAndCommit()
            isRunning = false
            break
          }
          lock.withLock { dataAvailable.await(10, TimeUnit.MILLISECONDS) }
          continue
        }

        // Feed audio to recognizer
        recognizer.acceptWaveform(stream, chunk, sampleRate)
        unitsRead += chunk.size

        // Decode as much as possible
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream)
        }
        chunksProcessed++

        val result = recognizer.getResult(stream)

        // Update partial text for UI display
        if (result.text.isNotBlank()) {
          outputEntry.writePartial(result.text, source = "stt_stream")
        }

        // Endpoint detection → commit segment
        if (recognizer.isEndpoint(stream)) {
          if (result.text.isNotBlank()) {
            outputEntry.commitSegment(
              text = result.text,
              tokens = result.tokens,
              timestamps = result.timestamps,
              source = "stt_stream",
            )
            // Clear partial after committing
            outputEntry.writePartial("", source = "stt_stream")
          }
          recognizer.reset(stream)
        }
      }
    } catch (e: Exception) {
      error = e.message
      isRunning = false
    } finally {
      inputEntry.releaseCursor(audioCursorId)
      inputEntry.removeAppendListener(appendListenerToken)
      executor.shutdown()
    }
  }

  private fun autoFlushAndCommit() {
    // Final decode pass
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream)
    }
    val result = recognizer.getResult(stream)
    if (result.text.isNotBlank()) {
      outputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "stt_stream",
      )
      outputEntry.writePartial("", source = "stt_stream")
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            autoFlushAndCommit()
            cmd.completion.complete(Unit)
          } catch (e: Exception) { cmd.completion.completeExceptionally(e) }
        }
        is PipelineCommand.Reset -> {
          try {
            recognizer.reset(stream)
            outputEntry.writePartial("", source = "stt_stream")
            cmd.completion.complete(Unit)
          } catch (e: Exception) { cmd.completion.completeExceptionally(e) }
        }
      }
    }
  }

  override fun stop() { /* same as EnhancementPipelineWorker */ }
  override fun flush(): CompletableFuture<Unit> { /* same pattern */ }
  override fun reset(): CompletableFuture<Unit> { /* same pattern */ }
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

### 6.2 iOS: `SttPipelineWorker`

Mirror Android using `std::thread` + `std::condition_variable`, same as `EnhancementPipelineWorker`:

```cpp
class SttPipelineWorker : public StreamingPipelineWorker {
  std::shared_ptr<OnlineSttWrapper> wrapper;
  std::string streamId;
  std::shared_ptr<PaLiveEntry> inputEntry;     // LiveAudioBuffer
  std::shared_ptr<TxtLiveEntry> outputEntry;   // LiveTextBuffer
  std::thread workerThread;
  std::mutex mtx;
  std::condition_variable cv;
  int appendListenerToken = -1;
  int audioCursorId = -1;
  // Command queue: std::deque<PipelineCommand>
  // Same runLoop: drain audio → acceptWaveform → decode → getResult → commitSegment on endpoint
};
```

---

## 7. Usage examples

### 7.1 Basic: Mic → STT → text segments

```ts
import {
  createStreamingStt,
  createLiveAudioBuffer,
  createLiveTextBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  finalizeLiveTextBuffer,
} from 'react-native-sherpa-onnx';

// 1. Create STT engine
const stt = await createStreamingStt({
  modelDir: '/models/zipformer',
  modelType: 'transducer',
  enableEndpoint: true,
});

// 2. Create buffers
const micBuffer = await createLiveAudioBuffer({ sampleRate: 16000 });
const textBuffer = await createLiveTextBuffer({
  onPartial: (event) => {
    // Real-time UI: show in-progress hypothesis
    setPartialText(event.partialText);
  },
});

// 3. Start native pipeline
const pipeline = await stt.transcribe(micBuffer, textBuffer);

// 4. Start mic capture
await startMicToLiveAudioBuffer(micBuffer.bufferId);

// Audio now flows: mic → micBuffer → [STT worker] → textBuffer
// Zero bridge traffic for audio/text data.
// onPartial fires for UI updates (minimal bridge traffic, throttled).

// 5. Stop
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(micBuffer.bufferId);  // STT worker auto-flushes and stops
await finalizeLiveTextBuffer(textBuffer.bufferId);

// 6. Read committed segments (by-reference, sliced)
const info = await getPipelineTextBufferInfo(textBuffer);
// info.segmentCount = 5 (e.g. 5 committed utterances)
const segments = await getLiveTextBufferSegments(textBuffer, 0, 5);
// segments = [{ text: "Hello world.", tokens: [...], ... }, ...]

await stt.destroy();
```

### 7.2 Full pipeline: Mic → Enhancement → STT → TTS

```ts
const micBuf = await createLiveAudioBuffer({ sampleRate: 16000 });
const enhancedBuf = await createLiveAudioBuffer({ sampleRate: 16000 });
const textBuf = await createLiveTextBuffer();
const ttsBuf = await createLiveAudioBuffer({ sampleRate: 22050 });

const enhancer = await createStreamingEnhancement({ modelPath: { modelDir: '...' } });
const stt = await createStreamingStt({ modelDir: '...', enableEndpoint: true });
const tts = await createStreamingTts({ modelDir: '...' }); // future

const p1 = await enhancer.enhance(micBuf, enhancedBuf);
const p2 = await stt.transcribe(enhancedBuf, textBuf);
const p3 = await tts.synthesize(textBuf, ttsBuf);  // future

await startMicToLiveAudioBuffer(micBuf.bufferId);

// Four native threads work in parallel:
// Thread 1: Mic → micBuf
// Thread 2: micBuf → [Enhancement] → enhancedBuf
// Thread 3: enhancedBuf → [STT] → textBuf
// Thread 4: textBuf → [TTS] → ttsBuf
//
// TTS starts synthesizing the first committed sentence while STT is still
// transcribing the second sentence. Zero JS bridge traffic for data.
```

### 7.3 Manual text + pipeline (non-STT producer)

```ts
// LiveTextBuffer can also receive manual text via JS
const textBuf = await createLiveTextBuffer();
const ttsBuf = await createLiveAudioBuffer({ sampleRate: 22050 });

const tts = await createStreamingTts({ modelDir: '...' }); // future
const p = await tts.synthesize(textBuf, ttsBuf);

// Append text segments from JS (e.g. chat messages, subtitles)
await appendLiveTextSegment(textBuf, "Hello, how are you?");
await appendLiveTextSegment(textBuf, "I'm doing well, thanks.");
// TTS worker processes each segment as it arrives

await finalizeLiveTextBuffer(textBuf);
// TTS worker auto-flushes remaining and stops
```

---

## 8. New TurboModule methods for `LiveTextBuffer` pipeline support

```ts
// ── Additions to src/NativeSherpaOnnx.ts ──

/** Commit a text segment to a live text buffer's segment log from JS. */
appendLiveTextSegment(
  liveBufferId: string,
  text: string,
  tokens?: string[],
  timestamps?: number[],
): Promise<{ segmentIndex: number }>;

/**
 * Read committed segments from a live text buffer.
 * By-reference getter: returns segment data for the given index range.
 * Default: text + source + segmentIndex only. Opt in for tokens/timestamps via options.
 */
getLiveTextBufferSegments(
  liveBufferId: string,
  startIndex: number,
  maxCount: number,
  options?: { includeTokens?: boolean; includeTimestamps?: boolean },
): Promise<{
  segments: Array<{
    text: string;
    source: string;
    segmentIndex: number;
    /** Only present when `includeTokens: true`. */
    tokens?: string[];
    /** Only present when `includeTimestamps: true`. */
    timestamps?: number[];
  }>;
}>;

/** Get the current segment count of a live text buffer. */
getLiveTextBufferSegmentCount(
  liveBufferId: string,
): Promise<number>;
```

/** Options for `createLiveTextBuffer`. */
export interface CreateLiveTextBufferOptions {
  /** Max held UTF-16 characters for partial history (ring). Default: native/SDK. */
  windowMaxChars?: number;
  /** Max committed segments retained in the segment log. Default: 1000.
   *  When exceeded, oldest segments are evicted (ring). Cursors snap forward. */
  maxSegments?: number;
  emitPartialEvents?: boolean;
  partialEventMinIntervalMs?: number;
  onPartial?: (event: LiveTextBufferPartialEvent) => void;
  onError?: (event: LiveTextBufferErrorEvent) => void;
}
```

### Updated `LiveTextBufferInfo`

```ts
export interface LiveTextBufferInfo {
  bufferId: string;
  kind: 'liveTextBuffer';
  state: LiveTextBufferState;
  totalCharsWritten: number;
  revision: number;
  segmentCount: number;    // ← NEW: number of committed segments
}
```

---

## 9. New source constant

Add a new `LiveTextBufferPartialSource` value for STT-produced text:

```ts
export type LiveTextBufferPartialSource =
  | 'stt_stream'        // ← from STT pipeline worker
  | 'append'            // ← from JS appendText / appendLiveTextSegment
  | 'replace'
  | 'unknown'
  | 'mixed';
```

`stt_stream` already exists in the current type definition. No change needed here.

---

## 10. Errors

| Code | Meaning |
| --- | --- |
| `STT_PIPELINE_ALREADY_RUNNING` | `transcribe()` called while a pipeline on this engine is already active |
| `STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND` | Input live audio buffer ID not found in registry |
| `STT_PIPELINE_TEXT_BUFFER_NOT_FOUND` | Output live text buffer ID not found in registry |
| `STT_PIPELINE_BUFFER_KIND_MISMATCH` | Non-live buffer passed (must be `live_*`) |
| `STT_PIPELINE_BUFFER_NOT_RECORDING` | Buffer already finalized; cannot start pipeline on it |
| `STT_PIPELINE_SAMPLE_RATE_MISMATCH` | Input buffer's `sampleRate` does not match the recognizer's expected sample rate |
| `STREAMING_PIPELINE_NOT_FOUND` | Generic: `pipelineId` not found (stop/flush/reset/status) |
| `STREAMING_PIPELINE_ERROR` | Generic: worker thread crashed |
| `TEXT_CURSOR_NOT_FOUND` | Invalid cursor ID in `drainSegments` / `releaseSegmentCursor` |

---

## 11. Behavioral contracts

### 11.1 One pipeline per engine

An `OnlineRecognizer` holds internal state per stream. Running two pipelines on the same engine would corrupt recognizer state. Therefore:
- `transcribe()` rejects with `STT_PIPELINE_ALREADY_RUNNING` if a pipeline is active.
- `destroy()` calls `stop()` on any running pipeline first.

### 11.1a Strict sample rate validation

`transcribe()` / `startSttPipeline` validates that `inputBuffer.sampleRate === recognizer.sampleRate` before starting the worker. If they differ, the call is rejected with `STT_PIPELINE_SAMPLE_RATE_MISMATCH`. Same strict approach as enhancement. The SDK consumer creates buffers at the correct rate.

### 11.2 Input finalization → auto-flush + auto-stop

When the input audio buffer transitions to `FINISHED` and the cursor has drained all remaining samples:
1. The worker performs a final decode pass (flush any buffered audio in the recognizer).
2. The worker commits any remaining partial hypothesis as a final segment.
3. The worker exits its loop (`isRunning = false`).
4. The output text buffer is **not** auto-finalized (caller decides when).

### 11.3 Flush semantics (blocking)

`flush()` on the STT pipeline handle:
- Enqueues a flush command on the worker thread.
- The worker performs a final decode + getResult + commitSegment for any buffered state.
- The promise resolves when the flush is complete.
- The pipeline **continues running** after flush.

### 11.4 Reset semantics (blocking)

`reset()` on the STT pipeline handle:
- Enqueues a reset command.
- The worker calls `recognizer.reset(stream)` and clears the partial text.
- The pipeline **continues running** — subsequent audio is treated as a new utterance.

### 11.5 Worker wait strategy (condition variable)

Same as Enhancement pipeline:
- Worker waits on a condition variable when no audio data is available.
- `LiveEntry.appendSamples()` signals via append listener.
- 10ms safety timeout.
- Zero-latency wakeup in the common case.

### 11.6 Segment cursor semantics

For downstream native pipeline workers (e.g., TTS consuming from a `LiveTextBuffer`):
- `createSegmentCursor()` → new cursor at position 0.
- `drainSegments(cursorId, maxSegments)` → returns up to N unread committed segments, advances cursor.
- Empty result when caught up — worker waits on append listener.
- `releaseSegmentCursor(cursorId)` → free handle.

Cursors are independent: multiple downstream workers can consume segments at their own pace.

### 11.7 Segment log capacity and eviction

The segment log is **configurable** with a `maxSegments` parameter (default: 1000):

```ts
const textBuf = await createLiveTextBuffer({ maxSegments: 500 });
```

When `segments.size >= maxSegments`, the oldest segment is evicted on the next `commitSegment()` call (ring semantics). Cursor positions that have been evicted past **snap forward** to the oldest available segment — same pattern as audio ring buffer overflow.

**Rationale:** For a public SDK, we cannot assume session length. A long-running live transcription (e.g., 2-hour meeting) could accumulate thousands of segments. Configurable capacity from day one avoids hidden memory growth and provides predictable behavior.

- `windowMaxChars` limits the mutable `currentText` partial window (existing).
- `maxSegments` limits the committed segment log (new).

Native implementation:

**Android:** `segments` is an `ArrayList<TextSegment>`. On overflow, `segments.removeAt(0)` and adjust all cursor `readPos` values by `-1` (clamped to 0). The evicted segment's data is GC'd.

**iOS:** `segments` is a `std::deque<TextSegment>`. On overflow, `segments.pop_front()` and adjust cursor positions analogously.

### 11.8 Partial text vs. committed segments

- **Partial text** (`writePartial`): Replaced on every decode cycle. High-frequency. Used for UI display via `onPartial` JS events (existing mechanism).
- **Committed segments** (`commitSegment`): Appended only on endpoint detection. Low-frequency. Used for downstream native pipeline workers via cursor.

Append listeners are notified **only on `commitSegment`** (and `finalize_`), not on `writePartial`. This ensures downstream workers are woken only when there's actionable data, not on every partial update.

### 11.9 Ring buffer overflow (backpressure) on audio input

If the STT worker is slower than the audio producer:
- `LiveEntry.appendSamples()` overwrites oldest samples in the ring.
- The audio cursor snaps forward.
- Some audio data is lost — acceptable for real-time streaming.
- Observable via audio buffer's `totalSamplesDropped`.

### 11.10 Output text source tagging

The STT worker writes segments with `source = "stt_stream"`. Downstream consumers can distinguish STT-produced text from manually appended text.

---

## 12. Migration plan

| Phase | Work |
| --- | --- |
| **P0** | This spec (done). All design decisions resolved. |
| **P0.5** | **Relocate generic pipeline types:** Move `StreamingPipelineStatus` and `StreamingPipelineHandle` from `src/enhancement/streaming.ts` to `src/audiobuffer/streamingPipelineTypes.ts`. Rename `samplesRead` → `unitsRead`, `samplesWritten` → `unitsWritten` on both TypeScript and native (`StreamingPipelineStatus` data class / struct). Update all imports in `enhancement/`, `NativeSherpaOnnx.ts`, and native getStatus impls. **Breaking change.** |
| **P1** | **LiveTextEntry extension (Android):** Add `TextSegment` data class, segment log (`ArrayList<TextSegment>`) with `maxSegments` + eviction, `commitSegment()`, cursor system (`createSegmentCursor` / `drainSegments` / `releaseSegmentCursor`), append listener list (token-based), `notifyAppendListeners()` in `commitSegment` and `finalize_`. |
| **P2** | **TxtLiveEntry extension (iOS):** Mirror P1 — `TextSegment` struct, `std::deque<TextSegment>` with ring eviction, cursor map, token-based append listeners. |
| **P3** | **STT pipeline worker (Android):** `SttPipelineWorker` implementing `StreamingPipelineWorker`. Audio cursor on input, configurable `chunkSize`, commitSegment on endpoint, writePartial for UI, sample rate validation. Wire `startSttPipeline` into `SherpaOnnxModule`. |
| **P4** | **STT pipeline worker (iOS):** Mirror P3 — `SttPipelineWorker` subclass. |
| **P5** | **TurboModule:** Add `startSttPipeline` (with optional `chunkSize`). Add `appendLiveTextSegment`, `getLiveTextBufferSegments` (with optional `includeTokens`/`includeTimestamps`), `getLiveTextBufferSegmentCount`. Update `LiveTextBufferInfo` with `segmentCount`. Update `createLiveTextBuffer` to accept `maxSegments`. **Remove** per-chunk STT bridge methods: `createSttStream`, `acceptSttWaveform`, `decodeSttStream`, `isSttStreamReady`, `getSttStreamResult`, `isSttStreamEndpoint`, `resetSttStream`, `releaseSttStream`, `processSttAudioChunk`. |
| **P6** | **TypeScript:** `LiveSttEngine` interface + `SttPipelineHandle` + `SttPipelineOptions`. `createStreamingStt` factory. Update `CreateLiveTextBufferOptions` with `maxSegments`. Update `LiveTextBufferInfo` type. Export new types from `audiobuffer/` and `stt/`. |
| **P7** | **Example app:** Streaming STT screen using pipeline (mic → STT → text display from committed segments + partial UI). |
| **P8** | **Documentation:** Update `docs/stt-streaming.md`. |
| **P9** | **Cleanup:** Remove dead native code paths (old per-chunk STT JNI/ObjC selectors, `SttStream` maps on native side, old TurboModule methods). Remove old `StreamingPipelineStatus`/`Handle` exports from `enhancement/`. |

---

## 13. Acceptance criteria

- [ ] `StreamingPipelineStatus` and `StreamingPipelineHandle` relocated to `src/audiobuffer/streamingPipelineTypes.ts`. Fields renamed to `unitsRead` / `unitsWritten`. Old exports from `enhancement/` removed.
- [ ] `LiveTextEntry` (Android) and `TxtLiveEntry` (iOS) have: segment log with configurable `maxSegments` + ring eviction, `commitSegment()`, cursor system (with snap-forward on eviction), token-based append listeners.
- [ ] `SttPipelineWorker` exists on both platforms, implementing `StreamingPipelineWorker`.
- [ ] `LiveSttEngine.transcribe(liveAudioIn, liveTextOut, options?)` returns `Promise<SttPipelineHandle>`.
- [ ] `SttPipelineOptions.chunkSize` is configurable; default 3200 samples.
- [ ] Audio data never crosses JS ↔ native bridge during steady-state STT pipeline operation.
- [ ] Per-chunk STT bridge methods (`acceptSttWaveform`, `processSttAudioChunk`, etc.) fully removed from TurboModule spec and native implementations.
- [ ] Text segments are committed on endpoint detection; partial text updated for UI.
- [ ] `writePartial` fires `onPartial` JS events when `emitPartialEvents` is enabled (opt-in).
- [ ] Append listeners on `LiveTextBuffer` fire on `commitSegment` and `finalize_` only, not on `writePartial`.
- [ ] Generic `stopStreamingPipeline` / `flushStreamingPipeline` / `resetStreamingPipeline` / `getStreamingPipelineStatus` work for STT pipelines via `pipelineId`.
- [ ] Downstream native pipeline worker can create a segment cursor on `LiveTextBuffer` and drain committed segments independently.
- [ ] Input audio finalization triggers auto-flush + auto-stop on STT worker.
- [ ] `startSttPipeline` validates `inputBuffer.sampleRate === recognizer.sampleRate`; rejects with `STT_PIPELINE_SAMPLE_RATE_MISMATCH` on mismatch.
- [ ] `flush()` and `reset()` are blocking: promise resolves only after the native worker has processed the command.
- [ ] Worker uses condition variable signaling (zero-latency wakeup), not polling.
- [ ] `LiveTextBufferInfo` reports `segmentCount`.
- [ ] `getLiveTextBufferSegments` returns text + source by default; `tokens[]` and `timestamps[]` only when `includeTokens` / `includeTimestamps` options are set.
- [ ] `appendLiveTextSegment` allows JS to manually commit segments (for non-STT producers).
- [ ] `createLiveTextBuffer({ maxSegments })` configurable; default 1000.

---

## 14. Resolved design decisions

All questions have been resolved. Decisions are documented here for traceability.

### Q1: `StreamingPipelineStatus` field naming → **Rename to `unitsRead` / `unitsWritten` (Option B)**

For a public SDK, field names should not be misleading. `samplesWritten` when the output is text characters is confusing and invites bugs. Renaming to `unitsRead` / `unitsWritten` is a breaking change on the generic interface, which is acceptable. This aligns with the relocation of these types from `enhancement/` to `audiobuffer/` (a combined breaking change).

### Q2: Segment capacity and eviction → **Configurable `maxSegments` from day one (Option B)**

`createLiveTextBuffer({ maxSegments: 1000 })` with default 1000. Oldest segments are evicted on overflow (ring semantics). Cursor positions snap forward if evicted past. For a public SDK, we cannot assume session lengths; predictable memory behavior from day one is best practice.

### Q3: Should `writePartial` also notify append listeners? → **commitSegment-only (Option A)**

Append listeners fire **only** on `commitSegment` and `finalize_`, not on `writePartial`. Downstream pipeline workers react only to finalized text — clean separation. Speculative TTS is a future optimization; `addPartialListener` can be added later without breaking the existing `addAppendListener`.

### Q4: Keep or remove per-chunk STT bridge methods? → **Remove entirely (Option A)**

All per-chunk bridge methods are removed: `createSttStream`, `acceptSttWaveform`, `decodeSttStream`, `isSttStreamReady`, `getSttStreamResult`, `isSttStreamEndpoint`, `resetSttStream`, `releaseSttStream`, `processSttAudioChunk`. Pipeline-only API. Same approach as enhancement (removed `feedEnhancementSamples`). Breaking change accepted.

### Q5: Chunk size for STT audio drain → **Configurable at pipeline start with sensible default (Option B)**

`transcribe(audioIn, textOut, { chunkSize: 4800 })`. Default: 3200 samples (~200ms at 16kHz). Passed through TurboModule as optional `chunkSize` parameter on `startSttPipeline`. Allows tuning the latency/overhead trade-off without requiring a new engine.

### Q6: Endpoint configuration per pipeline → **Engine config only (Option A)**

Endpoint rules are set at `initializeOnlineSttWithOptions` time. If different rules are needed, create a different engine instance. Endpoint tuning is rarely changed mid-session.

### Q7: Partial text emission for pipeline use → **Keep existing behavior (Option A)**

Pipeline workers call `writePartial` → JS `onPartial` fires when `emitPartialEvents: true` is set on the buffer. Default is `false` (no events). Users opt in for UI display. Minimal bridge traffic, throttled by `partialEventMinIntervalMs`.

### Q8: `LiveTextBuffer` segment getters — slicing strategy → **Text always, tokens/timestamps optionally (Option C)**

`getLiveTextBufferSegments(id, start, max, { includeTokens: true, includeTimestamps: true })`. Default returns text + source + segmentIndex only. Tokens and timestamps are opt-in per call. Keeps the common case (UI display) fast and lightweight.

### Q9: Sample rate validation for STT pipeline → **Strict reject (Option A)**

`startSttPipeline` validates `inputBuffer.sampleRate === recognizer.sampleRate` and rejects with `STT_PIPELINE_SAMPLE_RATE_MISMATCH` on mismatch. Same strict approach as enhancement. Hidden resampling leads to unpredictable quality.

---

## 15. Related documents

- [Online enhancement live pipeline spec](./online-enhancement-live-pipeline-spec.md) — the base pattern this spec extends
- [STT pipeline buffer-only API plan](../stt/stt-pipeline-buffer-only-api-plan.md) — offline STT migration (separate)
- [Pipeline text buffer types (`src/textbuffer/types.ts`)](../../../src/textbuffer/types.ts)
- [Pipeline audio buffer types (`src/audiobuffer/types.ts`)](../../../src/audiobuffer/types.ts)
