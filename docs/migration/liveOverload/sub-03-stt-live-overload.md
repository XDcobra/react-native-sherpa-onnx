# Sub-Plan 03: STT Live Overload (Reference Feature)

## Status
- Phase: **2**
- Depends on: sub-01 (foundation contract), sub-02 (shared worker base).
- Prerequisite for: sub-04, sub-05, sub-06 — these features mirror this template, so any deviations from the STT shape that surface here must be reflected upstream before the next phase ships.

## Purpose

STT is the **reference implementation** for the cross-feature live overload. Per design §5.1 (decision **a**), `SttEngine.transcribe()` gains a second overload that accepts `LiveAudioBufferIdSource` + `LiveTextBufferIdSource` and **requires** `segmentation.policy`. The offline recognizer (`createSTT()`) is reused as-is per committed speech segment.

By the end of this phase:

- A user with **offline-only** STT assets (e.g. Whisper, SenseVoice, Canary, Paraformer-offline) can drive a live mic pipeline without needing a streaming-capable model.
- The new overload returns the **existing** `SttPipelineHandle` and integrates with the **existing** `streamingPipelineCompleted` event.
- The shared worker base from sub-02 is exercised end-to-end for the first time.

---

## API surface

### TypeScript — `src/stt/types.ts`

Add a new options type and extend `SttEngine` with a second overload. The existing batch overload is **unchanged**.

```ts
import type {
  LiveAudioBufferIdSource,
} from '../audiobuffer/types';
import type {
  LiveTextBufferIdSource,
} from '../textbuffer/types';
import type { TextSegment } from '../segment/types';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { SttPipelineHandle } from './streamingTypes';

export interface SttLivePipelineOptions extends LiveOfflinePipelineBaseOptions {
  /**
   * Number of audio samples drained per worker loop into the offline recognizer
   * for a single committed segment. Default: 3200 (≈200 ms @ 16 kHz). Capped to the
   * segment's actual length.
   */
  chunkSize?: number;

  /**
   * Optional per-segment mirror of every committed text segment. Fires from the
   * worker thread; do not block. **No `onPartial`** — the live-offline path is
   * commit-only by design (see design §7.1).
   */
  onSegment?: (segment: TextSegment) => void;
}

export interface SttEngine {
  readonly instanceId: string;

  // Existing batch overload (unchanged).
  transcribe(
    buffer: OfflineAudioBufferRef | OfflineBufferHandle | string,
    textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string,
    options?: SttTranscribeOptions
  ): Promise<SttTranscribeResult>;

  // NEW live overload — returns the existing pipeline handle.
  transcribe(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: SttLivePipelineOptions   // REQUIRED — no overload without segmentation
  ): Promise<SttPipelineHandle>;

  setConfig(options: SttRuntimeConfig): Promise<void>;
  destroy(): Promise<void>;
}
```

> Implementation note for the overload resolver: `src/stt/index.ts`'s `createSTT()` already returns an `SttEngine`. The internal implementation calls a discriminator (`isLiveAudioBufferIdSource(...)`) to route the call to either the existing offline orchestrator or the new live worker entry. Helpers `resolvePipelineAudioBufferId` and `resolvePipelineTextBufferId` already exist in `src/audiobuffer/index.ts` and `src/textbuffer/index.ts` respectively — reuse them.

### Native bridge — `src/NativeSherpaOnnx.ts`

```ts
/**
 * Start a live-offline STT pipeline driven by a segmentation engine on the LIVE
 * audio buffer. The offline recognizer is reused per committed speech segment.
 */
startSttOfflineLivePipeline(
  instanceId: string,
  audioInLiveBufferId: string,
  textOutLiveBufferId: string,
  options: {
    segmentationPolicy: Object;   // already-marshalled SegmentationPolicy
    chunkSize?: number;
  }
): Promise<{ pipelineId: string }>;
```

Lifecycle (`stopStreamingPipeline`, `flushStreamingPipeline`, `resetStreamingPipeline`, `getStreamingPipelineStatus`) is reused unchanged.

---

## JS implementation outline

`src/stt/index.ts` — extend the existing factory's returned object:

```ts
import {
  validateLiveOfflinePipelineOptions,
} from '../livePipeline';
import {
  isLiveAudioBufferIdSource,
} from '../audiobuffer';
import {
  isLiveTextBufferIdSource,
} from '../textbuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  marshalSegmentationPolicyForNative,
} from '../segment';
import SherpaOnnx from '../NativeSherpaOnnx';

function createSttPipelineHandle(
  instanceId: string,
  pipelineId: string,
): SttPipelineHandle {
  // Reuse the existing pattern from streamingPunctuation.createPunctuationPipelineHandle
  // (sub-02's worker base detaches the segmentation engine on completion;
  //  no JS-side detach needed beyond the existing stop/flush wrappers).
  const completed = createStreamingPipelineCompletionPromise(pipelineId).then(
    () => undefined
  );
  return {
    instanceId,
    pipelineId,
    completed,
    stop: async () => { await SherpaOnnx.stopStreamingPipeline(pipelineId); },
    flush: async () => { await SherpaOnnx.flushStreamingPipeline(pipelineId); },
    reset: async () => { await SherpaOnnx.resetStreamingPipeline(pipelineId); },
    getStatus: () => SherpaOnnx.getStreamingPipelineStatus(pipelineId),
  };
}

async function transcribeLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: SttLivePipelineOptions,
): Promise<SttPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline STT',
    domain: 'speech',
    segmentation: options.segmentation,
  });

  const audioInId = resolvePipelineAudioBufferId(audioIn);
  const textOutId = resolvePipelineTextBufferId(textOut);

  // The native start call attaches the segmentation engine internally
  // via the same code path as attachSegmentationEngine() — no double attach
  // here. Returns the pipelineId once the worker is registered with
  // StreamingPipelineRegistry.
  const { pipelineId } = await SherpaOnnx.startSttOfflineLivePipeline(
    instanceId,
    audioInId,
    textOutId,
    {
      segmentationPolicy: marshalSegmentationPolicyForNative(policy),
      chunkSize: options.chunkSize,
    },
  );

  // Wire optional per-segment mirror (uses existing live text buffer onSegment event).
  if (options.onSegment) {
    subscribeLiveTextSegmentEvents(textOutId, options.onSegment);
    // unsubscribe is handled in createSttPipelineHandle's completion finally.
  }

  return createSttPipelineHandle(instanceId, pipelineId);
}
```

> The dispatcher inside `createSTT()`'s returned `transcribe(...)` checks `isLiveAudioBufferIdSource(buffer)` first; if true, it routes to `transcribeLiveOverload`. If both args are offline refs, the existing batch path runs unchanged. Mixed inputs (offline audio + live text, or vice versa) throw an explicit `STT_INVALID_ARGUMENT` describing the mismatch.

---

## Native — Android (Kotlin)

### `SherpaOnnxOfflineSttLivePipelineHelper.kt`

New file: `android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxOfflineSttLivePipelineHelper.kt`.

```kotlin
package com.sherpaonnx.stt.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.stt.OfflineSttRegistry
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.UUID

internal class SherpaOnnxOfflineSttLivePipelineHelper(
  private val context: ReactApplicationContext,
) {
  fun startSttOfflineLivePipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) = try {
    val recognizer = OfflineSttRegistry.require(instanceId)
    val liveAudioEntry = PipelineAudioRegistry.requireLive(audioInLiveBufferId)
    val liveTextEntry = TextPipelineRegistry.requireLive(textOutLiveBufferId)

    val policyMap = options.getMap("segmentationPolicy")
      ?: error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: segmentationPolicy missing on native bridge")
    val chunkSize = if (options.hasKey("chunkSize")) options.getInt("chunkSize") else 3200

    // Reuse the same attach path as attachSegmentationEngine().
    val seg = SegmentationEngineRegistry.attach(
      bufferId = audioInLiveBufferId,
      policy = SegmentationEngineRegistry.parsePolicy(policyMap),
    )
    val liveSegmentEntry = SegmentPipelineRegistry.requireLive(seg.segmentBufferId!!)

    val pipelineId = "live_offline_stt_${UUID.randomUUID()}"
    val worker = SttOfflineLivePipelineWorker(
      pipelineId = pipelineId,
      attachedSegmentationEngineId = seg.engineId,
      audioInput = OfflineLivePipelineWorker.AudioInput(
        liveAudioEntry = liveAudioEntry,
        liveSegmentEntry = liveSegmentEntry,
      ),
      recognizer = recognizer,
      textOutputEntry = liveTextEntry,
      chunkSize = chunkSize,
    )

    StreamingPipelineRegistry.registerAndStart(worker) { completion ->
      emitStreamingPipelineCompleted(context, completion)
    }

    val result = WritableNativeMap().apply { putString("pipelineId", pipelineId) }
    promise.resolve(result)
  } catch (e: Exception) {
    promise.reject("STT_TRANSCRIBE_FAILED", e.message ?: "live offline STT failed", e)
  }
}
```

### `SttOfflineLivePipelineWorker.kt`

New file in `android/src/main/java/com/sherpaonnx/stt/pipeline/SttOfflineLivePipelineWorker.kt`. **Inherits** from `OfflineLivePipelineWorker` (sub-02). Per-feature work lives only in `onSegmentCommitted`:

```kotlin
internal class SttOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  audioInput: AudioInput,
  private val recognizer: OfflineRecognizer,
  private val textOutputEntry: LiveTextEntry,
  private val chunkSize: Int,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInput,
  textInput = null,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech
      ?: error("Expected speech segment in STT live overload")

    val pcm = audioInput!!.liveAudioEntry.readSamples(
      startSample = speech.startSample,
      endSample = speech.endSample,
    )

    val stream = recognizer.createStream()
    try {
      stream.acceptWaveform(pcm, speech.sampleRate)
      stream.inputFinished()
      recognizer.decode(stream)
      val result = recognizer.getResult(stream)
      textOutputEntry.appendCommittedSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        lang = result.lang,
        // reuse the speech segment's reason/source/createdAtMs/segmentIndex
        reason = "endpoint",
        source = "segmentation_engine",
        createdAtMs = System.currentTimeMillis(),
      )
    } finally {
      stream.release()
    }
  }
}
```

### TurboModule wiring — `SherpaOnnxModule.kt`

```kotlin
@ReactMethod
fun startSttOfflineLivePipeline(
  instanceId: String,
  audioInLiveBufferId: String,
  textOutLiveBufferId: String,
  options: ReadableMap,
  promise: Promise,
) = offlineSttLivePipelineHelper.startSttOfflineLivePipeline(
  instanceId,
  audioInLiveBufferId,
  textOutLiveBufferId,
  options,
  promise,
)
```

---

## Native — iOS (Obj-C++ / C++)

### `SherpaOnnx+OfflineSTTLivePipeline.h` / `.mm`

New files in `ios/stt/bridge/`:

```objcpp
// header
@interface SherpaOnnx (OfflineSTTLivePipeline)

- (void)startSttOfflineLivePipeline:(NSString *)instanceId
                audioInLiveBufferId:(NSString *)audioInLiveBufferId
                textOutLiveBufferId:(NSString *)textOutLiveBufferId
                            options:(JS::NativeSherpaOnnx::SpecStartSttOfflineLivePipelineOptions &)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject;

@end
```

```objcpp
// implementation
- (void)startSttOfflineLivePipeline:(NSString *)instanceId
                audioInLiveBufferId:(NSString *)audioInLiveBufferId
                textOutLiveBufferId:(NSString *)textOutLiveBufferId
                            options:(JS::NativeSherpaOnnx::SpecStartSttOfflineLivePipelineOptions &)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  // 1. Resolve OfflineSttWrapper from g_offline_stt_instances[instanceId]; reject STT_INSTANCE_NOT_FOUND if missing.
  // 2. Resolve PaLiveEntry / TxtLiveEntry; reject BUFFER_KIND_MISMATCH on mismatch.
  // 3. Parse segmentationPolicy via the same parser used by attachSegmentationEngine.
  // 4. seg = seg_engine_attach_speech(bufferId, policy); resolve segLiveEntry from seg.segmentBufferId.
  // 5. Construct SttOfflineLivePipelineWorker (sub-02 base), register via SharedStreamingPipelineRegistry.
  // 6. resolve(@{ @"pipelineId": pipelineId }).
}
```

### `SttOfflineLivePipelineWorker.h` / `.mm`

Mirrors the Android worker — subclass `OfflineLivePipelineWorker` (sub-02), implement `onSegmentCommitted`:

```cpp
class SttOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  SttOfflineLivePipelineWorker(std::string pipelineId,
                               std::string attachedSegmentationEngineId,
                               std::shared_ptr<PaLiveEntry> audioInput,
                               std::shared_ptr<SegLiveEntry> audioSegmentInput,
                               std::shared_ptr<TxtLiveEntry> textOutput,
                               sherpaonnx::OfflineSttWrapper *wrapper,
                               int chunkSize);

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<TxtLiveEntry> textOutput_;
  sherpaonnx::OfflineSttWrapper *wrapper_;
  int chunkSize_ = 3200;
};
```

`onSegmentCommitted` reads PCM via `audioInput->readSamples(startSample, endSample)`, runs the wrapper's create-stream / decode / get-result flow, then appends a committed text segment to `textOutput_` (the same path that `seg_engine_speech_commit` uses today for streaming STT, just driven from the offline recognizer).

---

## Per-feature segmentation defaults

Per design §5.3:

- Default policy when caller omits explicit policy: **`speech_energy_silence`**.
- `speech_vad_model` is supported when caller provides `policy.modelPath` (existing semantics; the live overload does **not** auto-detect a VAD model).
- `text_*` evaluators are rejected at validation time (sub-01 enforces domain).
- `continuous_frames` is rejected for STT (sub-01 doesn't whitelist it for `'speech'` domain unless `supportedEvaluators` is set; STT uses the default speech whitelist).

---

## Validation (mandatory contract)

- TS-level: `transcribe(LiveAudio, LiveText, options)` requires `options.segmentation.policy` (compile-time error if missing).
- Runtime-level: `validateLiveOfflinePipelineOptions(...)` (sub-01) throws `LIVE_OFFLINE_SEGMENTATION_REQUIRED` for:
  - `options.segmentation` undefined
  - `options.segmentation.policy` undefined
  - `options.segmentation.mode` set to `'off'` or `'manual'`
  - any policy domain mismatch (e.g. text evaluator on speech domain)

Per design §8 (acceptance criteria): the negative-path test below covers all four cases.

---

## Test matrix (Jest)

`src/stt/__tests__/live-offline.test.ts` — new file.

| # | Scenario | Expected |
|---|---|---|
| L-1 | **Golden path**: offline weights (Whisper-tiny) + LiveAudio mic-buffer + `speech_energy_silence` policy → committed text segments arrive on the LiveTextBuffer; `pipeline.stop()` resolves; `pipeline.completed` settles `'completed'` or `'stopped'`. | Pass |
| L-2 | `transcribe(liveAudio, liveText, {})` (missing options.segmentation) | Throws `LiveOfflinePipelineError`, `code === 'LIVE_OFFLINE_SEGMENTATION_REQUIRED'`. |
| L-3 | `transcribe(liveAudio, liveText, { segmentation: { mode: 'off' } } as any)` | Same as L-2. |
| L-4 | `transcribe(liveAudio, liveText, { segmentation: { policy: { evaluator: 'text_synthetic_auto' } } } as any)` (text policy on speech input) | Throws `LiveOfflinePipelineError`, message mentions speech evaluator. |
| L-5 | Mixed: `transcribe(offlineAudio, liveText, …)` | Throws `STT_INVALID_ARGUMENT`. |
| L-6 | `flush()`: live audio buffer is finalized mid-pipeline → handle resolves with all in-flight segments committed; remaining tail (if any) is processed by `detachSegmentationEngine(..., flushFinal: true)`. | Pass |
| L-7 | `stop()` mid-segment → in-flight decode is cancelled; pipeline status reports `error == null && reason == 'stopped'`; segmentation engine is detached. | Pass |
| L-8 | `onSegment` callback fires once per committed segment (count matches output buffer's `segmentCount`). | Pass |

In addition, the existing batch tests (`transcribe-segmented.test.ts`) must remain **green** — the batch overload signature/behavior is unchanged.

---

## Native build verification

- **Android**: `cd example && yarn android` runs the example app's STT live-overload screen against a Whisper-tiny model (sub-07 wires the screen).
- **iOS**: `xcodebuild` Debug simulator + manual smoke on the same screen.

Both platforms verify:
- Pipeline start/stop/flush no longer leak the segmentation engine.
- Completion event payload uses `unitsRead = total samples consumed`, `unitsWritten = total chars committed`.

---

## Acceptance criteria

- New `transcribe(LiveAudio, LiveText, options)` overload exists on `SttEngine`.
- All Jest cases L-1 … L-8 pass.
- Existing `transcribe-segmented.test.ts` and `transcribe.test.ts` remain green (batch path unchanged).
- `SttOfflineLivePipelineWorker` is a thin subclass of `OfflineLivePipelineWorker` — only `onSegmentCommitted` (and feature-specific cleanup, if any) is overridden.
- No changes to `createStreamingSTT` / `LiveSttEngine`.
- Doc: `docs/stt-offline.md` gets a new section **"Live overload"** linking to the design note. (Done as part of sub-07.)

---

## Open questions

### OQ-3.1 — Should `chunkSize` actually do something for the live overload, or be ignored?

**Question.** `chunkSize` controls the streaming worker's drain granularity. In the live-offline path, every segment is decoded as a whole (`stream.acceptWaveform(pcm, sr); stream.inputFinished(); recognizer.decode(stream);`). What should the option do?

**Recommendation: Use `chunkSize` for very long segments, otherwise ignore.** Specifically:

- If `pcm.length <= chunkSize`, decode in one shot (current behavior).
- If `pcm.length > chunkSize`, accept the waveform in `chunkSize`-sized batches before `inputFinished()`. This prevents pathological long segments (e.g. 5+ minute monologues without VAD silence) from spiking memory in the recognizer's internal feature buffer.
- Default `chunkSize: 3200` (≈200 ms @ 16 kHz) matches the streaming-STT default and is a safe lower bound.

Alternative considered: drop `chunkSize` entirely. Rejected because long segments are precisely the case where users without VAD models hit OOM, and exposing the knob is cheap.

### OQ-3.2 — Whisper-internal segmentation: collision with policy?

**Question.** Whisper's offline decoder produces 30 s windows internally. If the user picks a `speech_energy_silence` policy with `maxSegmentMs: 60000`, each commit decodes ~60 s of audio with two internal Whisper passes. Should we cap or warn?

**Recommendation: Document, do not cap.** Reasoning:

- Capping would override user intent without telemetry to justify a default.
- The existing offline orchestrator already handles long Whisper inputs the same way; this overload's behavior matches.
- Add a documentation note in `docs/stt-offline.md` (see sub-07) recommending `maxSegmentMs ≤ 30000` for Whisper to reduce per-segment latency.

### OQ-3.3 — Should the live overload return `SttPipelineHandle` (existing) or a new `SttLivePipelineHandle`?

**Question.** The existing `SttPipelineHandle` is exposed by streaming STT (`createStreamingSTT().transcribe(...)`). Reusing it for the live overload could imply identical semantics, while users may want to differentiate.

**Recommendation: Reuse `SttPipelineHandle`.** Reasoning:

- Both handles use the same `streamingPipelineCompleted` event, the same `stop`/`flush`/`reset`/`getStatus` calls, and write to the same `LiveTextBuffer`.
- The differences (no partials in the live-offline case) are documented at the engine level, not the handle level — handle methods all behave identically.
- Adding a new handle type would balloon the public type surface for zero ergonomic gain.

If telemetry shows users tripping over "did this come from streaming STT or live-offline STT?", we can add a `kind: 'streaming' | 'live-offline'` field on the handle in a minor version. Until then: keep one handle type.
