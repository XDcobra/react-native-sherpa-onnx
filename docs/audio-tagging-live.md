# Audio tagging (live overload)

> **Live overload** — not a streaming audio-tagging model.
>
> This guide uses the **same offline** CED / Zipformer weights as [audio-tagging-offline.md](audio-tagging-offline.md). Live audio is sliced by a mandatory **speech segmentation policy**; each committed span is tagged **natively** inside an `OfflineLivePipelineWorker`. There is **no** separate online/streaming audio tagger in sherpa-onnx.
>
> Contrast with features that have a **true streaming** engine (e.g. [stt-streaming.md](stt-streaming.md), [vad-streaming.md](vad-streaming.md), [kws-streaming.md](kws-streaming.md), [enhancement-streaming.md](enhancement-streaming.md) via `createStreaming*` / `createKeywordSpotting`).

## Introduction

On-device **sound-event tagging** over a live audio stream. Audio tagging owns speech/energy segmentation; a native live worker tags each committed span, commits the **primary event name** to a live text Out buffer (plus top-K in meta), and optionally appends labeled speech segments (`payload.source: 'audioTagging'`).

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mic / file ingest |
| **Text out** | [`LiveTextBuffer`](textbuffer-streaming.md) | Required — committed primary event names |
| **Segments out (optional)** | [`LiveSegmentBuffer`](segmentbuffer-streaming.md) | `payload.source: 'audioTagging'`, `primaryName`, `events` |
| **Engine** | Same `AudioTaggingEngine` as offline | `tag(liveAudio, liveText, options)` |
| **Pipeline handle** | `AudioTaggingPipelineHandle` | `stop` / `flush` / `reset` / `getStatus` / `completed` |

Import path: **`react-native-sherpa-onnx/audio-tagging`**.

Factory / detect / models: [audio-tagging-offline.md](audio-tagging-offline.md#api-reference).

## Quick start

```ts
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
} from 'react-native-sherpa-onnx/audio-tagging';

// Assume `tagger` from createAudioTagging (see offline doc).

const audioIn = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
});
const textOut = await createLiveTextBuffer();

const pipeline = await tagger.tag(audioIn, textOut, {
  topK: 5,
  segmentation: {
    mode: 'auto',
    policy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
    // Or continuous_frames with checkpointIntervalMs >= 1500
  },
  onSegment: (e) =>
    console.log(
      '#',
      e.segmentIndex,
      e.result.primary?.name,
      e.durationMs,
      e.result.events
    ),
  // e → {
  //   segmentIndex: 0,
  //   startTime: 1.2,
  //   endTime: 3.0,
  //   durationMs: 1800,
  //   result: {
  //     events: [
  //       { name: 'Dog', index: 74, prob: 0.88 },
  //       { name: 'Speech', index: 0, prob: 0.21 },
  //       …
  //     ],
  //     primary: { name: 'Dog', index: 74, prob: 0.88 },
  //     audioDuration: 1.8,
  //     elapsedMs: 0,
  //     topK: 2,
  //   },
  // }
});
// pipeline → AudioTaggingPipelineHandle
//   { instanceId, pipelineId, stop, flush, reset, getStatus, completed }

await startMicToLiveAudioBuffer(audioIn);
// … capture …
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(audioIn);
const completion = await pipeline.completed;
// completion → { reason: 'completed' }  // or { reason: 'stopped' } after stop()

await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

`finalizeLiveAudioBuffer(audioIn)` drains remaining spans and resolves `completed`. Prefer that over an early `stop()` when the session ends naturally.

## Buffer matrix

| | Offline | Live overload |
| --- | --- | --- |
| **Audio in** | `OfflineAudioBuffer` | `LiveAudioBuffer` |
| **Text out** | — | `LiveTextBuffer` (**required**) |
| **Segments out** | optional offline `targetSegmentBuffer` | optional live `targetSegmentBuffer` |
| **Return** | result object | `AudioTaggingPipelineHandle` |

Mixed live/offline arguments throw `AUDIO_TAGGING_INVALID_ARGUMENT`.

## Mandatory segmentation

`options.segmentation.policy` is **required** (`LIVE_OFFLINE_SEGMENTATION_REQUIRED` if missing or `mode !== 'auto'`).

| Evaluator | Live overload | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ | Default via `DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY` (`minSegmentMs: 1500`) |
| `continuous_frames` | ✅ | Fixed windows; `checkpointIntervalMs` must be ≥ 1500 |
| `speech_vad_model` | ❌ | Speech-only windows miss sirens, music, and other non-speech events |
| `speech_pyannote_segmentation` | ❌ | Same reason — speech-only cuts |

Audio tagging attaches the engine — you do **not** pass a pre-built VAD segment In from the app for the worker path.

### Live span floor (`AUDIO_TAGGING_LIVE_MIN_SPAN_MS`)

Live OfflineLive workers skip spans shorter than **1500 ms**. JS `assertAudioTaggingLiveSpanPolicy` rejects policies that cannot meet that floor:

| Evaluator | Constraint |
| --- | --- |
| `speech_energy_silence` | `minSegmentMs` and `maxSegmentMs` ≥ 1500 (and `max ≥ min`) |
| `continuous_frames` | `checkpointIntervalMs` ≥ 1500 |

Policy tuning: [segmentation-engine.md](segmentation-engine.md).

## Pipeline handle

Same control surface as other streaming / live-overload features ([streaming-pipelines-overview.md](streaming-pipelines-overview.md)):

| Method | Behavior |
| --- | --- |
| `stop()` | Stop tagging, flush remaining committed spans, resolve `completed` with `reason: 'stopped'`. |
| `flush()` | Tag **already-committed** spans. Open tail emits on `stop` / input finalize. |
| `reset()` | Clears progress counters while the pipeline remains running. |
| `getStatus()` | `{ pipelineId, isRunning, chunksProcessed, unitsRead, unitsWritten, error }` |
| `completed` | Resolves on graceful finalize (`completed`) or `stop()` (`stopped`); rejects on fatal errors (`STREAMING_PIPELINE_ERROR`). |

## LiveText encoding

Each committed span writes one LiveText segment:

| Field | Value |
| --- | --- |
| `text` | Primary event `name` (highest probability) |
| `source` | `'audio_tagging'` |
| `timestamps` | `[startTime, endTime]` (seconds) |
| `meta.durationMs` | Span duration in ms |
| `meta.events` | Nested top-K array `[{ name, index, prob }]` |

LiveText `meta` is a Fabric-safe JSON tree. Apps that read the buffer directly see `meta.events` as an array. The JS `onSegment` callback maps it into `AudioTaggingLiveSegmentEvent.result`.

See [live-text-meta-json-tree-contract.md](future-work/live-text-meta-json-tree-contract.md).

## API reference

```ts
tag(
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: AudioTaggingLivePipelineOptions
): Promise<AudioTaggingPipelineHandle>;
```

```ts
type AudioTaggingLivePipelineOptions = {
  segmentation: {
    policy: SegmentationPolicy; // speech_energy_silence | continuous_frames
    mode?: 'auto';
  };
  topK?: number;
  onSegment?: (event: AudioTaggingLiveSegmentEvent) => void;
  targetSegmentBuffer?: LiveSegmentBufferIdSource;
};
```

`AudioTaggingLiveSegmentEvent` carries `segmentIndex`, `startTime`, `endTime`, `durationMs`, and `result: AudioTaggingResult` (parsed from LiveText). There is no `onLanguageChanged` / separate `onEvent` API — use `onSegment` (and optionally read LiveText commits).

## Optional `targetSegmentBuffer`

Pass a **live** segment buffer (`seg_live_*`) to append the same payload as offline:

```ts
payload: {
  source: 'audioTagging';
  primaryName?: string;
  events?: Array<{ name: string; index: number; prob: number }>;
}
```

Offline `targetSegmentBuffer` ids are rejected (`AUDIO_TAGGING_INVALID_ARGUMENT`).

## Error codes

| Code / token | Typical reason |
| --- | --- |
| `LIVE_OFFLINE_SEGMENTATION_REQUIRED` | Missing `segmentation` / `policy`, or `mode !== 'auto'`. |
| `AUDIO_TAGGING_INVALID_ARGUMENT` | Non-live audio/text, bad span policy, or non-live `targetSegmentBuffer`. |
| `AUDIO_TAGGING_TAG_FAILED` | Live start / tag path failed. |
| `STREAMING_PIPELINE_ERROR` | Fatal error during the run; `completed` rejects with this `code`. |
| `AUDIO_TAGGING_*` / `SEGMENT_*` | Same codes as [offline audio tagging](audio-tagging-offline.md#error-codes). |

## See also

- [Audio tagging (offline)](audio-tagging-offline.md)
- [Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)
- [Segmentation engine](segmentation-engine.md)
- [Pipeline audio buffers — streaming](audiobuffer-streaming.md)
- [Pipeline text buffers — live](textbuffer-streaming.md)
- [Spoken language identification (live overload)](language-identification-live.md) — same live-overload pattern

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer**. Full details: [native-diagnostics.md](./native-diagnostics.md).
