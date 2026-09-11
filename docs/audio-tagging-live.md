# Audio tagging (live overload)

> **Live overload** — not a streaming audio-tagging model.
>
> Live audio is sliced by a mandatory speech segmentation policy; each committed span is tagged natively with the same offline CED/Zipformer weights. There is no separate online/streaming audio tagger in sherpa-onnx.

## Introduction

On-device **sound-event tagging** over a live mic or file stream. Each committed span writes the primary event name (and top-K meta) to a live text buffer and can optionally append labeled speech segments.

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
    console.log(e.segmentIndex, e.result.primary?.name, e.durationMs),
});

await startMicToLiveAudioBuffer(audioIn);
// … capture …
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(audioIn);
const completion = await pipeline.completed;
console.log(completion.reason);

await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

`finalizeLiveAudioBuffer(audioIn)` drains remaining spans and resolves `completed`. Prefer that over an early `stop()` when the session ends naturally.

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mic / file ingest (offline path uses `OfflineAudioBuffer`) |
| **Text out** | [`LiveTextBuffer`](textbuffer-streaming.md) | Required on live — committed primary event names |
| **Segments out (optional)** | [`LiveSegmentBuffer`](segmentbuffer-streaming.md) | Live `targetSegmentBuffer`; offline uses offline segment buffer |
| **Return** | `AudioTaggingPipelineHandle` | Offline returns result objects instead |
| **Engine** | Same `AudioTaggingEngine` as offline | `tag(liveAudio, liveText, options)` |
| **Pipeline handle** | `AudioTaggingPipelineHandle` | `stop` / `flush` / `reset` / `getStatus` / `completed` |

Mixed live/offline arguments throw `AUDIO_TAGGING_INVALID_ARGUMENT`.

## Segmentation (Mandatory)

Live audio tagging must cut the incoming audio stream into committed spans before each offline tagging step. `options.segmentation.policy` is **required** (`LIVE_OFFLINE_SEGMENTATION_REQUIRED` if missing or `mode !== 'auto'`). Audio tagging attaches the engine — you do **not** pass a pre-built VAD segment from the app.

**Modes:** `'auto'` only (policy required). `'off'` / `'manual'` are not supported on the live path.

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ **Default** | `DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY` (`minSegmentMs: 1500`) |
| `continuous_frames` | ✅ | Fixed windows; `checkpointIntervalMs` must be ≥ 1500 |
| `speech_vad_model` | ❌ | Speech-only windows miss sirens, music, and other non-speech events |
| `speech_pyannote_segmentation` | ❌ | Same reason — speech-only cuts |

### Live span floor (`AUDIO_TAGGING_LIVE_MIN_SPAN_MS`)

Live workers skip spans shorter than **1500 ms**. JS `assertAudioTaggingLiveSpanPolicy` rejects policies that cannot meet that floor:

| Evaluator | Constraint |
| --- | --- |
| `speech_energy_silence` | `minSegmentMs` and `maxSegmentMs` ≥ 1500 (and `max ≥ min`) |
| `continuous_frames` | `checkpointIntervalMs` ≥ 1500 |

```ts
const pipeline = await tagger.tag(audioIn, textOut, {
  segmentation: {
    mode: 'auto',
    policy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  },
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Offline Auto: [audio-tagging-offline.md](audio-tagging-offline.md#segmentation-optional).

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

LiveText `meta` is a Fabric-safe JSON tree. The JS `onSegment` callback maps it into `AudioTaggingLiveSegmentEvent.result`.

## API reference

Factory, detection, and model init are the same as offline — see [audio-tagging-offline.md](audio-tagging-offline.md#api-reference).

### `tagger.tag(audioIn, textOut, options)`

Starts a live overload pipeline: tags each committed audio span with offline CED/Zipformer weights, commits the primary event name to `textOut`, and returns a pipeline handle.

```ts
tag(
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: AudioTaggingLivePipelineOptions
): Promise<AudioTaggingPipelineHandle>;
```

**Constraints:** both buffers must be live; `segmentation.policy` required (`speech_energy_silence` or `continuous_frames`); span floor ≥ `AUDIO_TAGGING_LIVE_MIN_SPAN_MS` (1500).

```ts
const pipeline = await tagger.tag(audioIn, textOut, {
  topK: 5,
  segmentation: {
    mode: 'auto',
    policy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  },
  onSegment: (e) => console.log(e.segmentIndex, e.result.primary?.name),
});
```

## Optional `targetSegmentBuffer`

Pass a **live** segment buffer (`seg_live_*`) to append the same payload as offline (`payload.source: 'audioTagging'`). Offline `targetSegmentBuffer` ids are rejected (`AUDIO_TAGGING_INVALID_ARGUMENT`).

## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onSegment` | `AudioTaggingLiveSegmentEvent` | after each committed span is tagged | no `onProgress` on the live path |

Shapes: [Types](#types) · offline result fields: [audio-tagging-offline.md](audio-tagging-offline.md#types).

```ts
await tagger.tag(audioIn, textOut, {
  segmentation: { mode: 'auto', policy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY },
  onSegment: (e) => console.log(e.segmentIndex, e.result.primary?.name),
});
```

## Types

### Live-only audio-tagging types (`react-native-sherpa-onnx/audio-tagging`)

| Type | Description |
| --- | --- |
| `AudioTaggingLivePipelineOptions` | Mandatory `segmentation.policy`; optional `topK`, `onSegment`, `targetSegmentBuffer` |
| `AudioTaggingLiveSegmentEvent` | Per-span live callback: ranges + `result: AudioTaggingResult` |
| `AudioTaggingPipelineHandle` | Extends `StreamingPipelineHandle` — live run control surface |
| `AUDIO_TAGGING_LIVE_MIN_SPAN_MS` | Runtime constant `1500` — live span floor |
| `StreamingPipelineCompletion` | `{ reason: 'completed' \| 'stopped' }` from `completed` |
| `StreamingPipelineStatus` | Snapshot from `getStatus()` |

Engine, detect, and offline result types: [audio-tagging-offline.md](audio-tagging-offline.md#types).

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
