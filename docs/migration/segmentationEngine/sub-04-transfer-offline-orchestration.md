# Sub-Plan 04: Transfer & Offline Orchestration

## Status
- Draft
- Depends on: Sub-Plan 01, 02, 03

## Purpose

Define `transferOfflineAudioBufferFromLive` for zero-copy live→offline conversion, and the offline segmented processing orchestration loop for both text and audio.

---

## Part A: transferOfflineAudioBufferFromLive

### Problem

In Mode 2 (offline with segmentation), per-segment results are collected in a `LiveAudioBuffer`. Converting to the final `OfflineAudioBuffer` via `createOfflineAudioBufferFromLive('fullIfSpooled')` copies the entire spool (strip WAV header → write .f32 → mmap). For large audio, this is slow and doubles disk usage temporarily.

### Solution: Ownership Transfer

Instead of copy, **transfer ownership** of the spool file from the Live buffer to the Offline buffer.

### API

```typescript
/**
 * Transfer a finalized LiveAudioBuffer's spool to an OfflineAudioBuffer.
 * Zero-copy: the spool file is adopted, not copied.
 * The LiveAudioBuffer is invalidated after transfer.
 */
function transferOfflineAudioBufferFromLive(
  liveBuffer: LiveAudioBufferRef,
  mode: 'fullIfSpooled'
): OfflineAudioBufferRef;
```

### Invariants

| # | Invariant | Error if violated |
|---|---|---|
| 1 | Live buffer must be in `finished` state | `INVALID_STATE` |
| 2 | Spool must exist and be complete | `SPOOL_UNAVAILABLE` |
| 3 | No active cursors or writers | `CURSORS_ACTIVE` |
| 4 | Atomic ownership handoff | Internal (no partial state) |
| 5 | Live buffer invalidated after | `BUFFER_INVALIDATED` on any op |
| 6 | Crash-safe: cleanup on failure | Internal |

### File Format: dataOffsetBytes

**Current state:**
- LiveAudioBuffer spool = Float32 WAV (44-byte header + raw F32 samples)
- OfflineAudioBuffer file = raw .f32 (no header, byte 0 = first sample)

**Problem:** Direct file transfer doesn't work because the offline reader expects byte 0 = sample, but the WAV file has a 44-byte header.

**Solution: Add `dataOffsetBytes` to FileBacked variant.**

```kotlin
// Android
data class FileBacked(
    // ... existing fields ...
    val dataOffsetBytes: Long = 0  // NEW: skip this many bytes before sample data
) : OfflineEntry()
```

```cpp
// iOS
struct PaOfflineFileBacked {
    // ... existing fields ...
    int64_t dataOffsetBytes = 0;  // NEW
};
```

**Impact on readers:**

| Reader | Change needed |
|---|---|
| `readAllSamples()` | Start read at `dataOffsetBytes` instead of byte 0 |
| `readSlice(start, count)` | Offset = `dataOffsetBytes + start * 4` |
| `floatPtr()` (iOS) | Base pointer = `mmapBase + dataOffsetBytes` |
| `numSamples` calculation | `numSamples = (fileSize - dataOffsetBytes) / 4` |
| mmap region | Map from `dataOffsetBytes` to end (or map full file, adjust base pointer) |

This is a small, localized change. All reader methods already go through a central access path.

### Transfer Flow

```
1. Validate invariants (state, spool, no cursors)
2. Finalize spool WAV header (ensure data-size patched)
3. Create OfflineEntry::FileBacked {
       filePath = liveBuffer.spoolPath,
       dataOffsetBytes = 44,  // WAV header size
       numSamples = (fileSize - 44) / 4,
       sampleRate = liveBuffer.sampleRate,
       storageKind = 'mmap'
   }
4. Setup mmap on the transferred file
5. Register OfflineAudioBuffer in buffer registry
6. Invalidate LiveAudioBuffer:
     - Set state to 'invalidated'
     - Clear ring buffer
     - Remove from live registry
     - Do NOT delete spool file (ownership transferred)
7. Return OfflineAudioBufferRef
```

### Cleanup Responsibility

| Scenario | Who deletes the spool file |
|---|---|
| Normal: transfer succeeded | OfflineAudioBuffer on `release()` |
| Error during transfer | LiveAudioBuffer (still owns it) |
| Crash after step 5, before step 6 | Orphan sweep (startup cleanup finds the file) |
| LiveBuffer released without transfer | LiveAudioBuffer on `release()` (existing behavior) |

### Kotlin Implementation Sketch

```kotlin
fun transferOfflineAudioBufferFromLive(
    liveBufferId: String
): String /* offlineBufferId */ {
    val live = liveRegistry.get(liveBufferId)
        ?: throw PaError("BUFFER_NOT_FOUND")
    
    if (live.state != BufferState.FINISHED)
        throw PaError("INVALID_STATE", "Buffer must be finalized")
    
    if (!live.hasSpoolFile())
        throw PaError("SPOOL_UNAVAILABLE")
    
    if (live.hasActiveCursors())
        throw PaError("CURSORS_ACTIVE")
    
    val spoolPath = live.spoolFilePath!!
    val fileSize = File(spoolPath).length()
    val dataOffset = 44L  // WAV header
    val numSamples = ((fileSize - dataOffset) / 4).toInt()
    
    val offlineId = "off_${UUID.randomUUID()}"
    val entry = OfflineEntry.FileBacked(
        bufferId = offlineId,
        sampleRate = live.sampleRate,
        channelCount = 1,
        numSamples = numSamples,
        filePath = spoolPath,
        dataOffsetBytes = dataOffset,
        storageKind = "mmap"
    )
    // Setup mmap
    entry.initMmap()
    
    // Register offline buffer
    offlineRegistry.put(offlineId, entry)
    
    // Invalidate live buffer (do NOT delete spool)
    live.invalidateWithoutSpoolDelete()
    liveRegistry.remove(liveBufferId)
    
    return offlineId
}
```

### When NOT to Use Transfer

| Scenario | Use instead |
|---|---|
| `windowSnapshot` mode | `createOfflineAudioBufferFromLive('windowSnapshot')` — ring copy |
| Small audio (< threshold) | `createOfflineAudioBufferFromLive('fullIfSpooled')` — InMemory is fine |
| Live buffer still needed after | `createOfflineAudioBufferFromLive('fullIfSpooled')` — copy, keep live |

---

## Part B: Offline Segmented Processing Orchestration

### Text Pipeline (Mode 2)

```
OfflineTextBuffer₁ + SegmentationEngine → OfflineConsumer(per seg) → OfflineTextBuffer₂
```

**Flow:**

```
1. segmentOfflineBuffer(textBuffer₁, policy) → OfflineSegmentBuffer
2. for each segment in OfflineSegmentBuffer:
     a. Extract segment text: textBuffer₁.textSlice(seg.startOffset, seg.endOffset)
     b. Create temporary OfflineTextBuffer for segment
     c. Run consumer (e.g., OfflinePunctuation) on temp buffer
     d. Read result text
     e. Append result to in-memory accumulator
     f. Release temp buffers
3. Create OfflineTextBuffer₂ from accumulated results
4. Release OfflineSegmentBuffer
```

**Intermediate storage (final decision):** In-memory string accumulation. Text is small, no spooling needed.
**Non-goal for this path:** do not add active-window/spooling mechanics for text analogous to audio.

**Segment boundary handling:**
- Consumer receives each segment independently → no cross-segment context.
- For punctuation: segment boundaries may affect casing/punctuation at edges.
- Mitigation: overlap N characters at boundaries (configurable).

### Audio Pipeline (Mode 2)

```
OfflineAudioBuffer₁ + SegmentationEngine → OfflineConsumer(per seg) → OfflineAudioBuffer₂
```

**Flow:**

```
1. segmentOfflineBuffer(audioBuffer₁, policy) → OfflineSegmentBuffer
2. Create internal LiveAudioBuffer (accumulator) with spool enabled
3. for each segment in OfflineSegmentBuffer:
     a. Extract segment audio: audioBuffer₁.readSlice(seg.startOffset, seg.endOffset - seg.startOffset)
     b. Create temporary OfflineAudioBuffer for segment (small, InMemory)
     c. Run consumer (e.g., OfflineEnhancement) on temp buffer → temp output buffer
     d. Read result samples from temp output buffer
     e. Append result samples to accumulator LiveAudioBuffer
     f. Release temp buffers (input + output)
4. Finalize accumulator LiveAudioBuffer
5. transferOfflineAudioBufferFromLive(accumulator) → OfflineAudioBuffer₂
6. Release OfflineSegmentBuffer
```

**Why LiveAudioBuffer as accumulator:**
- Per-segment results can be large (audio).
- LiveAudioBuffer with spool writes incrementally to disk.
- No full-result-in-memory requirement.
- `transferOfflineAudioBufferFromLive` provides zero-copy final conversion.

**Segment boundary handling for audio:**
- Enhancement: overlap N ms at segment boundaries, cross-fade.
- STT: context carry-forward (pass last N samples as context).
- Configurable per feature in future specs.

### Orchestrator Interface

```typescript
/**
 * Run an offline consumer with optional segmentation.
 * Handles the segment loop, temp buffer management, and result collection.
 */
interface OfflineOrchestrator<TInput, TOutput> {
  /** The consumer function to run per segment */
  consumer: (input: TInput, output: TOutput) => Promise<void>;
  
  /** Segmentation config (mode='off' for full run) */
  segmentation: SegmentationConfig;
}

// Text example
async function runOfflineTextPipeline(
  input: OfflineTextBufferRef,
  consumer: (segIn: OfflineTextBufferRef, segOut: OfflineTextBufferRef) => Promise<void>,
  segmentation: SegmentationConfig
): Promise<OfflineTextBufferRef>;

// Audio example
async function runOfflineAudioPipeline(
  input: OfflineAudioBufferRef,
  consumer: (segIn: OfflineAudioBufferRef, segOut: OfflineAudioBufferRef) => Promise<void>,
  segmentation: SegmentationConfig
): Promise<OfflineAudioBufferRef>;
```

**Note:** These orchestrator functions are **internal SDK functions** (native), not public API. Features call them to implement their segmented processing. The public API is the feature's own API (e.g., `enhance(audio, { segmentation: ... })`).

---

## Part C: Lifecycle Management & Error Recovery

### Design Principle

> **"Every intermediate buffer has an owner, every owner has a cleanup path, every failure leaves no orphans."**

For a public SDK, we cannot predict how consumers will fail. The orchestrator must guarantee:
1. No leaked native buffers (memory or disk) in any scenario.
2. Deterministic cleanup even on crash.
3. Meaningful partial results when possible.
4. Cancellation support for long-running operations.

---

### OrchestrationSession State Machine

Every call to `runOfflineAudioPipeline` or `runOfflineTextPipeline` creates an internal `OrchestrationSession` that tracks the lifecycle:

```
                  ┌────────────┐
                  │  created    │
                  └──────┬─────┘
                        │ start()
                        ▼
                  ┌────────────┐
           ┌─────┤  running     ├────────┐
           │      └──────┬─────┘         │
           │ cancel()   │ all done     │ segment fails
           ▼            ▼              ▼
    ┌──────────┐ ┌────────────┐ ┌────────────┐
    │cancelled │ │ completing  │ │ recovering  │
    └────┬─────┘ └──────┬─────┘ └────┬───────┘
         │             │ transfer       │ recovery
         │             ▼              │ strategy
         │       ┌────────────┐     │
         ├──────►│    done      │◄────┘ (partial/retry)
         │       └────────────┘
         │       ┌────────────┐
         └──────►│   failed     │◄───── (abort strategy)
                └────────────┘
```

**States:**

| State | Description |
|---|---|
| `created` | Session initialized, no processing started |
| `running` | Segments are being processed sequentially |
| `completing` | All segments done, transferring accumulator to offline |
| `done` | Final result available, all temporaries cleaned up |
| `failed` | Unrecoverable error, all temporaries cleaned up |
| `cancelled` | User cancelled, all temporaries cleaned up |
| `recovering` | A segment failed, recovery strategy is executing |

---

### Accumulator Lifecycle (Audio)

The internal `LiveAudioBuffer` accumulator follows a strict lifecycle:

```
Phase           Accumulator State      Owned By
────────────────────────────────────────────────────────
1. Creation     recording              OrchestrationSession
2. Processing   recording              OrchestrationSession
3. Finalize     finished               OrchestrationSession
4a. Transfer    invalidated            OfflineAudioBuffer (new owner)
4b. Error       released               (freed)
4c. Cancel      released               (freed)
```

**Key invariant:** The `OrchestrationSession` always owns the accumulator until either:
- It transfers ownership to the output `OfflineAudioBuffer` (success), or
- It releases the accumulator (error/cancel).

There is **no state** where the accumulator exists without an owner.

```kotlin
class OrchestrationSession(
    val sessionId: String,
    val inputBuffer: OfflineAudioBufferRef,
    val segments: List<Segment>,
    val config: OrchestrationConfig
) {
    // Accumulator — owned exclusively by this session
    private var accumulator: LiveAudioBuffer? = null
    private var state: SessionState = SessionState.CREATED
    
    // Tracking
    var completedSegments: Int = 0
    var failedSegments: MutableList<FailedSegment> = mutableListOf()
    var skippedSegments: MutableList<Int> = mutableListOf()
    
    fun start() { /* create accumulator, transition to running */ }
    fun cancel() { /* cleanup accumulator, transition to cancelled */ }
    
    /**
     * CRITICAL: cleanup is called in ALL terminal paths.
     * This is the only place where the accumulator is released on non-success.
     */
    private fun cleanupOnFailure() {
        accumulator?.let {
            it.finalize()  // ensure spool is consistent
            it.release()   // free memory + delete spool
            accumulator = null
        }
        cleanupTempBuffers()
    }
}
```

### Temporary Buffer Lifecycle (per-segment)

Each segment creates temporary input/output buffers. These must be cleaned up whether the consumer succeeds or fails:

```kotlin
for (seg in segments) {
    var tempIn: OfflineAudioBuffer? = null
    var tempOut: OfflineAudioBuffer? = null
    try {
        // Create temp input (InMemory, small)
        tempIn = createTempSegmentBuffer(inputBuffer, seg)
        tempOut = createEmptyTempBuffer(inputBuffer.sampleRate)
        
        // Run consumer
        consumer.process(tempIn, tempOut)
        
        // Append result to accumulator
        accumulator.appendSamples(tempOut.readAllSamples())
        completedSegments++
    } catch (e: Exception) {
        handleSegmentError(seg, e)
    } finally {
        // ALWAYS release temp buffers, success or failure
        tempIn?.release()
        tempOut?.release()
    }
}
```

---

### Error Recovery Strategies

The orchestrator supports four strategies, configurable per pipeline call:

```typescript
type ErrorRecoveryStrategy =
  | 'abort'           // stop immediately, release everything, return error
  | 'skip'            // skip failed segment, continue with next, mark as skipped
  | 'retry'           // retry failed segment up to maxRetries, then abort or skip
  | 'partial_result'; // stop on error, but return whatever was processed so far
```

```typescript
interface OrchestrationConfig {
  segmentation: SegmentationConfig;
  
  /** Error recovery strategy (default: 'abort') */
  errorRecovery?: ErrorRecoveryStrategy;
  
  /** Max retries per segment when strategy is 'retry' (default: 2) */
  maxRetriesPerSegment?: number;
  
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  
  /** Progress callback */
  onProgress?: (progress: OrchestrationProgress) => void;
  
  /** Overlap samples at segment boundaries for cross-fade (audio only) */
  overlapSamples?: number;
}
```

#### Strategy: `abort` (default)

```
Segment 1: OK
Segment 2: OK
Segment 3: FAIL → release accumulator → release all temps → throw error
Result: Error thrown, no output, no leaks.
```

Safest option. Use when correctness is paramount and partial output is useless.

#### Strategy: `skip`

```
Segment 1: OK      → appended to accumulator
Segment 2: FAIL    → logged, skipped, continue
Segment 3: OK      → appended to accumulator
Result: Output contains segments 1+3. Gap at segment 2. Metadata reports skip.
```

For audio: inserts silence for the skipped segment's duration (maintains time alignment).  
For text: inserts a placeholder marker `[segment_skipped]` or empty string.

#### Strategy: `retry`

```
Segment 1: OK
Segment 2: FAIL → retry 1 → FAIL → retry 2 → OK → appended
Segment 3: OK
Result: Complete output. Metadata reports retry count.
```

Fallback: after `maxRetriesPerSegment` exhausted, falls through to `abort` or `skip` (configurable via `retryExhaustedFallback`).

```typescript
interface OrchestrationConfig {
  // ... other fields ...
  
  /** What to do when retries are exhausted (default: 'abort') */
  retryExhaustedFallback?: 'abort' | 'skip';
}
```

#### Strategy: `partial_result`

```
Segment 1: OK      → appended to accumulator
Segment 2: OK      → appended to accumulator
Segment 3: FAIL    → stop processing, finalize + transfer what we have
Result: Output contains segments 1+2 only. Metadata reports partial.
```

Useful for long audio (e.g., 2-hour podcast): better to get 90% enhanced audio than nothing.

---

### OrchestrationResult

The orchestrator always returns a structured result, never just a buffer ID:

```typescript
interface OrchestrationResult {
  /** Final output buffer (present unless status is 'failed') */
  outputBuffer?: OfflineAudioBufferRef | OfflineTextBufferRef;
  
  /** Overall status */
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  
  /** Total segments in input */
  totalSegments: number;
  
  /** Segments successfully processed */
  completedSegments: number;
  
  /** Segments that were skipped (with skip/partial strategy) */
  skippedSegments: SkippedSegmentInfo[];
  
  /** Segments that failed and caused abort */
  failedSegment?: FailedSegmentInfo;
  
  /** Processing time in ms */
  processingTimeMs: number;
  
  /** SegmentLinkMap for cross-domain pipelines (STT, TTS) */
  linkMap?: SegmentLinkMapRef;
}

interface SkippedSegmentInfo {
  segmentIndex: number;
  segmentId: string;
  error: string;
  retryCount: number;
}

interface FailedSegmentInfo {
  segmentIndex: number;
  segmentId: string;
  error: string;
  retryCount: number;
}
```

### Updated Orchestrator APIs

```typescript
async function runOfflineAudioPipeline(
  input: OfflineAudioBufferRef,
  consumer: (segIn: OfflineAudioBufferRef, segOut: OfflineAudioBufferRef) => Promise<void>,
  config: OrchestrationConfig
): Promise<OrchestrationResult>;

async function runOfflineTextPipeline(
  input: OfflineTextBufferRef,
  consumer: (segIn: OfflineTextBufferRef, segOut: OfflineTextBufferRef) => Promise<void>,
  config: OrchestrationConfig
): Promise<OrchestrationResult>;
```

---

### Cancellation

Cancellation is supported via `AbortSignal` (standard Web API, also available in React Native):

```typescript
const controller = new AbortController();

const result = runOfflineAudioPipeline(input, consumer, {
  segmentation: { mode: 'auto', policy: { type: 'speech_energy_silence' } },
  errorRecovery: 'partial_result',
  abortSignal: controller.signal,
});

// Later:
controller.abort();
// → result resolves with status: 'cancelled', outputBuffer contains processed segments
```

**Native implementation:**

```kotlin
// Check abort signal before each segment
for ((index, seg) in segments.withIndex()) {
    if (abortSignal.isAborted) {
        state = SessionState.CANCELLED
        break  // exit loop, proceed to cleanup/partial result
    }
    processSegment(seg, index)
}
```

**Cancellation behavior by strategy:**

| Strategy | Cancel behavior |
|---|---|
| `abort` | Release accumulator, return `status: 'cancelled'`, no output |
| `skip` | Finalize + transfer processed segments, return `status: 'cancelled'` with output |
| `partial_result` | Finalize + transfer processed segments, return `status: 'cancelled'` with output |
| `retry` | Stop retrying, fallback to `abort` cancel behavior |

---

### Progress Reporting

```typescript
interface OrchestrationProgress {
  /** Current segment being processed (0-based) */
  currentSegment: number;
  
  /** Total segment count */
  totalSegments: number;
  
  /** Fraction complete (0.0–1.0) */
  fraction: number;
  
  /** Current segment's estimated duration (ms) */
  currentSegmentDurationMs: number;
  
  /** Time elapsed so far (ms) */
  elapsedMs: number;
}
```

Progress is reported:
- Before each segment starts.
- After each segment completes.
- On retry (with same segment index, incremented attempt).

---

### Crash Recovery: Orphan Sweep

If the process crashes mid-orchestration, temporary files may be left on disk. The SDK performs an **orphan sweep** at startup:

```kotlin
/**
 * Called once during SDK initialization.
 * Finds and deletes orphaned orchestration files.
 */
fun cleanupOrphanedOrchestrationFiles(baseDir: File) {
    // Orchestration temp files use a naming convention:
    //   {baseDir}/orch_{sessionId}_acc.wav   (accumulator spool)
    //   {baseDir}/orch_{sessionId}_seg_{N}.f32 (temp segment, if file-backed)
    
    val orchFiles = baseDir.listFiles { _, name -> 
        name.startsWith("orch_") 
    } ?: return
    
    for (file in orchFiles) {
        // Check if a corresponding session is active (it shouldn't be after crash)
        // If no active session, delete the file
        file.delete()
        Log.w(TAG, "Deleted orphaned orchestration file: ${file.name}")
    }
}
```

**File naming convention for orchestration temps:**

| File | Purpose | Naming |
|---|---|---|
| Accumulator spool | LiveAudioBuffer spool for collecting results | `orch_{sessionId}_acc.wav` |
| Temp segment input | File-backed segment extraction (large segments only) | `orch_{sessionId}_seg_{N}_in.f32` |
| Temp segment output | File-backed consumer output (large outputs only) | `orch_{sessionId}_seg_{N}_out.f32` |

Small segments (< `fileSizeThresholdBytes`, default 1 MB) stay InMemory. Only large segments spill to disk.

---

### Complete Audio Orchestration Flow (with lifecycle + error recovery)

```
1.  Create OrchestrationSession(sessionId, input, segments, config)
2.  Create accumulator LiveAudioBuffer:
      - spoolPath = "orch_{sessionId}_acc.wav"
      - sampleRate = input.sampleRate
      - state = recording
3.  For each segment (index = 0..N-1):
      a.  Check abortSignal → if aborted, go to 6
      b.  Report progress(index, N)
      c.  Create tempIn  (InMemory or FileBacked depending on size)
      d.  Create tempOut (InMemory)
      e.  try:
            consumer.process(tempIn, tempOut)
            Read samples from tempOut
            Apply overlap/crossfade if overlapSamples > 0 and index > 0
            Append samples to accumulator
            completedSegments++
          catch (error):
            match config.errorRecovery:
              'abort':
                  failedSegment = { index, error }
                  cleanup(accumulator, temps)
                  return Result(status='failed', failedSegment)
              'skip':
                  Insert silence (seg.durationMs worth) into accumulator
                  skippedSegments.add({ index, error })
              'retry':
                  Retry up to maxRetriesPerSegment
                  If exhausted → apply retryExhaustedFallback ('abort' or 'skip')
              'partial_result':
                  failedSegment = { index, error }
                  go to 4 (finalize with what we have)
          finally:
            tempIn.release()
            tempOut.release()
4.  Finalize accumulator (patch WAV header)
5.  transferOfflineAudioBufferFromLive(accumulator) → outputBuffer
6.  Determine status:
      - aborted → 'cancelled'
      - all completed → 'complete'
      - some skipped → 'complete' (skippedSegments populated)
      - stopped early → 'partial'
7.  Return OrchestrationResult {
      outputBuffer, status, totalSegments, completedSegments,
      skippedSegments, failedSegment, processingTimeMs, linkMap?
    }
```

### Complete Text Orchestration Flow (with lifecycle + error recovery)

```
1.  Create OrchestrationSession(sessionId, input, segments, config)
2.  Create in-memory text accumulator (StringBuilder)
3.  For each segment (index = 0..N-1):
      a.  Check abortSignal → if aborted, go to 5
      b.  Report progress(index, N)
      c.  Extract segment text from input
      d.  Create tempIn  (OfflineTextBuffer, InMemory)
      e.  Create tempOut (OfflineTextBuffer, InMemory)
      f.  try:
            consumer.process(tempIn, tempOut)
            Read result text from tempOut
            Append to accumulator
            completedSegments++
          catch (error):
            match config.errorRecovery:
              'abort'   → cleanup, return failed
              'skip'    → append "" or placeholder, continue
              'retry'   → retry up to max, then fallback
              'partial' → go to 5
          finally:
            tempIn.release()
            tempOut.release()
5.  Create OfflineTextBuffer from accumulated text
6.  Return OrchestrationResult { outputBuffer, status, ... }
```

Text is simpler: no accumulator buffer lifecycle (just a string), no spool, no transfer.

---

## Error Handling

### Transfer Errors

| Error | When |
|---|---|
| `TRANSFER_INVALID_STATE` | Live buffer not finalized |
| `TRANSFER_SPOOL_UNAVAILABLE` | No spool file |
| `TRANSFER_CURSORS_ACTIVE` | Active cursors on live buffer |
| `BUFFER_INVALIDATED` | Operation on invalidated live buffer |

### Orchestration Errors

| Error | When |
|---|---|
| `ORCHESTRATION_SEGMENT_FAILED` | Consumer failed on a segment (with strategy `abort`) |
| `ORCHESTRATION_ACCUMULATOR_ERROR` | Accumulator buffer error (write/finalize) |
| `ORCHESTRATION_TRANSFER_FAILED` | `transferOfflineAudioBufferFromLive` failed after all segments |
| `ORCHESTRATION_CANCELLED` | Processing cancelled via AbortSignal |
| `ORCHESTRATION_INPUT_EMPTY` | Input buffer has no data / no segments computed |

### Error Propagation

```
Consumer error (per-segment)
  │
  ├─ abort strategy    → ORCHESTRATION_SEGMENT_FAILED (thrown to caller)
  ├─ skip strategy     → logged in skippedSegments, processing continues
  ├─ retry strategy    → retried, then fallback to abort/skip
  └─ partial strategy  → logged in failedSegment, partial result returned

Accumulator error (write/append failure)
  │
  └─ always fatal      → ORCHESTRATION_ACCUMULATOR_ERROR (cleanup, thrown)

Transfer error (finalize/transfer failure)
  │
  └─ always fatal      → ORCHESTRATION_TRANSFER_FAILED (cleanup, thrown)

Cancellation
  │
  └─ not an error      → status: 'cancelled' with optional partial output
```

---

## Implementation Steps

### Phase A: Transfer (foundation)

1. Add `dataOffsetBytes` field to `OfflineEntry.FileBacked` (Kotlin) and `PaOfflineFileBacked` (C++).
2. Update all reader methods to respect `dataOffsetBytes`.
3. Implement `transferOfflineAudioBufferFromLive` (Kotlin + C++).
4. Add `invalidateWithoutSpoolDelete` to LiveAudioBuffer.
5. Write unit tests: transfer roundtrip, edge cases.

### Phase B: Orchestration Core

6. Implement `OrchestrationSession` class with state machine.
7. Implement accumulator creation with naming convention (`orch_{sessionId}_acc.wav`).
8. Implement text orchestration loop (simpler, do first).
9. Implement audio orchestration loop with LiveAudioBuffer accumulator.
10. Implement deterministic cleanup in all terminal paths (done/failed/cancelled).

### Phase C: Error Recovery

11. Implement `abort` strategy (default, simplest).
12. Implement `skip` strategy with silence insertion (audio) / placeholder (text).
13. Implement `retry` strategy with configurable max retries and exhausted fallback.
14. Implement `partial_result` strategy with early finalize + transfer.
15. Implement `OrchestrationResult` return type.

### Phase D: Cancellation & Progress

16. Implement `AbortSignal` integration (check before each segment).
17. Implement `onProgress` callback.
18. Implement cancellation behavior per strategy (output vs. no output).

### Phase E: Crash Recovery & Polish

19. Implement orphan sweep (`cleanupOrphanedOrchestrationFiles`) at SDK startup.
20. Add file naming convention for all orchestration temps.
21. Add overlap/crossfade support for audio segment boundaries.
22. Write integration tests: error recovery per strategy, cancellation, crash recovery.
23. Benchmark: transfer vs. copy, orchestration overhead per segment count.
