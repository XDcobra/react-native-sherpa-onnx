# Speaker Identification (offline)

## Introduction

On-device **named-speaker** enrollment and identification on a shared speaker-embedding foundation.

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Populated PCM (full clip or ranges via segment spans) |
| **Segments in / out** | [`OfflineSegmentBuffer`](segmentbuffer-offline.md) | Speech ranges (typically from VAD); Out gets `payload.source: 'sid'` |
| **Engine** | `SpeakerIdentificationEngine` via `createSpeakerIdentification` | Enroll / identify / verify / label; named-speaker manager under the hood |

Import path: **`react-native-sherpa-onnx/speaker-identification`**.

Model detect lives on **`react-native-sherpa-onnx/speaker-embedding`** (`detectSpeakerEmbeddingModel`). Most embedding internals stay package-local; apps use the SID surface for enrollment and search.

SID answers **who** spoke against an enrolled name list. It does **not** invent anonymous clusters — that is [Speaker Diarization](diarization.md) (planned). VAD still answers **when** speech happens; the app decides which spans belong together for enroll (for example every other interview turn).

There is **no live/streaming SID API** yet. “Live” usage is app orchestration: finalize live audio/segments → offline SID APIs (same idea as other offline engines before live overload).

## Quick start

```ts
import {
  createSpeakerIdentification,
} from 'react-native-sherpa-onnx/speaker-identification';
import { detectSpeakerEmbeddingModel } from 'react-native-sherpa-onnx/speaker-embedding';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const modelDir = {
  kind: 'fs' as const,
  path: '/absolute/path/to/speaker-embedding-model-dir',
};

const det = await detectSpeakerEmbeddingModel(modelDir, { modelType: 'auto' });
if (!det.success) {
  throw new Error(det.error ?? 'Speaker embedding detection failed');
}

const sid = await createSpeakerIdentification({
  modelSource: modelDir,
  modelType: (det.modelType as 'wespeaker' | '3d-speaker' | 'nemo' | 'auto') ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
});

try {
  const aliceClip = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/alice.wav',
  });
  const query = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/query.wav',
  });

  await sid.enroll('alice', aliceClip);
  // Optional: average multiple clips
  // await sid.enroll('alice', [clipA, clipB]);

  const { name } = await sid.identify(query, { threshold: 0.5 });
  console.log(name); // 'alice' | null

  const ok = await sid.verify('alice', query, { threshold: 0.5 });
  console.log(ok);

  await releasePipelineAudioBuffer(aliceClip);
  await releasePipelineAudioBuffer(query);
} finally {
  await sid.destroy();
}
```

### Segment-buffer enroll + label

Symmetric to whole-buffer APIs: PCM audio **plus** speech ranges.

```ts
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

// aliceOnlySegs: OfflineSegmentBuffer with speech spans the app already filtered
// (e.g. even interview turns). Segment buffers alone have no samples.
await sid.enrollOfflineSegments('alice', interviewAudio, aliceOnlySegs);

const labeledOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: interviewAudio,
});

try {
  const { labeledCount, unknownCount } = await sid.labelOfflineSegments(
    interviewAudio,
    vadSegs, // speech spans from VAD (or manual)
    labeledOut,
    { threshold: 0.5 }
  );
  console.log({ labeledCount, unknownCount });

  const rows = await getOfflineSegmentBufferSegments(labeledOut);
  for (const row of rows) {
    if (row.kind === 'speech' && row.payload?.source === 'sid') {
      console.log(row.startSample, row.endSample, row.payload.speakerName);
    }
  }
} finally {
  await releasePipelineSegmentBuffer(labeledOut);
}
```

`labelOfflineSegments` does **not** mutate `vadSegs`. It stages a live segment buffer, then populates the empty `labeledOut` offline snapshot (same writeback pattern as offline VAD merge).

---

## Buffer matrix

| | Offline audio buffer(s) | Offline audio + segment buffer |
| --- | --- | --- |
| **Enroll** | `enroll(name, audio \| audio[])` | `enrollOfflineSegments(name, audioIn, segmentsIn)` |
| **Identify** | `identify(audio)` → `{ name }` | `labelOfflineSegments(audioIn, segmentsIn, segmentsOut)` |

Segment APIs always need the **PCM** buffer. Empty speech ranges and non-`speech` rows are skipped. `enrollOfflineSegments` rejects when no usable speech span remains.

---

## API reference

### Detection

#### `detectSpeakerEmbeddingModel(source, options?)`

Exported from **`react-native-sherpa-onnx/speaker-embedding`**.

```ts
function detectSpeakerEmbeddingModel(
  source: FileSource,
  options?: {
    modelType?: 'wespeaker' | '3d-speaker' | 'nemo' | 'auto';
    assetName?: string;
  }
): Promise<SpeakerEmbeddingDetectResult>;
```

Supported families: **WeSpeaker**, **3D-Speaker**, **NeMo** embedding packs (see [sherpa-onnx speaker-recognition models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)). Prefer detect before `createSpeakerIdentification`.

### Factory

#### `createSpeakerIdentification(options)`

```ts
function createSpeakerIdentification(
  options: SpeakerIdentificationOptions
): Promise<SpeakerIdentificationEngine>;
```

`SpeakerIdentificationOptions` is the same union as speaker-embedding init (`initMode: 'auto' | 'custom'`, `modelSource` / `customConfig`, `numThreads`, `provider`, `debug`).

The extractor is **ref-counted** so a future diarization engine can share the same weights. Each SID instance still owns its own **named-speaker manager**.

### Engine methods

```ts
interface SpeakerIdentificationEngine {
  readonly instanceId: string;
  readonly managerId: string;
  readonly dim: number;

  enroll(
    name: string,
    audio: OfflineAudioBufferIdSource | OfflineAudioBufferIdSource[]
  ): Promise<void>;

  enrollOfflineSegments(
    name: string,
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource
  ): Promise<void>;

  identify(
    audio: OfflineAudioBufferIdSource,
    options?: { threshold?: number }
  ): Promise<{ name: string | null }>;

  labelOfflineSegments(
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    segmentsOut: OfflineSegmentBufferIdSource,
    options?: { threshold?: number }
  ): Promise<{ labeledCount: number; unknownCount: number }>;

  verify(
    name: string,
    audio: OfflineAudioBufferIdSource,
    options?: { threshold?: number }
  ): Promise<boolean>;

  removeSpeaker(name: string): Promise<boolean>;
  listSpeakers(): Promise<string[]>;
  contains(name: string): Promise<boolean>;
  numSpeakers(): Promise<number>;
  destroy(): Promise<void>;
}
```

| Method | Behavior |
| --- | --- |
| `enroll` | Extract embedding(s) from whole buffer(s); native manager averages multiple clips (L2-normalized). Fails if the name already exists. |
| `enrollOfflineSegments` | Same average path, one embedding per non-empty speech span. |
| `identify` | Extract → search; `name` is `null` when below threshold / unknown. Default `threshold` is `0.5`. |
| `labelOfflineSegments` | Per speech span: extract → search → append `{ source: 'sid', speakerName }` into staging → populate empty `segmentsOut`. `speakerName == null` increments `unknownCount`. |
| `verify` | Cosine check against one enrolled name. |
| `destroy` | Releases manager + drops extractor ref-count. |

---

## Speech payload (`source: 'sid'`)

Labeled Out rows use the strict speech payload contract:

```ts
{ source: 'sid'; speakerName: string | null }
```

Allowed keys: `source`, `speakerName` only. See [segmentbuffer-offline.md](segmentbuffer-offline.md).

---

## Patterns

### Interview turns (app-filtered enroll)

VAD (or manual spans) produces speech segments. The app knows heuristically that every other segment is speaker A:

1. Build or filter an `OfflineSegmentBuffer` that contains **only** Alice’s spans (today: new live buffer → append selected spans → finalize/populate; segment buffers are not mutated in place).
2. `enrollOfflineSegments('alice', audio, aliceOnlySegs)`.
3. Repeat for Bob.
4. Later `labelOfflineSegments(audio, allVadSegs, labeledOut)` to stamp names on the full timeline.

SID does **not** decide which spans belong together; the app selects enroll input.

### Buffer-first embeddings

PCM stays native via buffer ids. Only the compact embedding (`dim` floats, typically ~256) crosses the TurboModule for enroll/search — not the full waveform.

### Persistence

Enrollment lives in the native manager for the process lifetime of the SID instance. Export/import of enrollments is **not** in this SDK surface yet; persist names + clips (or embeddings) in the app if you need cross-session memory.

---

## Out of scope (this release)

- Live overload / native SID worker
- `kind: 'diarization'` segment rows
- Score / top-N search results
- In-place mutation of VAD segment buffers
- Enroll from a segment buffer **without** PCM audio

---

## Related docs

- [segmentbuffer-offline.md](segmentbuffer-offline.md) — speech payload `sid`, immutable snapshots
- [audiobuffer-offline.md](audiobuffer-offline.md) — PCM input
- [vad-streaming.md](vad-streaming.md) — speech boundaries (when)
- [diarization.md](diarization.md) — anonymous clustering (planned; shares embedding foundation)
- [feature-pipelines.md](feature-pipelines.md) — composed recipes
- [model-detect.md](model-detect.md) — detect vs init modes
- [download-manager.md](download-manager.md) — runtime model packs (`SpeakerEmbedding` category)
