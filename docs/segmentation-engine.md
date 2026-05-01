# Segmentation engine (`segment`)

Segmentation is the SDK's cross-feature boundary layer for splitting text/audio into bounded chunks and linking speech segments to text segments.

**Import path:** `react-native-sherpa-onnx/segment`

## Introduction

Many models in this SDK are offline-first or offline-only. Running one large offline pass over long recordings can push device memory too high and trigger OOM on low-memory hardware.

The segmentation engine mitigates that by splitting work into smaller segments and running the offline feature repeatedly on bounded chunks. This reduces peak RAM, but quality can be slightly lower than one monolithic offline pass. The tradeoff is intentional for stability and feasibility on mobile devices.

Use this guide as the canonical reference for:

- Engine lifecycle (`attachSegmentationEngine`/`detachSegmentationEngine`)
- Segment materialization and reads (`segmentOfflineBuffer`, `getSegments`)
- Cross-domain linking (`SegmentLink`, `SegmentLinkMap`)

Related docs:

- Memory planning and OOM: [memory-and-models.md](./memory-and-models.md)
- Buffer contracts: [audiobuffer-offline.md](./audiobuffer-offline.md), [textbuffer-offline.md](./textbuffer-offline.md), [segmentbuffer-offline.md](./segmentbuffer-offline.md)
- Feature integration points: [stt-offline.md](./stt-offline.md), [tts-offline.md](./tts-offline.md), [enhancement-offline.md](./enhancement-offline.md), [punctuation-offline.md](./punctuation-offline.md), [tts-streaming.md](./tts-streaming.md)

### Segmentation modes used by feature APIs

Features (STT, TTS, enhancement, punctuation, …) pass **`segmentation`** on their own API — **not** only via `segment`. Per-feature **`mode`**, **`policy`**, and limits are documented under **`## Segmentation`** in each guide.

**Modes (overview):** `off` = one-shot; `manual` = you commit boundaries (streaming where supported); `auto` = engine + `policy`. Offline features in `src/` often only `off`/`auto`; streaming often `off`/`manual`/`auto`.

### Evaluators (domain & behavior)

Policies are **domain-specific**: only **text** evaluators go on text buffers; only **speech** evaluators on speech buffers. Wrong domain → `POLICY_INVALID`.

| Evaluator | Domain | `segmentOfflineBuffer` · `attachSegmentationEngine` | Behavior |
| --- | --- | --- | --- |
| `text_synthetic_auto` | Text | Offline + live (text) | **Offline:** forward scan — delimiter first ([delimiters below](#text-sentenceboundary-delimiters)), else `maxLengthChars`. **Live:** commit at **last** delimiter or length cap in partial. |
| `text_punctuation_assisted` | Text | Offline + live (text); needs `policy.punctuationInstanceId` | Punctuation pass (`punctuationInstanceId`), then same split as `text_synthetic_auto`. Missing instance → `POLICY_PUNCTUATION_INSTANCE_NOT_FOUND`. |
| `speech_energy_silence` | Speech | Offline + live (speech) | Spans from energy + silence (`silenceThresholdMs`, `energyThresholdDb`, `minSegmentMs`, `maxSegmentMs`, `hangoverMs`). No VAD ONNX. |
| `speech_vad_model` | Speech | Offline + live (speech); needs `policy.modelPath` | Spans from VAD ONNX (`modelPath`, `vadThreshold`, `vadMinSpeechMs`, `vadMinSilenceMs`, …). |
| `continuous_frames` | Speech | **Live speech only** (offline → `POLICY_INVALID_FOR_OFFLINE`) | Frame checkpoints (`checkpointIntervalMs`). |

### Text `sentenceBoundary` delimiters

For `text_synthetic_auto` and `text_punctuation_assisted`, when `sentenceBoundary` is **true**, splitting uses Unicode-aware scanning (not ASCII-only). Boundary characters include:

- Latin / common: `.` `!` `?` `;` `:` and newline
- CJK (full-width sentence punctuation): U+3002 `。` · U+FF01 `！` · U+FF1F `？` · U+FF61 `｡`
- Arabic question mark: U+061F `؟`
- Devanagari sentence marks: U+0964 `।` · U+0965 `॥`

Optional **`sentenceBoundaryChars`** (`string[]`, non-empty after validation) replaces the default delimiter list entirely (no merge).

## Quick start

```ts
import {
  segmentOfflineBuffer,
  getSegments,
  createSegmentLinkMap,
  addSegmentLink,
  getAllSegmentLinks,
} from 'react-native-sherpa-onnx/segment';
import { createEmptyOfflineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { createOfflineTextBufferFromText } from 'react-native-sherpa-onnx/textbuffer';

const offlineAudio = await createEmptyOfflineAudioBuffer({ sampleRate: 16000 });
// Pre-fill offline text in one step (`appendOfflineText` is not a public JS export).
const offlineText = await createOfflineTextBufferFromText(
  'Hello world. This is a long paragraph that should be split.'
);

// Materialize text segments (domain='text') for offline text buffer.
await segmentOfflineBuffer(offlineText, {
  evaluator: 'text_synthetic_auto',
  sentenceBoundary: true,
  maxLengthChars: 500,
});

// Materialize speech segments (domain='speech') for offline audio buffer.
await segmentOfflineBuffer(offlineAudio, {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
  hangoverMs: 300,
});

const textSegments = await getSegments(offlineText, 0, 128);
const speechSegments = await getSegments(offlineAudio, 0, 128);

// Link map lets you persist relationships between text and speech segments.
const linkMap = await createSegmentLinkMap({
  textBufferId: offlineText.bufferId,
  audioBufferId: offlineAudio.bufferId,
});

if (textSegments.length > 0 && speechSegments.length > 0) {
  await addSegmentLink(linkMap, {
    textSegmentId: textSegments[0]!.segmentId,
    speechSegmentId: speechSegments[0]!.segmentId,
    linkType: 'alignment',
    confidence: 0.95,
  });
}

const links = await getAllSegmentLinks(linkMap, 0, 64);
console.log('links:', links.length);
```

## API reference

### Engine lifecycle

#### `attachSegmentationEngine(buffer, config)`

```ts
function attachSegmentationEngine(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  config: SegmentationConfig
): Promise<SegmentationEngineRef>;
```

```ts
const engine = await attachSegmentationEngine(liveTextBuffer, {
  policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 500 },
});
```

Attaches a native engine to a live text/audio buffer. The buffer must be live (`txt_live_*` or `live_*`).

#### `detachSegmentationEngine(engine, options?)`

```ts
function detachSegmentationEngine(
  engine: SegmentationEngineRef | string,
  options?: { flushFinal?: boolean }
): Promise<void>;
```

```ts
await detachSegmentationEngine(engine, { flushFinal: true });
```

Detaches the engine and optionally flushes final pending boundaries.

#### `getSegmentationEngineInfo(engine)`

```ts
function getSegmentationEngineInfo(
  engine: SegmentationEngineRef | string
): Promise<SegmentationEngineInfo>;
```

```ts
const info = await getSegmentationEngineInfo(engine);
console.log(info.state, info.totalSegmentsCommitted);
```

Returns state, attached buffer id, domain, policy, and counters for observability.

### Offline segmentation entrypoint

#### `segmentOfflineBuffer(buffer, policy)`

```ts
function segmentOfflineBuffer(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  policy: SegmentationPolicy
): Promise<SegmentBufferRef>;
```

```ts
const ref = await segmentOfflineBuffer(offlineAudioBuffer, {
  evaluator: 'speech_vad_model',
  modelPath: { type: 'file', path: '/models/silero_vad.onnx' },
  vadThreshold: 0.5,
  vadMinSpeechMs: 250,
  vadMinSilenceMs: 200,
});
```

Materializes segments for offline text/audio. For `speech_vad_model`, `modelPath` is required and resolved before native calls.

### Live text helpers

#### `setPartial(buffer, text)`

```ts
function setPartial(buffer: PipelineTextBufferIdSource, text: string): Promise<void>;
```

```ts
await setPartial(liveTextBuffer, 'working draft...');
```

Replaces the current live text partial. Works only with live text buffers.

#### `appendPartial(buffer, text)`

```ts
function appendPartial(
  buffer: PipelineTextBufferIdSource,
  text: string
): Promise<void>;
```

```ts
await appendPartial(liveTextBuffer, ' more text');
```

Appends to the current live text partial. Works only with live text buffers.

#### `commitSegment(buffer, options?)`

```ts
function commitSegment(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  options?: CommitSegmentOptions
): Promise<Segment>;
```

```ts
const segment = await commitSegment(liveAudioBuffer, {
  reason: 'manual_commit',
  source: 'manual',
});
```

Commits one segment from live partial state. Fails when segmentation is disabled (`mode='off'`) or no uncommitted content exists.

### Segment reads and handles

#### `getSegmentBuffer(buffer)`

```ts
function getSegmentBuffer(
  buffer:
    | SegmentBufferRef
    | PipelineTextBufferIdSource
    | PipelineAudioBufferIdSource
    | PipelineSegmentBufferIdSource
): Promise<SegmentBufferRef>;
```

```ts
const segRef = await getSegmentBuffer(offlineAudioBuffer);
console.log(segRef.segmentBufferId, segRef.domain);
```

Resolves the canonical segment buffer reference for text/speech sources.

#### `getSegments(buffer, startIndex?, maxCount?)`

```ts
function getSegments(
  buffer:
    | SegmentBufferRef
    | PipelineTextBufferIdSource
    | PipelineAudioBufferIdSource
    | PipelineSegmentBufferIdSource,
  startIndex?: number,
  maxCount?: number
): Promise<Segment[]>;
```

```ts
const items = await getSegments(segRef, 0, 64);
```

Reads text or speech segments from the resolved source. Throws `SEGMENT_INDEX_OUT_OF_RANGE` on invalid windows.

#### `getSegmentCount(buffer)`

```ts
function getSegmentCount(
  buffer:
    | SegmentBufferRef
    | PipelineTextBufferIdSource
    | PipelineAudioBufferIdSource
    | PipelineSegmentBufferIdSource
): Promise<number>;
```

```ts
const count = await getSegmentCount(segRef);
```

Returns total segment count for the resolved source.

### SegmentLinkMap lifecycle and writes

#### `createSegmentLinkMap(options?)`

```ts
function createSegmentLinkMap(options?: {
  textBufferId?: string;
  audioBufferId?: string;
}): Promise<SegmentLinkMapRef>;
```

```ts
const map = await createSegmentLinkMap({ textBufferId, audioBufferId });
```

Creates a native-held map for cross-domain links.

#### `addSegmentLink(linkMap, link)`

```ts
function addSegmentLink(
  linkMap: SegmentLinkMapRef | string,
  link: {
    textSegmentId: string;
    speechSegmentId: string;
    linkType: SegmentLinkType;
    confidence?: number;
    meta?: Record<string, unknown>;
  }
): Promise<SegmentLink>;
```

```ts
await addSegmentLink(map, {
  textSegmentId: 'txtseg_1',
  speechSegmentId: 'spseg_1',
  linkType: 'proportional',
});
```

Adds one typed link between a text and speech segment.

#### `addSegmentLinks(linkMap, links)`

```ts
function addSegmentLinks(
  linkMap: SegmentLinkMapRef | string,
  links: Array<{
    textSegmentId: string;
    speechSegmentId: string;
    linkType: SegmentLinkType;
    confidence?: number;
    meta?: Record<string, unknown>;
  }>
): Promise<SegmentLink[]>;
```

```ts
await addSegmentLinks(map, [
  { textSegmentId: 'txtseg_1', speechSegmentId: 'spseg_1', linkType: 'alignment' },
  { textSegmentId: 'txtseg_2', speechSegmentId: 'spseg_2', linkType: 'alignment' },
]);
```

Batch variant for link insertion.

#### `removeSegmentLink(linkMap, linkId)`

```ts
function removeSegmentLink(
  linkMap: SegmentLinkMapRef | string,
  linkId: string
): Promise<void>;
```

```ts
await removeSegmentLink(map, linkId);
```

Removes a link by id. Missing ids are ignored by native stores.

#### `releaseSegmentLinkMap(linkMap)`

```ts
function releaseSegmentLinkMap(
  linkMap: SegmentLinkMapRef | string
): Promise<void>;
```

```ts
await releaseSegmentLinkMap(map);
```

Releases native map resources. Call when links are no longer needed.

### SegmentLinkMap queries

#### `getSpeechSegmentsForText(linkMap, textSegmentId)`

```ts
function getSpeechSegmentsForText(
  linkMap: SegmentLinkMapRef | string,
  textSegmentId: string
): Promise<SegmentLink[]>;
```

```ts
const speechLinks = await getSpeechSegmentsForText(map, textSegmentId);
```

Returns all links whose source text segment matches the given id.

#### `getTextSegmentsForSpeech(linkMap, speechSegmentId)`

```ts
function getTextSegmentsForSpeech(
  linkMap: SegmentLinkMapRef | string,
  speechSegmentId: string
): Promise<SegmentLink[]>;
```

```ts
const textLinks = await getTextSegmentsForSpeech(map, speechSegmentId);
```

Returns all links whose speech segment matches the given id.

#### `getAllSegmentLinks(linkMap, startIndex?, maxCount?)`

```ts
function getAllSegmentLinks(
  linkMap: SegmentLinkMapRef | string,
  startIndex?: number,
  maxCount?: number
): Promise<SegmentLink[]>;
```

```ts
const page = await getAllSegmentLinks(map, 0, 100);
```

Reads a paged list of links.

#### `getSegmentLinkCount(linkMap)`

```ts
function getSegmentLinkCount(
  linkMap: SegmentLinkMapRef | string
): Promise<number>;
```

```ts
const total = await getSegmentLinkCount(map);
```

Returns the current number of links in the map.

#### `getSegmentLinkMapInfo(linkMap)`

```ts
function getSegmentLinkMapInfo(
  linkMap: SegmentLinkMapRef | string
): Promise<SegmentLinkMapInfo>;
```

```ts
const mapInfo = await getSegmentLinkMapInfo(map);
console.log(mapInfo.linkCount);
```

Returns map metadata (`linkMapId`, `linkCount`, optional associated buffer ids).

## Types and constants

```ts
import type {
  SegmentationPolicy, // evaluator + tuning
  SegmentationConfig, // { policy? } for attachSegmentationEngine
  SegmentationEngineRef, // { engineId } handle from attach
  SegmentationEngineInfo, // state from getSegmentationEngineInfo
  SegmentationEvaluator, // policy.evaluator discriminator
  SegmentationMode, // off | manual | auto (feature/runtime wiring)
  Segment, // TextSegment | SpeechSegment
  TextSegment,
  SpeechSegment,
  SegmentDomain,
  SegmentReason,
  SegmentSource,
  SegmentLink, // cross-domain link record
  SegmentLinkMapRef, // lightweight handle to native-held map
  SegmentLinkMapInfo, // getSegmentLinkMapInfo result
  SegmentLinkType, // alignment / proportional / vad_assisted / ...
  ValidateSegmentationOptions, // options for validateSegmentationConfig
} from 'react-native-sherpa-onnx/segment';

import {
  SegmentBufferRef, // resolved segment buffer handle (domain + parent ids)
  CommitSegmentOptions, // metadata for manual segment commits
  isTextSegment, // type guard for TextSegment
  isSpeechSegment, // type guard for SpeechSegment
  validateSegmentationConfig, // feature-level mode/policy validation
  attachSegmentationEngine, // attach engine to live text/audio
  detachSegmentationEngine, // detach engine and optional final flush
  getSegmentationEngineInfo, // runtime state for an attached engine
  segmentOfflineBuffer, // materialize offline text/speech segments
  setPartial, // replace live text partial
  appendPartial, // append to live text partial
  commitSegment, // commit one live segment from current state
  getSegmentBuffer, // resolve canonical segment buffer ref
  getSegments, // read paged segments
  getSegmentCount, // read total segment count
  createSegmentLinkMap, // allocate native link map
  addSegmentLink, // add one link
  addSegmentLinks, // add many links
  removeSegmentLink, // remove one link by id
  getSpeechSegmentsForText, // query links by text segment id
  getTextSegmentsForSpeech, // query links by speech segment id
  getAllSegmentLinks, // paged full-link scan
  getSegmentLinkCount, // total link count
  getSegmentLinkMapInfo, // link-map metadata
  releaseSegmentLinkMap, // free link-map resources
  segmentFromJson, // JSON → Segment
  segmentToJson, // Segment → JSON
  segmentLinkFromJson,
  segmentLinkToJson,
  validateSegment, // runtime validation helper
  validateSegmentLink,
} from 'react-native-sherpa-onnx/segment';
```

## Error codes

| Code | Meaning |
| --- | --- |
| `SEGMENT_INVALID_ARGUMENT` | Invalid buffer id, id source, index, or unsupported buffer kind for the called API |
| `SEGMENT_INDEX_OUT_OF_RANGE` | `startIndex` exceeds available segments |
| `SEGMENT_NOT_AVAILABLE` | Segmentation state or required materialization is missing (for example mode is off, or offline text was not segmented yet) |
| `SEGMENT_COMMIT_FAILED` | Manual commit failed due to missing partial/uncommitted content or commit materialization failure |
| `SEGMENT_LINK_INVALID` | Invalid or unsupported link payload (for example invalid `linkType`) |
| `SEGMENT_LINK_MAP_NOT_FOUND` | Link-map handle was released or never existed |
| `SEGMENT_INTERNAL_ERROR` | Native contract failure or unexpected internal state |
| `SEGMENTATION_POLICY_INVALID` | Feature-level mode/policy combination is invalid |
| `ENHANCEMENT_INVALID_SEGMENTATION` | Streaming enhancement segmentation config is invalid |

**`OFFLINE_OOM` (cross-cutting):** Not emitted by the segmentation APIs themselves, but several **offline** features map native allocation failures to this code (`OFFLINE_OOM`). User-visible reject messages recommend streaming where available **and** point to **this document** (`docs/segmentation-engine.md`) as the guide for chunked offline processing.

Other errors can come from feature engines, buffer modules, or native dependencies. For feature-specific codes, see each feature guide.

## Use case examples

<details>
<summary>Offline-only model on low-memory device: segment first, then run feature per chunk</summary>

```ts
import { segmentOfflineBuffer, getSegments } from 'react-native-sherpa-onnx/segment';

await segmentOfflineBuffer(offlineAudio, {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
});

const chunks = await getSegments(offlineAudio, 0, 10_000);
for (const chunk of chunks) {
  // Feed each bounded chunk into the offline feature pipeline.
}
```

Use this pattern when one giant offline pass would risk OOM.
</details>

<details>
<summary>Manual live commits for custom UI boundaries</summary>

```ts
import { setPartial, appendPartial, commitSegment } from 'react-native-sherpa-onnx/segment';

await setPartial(liveText, 'first phrase');
await appendPartial(liveText, ' continued');

const committed = await commitSegment(liveText, {
  reason: 'manual_commit',
  source: 'manual',
  meta: { trigger: 'user-tap' },
});

console.log(committed.segmentId);
```

Useful when product UX decides boundaries (button taps, subtitle breaks, custom checkpoints).
</details>

<details>
<summary>Build and query alignment links for subtitle/timing synchronization</summary>

```ts
import {
  createSegmentLinkMap,
  addSegmentLinks,
  getSpeechSegmentsForText,
} from 'react-native-sherpa-onnx/segment';

const linkMap = await createSegmentLinkMap({ textBufferId, audioBufferId });

await addSegmentLinks(linkMap, [
  { textSegmentId: 'txtseg_1', speechSegmentId: 'spseg_4', linkType: 'alignment', confidence: 0.97 },
  { textSegmentId: 'txtseg_2', speechSegmentId: 'spseg_5', linkType: 'alignment', confidence: 0.95 },
]);

const timingCandidates = await getSpeechSegmentsForText(linkMap, 'txtseg_1');
console.log(timingCandidates);
```

This keeps cross-domain mapping explicit and queryable for replay/export flows.
</details>