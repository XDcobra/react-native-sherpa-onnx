# Audio tagging (offline)

## Introduction

On-device **sound-event tagging** using dedicated **CED** or **Zipformer** packs from the sherpa-onnx [`audio-tagging-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) release. Returns a **ranked top-K list** of AudioSet-style event labels with probabilities (e.g. `Speech`, `Music`, `Siren`, `Dog`).

Unlike STT it does **not** produce a transcript; unlike VAD/KWS it does **not** localize events in time inside the model. Temporal structure comes only from **our** segmentation windows when you use Auto mode. Prefer this over [keyword spotting](kws-streaming.md) when you need a sound-event taxonomy rather than wake phrases; prefer [spoken language identification](language-identification-offline.md) when you need ISO language codes.

For **live overload** (same offline weights on live buffers — not a true streaming model), see [Audio tagging (live overload)](audio-tagging-live.md).

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Short clip (oneshot) or long-form (segmented) |
| **Segments out (optional)** | [`OfflineSegmentBuffer`](segmentbuffer-offline.md) | `payload.source: 'audioTagging'`, `primaryName`, `events` |
| **Engine** | `AudioTaggingEngine` via `createAudioTagging` | `tag` oneshot / segmented |

Import path: **`react-native-sherpa-onnx/audio-tagging`**.

Sherpa-onnx exposes audio tagging **only as offline** (`AudioTagging` + `OfflineStream` — no online tagger). This SDK adds:

1. **Oneshot** — single pass over the whole clip → top-K events.
2. **Segmented** — [segmentation engine](segmentation-engine.md) slices long audio; per-span top-K results.

There is **no** `createStreamingAudioTagging`. Continuous mic/file use is the [live overload](audio-tagging-live.md).

## Quick start — oneshot

```ts
import {
  createAudioTagging,
  detectAudioTaggingModel,
} from 'react-native-sherpa-onnx/audio-tagging';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const modelDir = {
  kind: 'fs' as const,
  path: '/absolute/path/to/sherpa-onnx-ced-mini-audio-tagging-2024-04-19',
};

const det = await detectAudioTaggingModel(modelDir, { modelType: 'auto' });
if (!det.success) {
  throw new Error(det.error ?? 'Audio tagging detection failed');
}

const tagger = await createAudioTagging({
  modelSource: modelDir,
  quantization: det.quantization ?? 'auto',
  topK: 5,
  numThreads: 2,
});

try {
  const audio = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/clip.wav',
  });
  // Omit segmentation / mode 'off' → oneshot.
  const result = await tagger.tag(audio);
  // {
  //   events: [
  //     { name: 'Speech', index: 0, prob: 0.91 },
  //     { name: 'Music', index: 137, prob: 0.12 },
  //     …
  //   ],
  //   primary: { name: 'Speech', index: 0, prob: 0.91 },
  //   audioDuration: 3.2,
  //   elapsedMs: 180,
  //   topK: 5,
  // }
  console.log(result.primary?.name, result.events);
  await releasePipelineAudioBuffer(audio);
} finally {
  await tagger.destroy();
}
```

## Quick start — segmented (long audio)

```ts
import { DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY } from 'react-native-sherpa-onnx/audio-tagging';

const result = await tagger.tag(audio, {
  topK: 5,
  segmentation: {
    mode: 'auto',
    // Or DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY (minSegmentMs: 1500)
    policy: {
      evaluator: 'speech_energy_silence',
      silenceThresholdMs: 500,
      energyThresholdDb: -40,
      minSegmentMs: 1500,
      maxSegmentMs: 25000,
      hangoverMs: 300,
    },
  },
  onProgress: (p) =>
    console.log(`${p.currentSegment + 1}/${p.totalSegments}`),
  // p → { currentSegment: 0, totalSegments: 3, fraction: 0, currentSegmentDurationMs: 2100, elapsedMs: 12 }
  onSegment: (e) =>
    console.log('#', e.segmentIndex, e.result.primary?.name, e.durationMs),
  // e → {
  //   segmentIndex: 0,
  //   totalSegments: 3,
  //   startTime: 0.4,
  //   endTime: 2.5,
  //   durationMs: 2100,
  //   result: { events: […], primary: { name: 'Siren', … }, audioDuration: 2.1, elapsedMs: 90, topK: 5 },
  // }
});

// result.segments         // [{ segmentIndex, totalSegments, startTime, endTime, durationMs, result }, …]
// result.totalSegments    // 3
// result.processingTimeMs // 420
```

Offline Auto supports **`speech_energy_silence` only**. `continuous_frames` is streaming-only in `segmentOfflineBuffer` (use it on [live overload](audio-tagging-live.md)). Speech-only VAD evaluators (`speech_vad_model`, `speech_pyannote_segmentation`) are **not** supported — they can miss non-speech events such as sirens or music.

Optional empty `targetSegmentBuffer` attaches `AudioTaggingSpeechSegmentPayload` for downstream pipelines.

`segmentation.mode: 'manual'` is rejected (`AUDIO_TAGGING_INVALID_ARGUMENT`).

---

## Buffer matrix

| | Oneshot | Segmented |
| --- | --- | --- |
| **Audio in** | `OfflineAudioBuffer` | `OfflineAudioBuffer` |
| **Segments out** | optional `targetSegmentBuffer` | optional `targetSegmentBuffer` |
| **Return** | `{ events, primary?, audioDuration, elapsedMs, topK }` | `{ segments, totalSegments, processingTimeMs }` |

---

## API reference

### Detection

#### `detectAudioTaggingModel(source, options?)`

```ts
function detectAudioTaggingModel(
  source: FileSource,
  options?: {
    modelType?: 'ced' | 'zipformer' | 'auto';
    assetName?: string;
    quantization?: QuantizationPreference;
  }
): Promise<AudioTaggingDetectModelResult>;
```

Prefer detect before `createAudioTagging`. Packs must include exactly one of CED or Zipformer ONNX **plus** `class_labels_indices.csv`. These packs are **not** interchangeable with ASR or KWS zipformer packs.

### Models and required files

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `ced` | CED ONNX + `class_labels_indices.csv` | `model`, `labels` |
| `zipformer` | Zipformer AT ONNX + `class_labels_indices.csv` | `model`, `labels` |

Validate category: **`audioTagging`**. Quantization: `'auto' \| 'int8' \| 'fp16' \| 'fp32' \| …`.

Recommended starter pack (size-first): `sherpa-onnx-ced-mini-audio-tagging-2024-04-19`. Other assets on the same release include `ced-tiny` / `ced-small` / `ced-base` and `zipformer` / `zipformer-small`.

Download via `ModelCategory.AudioTagging` → release tag [`audio-tagging-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) (built-in GitHub source; see [download-manager.md](download-manager.md)).

### Factory

#### `createAudioTagging(options)`

```ts
function createAudioTagging(
  options: AudioTaggingInitializeOptions
): Promise<AudioTaggingEngine>;
```

Init modes:

- **`auto`** (default): `modelSource` + optional `modelType` / `quantization`.
- **`custom`**: `modelType: 'ced' | 'zipformer'` + `customConfig: { model, labels }` (`FileSource` each).

Shared tuning: `topK` (default applied when `tag()` omits it), `numThreads`, `provider`, `debug`.

### Engine methods

```ts
interface AudioTaggingEngine {
  readonly instanceId: string;

  tag(
    audio: OfflineAudioBufferIdSource,
    options?: AudioTaggingTagOptions & {
      segmentation?: { mode?: 'off' };
    }
  ): Promise<AudioTaggingResult>;

  tag(
    audio: OfflineAudioBufferIdSource,
    options: AudioTaggingTagOptions & {
      segmentation: { mode: 'auto'; policy?: SegmentationPolicy };
    }
  ): Promise<SegmentedAudioTaggingResult>;

  /** Live overload — see audio-tagging-live.md */
  tag(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: AudioTaggingLivePipelineOptions
  ): Promise<AudioTaggingPipelineHandle>;

  destroy(): Promise<void>;
}
```

| Method | Behavior |
| --- | --- |
| `tag` (oneshot) | Whole-clip offline compute. Omit `segmentation` or `mode: 'off'`. Optional per-call `topK`. |
| `tag` (segmented) | `mode: 'auto'` + policy (`speech_energy_silence`). Optional `onProgress` / `onSegment` / `targetSegmentBuffer` / `topK`. |
| `destroy` | Releases the native instance (joins any live workers first). |

`AudioTaggingTagOptions` = optional `topK` + segmentation + optional `onProgress` / `onSegment` / `targetSegmentBuffer` / `errorRecovery`. Oneshot `tag` does **not** emit progress/segment events.

---

## Offline JS events (`onProgress` / `onSegment`)

### `onProgress` (start-of-step)

Multi-span paths support optional coarse offline progress via `onProgress` on **segmented** `tag`. The payload is shared **`OrchestrationProgress`** (same fields as VAD offline / Alignment / SID / SLID):

- Fires at the **start** of step `i` (before native tag for that span).
- `fraction` follows `totalSegments > 0 ? currentSegment / totalSegments : 1`.
- `totalSegments` is the number of non-empty speech spans; `currentSegmentDurationMs` is that span’s duration.
- Zero usable speech spans → **no** progress events (empty `segments`).
- Only **function** callbacks are registered. If a callback throws, the run aborts.

Oneshot `tag` does **not** emit progress.

### `onSegment` (per-span result)

Fires **after** native tag for each speech span:

| Field | Meaning |
| --- | --- |
| `segmentIndex` / `totalSegments` | 0-based index and span count |
| `startTime` / `endTime` / `durationMs` | Span range in seconds / ms |
| `result` | `AudioTaggingResult` for that span (`events`, `primary`, …) |

Order per span: `onProgress` → tag → (`append` when `targetSegmentBuffer` is set) → `onSegment`.

```ts
await tagger.tag(audio, {
  segmentation: {
    mode: 'auto',
    policy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  },
  onProgress: (p) => {
    console.log(
      `at ${p.currentSegment + 1}/${p.totalSegments} fraction=${p.fraction.toFixed(3)}`
    );
  },
  onSegment: (e) => {
    console.log(
      `#${e.segmentIndex} ${e.result.primary?.name ?? '—'} (${e.durationMs}ms)`
    );
  },
});
```

Live overload uses `onSegment` only (no offline `onProgress`) — see [audio-tagging-live.md](audio-tagging-live.md).

---

## Speech payload (`source: 'audioTagging'`)

```ts
{
  source: 'audioTagging';
  primaryName?: string;
  events?: Array<{ name: string; index: number; prob: number }>;
}
```

See [segmentbuffer-offline.md](segmentbuffer-offline.md).

---

## Types and constants

```ts
import {
  createAudioTagging,
  detectAudioTaggingModel,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  AUDIO_TAGGING_LIVE_MIN_SPAN_MS,
  AUDIO_TAGGING_MODEL_TYPES,
  AudioTaggingErrorCode,
  type AudioTaggingEngine,
  type AudioTaggingTagOptions,
  type AudioTaggingResult,
  type SegmentedAudioTaggingResult,
  type AudioTaggingSegmentEvent,
  type AudioTaggingEvent,
  type AudioTaggingLivePipelineOptions,
  type AudioTaggingLiveSegmentEvent,
  type AudioTaggingPipelineHandle,
} from 'react-native-sherpa-onnx/audio-tagging';
```

- **`AudioTaggingEvent`:** `{ name, index, prob }`
- **`AudioTaggingResult`:** `{ events, primary?, audioDuration, elapsedMs, topK }`
- **`SegmentedAudioTaggingResult`:** `{ segments, totalSegments, processingTimeMs }`
- **`AudioTaggingSegmentEvent`:** per-span result (`result`, ranges, `totalSegments`, …)
- **`OrchestrationProgress`:** shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …)
- **`DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY`:** energy silence, `minSegmentMs: 1500`
- **`AUDIO_TAGGING_LIVE_MIN_SPAN_MS`:** `1500` (live span floor — see live doc)

---

## Error codes

| Error code | Explanation |
| --- | --- |
| `AUDIO_TAGGING_INVALID_ARGUMENT` | Bad options / buffer kind / unsupported segmentation / missing required fields. |
| `AUDIO_TAGGING_INIT_FAILED` | Model load / native construct failed. |
| `AUDIO_TAGGING_DESTROYED` | Call after `destroy()`. |
| `AUDIO_TAGGING_TAG_FAILED` | Offline or live tag path failed. |
| `AUDIO_TAGGING_NOT_INITIALIZED` | Native instance missing (native path). |
| `AUDIO_TAGGING_BUFFER_NOT_FOUND` | Audio buffer id missing from the registry (native). |
| `AUDIO_TAGGING_BUFFER_EMPTY` | Offline audio has no samples (native). |
| `AUDIO_TAGGING_INIT_ERROR` | Native init error token (native). |
| `AUDIO_TAGGING_OFFLINE_OOM` | Offline compute ran out of memory (native). |
| `SEGMENT_*` / `FILEIO_*` | Segment buffers / `FileSource` resolution (same as other offline features). |

---

## See also

- [Audio tagging (live overload)](audio-tagging-live.md)
- [Keyword spotting (streaming)](kws-streaming.md) — wake phrases, not sound-event taxonomy
- [Spoken language identification (offline)](language-identification-offline.md)
- [Segmentation engine](segmentation-engine.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline segment buffers — offline](segmentbuffer-offline.md)
- [Model detect](model-detect.md)
- [Download manager](download-manager.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer**. Full details: [native-diagnostics.md](./native-diagnostics.md).
