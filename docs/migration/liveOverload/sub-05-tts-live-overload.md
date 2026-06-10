# Sub-Plan 05: TTS Live Overload (Track A)

## Status
- Phase: **4**
- Depends on: sub-01 (foundation contract), sub-02 (shared worker base), sub-03 (STT reference template).
- Prerequisite for: sub-08 (TTS dedup) — that phase **assumes** Track A is complete and stable.

## Purpose

Per design §5.1 (decision **a**) and §7.5 (TTS — two tracks):

> **In scope (required):** Extend the **offline** TTS engine (`createTTS` / `TtsEngine`) with the same pattern as STT: a **live overload** `synthesize(LiveTextBuffer, LiveAudioBuffer, options)` with **mandatory** `segmentation.policy` (text domain), returning the existing `TtsPipelineHandle`.

This sub-plan implements **Track A** (live overload on offline TTS). **Track B** (deduplication of `createStreamingTTS`) is explicitly out of scope here and tracked separately in [sub-08](./sub-08-streaming-tts-dedup.md).

The end state of this phase:

- `tts = createTTS(...)` followed by `await tts.synthesize(liveText, liveAudio, { segmentation: { policy: ... } })` works and returns a `TtsPipelineHandle`.
- `createStreamingTTS(...)` continues to exist **unchanged** (the only deprecated-style alias allowed in this rollout, per design §7.5).
- Behavioral parity: for the same `text_synthetic_auto` policy, the live overload produces the same per-segment audio as `createStreamingTTS().synthesize(...)` does today. Track B will exploit this parity to make the streaming-TTS factory a thin redirect.

---

## API surface

### TypeScript — `src/tts/types.ts`

Add a new options type and overload `synthesize()` on `TtsEngine`. The existing batch overload is **unchanged**.

```ts
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { SpeechSegment } from '../segment/types';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { TtsPipelineHandle } from './streamingTypes';
import type { TtsVoiceClone } from './types';

export interface TtsLivePipelineOptions extends LiveOfflinePipelineBaseOptions {
  /** Speaker ID for the entire pipeline. Default 0. May be overridden per
   *  text segment via `segment.meta.sid` (matches existing streaming-TTS contract). */
  sid?: number;

  /** Speed multiplier. Default 1.0. May be overridden per segment via `segment.meta.speed`. */
  speed?: number;

  /** Voice cloning configuration. Initialized once per pipeline (matches existing
   *  streaming-TTS contract — cloning reference is loaded at pipeline start, not per segment). */
  voiceClone?: TtsVoiceClone;

  /**
   * Optional mirror of every committed audio segment that lands on the output
   * `LiveAudioBuffer`. Same constraints as STT's `onSegment` (worker thread, no `onPartial`).
   */
  onSegment?: (segment: SpeechSegment) => void;
}

export interface TtsEngine {
  readonly instanceId: string;

  // Existing batch overload (unchanged).
  synthesize(
    textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
    audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
    options?: TtsSynthesisOptions
  ): Promise<TtsSynthesisResult>;

  // NEW live overload.
  synthesize(
    textIn: LiveTextBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options: TtsLivePipelineOptions   // REQUIRED
  ): Promise<TtsPipelineHandle>;

  // ... unchanged: updateParams, getModelInfo, getSampleRate, getNumSpeakers, destroy
}
```

### Native bridge — `src/NativeSherpaOnnx.ts`

```ts
startTtsOfflineLivePipeline(
  instanceId: string,                  // existing offline TTS instance from createTTS
  textInLiveBufferId: string,
  audioOutLiveBufferId: string,
  options: {
    segmentationPolicy: Object;        // already-marshalled SegmentationPolicy (text domain)
    sid?: number;
    speed?: number;
    voiceClone?: { /* same shape as TtsVoiceClone, marshalled */ } | null;
  }
): Promise<{ pipelineId: string }>;
```

---

## JS implementation outline

`src/tts/index.ts` — extend the engine returned by `createTTS()`:

```ts
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import { isLiveTextBufferIdSource, resolvePipelineTextBufferId } from '../textbuffer';
import { isLiveAudioBufferIdSource, resolvePipelineAudioBufferId } from '../audiobuffer';

async function synthesizeLiveOverload(
  instanceId: string,
  textIn: LiveTextBufferIdSource,
  audioOut: LiveAudioBufferIdSource,
  options: TtsLivePipelineOptions,
): Promise<TtsPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline TTS',
    domain: 'text',
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineTextBufferId(textIn);
  const outId = resolvePipelineAudioBufferId(audioOut);

  const { pipelineId } = await SherpaOnnx.startTtsOfflineLivePipeline(
    instanceId,
    inId,
    outId,
    {
      segmentationPolicy: marshalSegmentationPolicyForNative(policy),
      sid: options.sid,
      speed: options.speed,
      voiceClone: options.voiceClone
        ? marshalTtsVoiceCloneForNative(options.voiceClone)
        : null,
    },
  );

  if (options.onSegment) {
    subscribeLiveAudioSegmentEvents(outId, options.onSegment);
  }

  return createTtsPipelineHandle(instanceId, pipelineId);
}
```

The dispatcher inside the `synthesize` returned by `createTTS()` checks:
- `isLiveTextBufferIdSource(textIn) && isLiveAudioBufferIdSource(audioOut)` → live overload.
- Both offline → batch overload (unchanged).
- Mixed (offline + live or live + offline) → throw `TTS_INVALID_ARGUMENT` describing the mismatch.

---

## Native — Android (Kotlin)

### `SherpaOnnxOfflineTtsLivePipelineHelper.kt`

Mirrors STT's helper, but resolves `OfflineTts` and routes input from `LiveTextEntry` and output to `LiveEntry` (audio).

```kotlin
internal class SherpaOnnxOfflineTtsLivePipelineHelper(
  private val context: ReactApplicationContext,
) {
  fun startTtsOfflineLivePipeline(
    instanceId: String,
    textInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) = try {
    val tts = OfflineTtsRegistry.require(instanceId)
    val liveTextIn = TextPipelineRegistry.requireLive(textInLiveBufferId)
    val liveAudioOut = PipelineAudioRegistry.requireLive(audioOutLiveBufferId)

    require(liveAudioOut.sampleRate == tts.sampleRate) {
      "TTS_SAMPLE_RATE_MISMATCH: live audio buffer is ${liveAudioOut.sampleRate} Hz; model needs ${tts.sampleRate} Hz"
    }

    val seg = SegmentationEngineRegistry.attach(
      bufferId = textInLiveBufferId,
      policy = SegmentationEngineRegistry.parsePolicy(
        options.getMap("segmentationPolicy")
          ?: error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: segmentationPolicy missing on native bridge")
      ),
    )

    val voiceClone = parseTtsVoiceClone(options.getMap("voiceClone"))

    val pipelineId = "live_offline_tts_${UUID.randomUUID()}"
    val worker = TtsOfflineLivePipelineWorker(
      pipelineId = pipelineId,
      attachedSegmentationEngineId = seg.engineId,
      textInput = OfflineLivePipelineWorker.TextInput(liveTextIn),
      tts = tts,
      audioOutputEntry = liveAudioOut,
      defaultSid = if (options.hasKey("sid")) options.getInt("sid") else 0,
      defaultSpeed = if (options.hasKey("speed")) options.getDouble("speed") else 1.0,
      voiceClone = voiceClone,
    )
    StreamingPipelineRegistry.registerAndStart(worker) { completion ->
      emitStreamingPipelineCompleted(context, completion)
    }
    promise.resolve(WritableNativeMap().apply { putString("pipelineId", pipelineId) })
  } catch (e: Exception) {
    promise.reject("TTS_LIVE_OFFLINE_FAILED", e.message ?: "live offline TTS failed", e)
  }
}
```

### `TtsOfflineLivePipelineWorker.kt`

```kotlin
internal class TtsOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  textInput: TextInput,
  private val tts: OfflineTts,
  private val audioOutputEntry: LiveEntry,
  private val defaultSid: Int,
  private val defaultSpeed: Double,
  private val voiceClone: TtsVoiceCloneNative?,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = null,
  textInput = textInput,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val text = (segment as? CommittedSegmentRef.Text)
      ?: error("Expected text segment in TTS live overload")

    val perSegmentSid = text.metaIntOrNull("sid") ?: defaultSid
    val perSegmentSpeed = text.metaDoubleOrNull("speed") ?: defaultSpeed

    val pcm = tts.generate(
      text.text,
      sid = perSegmentSid,
      speed = perSegmentSpeed.toFloat(),
      voiceClone = voiceClone,
    )

    audioOutputEntry.appendSamples(pcm)
    // appendSamples already commits a speech segment via existing TTS streaming path
    // (text-driven commit boundaries from segmentation engine map 1:1 to audio segments).
  }
}
```

### TurboModule wiring

```kotlin
@ReactMethod
fun startTtsOfflineLivePipeline(
  instanceId: String,
  textInLiveBufferId: String,
  audioOutLiveBufferId: String,
  options: ReadableMap,
  promise: Promise,
) = offlineTtsLivePipelineHelper.startTtsOfflineLivePipeline(
  instanceId, textInLiveBufferId, audioOutLiveBufferId, options, promise,
)
```

---

## Native — iOS (Obj-C++ / C++)

`ios/tts/bridge/SherpaOnnx+OfflineTtsLivePipeline.{h,mm}` — mirrors STT's iOS pattern.

```cpp
class TtsOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  TtsOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<TxtLiveEntry> textInput,
    std::shared_ptr<PaLiveEntry> audioOutput,
    sherpaonnx::OfflineTtsWrapper *wrapper,
    int defaultSid,
    float defaultSpeed,
    std::optional<TtsVoiceCloneConfig> voiceClone);

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;

private:
  std::shared_ptr<PaLiveEntry> audioOutput_;
  sherpaonnx::OfflineTtsWrapper *wrapper_;
  int defaultSid_ = 0;
  float defaultSpeed_ = 1.0f;
  std::optional<TtsVoiceCloneConfig> voiceClone_;
};
```

`onSegmentCommitted` reads `segment.text`, calls the existing TTS wrapper's generate method (same path as `TtsPipelineWorker::synthesizeSegment`), then appends PCM to `audioOutput_`.

---

## Per-feature segmentation defaults

Per design §5.3:

- Default policy when caller omits explicit policy: **`text_synthetic_auto`** with `maxLengthChars: 500`, `sentenceBoundary: true`.
- `text_punctuation_assisted` is supported when caller provides `policy.punctuationInstanceId`.
- `speech_*` evaluators are rejected.

---

## Validation

Same contract as sub-03 (STT). The validator (sub-01) handles missing-policy / `mode: 'off'` / `mode: 'manual'` / domain-mismatch cases uniformly with `LIVE_OFFLINE_SEGMENTATION_REQUIRED`.

Additional native-side validation reused from existing `TtsPipelineWorker`:

- `audioOut.sampleRate == tts.sampleRate` (strict — already enforced for streaming TTS today).
- `audioOut.state == 'recording'` (existing live audio buffer state machine).

---

## Test matrix (Jest)

`src/tts/__tests__/synthesize-live-offline.test.ts` — new file.

| # | Scenario | Expected |
|---|---|---|
| LT-1 | **Golden path**: offline VITS + LiveTextBuffer in (`text_synthetic_auto`) → audio segments arrive on output LiveAudioBuffer; sample rate matches model; `pipeline.stop()` resolves. | Pass |
| LT-2 | `synthesize(liveText, liveAudio, {})` (missing options.segmentation) | `LiveOfflinePipelineError`, code `LIVE_OFFLINE_SEGMENTATION_REQUIRED`. |
| LT-3 | `synthesize(liveText, liveAudio, { segmentation: { policy: { evaluator: 'speech_energy_silence' } } } as any)` | `LiveOfflinePipelineError`, message mentions text evaluator. |
| LT-4 | LiveAudioBuffer sample rate ≠ model sample rate. | Throws (native side) `TTS_SAMPLE_RATE_MISMATCH` — matches existing streaming-TTS error. |
| LT-5 | Per-segment `meta.sid` overrides pipeline-default `sid` (from options). | Output audio uses per-segment sid. |
| LT-6 | Per-segment `meta.speed` overrides pipeline-default `speed`. | Output audio uses per-segment speed. |
| LT-7 | Voice cloning configured at pipeline start applies to all subsequent segments. | Synthesized voice matches reference; voice clone reference loaded once. |
| LT-8 | `flush()`: input live text buffer is finalized → in-flight + tail segments are committed; audio output buffer also has the tail data. | Pass |
| LT-9 | `stop()` mid-segment cancels TTS; partial PCM may be flushed but no further appends after stop. | Pass |
| LT-10 | **Parity** with `createStreamingTTS().synthesize(liveText, liveAudio, { segmentation: { mode: 'auto', policy: <same> } })`: produces identical audio (sample-equal modulo rounding) for the same input text. | Pass |

> LT-10 is the **parity gate** for sub-08. If parity holds, sub-08's redirect-style dedup is straightforward. If LT-10 surfaces drift, sub-08 must reconcile before any deprecation messaging.

Existing `synthesize-mode2-segmented.test.ts`, `streaming-mode4-segmentation.test.ts`, etc. must remain **green** — neither the batch path nor the streaming-TTS factory is touched in this phase.

---

## Acceptance criteria

- New `synthesize(LiveText, LiveAudio, options)` overload exists on `TtsEngine`.
- All Jest cases LT-1 … LT-10 pass.
- Existing batch + streaming-TTS test suites remain green.
- Worker is a thin subclass of `OfflineLivePipelineWorker`.
- `createStreamingTTS` is **untouched** in this sub-plan (intentional — see sub-08).
- Doc `docs/tts-offline.md` documents the **"Live overload on offline TTS"** behavior and links to the design note.

---

## Resolved decisions

### OQ-5.1 — Per-segment `meta.sid` / `meta.speed` resolution

**Decision: Yes — mirror existing streaming TTS behavior exactly (accepted).**

Per-segment `meta.sid` / `meta.speed` overrides pipeline defaults; fallback stays `options.sid` / `options.speed`.

### OQ-5.2 — Should `voiceClone` ever be re-loaded mid-pipeline?

**Decision: No — keep voice clone pipeline-scoped (accepted).**

`voiceClone` is initialized once at pipeline start and is not overridden per segment via `meta`.

### OQ-5.3 — How to surface a mid-pipeline TTS failure (e.g. one segment fails)?

**Decision: Skip failed segment and continue, with status accounting (accepted).**

Worker records the latest error in pipeline status (`pipeline.getStatus().error`) and continues processing subsequent segments.

### OQ-5.4 — Should the live overload support `silenceScale` / `numSteps` from offline batch options?

**Decision: No — keep live overload option shape aligned with streaming TTS (`sid`, `speed`, `voiceClone`) (accepted).**

`silenceScale` / `numSteps` are not part of the Phase-4 live-overload option shape.
