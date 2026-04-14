# Online speech enhancement: `LiveAudioBuffer` streaming pipeline

**Status:** Specification — all design decisions resolved; ready for implementation.  
**Scope:** **Online / streaming** denoising only (`gtcrn`, `dpdfnet` in streaming mode via `OnlineSpeechDenoiser`). **Offline** batch enhancement already migrated to `OfflineAudioBuffer` pipeline and is **not** affected by this document.  
**Infrastructure scope:** This spec defines a **generic streaming pipeline infrastructure** (`StreamingPipelineWorker`, `StreamingPipelineRegistry`) that is reusable for all future online features (STT, TTS, Alignment). Enhancement is the first consumer of this infrastructure.

---

## 1. Problem statement

Historically, a per-chunk JS API forced **every PCM chunk** through the JS ↔ native bridge twice (input `number[]` and denoised output map). That path has been **removed**; streaming enhancement is **`enhance` + `LiveAudioBuffer`** only (see current TypeScript in §3.1).

### Goal

Replace the per-chunk JS bridge approach with a **native-native streaming pipeline** where:

1. A **producer** (mic, file playback, or JS append) writes chunks into an **input `LiveAudioBuffer`**.
2. A **native worker thread** continuously drains the input buffer, runs `OnlineSpeechDenoiser`, and appends denoised samples to an **output `LiveAudioBuffer`**.
3. A **downstream consumer** (STT, PCM player, another pipeline, or JS) independently reads from the output buffer — **in parallel** while enhancement is still producing.

JS only orchestrates **start / stop / status**. PCM data never crosses the bridge during steady-state operation.

---

## 2. Relationship to other pipeline features

### 2.1 Feature matrix

| Feature | Buffer kind | Direction |
| --- | --- | --- |
| **Offline enhancement** | `OfflineAudioBuffer` → `OfflineAudioBuffer` | Batch; no parallelism |
| **Online enhancement (this spec)** | `LiveAudioBuffer` → `LiveAudioBuffer` | Streaming; parallel consumers |
| **Offline STT** | `OfflineAudioBuffer` → result | Batch |
| **Online STT (future)** | `LiveAudioBuffer` → streaming results | Streaming; same cursor model |
| **Online TTS (future)** | `LiveTextBuffer` → `LiveAudioBuffer` | Streaming; same worker model |
| **Online Alignment (future)** | `LiveAudioBuffer` + `LiveTextBuffer` → result | Streaming; multi-input |

### 2.2 Full streaming pipeline vision

The generic infrastructure defined here enables **arbitrary chaining of online stages** where each stage runs on its own native thread. Downstream stages can start processing as soon as the first chunk arrives — no need to wait for the upstream stage to complete:

```text
Mic ──→ LiveAudioBuffer₁ ──→ [Online Enhancement] ──→ LiveAudioBuffer₂ ──→ [Online STT] ──→ LiveTextBuffer₁ ──→ [Online Alignment] ──→ result
             (native worker)                              (native worker)                         (native worker)
```

**Key property:** All stages drain from their respective input buffers via **independent cursors** and run **concurrently** on separate native threads. The ring buffer acts as the coordination mechanism. With offline pipelines, each stage must wait for the previous to fully complete. With online pipelines, stage N+1 starts processing the moment stage N writes its first output chunk.

---

## 3. Current state (as-is)

### 3.1 Public TypeScript

```ts
// src/enhancement/streamingTypes.ts (public)
interface StreamingEnhancementEngine {
  readonly instanceId: string;
  getSampleRate(): Promise<number>;
  getFrameShiftInSamples(): Promise<number>;
  destroy(): Promise<void>;
  enhance(
    inputBufferId: string,
    outputBufferId: string
  ): Promise<EnhancementPipelineHandle>;
}
```

**Initialization:** `createStreamingEnhancement()` returns **`StreamingEnhancementEngine`** (user docs call this the **`denoiser`**; buffer pipeline **`enhance`** only; no JS chunk feed).

**Resolved (removed):** prior `feedSamples` / `flush` / `reset` returning audio over the bridge — replaced by **`LiveAudioBuffer`** → **`LiveAudioBuffer`** pipeline only.

### 3.2 TurboModule (`src/NativeSherpaOnnx.ts`)

```ts
initializeOnlineEnhancement(instanceId, modelDir, modelType?, numThreads?, provider?, debug?)
  → Promise<{ success, error?, sampleRate?, frameShiftInSamples? }>
unloadOnlineEnhancement(instanceId) → Promise<void>
getEnhancementSampleRate(instanceId) → Promise<number>
startEnhancementPipeline(instanceId, inputBufferId, outputBufferId) → Promise<{ pipelineId }>
stopStreamingPipeline / flushStreamingPipeline / resetStreamingPipeline / getStreamingPipelineStatus
```

### 3.3 Native Android (`SherpaOnnxEnhancementHelper.kt`)

- `OnlineSpeechDenoiser` wraps sherpa-onnx C++ `OnlineSpeechDenoiser`.
- **`EnhancementPipelineWorker`** calls `denoiser.run` / `flush` / `reset` on the worker thread; output goes to **`LiveEntry.appendSamples`** — not over the TurboModule as bulk PCM.
- `denoiser.sampleRate` / `denoiser.frameShiftInSamples` → model intrinsics.

### 3.4 Native iOS (`SherpaOnnx+Enhancement.mm`)

- `OnlineEnhancementWrapper` wraps C++ `OnlineSpeechDenoiser`.
- **`EnhancementPipelineWorker`** calls `wrapper->runSamples` / `flush` / `reset` on the worker thread; output is appended to the live output buffer — no JS return of full denoised arrays for streaming.

### 3.5 Existing `LiveEntry` infrastructure

Both platforms implement a **thread-safe ring buffer with independent consumer cursors**:

**Android (`LiveEntry.kt`):**

| Method | Description |
|---|---|
| `appendSamples(samples, inputSampleRate, source)` | Write-lock; auto-resample; monotonic `totalSamplesWritten` |
| `createCursorHandle() → Int` | New independent read head at oldest available sample |
| `drainCursor(cursorId, maxSamples) → FloatArray` | Advance cursor; returns 0..maxSamples available samples |
| `peekCursor(cursorId, maxSamples) → FloatArray` | Same but non-advancing |
| `releaseCursor(cursorId)` | Free cursor handle |
| `finalize_()` | Transition `RECORDING → FINISHED`; patches spool header |

**iOS (`PaLiveEntry` in `SherpaOnnx+PipelineAudio.mm`):**

| Method | Description |
|---|---|
| `appendSamples(data, count, inputRate, source)` | Mutex-guarded ring write; auto-resample |
| `createCursorHandle() → int` | New cursor at oldest available |
| `drainCursor(cursorId, maxSamples) → vector<float>` | Advance; returns available samples |
| `finalize_()` | State transition; WAV header patch |

Both use `ReentrantReadWriteLock` (Android) / `std::mutex` (iOS) — **concurrent append + drain is safe**.

---

## 4. Target API (concrete)

### 4.1 Generic streaming pipeline types (shared across all features)

These types live in a new shared location (e.g. `src/pipeline/streamingTypes.ts` or a section of `src/audiobuffer/types.ts`) and are reused by enhancement, STT, TTS, alignment, and future features.

```ts
// ── Generic pipeline handle and status (feature-agnostic) ──

/**
 * Status snapshot of a running streaming pipeline.
 * Identical structure for all pipeline types (enhancement, STT, TTS, etc.).
 */
export interface StreamingPipelineStatus {
  /** Whether the native worker loop is currently active. */
  isRunning: boolean;
  /** Number of processing invocations completed (chunks for enhancement, frames for STT, etc.). */
  chunksProcessed: number;
  /** Total samples/units read from the input buffer so far. */
  samplesRead: number;
  /** Total samples/units written to the output buffer so far. */
  samplesWritten: number;
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

  /**
   * Stop the pipeline.
   * The native worker finishes its current chunk, then exits.
   * Returns after the worker has fully stopped (blocking).
   * Calling stop on an already-stopped pipeline is a no-op.
   */
  stop(): Promise<void>;

  /**
   * Flush the processor's internal state.
   * Enqueues a flush command on the native worker thread and **blocks** until
   * the worker has processed it. Guarantees all buffered output has been written
   * to the output buffer when the promise resolves.
   * The pipeline continues running after flush (ready for more input).
   */
  flush(): Promise<void>;

  /**
   * Reset the processor's internal state without stopping the pipeline.
   * Enqueues a reset command on the native worker thread and **blocks** until
   * the worker has processed it.
   * Use when starting a new utterance mid-stream (speaker turn, silence gap).
   */
  reset(): Promise<void>;

  /**
   * Query pipeline status. Non-blocking.
   */
  getStatus(): Promise<StreamingPipelineStatus>;
}
```

### 4.2 Enhancement-specific TypeScript types

```ts
// ── src/enhancement/streamingTypes.ts (replaces current interface) ──

import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle, StreamingPipelineStatus } from '../pipeline/streamingTypes';
import type { EnhancementInitializeOptions } from './types';

export type StreamingEnhancementInitializeOptions = EnhancementInitializeOptions;

/**
 * Enhancement-specific pipeline handle.
 * Extends the generic StreamingPipelineHandle with the engine's instanceId.
 */
export interface EnhancementPipelineHandle extends StreamingPipelineHandle {
  /** The enhancement engine instance driving this pipeline. */
  readonly instanceId: string;
}

/**
 * Returned by `createStreamingEnhancement`. Online denoiser: native live-buffer path (`enhance`) only.
 *
 * Offline batch remains separate:
 * - `EnhancementEngine.enhance(offline, offline)` → `Promise<void>` (batch, resolves when done).
 * - `StreamingEnhancementEngine.enhance(liveIn, liveOut)` → `Promise<EnhancementPipelineHandle>` (pipeline started).
 */
export interface StreamingEnhancementEngine {
  readonly instanceId: string;

  /**
   * Start a native streaming enhancement pipeline.
   * A dedicated background worker thread drains `audioIn`, runs the denoiser chunk by chunk,
   * and appends denoised PCM to `audioOut`.
   *
   * - `audioIn` must be a live audio buffer in `recording` state.
   * - `audioOut` must be a live audio buffer in `recording` state (empty or accumulating).
   * - `audioIn.sampleRate` must equal the denoiser's sample rate (strict validation).
   * - Only one pipeline per engine instance at a time (denoiser has internal state).
   *
   * Returns a handle to control and inspect the running pipeline.
   */
  enhance(
    audioIn: LiveAudioBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
  ): Promise<EnhancementPipelineHandle>;

  /** Model's expected sample rate in Hz. */
  getSampleRate(): Promise<number>;

  /** Model's recommended chunk size in samples (frame shift). */
  getFrameShiftInSamples(): Promise<number>;

  /**
   * Destroy the engine. Stops any running pipeline first.
   * After this call, the engine instance is unusable.
   */
  destroy(): Promise<void>;
}
```

**Naming rationale:** Offline vs streaming are separate types from separate entry points (`createEnhancement` vs `createStreamingEnhancement`). On the streaming denoiser (`StreamingEnhancementEngine`), **`enhance(live, live)`** return type disambiguates from offline **`enhance(offline, offline)`** (`Promise<void>`).

| Type | Method | Return | Semantics |
|---|---|---|---|
| `EnhancementEngine` | `enhance(offlineIn, offlineOut)` | `Promise<void>` | Batch; resolves **when complete** |
| `StreamingEnhancementEngine` | `enhance(liveIn, liveOut)` | `Promise<EnhancementPipelineHandle>` | Native pipeline; resolves **when started** |

### 4.3 TurboModule methods

The TurboModule splits into **feature-specific start** (because each feature has different init params) and **generic control** (because stop/flush/reset/status are identical across all pipeline types).

```ts
// ── src/NativeSherpaOnnx.ts ──

// ==================== KEEP (unchanged) ====================
// initializeOnlineEnhancement(instanceId, modelDir, modelType?, numThreads?, provider?, debug?)
// unloadOnlineEnhancement(instanceId)
// getEnhancementSampleRate(instanceId)

// ==================== REMOVE ====================
// feedEnhancementSamples(instanceId, samples, sampleRate)
// flushOnlineEnhancement(instanceId)
// resetOnlineEnhancement(instanceId)

// ==================== ADD: Feature-specific pipeline start ====================

/** Launch a streaming enhancement worker. */
startEnhancementPipeline(
  instanceId: string,
  audioInLiveBufferId: string,
  audioOutLiveBufferId: string,
): Promise<{ pipelineId: string }>;

// Future: startSttPipeline(streamId, audioInLiveBufferId): Promise<{ pipelineId }>
// Future: startTtsPipeline(instanceId, textInBufferId, audioOutLiveBufferId): Promise<{ pipelineId }>

// ==================== ADD: Generic pipeline control ====================
// These operate on ANY pipeline type via pipelineId.

stopStreamingPipeline(pipelineId: string): Promise<void>;
flushStreamingPipeline(pipelineId: string): Promise<void>;
resetStreamingPipeline(pipelineId: string): Promise<void>;

getStreamingPipelineStatus(pipelineId: string): Promise<{
  isRunning: boolean;
  chunksProcessed: number;
  samplesRead: number;
  samplesWritten: number;
  error?: string;
}>;
```

**Design rationale:**
- **Feature-specific start** because each pipeline type needs different creation parameters (enhancement = `instanceId` + `audioIn` + `audioOut`; STT = `streamId` + `audioIn`; TTS = `instanceId` + `textIn` + `audioOut`).
- **Generic control** because stop/flush/reset/status are identical operations regardless of pipeline type. One set of TurboModule methods serves all features — no duplication.
- The native `StreamingPipelineRegistry` maps `pipelineId → StreamingPipelineWorker` regardless of feature type.

### 4.4 Generic native pipeline infrastructure

#### 4.4.1 `StreamingPipelineWorker` interface (Android)

```kotlin
// New file: android/src/main/java/com/sherpaonnx/audio/pipeline/StreamingPipelineWorker.kt

import java.util.concurrent.CompletableFuture

/**
 * Generic interface for all streaming pipeline workers.
 * Enhancement, STT, TTS workers all implement this.
 */
interface StreamingPipelineWorker {
  val pipelineId: String
  val isRunning: Boolean

  /** Start the worker loop on a dedicated background thread. */
  fun start()

  /**
   * Signal the worker to stop. Returns after the worker thread has exited.
   * Idempotent: calling stop on a stopped worker is a no-op.
   */
  fun stop()

  /**
   * Enqueue a flush command. Returns a future that completes when the worker
   * thread has processed the flush (synchronous from the caller's perspective).
   */
  fun flush(): CompletableFuture<Unit>

  /**
   * Enqueue a reset command. Returns a future that completes when the worker
   * thread has processed the reset.
   */
  fun reset(): CompletableFuture<Unit>

  /** Snapshot current status. Thread-safe, non-blocking. */
  fun getStatus(): StreamingPipelineStatus

  /** Release all resources (cursor handles, thread). Called by registry on removal. */
  fun release()
}

data class StreamingPipelineStatus(
  val isRunning: Boolean,
  val chunksProcessed: Long,
  val samplesRead: Long,
  val samplesWritten: Long,
  val error: String? = null,
)
```

#### 4.4.2 `StreamingPipelineRegistry` (Android)

```kotlin
// New file: android/src/main/java/com/sherpaonnx/audio/pipeline/StreamingPipelineRegistry.kt

object StreamingPipelineRegistry {
  private val pipelines = ConcurrentHashMap<String, StreamingPipelineWorker>()

  /** Register and start a worker. Returns the generated pipelineId. */
  fun registerAndStart(worker: StreamingPipelineWorker): String {
    pipelines[worker.pipelineId] = worker
    worker.start()
    return worker.pipelineId
  }

  fun get(pipelineId: String): StreamingPipelineWorker? = pipelines[pipelineId]

  fun stop(pipelineId: String) {
    pipelines[pipelineId]?.stop()
  }

  fun remove(pipelineId: String) {
    pipelines.remove(pipelineId)?.release()
  }

  /** Stop and remove all pipelines (e.g. on catalyst instance destroy). */
  fun clear() {
    pipelines.values.forEach { it.release() }
    pipelines.clear()
  }
}
```

#### 4.4.3 iOS equivalents

```cpp
// New or extended: ios/pipeline/core/SherpaOnnx+StreamingPipeline.h

/**
 * Generic streaming pipeline worker interface.
 * All feature-specific workers (enhancement, STT, TTS) derive from this.
 */
class StreamingPipelineWorker {
public:
  std::string pipelineId;
  std::atomic<bool> isRunning{false};

  virtual ~StreamingPipelineWorker() = default;
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual void flush(std::promise<void> completion) = 0;
  virtual void reset(std::promise<void> completion) = 0;
  virtual StreamingPipelineStatus getStatus() = 0;
  virtual void release() = 0;
};

struct StreamingPipelineStatus {
  bool isRunning;
  int64_t chunksProcessed;
  int64_t samplesRead;
  int64_t samplesWritten;
  std::string error;
};

// Global registry (analogous to g_pa_live / g_pa_offline)
extern std::unordered_map<std::string, std::shared_ptr<StreamingPipelineWorker>> g_streaming_pipelines;
extern std::mutex g_streaming_pipeline_mutex;
```

### 4.5 Enhancement-specific pipeline worker (Android)

```kotlin
// New file: android/src/main/java/com/sherpaonnx/audio/pipeline/EnhancementPipelineWorker.kt

class EnhancementPipelineWorker(
  override val pipelineId: String,
  private val denoiser: OnlineSpeechDenoiser,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveEntry,
) : StreamingPipelineWorker {

  private val executor = Executors.newSingleThreadExecutor()
  override var isRunning: Boolean = false
    @Volatile private set

  private var chunksProcessed = 0L
  private var samplesRead = 0L
  private var samplesWritten = 0L
  private var error: String? = null
  private var cursorId: Int = -1

  // ── Condition variable: zero-latency wakeup when input has data ──
  private val lock = ReentrantLock()
  private val dataAvailable: Condition = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  // ── Command queue for blocking flush/reset ──
  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    cursorId = inputEntry.createCursorHandle()

    // Register append listener to signal condition variable
    appendListener = { _ ->
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val chunkSize = denoiser.frameShiftInSamples
    val sampleRate = denoiser.sampleRate
    try {
      while (isRunning) {
        // 1. Process any pending commands (flush/reset)
        processCommands()

        // 2. Drain input
        val chunk = inputEntry.drainCursor(cursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            // Input stream ended → auto-flush and stop
            val flushed = denoiser.flush()
            if (flushed.samples.isNotEmpty()) {
              outputEntry.appendSamples(flushed.samples, sampleRate,
                source = LIVE_APPEND_SOURCE_ENHANCEMENT)
              samplesWritten += flushed.samples.size
            }
            isRunning = false
            break
          }
          // Wait for signal from input buffer (zero-latency wakeup)
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS) // timeout as safety net
          }
          continue
        }

        // 3. Denoise and write to output
        val denoised = denoiser.run(chunk, sampleRate)
        outputEntry.appendSamples(denoised.samples, sampleRate,
          source = LIVE_APPEND_SOURCE_ENHANCEMENT)

        samplesRead += chunk.size
        samplesWritten += denoised.samples.size
        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message
      isRunning = false
    } finally {
      inputEntry.releaseCursor(cursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            val flushed = denoiser.flush()
            if (flushed.samples.isNotEmpty()) {
              outputEntry.appendSamples(flushed.samples, denoiser.sampleRate,
                source = LIVE_APPEND_SOURCE_ENHANCEMENT)
              samplesWritten += flushed.samples.size
            }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            denoiser.reset()
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
    lock.withLock { dataAvailable.signal() } // wake worker so it exits
    executor.shutdown()
    executor.awaitTermination(5, TimeUnit.SECONDS)
  }

  override fun flush(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Flush(future))
    lock.withLock { dataAvailable.signal() } // wake worker to process command
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
    samplesRead = samplesRead,
    samplesWritten = samplesWritten,
    error = error,
  )

  override fun release() {
    stop()
  }
}
```

### 4.6 Enhancement-specific pipeline worker (iOS)

Mirror Android using `std::thread` + `std::condition_variable`:

```cpp
class EnhancementPipelineWorker : public StreamingPipelineWorker {
  OnlineEnhancementWrapper *wrapper;
  std::shared_ptr<PaLiveEntry> inputEntry;
  std::shared_ptr<PaLiveEntry> outputEntry;
  std::thread workerThread;
  std::mutex mtx;
  std::condition_variable cv;
  // Command queue: vector<PipelineCommand> + mutex
  // Same runLoop structure as Android: drain → denoise → append
  // Same command processing: flush/reset via queue + std::promise<void>
};
```

### 4.7 `LiveEntry` extension: append listener list

To support condition-variable wakeup, `LiveEntry` needs a **multi-listener** append notification mechanism (the existing single `onFramesAppendedListener` is used for JS event emission and must not be replaced):

**Android (`LiveEntry.kt`):**
```kotlin
// Add to LiveEntry class:
private val appendListeners = CopyOnWriteArrayList<(LiveFramesAppendedEvent) -> Unit>()

fun addAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
  appendListeners.add(listener)
}

fun removeAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
  appendListeners.remove(listener)
}

// In dispatchFramesAppended(), after existing listener call:
for (listener in appendListeners) {
  listener(event)
}
```

**iOS (`PaLiveEntry`):**
```cpp
// Add to PaLiveEntry struct:
std::vector<std::function<void()>> appendListeners;
std::mutex appendListenerMutex;

void addAppendListener(std::function<void()> listener) { ... }
void removeAppendListener(...) { ... }
// Called at end of appendSamples()
```

### 4.8 New source constant

Add a new `LiveBufferAppendSource` value for enhancement-produced audio:

**Android (`LiveEntry.kt`):**
```kotlin
const val LIVE_APPEND_SOURCE_ENHANCEMENT = "enhancement"
```

**iOS:**
```cpp
static const char *kLiveAppendSourceEnhancement = "enhancement";
```

**TypeScript (`src/audiobuffer/types.ts`):**
```ts
export type LiveBufferAppendSource =
  | 'mic'
  | 'append'
  | 'append_offline'
  | 'enhancement'   // ← NEW
  | 'unknown'
  | 'mixed';
```

This allows downstream consumers (JS event listeners on the output buffer) to distinguish enhanced audio from other sources in `onFramesAppended` callbacks.

---

## 5. Usage example

### Basic: Mic → Enhancement → Save

```ts
import {
  createStreamingEnhancement,
  createLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  saveLiveAudioBufferToWav,
} from 'react-native-sherpa-onnx';

// 1. Create streaming denoiser (loads model)
const denoiser = await createStreamingEnhancement({
  modelPath: { modelDir: '/models/gtcrn' },
});
const sampleRate = await denoiser.getSampleRate(); // e.g. 16000

// 2. Create live buffers (must match denoiser sample rate)
const micBuffer = await createLiveAudioBuffer({ sampleRate });
const enhancedBuffer = await createLiveAudioBuffer({ sampleRate });

// 3. Start native pipeline (background thread: micBuffer → denoise → enhancedBuffer)
const pipeline = await denoiser.enhance(micBuffer, enhancedBuffer);

// 4. Start mic capture (writes directly to micBuffer, no JS involvement)
await startMicToLiveAudioBuffer(micBuffer.bufferId);

// ... audio is now flowing entirely on native threads:
// mic → micBuffer → [enhancement worker] → enhancedBuffer
// A downstream consumer (STT, PCM player) can independently drain enhancedBuffer.

// 5. Later: stop recording
await stopMicToLiveAudioBuffer();
await pipeline.flush();     // flush remaining denoiser state (blocking: resolves when done)
await pipeline.stop();
await finalizeLiveAudioBuffer(micBuffer.bufferId);
await finalizeLiveAudioBuffer(enhancedBuffer.bufferId);

// 6. Save enhanced audio
await saveLiveAudioBufferToWav(enhancedBuffer.bufferId, '/path/to/enhanced.wav');

// 7. Cleanup
await denoiser.destroy();
```

### Parallel composition: Mic → Enhancement → STT (all native-native)

```ts
const micBuffer = await createLiveAudioBuffer({ sampleRate: 16000 });
const enhancedBuffer = await createLiveAudioBuffer({ sampleRate: 16000 });

const enhancer = await createStreamingEnhancement({ modelPath: { modelDir: '...' } });
const enhancePipeline = await enhancer.enhance(micBuffer, enhancedBuffer);

// Future STT streaming pipeline (same pattern, same generic infrastructure):
// const recognizer = await createStreamingSTT({ ... });
// const sttPipeline = await recognizer.transcribe(enhancedBuffer, textOut);

await startMicToLiveAudioBuffer(micBuffer.bufferId);

// Now three native threads work in parallel:
// Thread 1: Mic capture → micBuffer.appendSamples()
// Thread 2: Enhancement worker → micBuffer.drainCursor() → denoise → enhancedBuffer.appendSamples()
// Thread 3: STT worker → enhancedBuffer.drainCursor() → transcribe → emit results
//
// Zero JS bridge traffic for PCM data. Only control messages (start/stop/status) cross the bridge.
```

### Side-by-side: Offline vs Online Enhancement

```ts
// ── Offline (batch) ──
const offlineEngine = await createEnhancement({ modelPath: { modelDir: '...' } });
const inBuf = await createOfflineAudioBufferFromFile('/path/to/noisy.wav');
const outBuf = await createEmptyOfflineAudioBuffer(await offlineEngine.getSampleRate());
await offlineEngine.enhance(inBuf, outBuf);  // ← resolves when COMPLETE
await saveOfflineAudioBufferToWav(outBuf.bufferId, '/path/to/clean.wav');

// ── Online (streaming) ──
const denoiser = await createStreamingEnhancement({ modelPath: { modelDir: '...' } });
const micBuf = await createLiveAudioBuffer({ sampleRate: 16000 });
const outLive = await createLiveAudioBuffer({ sampleRate: 16000 });
const pipeline = await denoiser.enhance(micBuf, outLive);  // ← resolves when STARTED
// ... mic writes chunks, enhancement processes in parallel, downstream drains ...
await pipeline.flush();
await pipeline.stop();
```

---

## 6. Errors

| Code | Meaning |
| --- | --- |
| `ONLINE_ENHANCEMENT_INIT_ERROR` | Model dir invalid / unsupported type / native init failure (existing) |
| `ENHANCEMENT_PIPELINE_ALREADY_RUNNING` | `enhance()` called while a pipeline on this denoiser instance is already active |
| `ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND` | Live buffer id not found in registry |
| `ENHANCEMENT_PIPELINE_BUFFER_KIND_MISMATCH` | Non-live buffer passed (must be `live_*`) |
| `ENHANCEMENT_PIPELINE_BUFFER_NOT_RECORDING` | Buffer already finalized; cannot start pipeline on it |
| `ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH` | Input buffer's `sampleRate` does not match the denoiser's `sampleRate` |
| `STREAMING_PIPELINE_NOT_FOUND` | `pipelineId` not found (stop/flush/reset/status on unknown id) — generic, used by all pipeline types |
| `STREAMING_PIPELINE_ERROR` | Worker thread crashed during processing — generic |

---

## 7. Behavioral contracts

### 7.1 One pipeline per engine

An engine holds **one** `OnlineSpeechDenoiser` instance with **internal state**. Running two pipelines on the same engine would corrupt denoiser state. Therefore:
- `enhance()` rejects with `ENHANCEMENT_PIPELINE_ALREADY_RUNNING` if a pipeline is active.
- `destroy()` calls `stop()` on any running pipeline first.

### 7.2 Strict sample rate validation

`enhance()` validates that `inputBuffer.sampleRate === denoiser.sampleRate` before starting the worker. If they differ, the call is rejected with `ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH`. This avoids hidden resampling and ensures predictable behavior. The SDK consumer must create buffers at the correct rate (available via `getSampleRate()` after engine creation).

### 7.3 Input finalization → auto-flush + auto-stop

When the input buffer transitions to `FINISHED` state and the cursor has drained all remaining samples:
- The worker **automatically** calls `denoiser.flush()` and appends flushed samples to output.
- The worker **exits its loop** (sets `isRunning = false`).
- The pipeline can be queried via `getStatus()` to detect this.
- The output buffer is **not** auto-finalized (the caller decides when to finalize, e.g. after chaining another stage).

Re-running requires calling `enhance()` again with new buffers (which also resets the denoiser). This is simple and predictable.

### 7.4 Ring buffer overflow (backpressure)

If a downstream consumer is slower than the enhancement producer:
- `LiveEntry.appendSamples()` overwrites oldest samples in the ring (`totalSamplesDropped` increments).
- The downstream cursor's `absoluteReadPos` snaps forward to the oldest available sample.
- Some audio data is lost — this is **acceptable** for real-time streaming (same behavior as mic overflow).
- No error is raised; this is observable via `getPipelineAudioBufferInfo()` → `totalSamplesDropped`.

### 7.5 Flush semantics (blocking)

`flush()` on the pipeline handle:
- Enqueues a flush command on the native worker thread's command queue.
- The JS caller **blocks** until the worker processes the command.
- Guarantees: when the promise resolves, all internally buffered samples have been written to audioOut.
- The pipeline **continues running** after flush (ready for more input).
- Use case: call before `finalizeLiveAudioBuffer(audioOut)` to ensure no samples are lost.

Implementation: `CompletableFuture<Unit>` (Android) / `std::promise<void>` (iOS) that the worker completes after processing the flush. The worker checks its command queue on each iteration before draining input.

### 7.6 Reset semantics (blocking)

`reset()` on the pipeline handle:
- Enqueues a reset command on the native worker thread's command queue.
- The JS caller **blocks** until the worker processes the command.
- Clears the denoiser's internal overlap/state buffers.
- The pipeline **keeps running** and processes subsequent input as a new stream.
- Use case: speaker turn change, or recovering from a long silence.

### 7.7 Worker wait strategy (condition variable)

The worker drains `frameShiftInSamples` samples per iteration. When no samples are available:
- The worker **waits on a condition variable** (`Condition` on Android, `std::condition_variable` on iOS).
- `LiveEntry.appendSamples()` **signals** the condition after writing new data (via `addAppendListener`).
- A **safety timeout** of 10 ms guards against missed signals.
- This yields **zero-latency wakeup** in the common case (new data signals the worker immediately) while consuming no CPU during silence.

### 7.8 Output source tagging

The enhancement worker writes output with `source = "enhancement"` (new constant `LIVE_APPEND_SOURCE_ENHANCEMENT`). This allows downstream JS event listeners on the output buffer to distinguish enhanced audio from other sources in `onFramesAppended` callbacks.

### 7.9 Pipeline lifecycle events

The output buffer's existing `emitAppendedEvents` mechanism provides **progress-like** updates (frame counts, throttled by `appendEventMinIntervalMs`). No enhancement-specific JS events are emitted per chunk.

Additionally, the pipeline emits **lifecycle events** for state transitions:
- **started** — when the worker loop begins.
- **stopped** — when the worker loop exits (normal or auto-stop on input finalization).
- **error** — when the worker crashes.

These lifecycle events are accessible via `getStatus()` polling. If needed in the future, native event emission (via `RCTDeviceEventEmitter` / `sendEvent`) can be added for lifecycle changes only — minimal bridge traffic.

---

## 8. Migration plan

| Phase | Work |
| --- | --- |
| **P0** | This spec (done). |
| **P1** | **Generic infrastructure (Android):** `StreamingPipelineWorker` interface + `StreamingPipelineRegistry` + `StreamingPipelineStatus` data class. Add `addAppendListener` / `removeAppendListener` to `LiveEntry`. Add `LIVE_APPEND_SOURCE_ENHANCEMENT` constant. |
| **P2** | **Generic infrastructure (iOS):** Mirror P1 — `StreamingPipelineWorker` base class, global registry map, `PaLiveEntry` append listener list. |
| **P3** | **Enhancement worker (Android):** `EnhancementPipelineWorker` implementing `StreamingPipelineWorker`. Condition variable wakeup, command queue for blocking flush/reset, sample rate validation. Wire `startEnhancementPipeline` into `SherpaOnnxModule`. |
| **P4** | **Enhancement worker (iOS):** Mirror P3 — `EnhancementPipelineWorker` subclass, `std::thread` + `std::condition_variable`, same command queue pattern. |
| **P5** | **TurboModule:** Add `startEnhancementPipeline`. Add generic `stopStreamingPipeline`, `flushStreamingPipeline`, `resetStreamingPipeline`, `getStreamingPipelineStatus`. Remove `feedEnhancementSamples`, `flushOnlineEnhancement`, `resetOnlineEnhancement`. |
| **P6** | **TypeScript:** Generic `StreamingPipelineHandle` / `StreamingPipelineStatus` types. `StreamingEnhancementEngine` + `createStreamingEnhancement` include `enhance()`. Add `"enhancement"` to `LiveBufferAppendSource`. Update exports. |
| **P7** | **Example app:** Streaming enhancement screen using buffer pipeline (mic → enhance → save). |
| **P8** | **Documentation:** Online buffer pipeline examples live in `docs/enhancement-streaming.md` (overview: `docs/speech-enhancement.md`). |
| **P9** | **Cleanup:** Remove dead native code paths (old `feedSamples` JNI/ObjC selectors, `normalizeEnhancedAudio`, old TurboModule methods). |

---

## 9. Acceptance criteria

- [ ] Generic `StreamingPipelineWorker` interface exists on Android and iOS; generic `StreamingPipelineRegistry` manages all pipeline types.
- [ ] No `feedEnhancementSamples` / `flushOnlineEnhancement` / `resetOnlineEnhancement` on public API.
- [ ] `StreamingEnhancementEngine.enhance(liveIn, liveOut)` returns `Promise<EnhancementPipelineHandle>`.
- [ ] Streaming enhancement uses **only** live buffer IDs on the TurboModule wire.
- [ ] PCM data **never** crosses the JS ↔ native bridge during steady-state pipeline operation.
- [ ] Generic `stopStreamingPipeline` / `flushStreamingPipeline` / `resetStreamingPipeline` / `getStreamingPipelineStatus` work via `pipelineId` regardless of feature type.
- [ ] Android and iOS implement identical `pipelineId`-based control contract.
- [ ] Example app demonstrates: mic → enhancement → save (no per-chunk JS calls).
- [ ] `getStatus()` correctly reports `chunksProcessed`, `samplesRead`, `samplesWritten`.
- [ ] Input finalization triggers auto-flush + auto-stop.
- [ ] `flush()` and `reset()` are blocking: promise resolves only after the native worker thread has processed the command.
- [ ] Worker uses condition variable signaling (zero-latency wakeup), not polling/sleep.
- [ ] Sample rate mismatch between input buffer and denoiser is rejected at `enhance()` time.
- [ ] Output buffer `source` field is `"enhancement"` for all pipeline-produced samples.
- [ ] `LiveEntry` supports multiple append listeners (existing JS event emission unaffected).

---

## 10. Resolved design decisions

All questions from the original spec review have been resolved. Decisions are documented here for traceability.

### Q1: Pipeline registry scope → **Generic (Option B)**

A single `StreamingPipelineWorker` interface and `StreamingPipelineRegistry` serve all online features (enhancement, STT, TTS, alignment). Feature-specific workers implement the generic interface. TurboModule exposes feature-specific `start*Pipeline` methods (parameters differ per feature) but **generic** control methods (`stopStreamingPipeline`, `flushStreamingPipeline`, `resetStreamingPipeline`, `getStreamingPipelineStatus`) that operate on any `pipelineId`.

**Rationale:** All online features will use this pattern. Building generic from the start avoids N registries and an eventual refactoring pass.

### Q2: Worker thread strategy → **Dedicated thread (Option A)**

Each pipeline gets its own `Executors.newSingleThreadExecutor()` (Android) / `std::thread` (iOS). In a typical use case (1 enhancement + 1 STT = 2 threads), this is straightforward and avoids scheduling contention.

### Q3: Sample rate validation → **Strict reject (Option A)**

`enhance()` / `startEnhancementPipeline` validates `inputBuffer.sampleRate === denoiser.sampleRate` and rejects with `ENHANCEMENT_PIPELINE_SAMPLE_RATE_MISMATCH` on mismatch. No hidden resampling. The SDK consumer creates buffers at the correct rate (available via `getSampleRate()`).

### Q4: Input finalization behavior → **Auto-flush + auto-stop**

When the input buffer is finalized and the cursor is fully drained, the worker auto-flushes the denoiser and exits. Re-running requires a new `enhance()` call with new buffers. Simple and predictable.

### Q5: Output source field → **`"enhancement"` (Option A)**

New constant `LIVE_APPEND_SOURCE_ENHANCEMENT = "enhancement"` on both platforms. Downstream `onFramesAppended` callbacks can distinguish enhanced audio from mic audio.

### Q6: Flush/reset blocking → **Synchronous (Option A)**

`flush()` and `reset()` enqueue commands and block the caller until the native worker processes them. Implemented via `CompletableFuture<Unit>` (Android) / `std::promise<void>` (iOS). Guarantees correct sequencing for patterns like `await pipeline.flush(); await finalizeLiveAudioBuffer(...)`.

### Q7: Worker sleep strategy → **Condition variable (Option B)**

The worker waits on a condition variable when no data is available. `LiveEntry.appendSamples()` signals via `addAppendListener` (new multi-listener mechanism on `LiveEntry`). A 10 ms safety timeout guards against missed signals. This achieves zero-latency wakeup in the common case.

### Q8: Naming → **`enhance()` on both enhancement types**

| Initialization | Type | Method | Return |
|---|---|---|---|
| `createEnhancement()` | `EnhancementEngine` | `enhance(offlineIn, offlineOut)` | `Promise<void>` (done) |
| `createStreamingEnhancement()` | `StreamingEnhancementEngine` | `enhance(liveIn, liveOut)` | `Promise<EnhancementPipelineHandle>` (started) |

Receiver type + return type disambiguate statically. This is idiomatic TypeScript (same method name, different types).

### Q9: feedSamples escape hatch → **Remove entirely (Option A)**

No `feedSamples` in the public API. Buffer-only. Breaking changes are OK (SDK not published). One-shot denoising: create live buffer → append → finalize → enhance → drain.

### Q10: Pipeline events to JS → **Lifecycle events via getStatus + existing LiveBuffer events for progress**

- No per-chunk JS events from the pipeline (defeats zero-bridge purpose).
- Output buffer's existing `emitAppendedEvents` + `onFramesAppended` with `source: "enhancement"` provides progress-like updates.
- Pipeline lifecycle (started/stopped/error) is available via `getStatus()` polling.
- Future option: add native event emission for lifecycle changes only (Option C) if needed — minimal bridge traffic.

---

## 11. Related documents

- [Offline enhancement buffer pipeline spec](../enhancement/offline-enhancement-buffer-pipeline-spec.md) — reference for offline `enhance()` naming and buffer pattern
- [Pipeline audio buffers — live / streaming](../../audiobuffer-streaming.md) · [overview](../../audiobuffer.md)
- [Speech enhancement — streaming](../../enhancement-streaming.md) · [overview](../../speech-enhancement.md)
- [STT buffer-only plan](../stt/stt-pipeline-buffer-only-api-plan.md) — will reuse `StreamingPipelineWorker` + `StreamingPipelineRegistry`
