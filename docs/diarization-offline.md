# Speaker diarization (offline)

**Status:** Android ✅ · iOS ✅ · Example app ✅

## Introduction

On-device **batch** speaker diarization: who spoke when in a recording, as anonymous
cluster indices. Uses a **pyannote / reverb** segmentation model plus a separate
**speaker-embedding** model and agglomerative clustering.

Import path: `react-native-sherpa-onnx/diarization`

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Mono PCM |
| **Output** | [`OfflineSegmentBuffer`](segmentbuffer.md) | Empty buffer; segments written with `kind: 'diarization'` |
| **Engine** | `DiarizationEngine` via `createDiarization` | `diarize`, `recluster`, `getClusterEmbeddings`, `destroy` |

Segmentation packs from the `speaker-segmentation-models` release contain **only**
the pyannote/reverb ONNX — you must supply a speaker-embedding model separately
(same packs as [speaker identification](speaker-identification-offline.md)).

## Quick start

```ts
import {
  createDiarization,
  detectDiarizationModel,
} from 'react-native-sherpa-onnx/diarization';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
} from 'react-native-sherpa-onnx/segmentbuffer';

const detect = await detectDiarizationModel({
  kind: 'fs',
  path: '/path/to/sherpa-onnx-pyannote-segmentation-3-0',
});

const diar = await createDiarization({
  segmentation: {
    modelSource: { kind: 'fs', path: detect.paths!.model! },
  },
  embedding: {
    modelSource: {
      kind: 'fs',
      path: '/path/to/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    },
  },
  clustering: { threshold: 0.5 },
});

const segmentOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: audioIn,
});

const result = await diar.diarize(audioIn, segmentOut, {
  onProgress: (p) => console.log(p.fraction),
});

const segments = await getOfflineSegmentBufferSegments(segmentOut, 0, 4096);
// segments[i].kind === 'diarization'
// segments[i].payload.speaker === cluster id

await diar.destroy();
```

## API

### `detectDiarizationModel(source, options?)`

Detects `pyannote` / `reverb` packs (prefers `model.onnx` over `model.int8.onnx`).

### `createDiarization(options)`

| Field | Notes |
| --- | --- |
| `segmentation.modelSource` | Required. Path/dir for segmentation ONNX |
| `segmentation.windowShiftRatio` | Default `0.1` |
| `embedding.modelSource` | Required. Separate embedding ONNX |
| `clustering.numClusters` | If `> 0`, threshold ignored |
| `clustering.threshold` | Cosine dissimilarity; default `0.5` |
| `minDurationOn` / `minDurationOff` | Segment filter / gap merge (seconds) |

### `engine.diarize(audioIn, segmentOut, options?)`

Runs the full pipeline and writes `{start,end,speaker}` into `segmentOut`
natively (`kind: 'diarization'`, payload `{ source: 'diarization', speaker }`).

`segmentOut` must be an **empty** offline segment buffer.

Options: `onProgress`, `signal` (`AbortSignal` → `cancelDiarization`),
`includeOverlap` (returns `speakersPerFrame` when supported).

### `engine.recluster({ numClusters?, threshold? })`

Re-runs clustering on the **cached** embeddings from the last `diarize` — no
re-inference. Use a fresh empty `segmentOut` + another `diarize` if you need the
timeline rewritten into a buffer, or read `getClusterEmbeddings()`.

### `engine.getClusterEmbeddings()`

Mean embedding per cluster after the last `diarize` / `recluster`. Use these
centroids to match enrolled SID names (who-spoke-when with labels), either via
**`mapDiarizationToNames(diar, sid, diarizationSegments)`** or manually with
`sid.search(embedding)`.

End-to-end example (3 enrolled speakers + meeting with an unknown guest):
**[diarization-named-timeline.md](./diarization-named-timeline.md)**.

### `mapDiarizationToNames(diar, sid, diarizationSegments, options?)`

Composes `getClusterEmbeddings` + `sid.search` + reading the buffer filled by
`diarize` (`diarizationSegments`) into `{ clusterToName, timeline }`. See
[diarization-named-timeline.md](./diarization-named-timeline.md).

## Models

| Kind | Release tag | Notes |
| --- | --- | --- |
| `pyannote` | `speaker-segmentation-models` | MIT |
| `reverb` | `speaker-segmentation-models` | Often non-commercial — check license CSV |
| embedding | `speaker-recongition-models` | Required separately |

## Architecture note

The native core is a **shared C++** pipeline (Android + iOS): pyannote ONNX via
ORT, powerset decode, timeline stitch, sherpa C-API embedding extractor (refcounted
registry), and own agglomerative clustering. It does **not** wrap the upstream
`SherpaOnnxOfflineSpeakerDiarization` monolith (`_Exit` risk). See
[internal/speaker-embedding-foundation.md](./internal/speaker-embedding-foundation.md) §10.

## Status

- Offline batch: Android / iOS
- Live / streaming diarization: not yet (architecture-ready)
- `speech_pyannote_segmentation` evaluator for the shared segmentation engine: **shipped** (offline union spans; see [segmentation-engine.md](./segmentation-engine.md))

## Related

- [diarization-named-timeline.md](./diarization-named-timeline.md) — SID enroll + diarize → named who-spoke-when
- [speaker-identification-offline.md](./speaker-identification-offline.md) — named-speaker gallery
- [segmentation-engine.md](./segmentation-engine.md) — `speech_pyannote_segmentation` (union speech spans only)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread,
inspect the SDK **last-activity ring buffer**. Full details:
[native-diagnostics.md](./native-diagnostics.md).
