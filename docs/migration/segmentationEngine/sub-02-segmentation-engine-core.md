# Sub-Plan 02: Segmentation Engine Core

## Status
- **Implemented** (Phase 1d abgeschlossen laut `segmentation_engine_overview.md`): Native Engine-Registry und Laufzeit-APIs (`attachSegmentationEngine`, `detachSegmentationEngine`, `getSegmentationEngineInfo`, `segmentOfflineBuffer`) auf Android (`SegmentationEngineRegistry.kt`) und iOS (`SherpaOnnx+SegmentBuffer.mm`); P0-Evaluatoren (`text_synthetic_auto`, `speech_energy_silence`); `continuous_frames` mit Checkpoints; Buffer-Hooks bei Text-/Audio-Writes und Finalize/Release. Policy-IDs `text_punctuation_assisted` und `speech_vad_model` sind gültig; dedizierte Modell-Pipelines dafür bleiben gemäß Prioritätstabelle (P1/P2) und Folgephasen (z. B. Phase 2/4) nachziehbar.
- Depends on: Sub-Plan 01 (Segment Contract)
- Prerequisite for: Sub-Plan 03, 04, 05

## Purpose

Define the Segmentation Engine's internal architecture: native interface, policy evaluation, domain split, buffer attachment, lifecycle.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│            SegmentationEngine                 │
│                                               │
│  ┌─────────────────┐  ┌─────────────────┐    │
│  │TextPolicyEval   │  │SpeechPolicyEval │    │
│  │ synthetic_auto  │  │ energy_silence  │    │
│  │ punct_assisted  │  │ vad_model       │    │
│  │                 │  │ continuous_frames│    │
│  └───────┬─────────┘  └───────┬─────────┘    │
│          ▼                    ▼               │
│  ┌──────────────────────────────────────┐    │
│  │       Segment Commit Layer           │    │
│  │ - creates Segment (ID/reason/source) │    │
│  │ - writes to buffer segment log       │    │
│  │ - triggers onSegment event hint      │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
        │                         │
        ▼                         ▼
  LiveTextBuffer            LiveAudioBuffer
  (segment log)             (segment log)
```

---

## Public TypeScript API

```typescript
/** Attach engine to a buffer for auto-segmentation */
function attachSegmentationEngine(
  buffer: LiveTextBufferRef | LiveAudioBufferRef,
  config: SegmentationConfig
): SegmentationEngineRef;

/** Detach engine. Optional flush of pending partial as final segment. */
function detachSegmentationEngine(
  engine: SegmentationEngineRef,
  options?: { flushFinal?: boolean }
): void;

/** Query engine state */
function getSegmentationEngineInfo(
  engine: SegmentationEngineRef
): SegmentationEngineInfo;

/**
 * Manual segment commit (symmetric across domains).
 * Text: commits current partial as a segment.
 * Audio: commits accumulated frames since last commit as a segment.
 * Same function for both buffer types — follows 2-level write model.
 */
function commitSegment(
  buffer: LiveTextBufferRef | LiveAudioBufferRef,
  options?: { reason?: SegmentReason }
): Segment;

/** One-shot offline segmentation pass */
function segmentOfflineBuffer(
  buffer: OfflineTextBufferRef | OfflineAudioBufferRef,
  policy: SegmentationPolicy
): OfflineSegmentBufferRef;
```

> **Symmetric API note:** `commitSegment()` is the same function for both domains. The engine's `evaluate()` is triggered by the corresponding data-level write: `setPartial()`/`appendPartial()` for text, `appendFrames()` for audio. This 2-level symmetry (data write → engine evaluate → segment commit) is identical in both domains.

### Types

```typescript
interface SegmentationEngineRef { engineId: string; }

interface SegmentationEngineInfo {
  engineId: string;
  attachedBufferId: string;
  domain: 'text' | 'speech';
  policy: SegmentationPolicy;
  state: 'active' | 'detached';
  totalSegmentsCommitted: number;
  lastSegmentId?: string;
}
```

---

## Native Interface

### Kotlin (Android)

```kotlin
interface PaSegmentationEngine {
    val engineId: String
    val domain: SegmentDomain
    val policy: SegmentationPolicy
    val state: EngineState
    
    /** Called on every data event. May commit 0+ segments. */
    fun evaluate(buffer: PaBufferHandle)
    
    /** Flush pending state as final segment. */
    fun flush(buffer: PaBufferHandle)
    
    fun release()
}

enum class EngineState { ACTIVE, DETACHED, RELEASED }
```

### C++ (iOS)

```cpp
class PaSegmentationEngine {
public:
    virtual ~PaSegmentationEngine() = default;
    virtual const std::string& engineId() const = 0;
    virtual PaSegmentDomain domain() const = 0;
    virtual PaEngineState state() const = 0;
    virtual void evaluate(PaBufferHandle& buffer) = 0;
    virtual void flush(PaBufferHandle& buffer) = 0;
    virtual void release() = 0;
};
```

---

## Policy Evaluators

### TextSyntheticAutoEvaluator

**Input:** Current partial text from LiveTextBuffer.

```
on each partial update:
    accumulated = committed_end .. partial_end
    if sentenceBoundary:
        scan for sentence-ending punct (. ! ? etc.)
        if found at P: commit [committed_end, P+1), reason='punctuation'
    if accumulated.length > maxLengthChars:
        find word boundary → commit, reason='length_limit'
```

Params: `maxLengthChars` (500), `sentenceBoundary` (true), `languageHints`

### TextPunctuationAssistedEvaluator

Same as synthetic_auto, but uses punctuation model output as primary signal. Model's annotated punctuation marks become boundary candidates. Synthetic rules as post-processing.

### SpeechEnergySilenceEvaluator

**Input:** Audio frames from LiveAudioBuffer.

```
on frames appended:
    energy = RMS of new frames
    if energy < threshold: silence_ms += duration
    else: silence_ms = 0
    if silence_ms > silenceThresholdMs + hangoverMs:
        if segment_duration >= minSegmentMs:
            commit, reason='energy_silence'
    if segment_duration >= maxSegmentMs:
        commit at low-energy point, reason='length_limit'
```

Params: `silenceThresholdMs` (500), `energyThresholdDb` (-40), `minSegmentMs` (1000), `maxSegmentMs` (30000), `hangoverMs` (300)

### SpeechVadModelEvaluator

**Input:** VAD model state transitions.

```
on speech→silence transition:
    commit [speech_start, speech_end), reason='vad_boundary'
    vadInfo = { engine, score, decision }
```

Integrates with the existing VAD pipeline and consumes boundary/state decisions that are produced from audio input by that pipeline.  
The Segmentation Engine does not re-run VAD on raw audio internally; it adapts VAD outputs into the shared Segment Contract.

### ContinuousFramesEvaluator

No per-frame segments. Optional coarse checkpoints:

```
on frames appended:
    if checkpointIntervalMs set && time_since_last >= interval:
        emit checkpoint, reason='policy_checkpoint'
```

---

## Buffer Attachment Model

### Flow

1. User creates LiveBuffer with segmentation config
2. If `mode='auto'`: SDK creates engine, attaches to buffer
3. Buffer registers engine as **data-level event observer**:
   - Text: engine observes `setPartial()` / `appendPartial()` calls
   - Audio: engine observes `appendFrames()` calls
4. On data-level write → buffer calls `engine.evaluate(self)`
5. Engine may call `buffer.commitSegment(segment)` (segment-level)
6. Buffer stores segment + emits `onSegment` hint
7. On `finalize()` → `engine.flush()` → engine detaches
8. On `release()` → engine released

> **Symmetry:** The attachment flow is structurally identical for both domains. The engine always observes Level-1 (data writes) and produces Level-2 (segment commits). Only the policy evaluator implementation differs.

### Constraints

| Constraint | Rule |
|---|---|
| One engine per buffer | Reject if already attached |
| Engine cannot outlive buffer | Release cascades |
| No reattachment | Once detached, create new |
| `evaluate()` is synchronous | Inline on write thread, must be fast |
| No I/O in `evaluate()` | Model refs resolved at creation |

### Threading

- `evaluate()` on buffer write thread
- Segment commit acquires segment log lock briefly
- `flush()` same threading rules

---

## Offline Segmentation (Mode 2)

One-shot pass over full buffer content:

```
1. OfflineBuffer is fully populated
2. Engine runs single-pass segmentation over content
3. Results stored in OfflineSegmentBuffer
4. Consumer iterates segments, processes each
5. Results collected into output buffer
```

---

## Error Codes

| Code | When |
|---|---|
| `ENGINE_ALREADY_ATTACHED` | Buffer already has engine |
| `ENGINE_DETACHED` | Operation after detach |
| `POLICY_INVALID` | Policy doesn't match domain |
| `POLICY_MODEL_UNAVAILABLE` | Required model not loaded |
| `BUFFER_STATE_INVALID` | Buffer not in recording state |

---

## Implementation Priority

| Prio | Evaluator | Rationale |
|---|---|---|
| P0 | `TextSyntheticAutoEvaluator` | No model dep, validates contract |
| P0 | `SpeechEnergySilenceEvaluator` | No model dep, enables offline segmented |
| P1 | `SpeechVadModelEvaluator` | Reuses VAD pipeline |
| P1 | `ContinuousFramesEvaluator` | Enables Enhancement migration |
| P2 | `TextPunctuationAssistedEvaluator` | Requires punctuation model |

## Implementation Steps

1. Define engine registry (engineId → instance)
2. Implement `PaSegmentationEngine` base (Kotlin + C++)
3. Implement `TextSyntheticAutoEvaluator`
4. Implement `SpeechEnergySilenceEvaluator`
5. Implement buffer attachment hooks
6. Implement `commitSegment` on buffer
7. Implement `segmentOfflineBuffer` one-shot
8. Implement `SpeechVadModelEvaluator`
9. Implement `TextPunctuationAssistedEvaluator`
10. Implement `ContinuousFramesEvaluator`
11. Add detach + flush lifecycle
12. Integration tests per evaluator
