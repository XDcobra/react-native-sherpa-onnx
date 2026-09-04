# Speaker Identification (offline)

## Introduction

On-device **named-speaker** enrollment and identification on a shared speaker-embedding foundation.

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Populated PCM (full clip or ranges via segment spans) |
| **Segments in / out** | [`OfflineSegmentBuffer`](segmentbuffer-offline.md) | Speech ranges (typically from VAD); Out gets `payload.source: 'sid'` |
| **Engine** | `SpeakerIdentificationEngine` via `createSpeakerIdentification` | Enroll / identify / verify / label; named-speaker manager under the hood |

Import path: **`react-native-sherpa-onnx/speaker-identification`**.

Model detect is available on the SID package (`detectSpeakerEmbeddingModel`) and on **`react-native-sherpa-onnx/speaker-embedding`** (shared foundation). Most embedding internals stay package-local; apps use the SID surface for enrollment and search.

SID answers **who** spoke against an enrolled name list. It does **not** invent anonymous clusters — that is [Speaker Diarization](diarization-offline.md) (offline available). VAD still answers **when** speech happens; the app decides which spans belong together for enroll (for example every other interview turn).

Live labeling is available via **`labelLiveSegments`** — see [speaker-identification-live.md](speaker-identification-live.md). Enrollment remains offline (`enroll` / `enrollOfflineSegments`).

## Quick start

```ts
import {
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
} from 'react-native-sherpa-onnx/speaker-identification';
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

// One name → average all speech spans under that speaker:
await sid.enrollOfflineSegments('alice', interviewAudio, aliceSpeechSegs);

// Or one name per speech span (length must match speech-span count):
await sid.enrollOfflineSegments(
  ['alice', 'bob', 'alice'],
  interviewAudio,
  vadSegs
);

const labeledOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: interviewAudio,
});

try {
  // Label many speech spans on a long timeline. If you only have one short clip
  // to identify against the enrolled speaker(s), use sid.identify(clip) instead —
  // enrollOfflineSegments does not require labelOfflineSegments on the query side.
  const { labeledCount, unknownCount } = await sid.labelOfflineSegments(
    interviewAudio,
    vadSegs, // speech spans from VAD (or manual)
    labeledOut,
    {
      threshold: 0.5,
      onProgress: (p) =>
        console.log(
          `sid label ${p.currentSegment + 1}/${p.totalSegments} fraction=${p.fraction.toFixed(3)}`
        ),
      onLabeled: (e) =>
        console.log(
          `labeled ${e.segmentIndex + 1}/${e.totalSegments}`,
          e.speakerName
        ),
    }
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
  await sid.destroy(); // end of SID session (omit if you keep reusing `sid`)
}
```

`labelOfflineSegments` does **not** mutate `vadSegs`. It stages a live segment buffer, then populates the empty `labeledOut` offline snapshot (same writeback pattern as offline VAD merge).

---

## Buffer matrix

| | Offline audio buffer(s) | Offline audio + segment buffer |
| --- | --- | --- |
| **Enroll** | `enroll(name, audio \| audio[])` | `enrollOfflineSegments(name \| names[], audioIn, segmentsIn)` |
| **Identify** | `identify(audio)` → `{ name }` | `labelOfflineSegments(audioIn, segmentsIn, segmentsOut)` |
| **Search embedding** | `search(embedding)` → `name \| null` | — (used by diarization cluster centroids) |
| **Verify** | `verify(name, audio)` → `boolean` | `verifyOfflineSegments(name \| names[], audioIn, segmentsIn)` → counts + per-span flags |

Segment APIs always need the **PCM** buffer. Empty speech ranges and non-`speech` rows are skipped. `enrollOfflineSegments` / `verifyOfflineSegments` reject when no usable speech span remains.

---

## API reference

### Detection

#### `detectSpeakerEmbeddingModel(source, options?)`

Available from **`react-native-sherpa-onnx/speaker-identification`** (DX re-export) and **`react-native-sherpa-onnx/speaker-embedding`** (shared foundation).

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

### Models and required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `wespeaker` | `*.onnx` (WeSpeaker embedding) | — | `model` |
| `3d-speaker` | `*.onnx` (3D-Speaker embedding) | — | `model` |
| `nemo` | `*.onnx` (NeMo speaker embedding) | — | `model` |

Validate category for custom path helpers: **`speakerEmbedding`**.

### Factory

#### `createSpeakerIdentification(options)`

```ts
function createSpeakerIdentification(
  options: SpeakerIdentificationOptions
): Promise<SpeakerIdentificationEngine>;
```

`SpeakerIdentificationOptions` is the same union as speaker-embedding init (`initMode: 'auto' | 'custom'`, `modelSource` / `customConfig`, `numThreads`, `provider`, `debug`).

The extractor is **ref-counted** so diarization can share the same weights via the C++ `SpeakerEmbeddingRunner` registry. Each SID instance still owns its own **named-speaker manager**.

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
    nameOrNames: string | string[],
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    options?: SpeakerIdentificationSegmentOptions
  ): Promise<void>;

  identify(
    audio: OfflineAudioBufferIdSource,
    options?: { threshold?: number }
  ): Promise<{ name: string | null }>;

  /** Precomputed embedding (e.g. diarization cluster centroid) → enrolled name. */
  search(
    embedding: Float32Array,
    options?: { threshold?: number }
  ): Promise<string | null>;

  labelOfflineSegments(
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    segmentsOut: OfflineSegmentBufferIdSource,
    options?: SpeakerIdentificationLabelOptions
  ): Promise<{ labeledCount: number; unknownCount: number }>;

  /** Live overload — see speaker-identification-live.md */
  labelLiveSegments(
    audioIn: LiveAudioBufferIdSource,
    segmentsOut: LiveSegmentBufferIdSource,
    options: SpeakerIdentificationLiveLabelOptions
  ): Promise<SpeakerIdentificationPipelineHandle>;

  verify(
    name: string,
    audio: OfflineAudioBufferIdSource,
    options?: { threshold?: number }
  ): Promise<boolean>;

  verifyOfflineSegments(
    nameOrNames: string | string[],
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    options?: SpeakerIdentificationVerifyOptions
  ): Promise<{
    matchCount: number;
    mismatchCount: number;
    matches: boolean[];
  }>;

  removeSpeaker(name: string): Promise<boolean>;
  listSpeakers(): Promise<string[]>;
  contains(name: string): Promise<boolean>;
  numSpeakers(): Promise<number>;

  exportEnrollments(): Promise<SpeakerEnrollmentBundle>;
  importEnrollments(
    bundle: SpeakerEnrollmentBundle,
    options?: { replaceExisting?: boolean }
  ): Promise<{ imported: number; skipped: number }>;

  destroy(): Promise<void>;
}
```

| Method | Behavior |
| --- | --- |
| `enroll` | Combined `enrollSpeakerOffline` (whole buffer(s) → compute + manager.add). Fails if the name already exists. |
| `enrollOfflineSegments` | Combined `enrollSpeakerOffline` per name group (speech spans → embeddings + add). `string`: average all under one name. `string[]`: one name per speech span (length must match); duplicate names are grouped and averaged. Optional `onProgress`. |
| `identify` | Extract → search; `name` is `null` when below threshold / unknown. Default `threshold` is `0.5`. |
| `search` | Gallery search with a precomputed `Float32Array` (e.g. `getClusterEmbeddings()`). Empty / below threshold → `null`. Used by `mapDiarizationToNames` — see [diarization-named-timeline.md](diarization-named-timeline.md). |
| `labelOfflineSegments` | Per speech span: native `identifySpeakerOffline` (extract+search in one call) → append `{ source: 'sid', speakerName }` into staging → populate empty `segmentsOut`. `speakerName == null` increments `unknownCount`. Optional `onProgress` + `onLabeled`. |
| `labelLiveSegments` | Live overload: attach speech segmentation, label each committed utterance into a live segment Out. See [speaker-identification-live.md](speaker-identification-live.md). |
| `verify` | Native `verifySpeakerOffline` cosine check against one enrolled name (whole buffer). |
| `verifyOfflineSegments` | Per speech span: native `verifySpeakerOffline` (extract+verify in one call). `string`: same name on every span. `string[]`: one expected name per speech span (length must match). Returns `{ matchCount, mismatchCount, matches }`. Optional `onProgress` + `onVerified`. No segment Out buffer. |
| `exportEnrollments` / `importEnrollments` | Cross-session enrollment snapshot — see [Persistence](#persistence). |
| `destroy` | Releases manager + drops extractor ref-count. |

`SpeakerIdentificationSegmentOptions` = `{ threshold?: number; onProgress?: (p: OrchestrationProgress) => void }` (enroll + label + verify segments).  
`SpeakerIdentificationLabelOptions` = segment options + `{ onLabeled?: (e: SidLabeledSegmentEvent) => void }` (**label only**).  
`SpeakerIdentificationVerifyOptions` = segment options + `{ onVerified?: (e: SidVerifiedSegmentEvent) => void }` (**verify segments only**). Whole-buffer `identify` / `verify` only accept `{ threshold? }`.

---

## Offline progress (`onProgress`) and results (`onLabeled` / `onVerified`)

### `onProgress` (start-of-step)

Multi-span SID paths support optional coarse offline progress via `onProgress` on `enrollOfflineSegments`, `labelOfflineSegments`, and `verifyOfflineSegments`. The payload is shared **`OrchestrationProgress`** (same fields as VAD offline / Alignment):

- Fires at the **start** of step `i` (before extract / search-or-verify for that span).
- `fraction` follows `totalSegments > 0 ? currentSegment / totalSegments : 1`.
- `totalSegments` is the number of non-empty speech spans; `currentSegmentDurationMs` is that span’s duration.
- Zero usable speech spans → **no** progress events (`enrollOfflineSegments` / `verifyOfflineSegments` reject; `labelOfflineSegments` returns `{ labeledCount: 0, unknownCount: 0 }`).
- Non-function `onProgress` → `SID_INVALID_OPTIONS`. If the callback throws, the run aborts.

Whole-buffer `enroll` / `identify` / `verify` do **not** emit progress. Internal staging for `labelOfflineSegments` stays silent (no `onSegmentAppended`).

### `onLabeled` (per-span result — `labelOfflineSegments` only)

Fires **after** search + successful staging append for each speech span:

| Field | Meaning |
| --- | --- |
| `segmentIndex` / `totalSegments` | 0-based index and span count |
| `startSample` / `endSample` / `sampleRate` / `durationMs` | Span range |
| `speakerName` | Matched enrolled name, or `null` if below threshold / unknown |

Order per span: `onProgress` → identify/append → `onLabeled`. Enroll paths have **no** `onLabeled`. Non-function / throwing `onLabeled` behaves like `onProgress` (`SID_INVALID_OPTIONS` / abort + staging cleanup).

```ts
await sid.labelOfflineSegments(audio, vadSegs, labeledOut, {
  threshold: 0.5,
  onProgress: (p) => {
    console.log(
      `sid ${p.currentSegment + 1}/${p.totalSegments} fraction=${p.fraction.toFixed(3)}`
    );
  },
  onLabeled: (e) => {
    console.log(`result ${e.segmentIndex}:`, e.speakerName);
  },
});
```

### `onVerified` (per-span result — `verifyOfflineSegments` only)

Fires **after** native verify for each speech span. Fields match `onLabeled` ranges, plus `expectedName` (the name checked for that span) and `matched: boolean`. Order: `onProgress` → verify → `onVerified`. Non-function / throwing `onVerified` → `SID_INVALID_OPTIONS` / abort.

```ts
const { matchCount, mismatchCount, matches } = await sid.verifyOfflineSegments(
  ['alice', 'bob', 'alice'],
  audio,
  vadSegs,
  {
    threshold: 0.5,
    onVerified: (e) => {
      console.log(
        `span ${e.segmentIndex} vs ${e.expectedName}:`,
        e.matched ? 'match' : 'no match'
      );
    },
  }
);
```

---

## Speech payload (`source: 'sid'`)

Labeled Out rows use the strict speech payload contract:

```ts
{ source: 'sid'; speakerName: string | null }
```

Allowed keys: `source`, `speakerName` only. See [segmentbuffer-offline.md](segmentbuffer-offline.md).

---

## Patterns

### Interview turns (per-span enroll names)

VAD (or manual spans) produces speech segments. When the app already knows who spoke each turn, pass a **name list** aligned to the speech-span order:

1. Segment once into an `OfflineSegmentBuffer` (all speakers).
2. Build `string[]` with one enrolled name per non-empty speech span (same length as the speech-span count after skipping silence/empty rows). Duplicate names are fine — those embeddings are averaged under that speaker.
3. `enrollOfflineSegments(['alice', 'bob', 'alice', …], audio, vadSegs)`.
4. Later `labelOfflineSegments(audio, vadSegs, labeledOut)` (or a fuller timeline) to stamp predicted names on spans.

SID does **not** invent the name list; the app supplies who each span belongs to for enrollment. A single `string` still averages every speech span under one speaker when you do not need per-span naming.

### Buffer-first embeddings

PCM stays native via buffer ids. Identify / label / verify / enroll use combined native TMs (`identifySpeakerOffline` / `verifySpeakerOffline` / `enrollSpeakerOffline`) so embeddings stay off the JS product hot path. Low-level extract/search still move compact `dim` floats (~256) across the TurboModule when apps need raw vectors — not the full waveform.

### Persistence

The native manager cannot read embeddings back by name. SID keeps a **JS mirror** of vectors returned once from `enrollSpeakerOffline` (and from `importEnrollments`), and clears it on `removeSpeaker` / `destroy`. Product enroll does **not** call a separate `manager.add` with embedding arrays.

```ts
// After enroll…
const bundle = await sid.exportEnrollments();
// App stores JSON somewhere (file, key-value store, share) — SDK does not write files.
await saveJson('sid-enrollments.json', bundle);

// Later session, same embedding model:
const restored = await loadJson('sid-enrollments.json') as SpeakerEnrollmentBundle;
await sid.importEnrollments(restored);
// Name collision → throws (like enroll). Overwrite with:
await sid.importEnrollments(restored, { replaceExisting: true });
```

**`SpeakerEnrollmentBundle`:** `{ version: 1, dim, modelKey?, speakers: { name, embeddings: number[][] }[] }`.

- `dim` must match the current manager (else `SID_ENROLLMENT_DIM_MISMATCH`).
- When both the bundle and this SID instance have a `modelKey`, a mismatch rejects with `SID_ENROLLMENT_MODEL_MISMATCH`.
- Export only includes speakers enrolled through this SID instance’s enroll/import paths (not a raw native-only manager).
- Future: native readout via upstream `GetEmbedding` — [future-work/speaker-embedding-manager-upstream-export-import.md](future-work/speaker-embedding-manager-upstream-export-import.md).

---

## Out of scope

- `kind: 'diarization'` segment rows (see [diarization-offline.md](diarization-offline.md))
- Score / top-N search results
- In-place mutation of VAD segment buffers
- Enroll from a segment buffer **without** PCM audio
- Native embedding dump / Upstream `GetEmbedding` (export uses the JS mirror; see [future-work/speaker-embedding-manager-upstream-export-import.md](future-work/speaker-embedding-manager-upstream-export-import.md))
- Automatic file / cloud I/O for enrollment bundles (app-owned storage)

---

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| File decode path | `OfflineAudioBuffer` (`off_*`) | Enrollment / identify clips via `createOfflineAudioBufferFromFile(...)`. |
| Sample ingestion path | `OfflineAudioBuffer` (`off_*`) | App-owned PCM via `createOfflineAudioBufferFromSamples(...)`. |
| Offline / streaming VAD | `OfflineSegmentBuffer` (`seg_off_*`) | Speech ranges for `enrollOfflineSegments` / `labelOfflineSegments` (PCM still required). |
| App-filtered spans | `OfflineSegmentBuffer` (`seg_off_*`) | e.g. even interview turns rebuilt into a new offline segment snapshot. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Identify result | `{ name: string \| null }` | Whole-buffer `identify` — no segment Out. |
| Labeled timeline | `OfflineSegmentBuffer` (`seg_off_*`) | Empty `segmentsOut` filled with `payload.source: 'sid'`. |
| UI / export | Segment metadata | Read via `getOfflineSegmentBufferSegments(...)`. |
| Diarization | Shared embedding Runner | Same weights via C++ registry; anonymous clusters are **not** SID — see [diarization-offline.md](diarization-offline.md). |

```mermaid
flowchart LR
  A[OfflineAudioBuffer] --> C[createSpeakerIdentification]
  B[OfflineSegmentBuffer speech] --> C
  C --> D[enroll / enrollOfflineSegments]
  C --> E[identify]
  C --> F[labelOfflineSegments]
  F --> G[OfflineSegmentBuffer source sid]
```

More end-to-end patterns: [feature-pipelines.md#speaker-identification-offline-patterns](feature-pipelines.md#speaker-identification-offline-patterns).

## Types and constants

```ts
import {
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
  SPEAKER_EMBEDDING_MODEL_TYPES,
  SpeakerEmbeddingErrorCode,
  type IdentifyResult,
  type ImportEnrollmentsOptions,
  type ImportEnrollmentsResult,
  type LabelOfflineSegmentsResult,
  type OrchestrationProgress,
  type SidLabeledSegmentEvent,
  type SidLiveLabeledSegmentEvent,
  type SidVerifiedSegmentEvent,
  type SpeakerEmbeddingDetectResult,
  type SpeakerEmbeddingModelType,
  type SpeakerEnrollmentBundle,
  type SpeakerEnrollmentEntry,
  type SpeakerIdentificationEngine,
  type SpeakerIdentificationLabelOptions,
  type SpeakerIdentificationLiveLabelOptions,
  type SpeakerIdentificationOptions,
  type SpeakerIdentificationPipelineHandle,
  type SpeakerIdentificationSegmentOptions,
  type SpeakerIdentificationThresholdOptions,
  type SpeakerIdentificationVerifyOptions,
  type VerifyOfflineSegmentsResult,
} from 'react-native-sherpa-onnx/speaker-identification';
```

- **`SpeakerEmbeddingModelType`:** `'wespeaker' | '3d-speaker' | 'nemo'`
- **`IdentifyResult`:** `{ name: string | null }`
- **`LabelOfflineSegmentsResult`:** `{ labeledCount: number; unknownCount: number }`
- **`VerifyOfflineSegmentsResult`:** `{ matchCount: number; mismatchCount: number; matches: boolean[] }`
- **`SpeakerEnrollmentBundle` / `SpeakerEnrollmentEntry`:** versioned enrollment snapshot for `exportEnrollments` / `importEnrollments`
- **`ImportEnrollmentsOptions` / `ImportEnrollmentsResult`:** `{ replaceExisting? }` → `{ imported, skipped }`
- **`SpeakerIdentificationThresholdOptions`:** `{ threshold?: number }` (default `0.5`)
- **`SpeakerIdentificationSegmentOptions`:** threshold + optional `onProgress`
- **`SpeakerIdentificationLabelOptions`:** segment options + optional `onLabeled`
- **`SpeakerIdentificationVerifyOptions`:** segment options + optional `onVerified`
- **`SidLabeledSegmentEvent`:** per-span offline label result (`speakerName`, ranges, `totalSegments`, …)
- **`SidVerifiedSegmentEvent`:** per-span offline verify result (`expectedName`, `matched`, ranges, `totalSegments`, …)
- **`SpeakerIdentificationLiveLabelOptions` / `SidLiveLabeledSegmentEvent` / `SpeakerIdentificationPipelineHandle`:** live overload — see [speaker-identification-live.md](speaker-identification-live.md)
- **`OrchestrationProgress`:** shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …)

---

## Error codes

Typical **promise rejection `code`** strings from the native speaker-embedding layer (used under SID). Message text varies; prefer **`code`** for branching when catching. Some failures are plain JS `Error` messages from the SID wrapper (no native `code`).

| Error code | Explanation |
| --- | --- |
| `SPEAKER_EMBEDDING_DETECT_ERROR` | `detectSpeakerEmbeddingModel` failed or returned no usable layout. |
| `SPEAKER_EMBEDDING_INIT_ERROR` | Extractor init failed (invalid model path/type or native construct failure). |
| `SPEAKER_EMBEDDING_COMPUTE_ERROR` | Embedding extraction failed for an offline audio buffer / range. |
| `SPEAKER_EMBEDDING_MANAGER_ERROR` | Named-speaker manager create / add / search / verify / destroy failed. |
| `SPEAKER_EMBEDDING_BUFFER_NOT_FOUND` | Audio buffer id missing from the audio registry (released or never created). |
| `SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH` | A non-offline audio buffer was passed to offline extract. |
| `SPEAKER_EMBEDDING_BUFFER_EMPTY` | Offline audio buffer (or extracted range) has no samples. |
| `SPEAKER_EMBEDDING_INVALID_ARGUMENT` | Invalid `customConfig` / init arguments on the JS custom-path resolver. |
| `SID_INVALID_OPTIONS` | JS guard: `onProgress` / `onLabeled` / `onVerified` provided but not a function (message includes this token). |
| `SID_ENROLLMENT_BUNDLE_INVALID` | JS guard: malformed `SpeakerEnrollmentBundle` (version, speakers, embeddings). |
| `SID_ENROLLMENT_DIM_MISMATCH` | JS guard: bundle `dim` ≠ current manager dim. |
| `SID_ENROLLMENT_MODEL_MISMATCH` | JS guard: bundle `modelKey` ≠ this SID instance’s model key. |
| `SEGMENT_INVALID_ARGUMENT` | Bad segment buffer id or invalid speech payload during `labelOfflineSegments` staging (`source: 'sid'`). |
| `SEGMENT_BUFFER_NOT_FOUND` | Segment In/Out or staging live buffer id missing from the segment registry. |
| `FILEIO_*` | File / URI resolution for **`FileSource`** before or during detect/init. |

JS-side SID guards (message match, not always a native `code`): empty speaker name, name-list length mismatch / empty list entries, no audio buffers for `enroll`, no speech spans for `enrollOfflineSegments` / `verifyOfflineSegments`, enroll/import when the name already exists, enrollment bundle validation, and calls after `destroy()`.

---

## See also

- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline segment buffers — offline](segmentbuffer-offline.md) — speech payload `sid`
- [VAD streaming](vad-streaming.md) — speech boundaries (when)
- [Speaker Identification (live overload)](speaker-identification-live.md) — `labelLiveSegments`
- [Speaker diarization](diarization-offline.md) — anonymous clustering (offline shipped; shared embedding foundation)
- [Named diarization timeline](diarization-named-timeline.md) — map clusters to SID enrollments
- [Feature pipelines](feature-pipelines.md)
- [Model detect](model-detect.md)
- [Model setup](model-setup.md)
- [Download manager](download-manager.md) — `SpeakerEmbedding` category
- [Execution providers](execution-providers.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
