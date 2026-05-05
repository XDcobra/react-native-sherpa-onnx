# Sub-Plan 04: Punctuation Live Overload

## Status
- Phase: **3**
- Depends on: sub-01 (foundation contract), sub-02 (shared worker base), sub-03 (STT reference template).
- Prerequisite for: nothing — feature-leaf phase.

## Purpose

Per design §5.1 (decision **a**, rationale §5.2), the offline punctuation engine `OfflinePunctuationEngine` (CT-Transformer weights) gains a live-buffer overload of `punctuate()`. Users with **CT-Transformer-only** assets get live punctuation on a `LiveTextBuffer` without needing the separate CNN-BiLSTM-based `createStreamingPunctuation`.

Critical distinction from TTS (sub-05): the **two punctuation engines own different weights**:

- `createOfflinePunctuation` → `OfflinePunctuation` (CT-Transformer)
- `createStreamingPunctuation` → `OnlinePunctuation` (CNN-BiLSTM)

Therefore there is **no dedup question** in this sub-plan. The streaming engine continues to exist in parallel, owned by the streaming-punctuation factory; the live overload is purely additive.

---

## API surface

### TypeScript — `src/punctuation/types.ts`

Add a new options type and overload `punctuate()` on `OfflinePunctuationEngine`. The existing batch overload is **unchanged**.

```ts
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { TextSegment } from '../segment/types';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { PunctuationPipelineHandle } from './streamingTypes';

export interface PunctuationLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  /**
   * Optional mirror of every committed punctuated segment that lands on the
   * output `LiveTextBuffer`. Same constraints as STT's `onSegment` (worker
   * thread, no `onPartial`).
   */
  onSegment?: (segment: TextSegment) => void;
}

export interface OfflinePunctuationEngine {
  readonly instanceId: string;

  // Existing batch overload (unchanged).
  punctuate(
    textIn: OfflineTextBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;

  // NEW live overload.
  punctuate(
    textIn: LiveTextBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: PunctuationLivePipelineOptions   // REQUIRED
  ): Promise<PunctuationPipelineHandle>;

  punctuateString(
    plain: string,
    textOut: OfflineTextBufferRef,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;

  destroy(): Promise<void>;
}
```

> The handle type is the **existing** `PunctuationPipelineHandle` exported from `streamingTypes.ts` — same rationale as STT (sub-03 / OQ-3.3).

### Native bridge — `src/NativeSherpaOnnx.ts`

```ts
startPunctuationOfflineLivePipeline(
  instanceId: string,
  textInLiveBufferId: string,
  textOutLiveBufferId: string,
  options: {
    segmentationPolicy: Object;   // already-marshalled SegmentationPolicy
  }
): Promise<{ pipelineId: string }>;
```

> No `chunkSize` here — punctuation operates on whole text segments, not sample windows. The text-domain segmentation engine already controls the granularity through `policy.maxLengthChars` / `policy.sentenceBoundary`.

---

## JS implementation outline

`src/punctuation/offline.ts` — extend the engine returned by `createOfflinePunctuation`:

```ts
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import { isLiveTextBufferIdSource, resolvePipelineTextBufferId } from '../textbuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  marshalSegmentationPolicyForNative,
} from '../segment';

async function punctuateLiveOverload(
  instanceId: string,
  textIn: LiveTextBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: PunctuationLivePipelineOptions,
): Promise<PunctuationPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline punctuation',
    domain: 'text',
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineTextBufferId(textIn);
  const outId = resolvePipelineTextBufferId(textOut);

  const { pipelineId } = await SherpaOnnx.startPunctuationOfflineLivePipeline(
    instanceId,
    inId,
    outId,
    { segmentationPolicy: marshalSegmentationPolicyForNative(policy) },
  );

  if (options.onSegment) {
    subscribeLiveTextSegmentEvents(outId, options.onSegment);
  }

  return createPunctuationPipelineHandle(instanceId, pipelineId);
}
```

The dispatcher inside the `punctuate` returned by `createOfflinePunctuation` checks `isLiveTextBufferIdSource(textIn)`; if true, route to `punctuateLiveOverload`, else keep existing batch behavior.

---

## Native — Android (Kotlin)

### `SherpaOnnxOfflinePunctuationLivePipelineHelper.kt`

Same pattern as STT's helper (sub-03), but resolves `OfflinePunctuation` (CT-Transformer) and routes input from `LiveTextEntry`.

```kotlin
internal class SherpaOnnxOfflinePunctuationLivePipelineHelper(
  private val context: ReactApplicationContext,
) {
  fun startPunctuationOfflineLivePipeline(
    instanceId: String,
    textInLiveBufferId: String,
    textOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) = try {
    val punc = OfflinePunctuationRegistry.require(instanceId)
    val liveTextIn = TextPipelineRegistry.requireLive(textInLiveBufferId)
    val liveTextOut = TextPipelineRegistry.requireLive(textOutLiveBufferId)

    val seg = SegmentationEngineRegistry.attach(
      bufferId = textInLiveBufferId,
      policy = SegmentationEngineRegistry.parsePolicy(
        options.getMap("segmentationPolicy")
          ?: error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: segmentationPolicy missing on native bridge")
      ),
    )

    val pipelineId = "live_offline_punc_${UUID.randomUUID()}"
    val worker = PunctuationOfflineLivePipelineWorker(
      pipelineId = pipelineId,
      attachedSegmentationEngineId = seg.engineId,
      textInput = OfflineLivePipelineWorker.TextInput(liveTextIn),
      punctuator = punc,
      textOutputEntry = liveTextOut,
    )
    StreamingPipelineRegistry.registerAndStart(worker) { completion ->
      emitStreamingPipelineCompleted(context, completion)
    }
    promise.resolve(WritableNativeMap().apply { putString("pipelineId", pipelineId) })
  } catch (e: Exception) {
    promise.reject("PUNCTUATION_OFFLINE_LIVE_FAILED", e.message ?: "live offline punctuation failed", e)
  }
}
```

### `PunctuationOfflineLivePipelineWorker.kt`

```kotlin
internal class PunctuationOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  textInput: TextInput,
  private val punctuator: OfflinePunctuation,
  private val textOutputEntry: LiveTextEntry,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = null,
  textInput = textInput,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val text = (segment as? CommittedSegmentRef.Text)
      ?: error("Expected text segment in punctuation live overload")
    val punctuated = punctuator.addPunctuation(text.text)
    textOutputEntry.appendCommittedSegment(
      text = punctuated,
      tokens = null,
      timestamps = null,
      lang = null,
      reason = "punctuation",
      source = "segmentation_engine",
      createdAtMs = System.currentTimeMillis(),
    )
  }
}
```

### TurboModule wiring

```kotlin
@ReactMethod
fun startPunctuationOfflineLivePipeline(
  instanceId: String,
  textInLiveBufferId: String,
  textOutLiveBufferId: String,
  options: ReadableMap,
  promise: Promise,
) = offlinePunctuationLivePipelineHelper.startPunctuationOfflineLivePipeline(
  instanceId, textInLiveBufferId, textOutLiveBufferId, options, promise,
)
```

---

## Native — iOS (Obj-C++ / C++)

`ios/punctuation/bridge/SherpaOnnx+OfflinePunctuationLivePipeline.{h,mm}` — mirrors STT's iOS pattern. Worker:

```cpp
class PunctuationOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  PunctuationOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<TxtLiveEntry> textInput,
    std::shared_ptr<TxtLiveEntry> textOutput,
    sherpaonnx::OfflinePunctuationWrapper *wrapper);

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<TxtLiveEntry> textOutput_;
  sherpaonnx::OfflinePunctuationWrapper *wrapper_;
};
```

`onSegmentCommitted` reads `segment.text`, calls the wrapper's `addPunctuation(text)` (already used today by `punctuateOfflineString`), appends a committed text segment to `textOutput_`. Same pattern as `PunctuationPipelineWorker` (streaming/online), but driven from the offline engine.

---

## Per-feature segmentation defaults

Per design §5.3:

- Default policy when caller omits explicit policy: **`text_synthetic_auto`** (regex sentence boundaries with `maxLengthChars: 500`, `sentenceBoundary: true`).
- `text_punctuation_assisted` is supported **only when the caller explicitly supplies `policy.punctuationInstanceId`** (the validator already enforces this; reuses the offline engine's own instance id is a valid choice for a feedback loop, but most users will use `text_synthetic_auto`).
- `speech_*` evaluators are rejected (sub-01 enforces text domain).

> See OQ-4.1 for the recommended default-policy choice.

---

## Validation

Same contract as sub-03 (STT). The validator (sub-01) handles the missing-policy / `mode: 'off'` / `mode: 'manual'` / domain-mismatch cases uniformly with `LIVE_OFFLINE_SEGMENTATION_REQUIRED`.

---

## Test matrix (Jest)

`src/punctuation/__tests__/punctuation-live-offline.test.ts` — new file.

| # | Scenario | Expected |
|---|---|---|
| LP-1 | **Golden path**: offline CT-Transformer + LiveTextBuffer in (segmented `text_synthetic_auto`) → punctuated text segments arrive on output LiveTextBuffer; `pipeline.stop()` resolves. | Pass |
| LP-2 | `punctuate(liveText, liveText, {})` (missing options.segmentation) | `LiveOfflinePipelineError`, code `LIVE_OFFLINE_SEGMENTATION_REQUIRED`. |
| LP-3 | `punctuate(liveText, liveText, { segmentation: { policy: { evaluator: 'speech_energy_silence' } } } as any)` | `LiveOfflinePipelineError`, message mentions text evaluator. |
| LP-4 | `punctuate(liveText, liveText, { segmentation: { policy: { evaluator: 'text_punctuation_assisted' } } } as any)` (no `punctuationInstanceId`) | `LiveOfflinePipelineError`, message mentions `punctuationInstanceId`. |
| LP-5 | Mixed: `punctuate(offlineText, liveText, …)` | Throws `PUNCTUATION_INVALID_ARGUMENT`. |
| LP-6 | `flush()`: input live text buffer is finalized → in-flight + tail segments are committed; `detachSegmentationEngine(..., flushFinal: true)` runs. | Pass |
| LP-7 | `stop()` mid-segment cancels pending punctuation; segmentation engine is detached. | Pass |
| LP-8 | `onSegment` callback fires per committed punctuated segment. | Pass |

Existing Jest suites (`punctuation-segmented.test.ts`, `streaming-punctuation.test.ts`) must remain green — neither the offline batch path nor the separate streaming engine is touched.

---

## Acceptance criteria

- New `punctuate(LiveText, LiveText, options)` overload exists on `OfflinePunctuationEngine`.
- All Jest cases LP-1 … LP-8 pass.
- Existing Jest suites for offline and streaming punctuation remain green.
- Worker is a thin subclass of `OfflineLivePipelineWorker`.
- `createStreamingPunctuation` is **untouched** — different weights, different engine, both stay public.
- Doc `docs/punctuation.md` (or equivalent) gets a "Live overload" section (sub-07).

---

## Resolved decisions

### OQ-4.1 — Default policy: `text_synthetic_auto` or `text_punctuation_assisted`?

**Decision: Default to `text_synthetic_auto`. Do NOT auto-wire the engine as `punctuationInstanceId` (accepted).**

`text_punctuation_assisted` remains opt-in and requires explicit caller-provided `policy.punctuationInstanceId`.

### OQ-4.2 — Should the live overload write committed segments only, or also partials?

**Decision: Commit-only — no partials (accepted).**

Required follow-up documentation:

- Add/keep explicit commit-only behavior in punctuation feature docs (`docs/punctuation.md` or equivalent) as part of sub-07.
- Add/keep explicit commit-only wording in relevant in-code docstrings/comments at useful call sites (for example on `PunctuationLivePipelineOptions` and live-overload `punctuate(...)` overload docs). If needed, repeat at multiple relevant points to prevent drift.

### OQ-4.3 — Should live overload include batch orchestration options like `onProgress`?

**Decision: No — keep the live-overload option shape minimal (accepted).**

Do not add `onProgress`, `errorRecovery`, `linkMap`, or batch-only orchestration fields to the live-overload options.
