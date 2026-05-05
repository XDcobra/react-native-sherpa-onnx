# Sub-Plan 06: Enhancement Live Overload (Restricted)

## Status
- Phase: **5**
- Depends on: sub-01 (foundation contract), sub-02 (shared worker base), sub-03 (STT reference template).
- Prerequisite for: nothing — feature-leaf phase.

## Purpose

Per design §5.1 (decision **b**, rationale §5.2), the offline `EnhancementEngine` (offline denoiser, e.g. GTCRN/DPDFNet) gains a live-buffer overload of `enhance()`, but with **enforced policy restriction**: only `policy.evaluator === 'continuous_frames'` is accepted.

Why the restriction (from design §5.2):

> Speech denoisers carry non-trivial inter-frame state and produce **boundary artifacts** when chunked without overlap. The streaming engine handles this with `continuous_frames` (fixed frame block) and `supportedEvaluators: ['continuous_frames']`. The live overload on `createEnhancement` must mirror that constraint.

The end state of this phase:

- A user with **GTCRN/DPDFNet offline-only** assets can drive a live audio pipeline, with the SDK enforcing `continuous_frames` to keep boundary artifacts manageable.
- The feature documentation states the trade-off: **audible boundary discontinuities are possible** vs. the true online denoiser; for artifact-free real-time output use `createStreamingEnhancement`.

---

## API surface

### TypeScript — `src/enhancement/types.ts`

Add a new options type and overload `enhance()` on `EnhancementEngine`. The existing batch overload is **unchanged**.

```ts
import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { SpeechSegment } from '../segment/types';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { EnhancementPipelineHandle } from './streamingTypes';
import type { SegmentationPolicy } from '../segment/engine-types';

/**
 * Live-pipeline options for enhancement. Policy evaluator is restricted to
 * `continuous_frames` — see `sub-06-enhancement-live-overload.md`.
 */
export interface EnhancementLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  segmentation: {
    /** Required. Must be a `continuous_frames` policy. */
    policy: SegmentationPolicy & { evaluator: 'continuous_frames' };
    mode?: 'auto';
  };

  /**
   * Optional mirror of every committed audio chunk (per `continuous_frames`
   * checkpoint). Same constraints as STT's `onSegment`.
   */
  onSegment?: (segment: SpeechSegment) => void;
}

export interface EnhancementEngine {
  readonly instanceId: string;

  // Existing batch overload (unchanged).
  enhance(
    audioIn: OfflineAudioBufferIdSource,
    audioOut: OfflineAudioBufferIdSource,
    options?: EnhanceOptions
  ): Promise<EnhancementResult>;

  // NEW live overload — restricted to continuous_frames.
  enhance(
    audioIn: LiveAudioBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options: EnhancementLivePipelineOptions   // REQUIRED
  ): Promise<EnhancementPipelineHandle>;

  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
}
```

> Note: at the **type level**, `policy.evaluator` is constrained to `'continuous_frames'` via intersection with the live options. This means TS code that tries to pass a different evaluator does not compile. The runtime validator (sub-01) supplies the second line of defense for JS callers.

### Native bridge — `src/NativeSherpaOnnx.ts`

```ts
startEnhancementOfflineLivePipeline(
  instanceId: string,
  audioInLiveBufferId: string,
  audioOutLiveBufferId: string,
  options: {
    segmentationPolicy: Object;   // already-marshalled SegmentationPolicy (must be continuous_frames)
  }
): Promise<{ pipelineId: string }>;
```

---

## JS implementation outline

`src/enhancement/index.ts` — extend the engine returned by `createEnhancement()`:

```ts
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import { isLiveAudioBufferIdSource, resolvePipelineAudioBufferId } from '../audiobuffer';

async function enhanceLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  audioOut: LiveAudioBufferIdSource,
  options: EnhancementLivePipelineOptions,
): Promise<EnhancementPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline enhancement',
    domain: 'speech',
    supportedEvaluators: ['continuous_frames'],
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineAudioBufferId(audioIn);
  const outId = resolvePipelineAudioBufferId(audioOut);

  const { pipelineId } = await SherpaOnnx.startEnhancementOfflineLivePipeline(
    instanceId,
    inId,
    outId,
    { segmentationPolicy: marshalSegmentationPolicyForNative(policy) },
  );

  if (options.onSegment) {
    subscribeLiveAudioSegmentEvents(outId, options.onSegment);
  }

  return createEnhancementPipelineHandle(instanceId, pipelineId);
}
```

The dispatcher inside the `enhance` returned by `createEnhancement()` checks `isLiveAudioBufferIdSource(audioIn) && isLiveAudioBufferIdSource(audioOut)`; if true → live overload, else → batch (unchanged).

---

## Native — Android (Kotlin)

### `SherpaOnnxOfflineEnhancementLivePipelineHelper.kt`

Same shape as STT/TTS helpers. Resolves `OfflineSpeechEnhancement` from `OfflineEnhancementRegistry`. Validates that the attached policy is `continuous_frames` (defense in depth — JS already checks).

```kotlin
internal class SherpaOnnxOfflineEnhancementLivePipelineHelper(
  private val context: ReactApplicationContext,
) {
  fun startEnhancementOfflineLivePipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) = try {
    val enhancer = OfflineEnhancementRegistry.require(instanceId)
    val liveAudioIn = PipelineAudioRegistry.requireLive(audioInLiveBufferId)
    val liveAudioOut = PipelineAudioRegistry.requireLive(audioOutLiveBufferId)

    val policyMap = options.getMap("segmentationPolicy")
      ?: error("LIVE_OFFLINE_SEGMENTATION_REQUIRED: segmentationPolicy missing on native bridge")
    val policy = SegmentationEngineRegistry.parsePolicy(policyMap)
    require(policy.evaluator == "continuous_frames") {
      "LIVE_OFFLINE_SEGMENTATION_REQUIRED: live enhancement supports only continuous_frames policy; received ${policy.evaluator}"
    }

    val seg = SegmentationEngineRegistry.attach(
      bufferId = audioInLiveBufferId,
      policy = policy,
    )
    val liveSegmentEntry = SegmentPipelineRegistry.requireLive(seg.segmentBufferId!!)

    val pipelineId = "live_offline_enh_${UUID.randomUUID()}"
    val worker = EnhancementOfflineLivePipelineWorker(
      pipelineId = pipelineId,
      attachedSegmentationEngineId = seg.engineId,
      audioInput = OfflineLivePipelineWorker.AudioInput(
        liveAudioEntry = liveAudioIn,
        liveSegmentEntry = liveSegmentEntry,
      ),
      enhancer = enhancer,
      audioOutputEntry = liveAudioOut,
    )
    StreamingPipelineRegistry.registerAndStart(worker) { completion ->
      emitStreamingPipelineCompleted(context, completion)
    }
    promise.resolve(WritableNativeMap().apply { putString("pipelineId", pipelineId) })
  } catch (e: Exception) {
    promise.reject(
      "LIVE_OFFLINE_SEGMENTATION_REQUIRED",
      e.message ?: "live offline enhancement failed",
      e,
    )
  }
}
```

### `EnhancementOfflineLivePipelineWorker.kt`

```kotlin
internal class EnhancementOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  audioInput: AudioInput,
  private val enhancer: OfflineSpeechEnhancement,
  private val audioOutputEntry: LiveEntry,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInput,
  textInput = null,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech
      ?: error("Expected speech segment in enhancement live overload")

    require(audioOutputEntry.sampleRate == speech.sampleRate) {
      "ENHANCEMENT_SAMPLE_RATE_MISMATCH: live audio out is ${audioOutputEntry.sampleRate} Hz; chunk is ${speech.sampleRate} Hz"
    }

    val pcm = audioInput!!.liveAudioEntry.readSamples(
      startSample = speech.startSample,
      endSample = speech.endSample,
    )

    // The offline enhancer accepts a raw PCM buffer and returns denoised PCM
    // (same call shape used by the existing offline batch path).
    val denoised = enhancer.process(pcm, speech.sampleRate)
    audioOutputEntry.appendSamples(denoised)
  }
}
```

### TurboModule wiring

```kotlin
@ReactMethod
fun startEnhancementOfflineLivePipeline(
  instanceId: String,
  audioInLiveBufferId: String,
  audioOutLiveBufferId: String,
  options: ReadableMap,
  promise: Promise,
) = offlineEnhancementLivePipelineHelper.startEnhancementOfflineLivePipeline(
  instanceId, audioInLiveBufferId, audioOutLiveBufferId, options, promise,
)
```

---

## Native — iOS (Obj-C++ / C++)

`ios/enhancement/SherpaOnnx+OfflineEnhancementLivePipeline.{h,mm}` — mirrors the existing iOS pattern.

```cpp
class EnhancementOfflineLivePipelineWorker : public OfflineLivePipelineWorker {
public:
  EnhancementOfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::shared_ptr<SegLiveEntry> audioSegmentInput,
    std::shared_ptr<PaLiveEntry> audioOutput,
    sherpaonnx::OfflineSpeechEnhancementWrapper *wrapper);

protected:
  void onSegmentCommitted(const CommittedSegmentRef &segment) override;
};
```

`onSegmentCommitted` reads PCM, calls the wrapper's offline enhance method (same call shape as `enhanceOfflineAudioBuffers`), and appends denoised PCM to the output buffer.

---

## Per-feature segmentation defaults

Per design §5.3:

- **Default policy**: There is **no caller-implicit default** for enhancement. The `continuous_frames` policy requires explicit `checkpointIntervalMs` (and possibly `frameShiftSamples`); we don't pretend to pick one. The validator throws if `policy` is missing entirely. If the user omits `checkpointIntervalMs`, the segmentation engine uses its own default (currently 1000 ms — verified in `segmentation_engine_overview.md` Phase 3 notes).
- **Allowed evaluators**: `['continuous_frames']` only. JS validator (sub-01) and native helper both enforce this.
- **Sample rate**: `audioOut.sampleRate == audioIn.sampleRate == enhancer.sampleRate` (existing constraint).

---

## Validation

The validator (sub-01) is called with `supportedEvaluators: ['continuous_frames']`, so:

- Missing `segmentation` / missing `policy` → `LIVE_OFFLINE_SEGMENTATION_REQUIRED` (generic case).
- `mode: 'off'` / `mode: 'manual'` → `LIVE_OFFLINE_SEGMENTATION_REQUIRED`.
- `policy.evaluator !== 'continuous_frames'` → `LIVE_OFFLINE_SEGMENTATION_REQUIRED` with message `"... live enhancement supports only continuous_frames policy; received <evaluator>."`.

Per design §7.6, **all** of these failures use the **same** code (`LIVE_OFFLINE_SEGMENTATION_REQUIRED`). The message is what disambiguates.

---

## Test matrix (Jest)

`src/enhancement/__tests__/enhance-live-offline.test.ts` — new file.

| # | Scenario | Expected |
|---|---|---|
| LE-1 | **Golden path**: offline GTCRN + LiveAudioBuffer in (`continuous_frames` policy with `checkpointIntervalMs: 1000`) → denoised audio segments arrive on output LiveAudioBuffer; `pipeline.stop()` resolves. | Pass |
| LE-2 | `enhance(liveAudio, liveAudio, {})` (missing options.segmentation) | `LiveOfflinePipelineError`, code `LIVE_OFFLINE_SEGMENTATION_REQUIRED`. |
| LE-3 | `enhance(liveAudio, liveAudio, { segmentation: { policy: { evaluator: 'speech_energy_silence' } } } as any)` | `LiveOfflinePipelineError`, message contains `continuous_frames`. |
| LE-4 | `enhance(liveAudio, liveAudio, { segmentation: { policy: { evaluator: 'speech_vad_model', modelPath: <…> } } } as any)` | Same as LE-3 — `continuous_frames` is the **only** allowed evaluator. |
| LE-5 | Sample rate mismatch (audioOut SR ≠ enhancer SR) | Native throws `ENHANCEMENT_SAMPLE_RATE_MISMATCH`. |
| LE-6 | `flush()` finalizes the input → tail chunks are processed and committed; pipeline completes cleanly. | Pass |
| LE-7 | `stop()` mid-chunk cancels the in-flight enhancement; segmentation engine is detached. | Pass |
| LE-8 | `onSegment` callback fires per checkpoint commit. | Pass |
| LE-9 | **Boundary artifact behavior** documented & explicit: comparing live-offline output with the true streaming-enhancement output on the same input shows expected artifact pattern at chunk boundaries (this is a **regression test for the artifact assumption** so we don't claim parity we don't have). | Documented difference, no assertion of equality. |

Existing batch enhancement tests must remain green (the batch overload signature/behavior is unchanged).

---

## Acceptance criteria

- New `enhance(LiveAudio, LiveAudio, options)` overload exists on `EnhancementEngine`.
- All Jest cases LE-1 … LE-9 pass.
- TS-level: `policy.evaluator` is **type-narrowed** to `'continuous_frames'` for the live overload (compile-time enforcement).
- Runtime: validator + native helper both reject non-`continuous_frames` policies.
- Worker is a thin subclass of `OfflineLivePipelineWorker`.
- `createStreamingEnhancement` is **untouched** (online denoiser stays public; the live overload does **not** replace it — see OQ-6.1).
- Doc `docs/enhancement-streaming.md` (or equivalent) gains a "Live overload on offline enhancement (restricted)" section explicitly stating the artifact trade-off (sub-07).

---

## Open questions

### OQ-6.1 — Should the live overload **replace** `createStreamingEnhancement` long-term?

**Question.** Like the TTS dedup question (sub-08), is there an analogous case for enhancement? Both engines (`createStreamingEnhancement` for online denoiser, `createEnhancement` live overload for offline denoiser via `continuous_frames`) sit on **different model weights**.

**Recommendation: No — keep both. They own different weights.** Reasoning:

- Online enhancement (`createStreamingEnhancement`) uses a **streaming-capable denoiser** (e.g. some GTCRN variants are explicitly trained for online causal inference); offline denoisers (e.g. DPDFNet) require non-causal context.
- The boundary-artifact trade-off is real and documented; users with audio quality requirements will pick the streaming engine.
- Removing `createStreamingEnhancement` would be a breaking change for an active use case.

This mirrors the punctuation analysis (sub-04): different model weights → no dedup question.

### OQ-6.2 — Should we expose `overlapSamples` on the live overload?

**Question.** The offline batch enhancement options expose `overlapSamples` (smoother boundaries via overlap-and-add). Should the live overload also support this?

**Recommendation: Yes, but plumb it through `policy.checkpointIntervalMs` indirection — not as a separate option.** Reasoning:

- The `continuous_frames` evaluator already controls the chunk granularity through `checkpointIntervalMs` (and natively `frameShiftSamples`). Adding a separate `overlapSamples` knob would duplicate that responsibility.
- A `continuous_frames` policy with `overlapMs: <N>` is a cleaner extension point — adds the overlap as a policy field consumed by the segmentation engine, not a separate option on the live overload.
- This keeps the live overload's option shape minimal and consistent with the cross-feature pattern.

If post-release telemetry shows users explicitly need overlap on the live path independent of policy, we can add it later. Until then: defer.

### OQ-6.3 — How to handle the implicit boundary-artifact warning?

**Question.** The design note explicitly says "audible boundary discontinuities are possible." Should we surface this as a `console.warn` on first call, a doc note, or no JS-side surfacing at all?

**Recommendation: Doc-only warning, no runtime warn.** Reasoning:

- Once the user picks `createEnhancement().enhance(LiveAudio, LiveAudio, ...)` they have **read the docs** that describe this limitation; warning at runtime adds noise without changing the user's options.
- A `console.warn` for **every** live-enhancement pipeline would be highly intrusive and quickly muted/ignored.
- Documentation in `docs/enhancement-streaming.md` (sub-07) plus a comparison table (live overload vs. streaming engine) is the right surface.

### OQ-6.4 — Should the live overload support both audio-out-as-live-buffer AND audio-out-as-callback?

**Question.** Some users may want denoised PCM directly delivered to a JS callback rather than written to a `LiveAudioBuffer`. Should we add that path?

**Recommendation: No — `LiveAudioBuffer` only.** Reasoning:

- All other live overloads (STT, TTS, punctuation) consume/produce live buffers; adding a callback-output mode for enhancement breaks the cross-feature symmetry.
- Users who want PCM in JS can still attach a `LiveAudioBuffer` reader (existing API).
- Per-frame JS callbacks would also be a performance footgun (bridge crossing per chunk).
