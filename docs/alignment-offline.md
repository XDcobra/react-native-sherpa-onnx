# AlignmentEngine (buffer-first)

Alignment is offline and buffer-first:
- input transcript from `OfflineTextBuffer`
- input waveform from `OfflineAudioBuffer`
- output written into a caller-provided `OfflineSegmentBuffer` as `kind: 'alignment'`

Use `createAlignment()` and `engine.alignTextToAudio(...)`.
The freestanding public `alignTextToAudio` symbol is removed (hard cut).

## Modes

| Mode | Needs | Segment payload `timingMode` |
| --- | --- | --- |
| `proportional` | text + audio duration | `proportional` |
| `estimated` | text + `segmentSampleCounts` | `estimated` |
| `accurate` | text + audio + wav2vec2 ONNX (row 3 one-shot, or rows 4a/4b with segmentation auto) | `accurate` |
| `vad` | text + VAD `speech` anchors from `seg_off_*` | `vad` |

Granularity rules:
- `proportional` / `estimated`: `sentence` or `word`
- `accurate` (row 3): `sentence`, `word`, or `character`
- `accurate` + segmentation auto (rows 4a/4b): `sentence` or `word`
- `vad`: `sentence` or `word` (`character` rejected)

### Detailed behavior matrix (mode x granularity)

| Mode | Granularity | Input assumptions | Runtime behavior | Notes |
| --- | --- | --- | --- | --- |
| `proportional` | `sentence`, `word` | Offline text + offline audio duration | Splits text by granularity and distributes timing by text weight over full audio duration | No acoustic boundaries; purely duration/text-weight based |
| `estimated` | `sentence`, `word` | Offline text + `segmentSampleCounts` (+ optional `sampleRate`) | Uses estimated chunk/sample timeline to assign timestamps | Not forced alignment; quality depends on provided chunk counts |
| `accurate` | `sentence`, `word`, `character` | Offline text + offline audio + wav2vec2 alignment model | CTC forced alignment on waveform and text | `character` is supported only in plain `accurate` (without segmentation) |
| `vad` | `sentence`, `word` | Offline text + VAD speech anchors from `seg_off_*` | Splits text by granularity, then maps units monotonically to VAD speech anchors (`vadMonotonicWeightDP`) and writes `alignment` segments only for mapped units | If `textUnits > vadAnchors`, multiple units merge into one output segment |
| `accurate` + `mappingStrategy: 'asr_mediated'` | `sentence`, `word` | Offline text + offline audio + wav2vec2 + speech anchors + hypothesis text buffer with token timestamps | Linker-assisted per-anchor accurate alignment (asrMediated, row 4a) | Missing timestamps reject with `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`; no fallback |
| `accurate` + `mappingStrategy: 'chunked_forced_ctc'` | `sentence`, `word` | Offline text + offline audio + wav2vec2 + speech anchors | Cursor-driven per-anchor forced CTC (chunkedForcedCtc, row 4b) | Emits deterministic progress/residual warnings; no fallback |

For `vad` mode, mismatch behavior is deterministic by design:
- `textUnits > vadAnchors`: multiple text units can be merged into one anchor/segment.
- `vadAnchors > textUnits`: extra anchors remain unmapped (reported in diagnostics).
- `vadAnchorCount = 0`: valid success path with `segmentsWritten = 0` (no reject).

For `accurate` with segmentation auto:
- `asrMediated` requires caller-provided hypothesis token timestamps.
- `chunkedForcedCtc` runs without ASR dependency.
- Both paths are anchor-constrained and deterministic; no silent fallback to other modes.

### Common surprises

- `vad + word` does **not** guarantee one output segment per word.
  - Output count follows available VAD speech anchors first, then text-unit mapping.
- Short utterances such as `"Hello World"` often become a single VAD speech anchor.
  - With one anchor and two words, output is typically one `alignment` segment with combined text.
- If you need long-form accurate alignment, prefer `accurate` with `segmentation.mode='auto'`:
  - `mappingStrategy: 'asr_mediated'` (`asrMediated`, row 4a)
  - `mappingStrategy: 'chunked_forced_ctc'` (`chunkedForcedCtc`, row 4b)

## Quick start

All modes share the same offline buffer setup:

```ts
import { createAlignment } from 'react-native-sherpa-onnx/alignment';
import { createSTT } from 'react-native-sherpa-onnx/stt';
import { segmentOfflineBuffer } from 'react-native-sherpa-onnx/segment';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

// 0) App-level model configuration: alignment + STT use FileSource;
//    speech_vad_model segmentation policy uses FileSource (detectVadModel).
const ALIGNMENT_MODEL: FileSource = {
  kind: 'fs',
  path: '/abs/path/to/wav2vec2-alignment-model',
};
const STT_MODEL: FileSource = {
  kind: 'fs',
  path: '/abs/path/to/stt-model',
};
const VAD_MODEL: FileSource = {
  kind: 'fs',
  path: '/abs/path/to/vad-model-dir-or-onnx',
};

const engine = createAlignment();
const textBuf = await createOfflineTextBufferFromText('Hello world.');
const audioBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});
const segmentOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: audioBuf,
});
```

### `proportional`

```ts
// No model, no chunks, no segmentation: pure duration/text-weight timing.
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'proportional',
  granularity: 'sentence',
});
```

### `estimated`

```ts
// Uses caller-provided timeline chunks.
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'estimated',
  granularity: 'word',
  chunks: {
    sampleRate: 16000,
    segmentSampleCounts: [3200, 4000, 2800],
  },
});
```

### `accurate` (plain)

```ts
// wav2vec2 CTC forced alignment over full offline audio.
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelSource: { kind: 'fs', path: '/abs/path/to/model.onnx' },
});
```

### `vad` (standalone)

```ts
// Uses VAD speech anchors from an existing offline segment buffer.
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'vad',
  granularity: 'word',
  segmentation: {
    source: 'vad',
    segmentBuffer: vadSegmentBufferId, // seg_off_*
  },
});
```

### `accurate + auto` asrMediated (`asr_mediated`)

```ts
const stt = await createSTT({
  modelSource: STT_MODEL,
  modelType: 'auto',
});

// 1) R = reference transcript (ground-truth script), not ASR output.
const textBuf = await createOfflineTextBufferFromText(
  'The full reference transcript that should be aligned to audio.'
);

// 2) input audio buffer for both STT and alignment.
const audioBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});

// 3) caller-owned output buffer where alignment segments will be written.
const segmentOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: audioBuf,
});

// 4) speech anchors (seg_off_*) from SegmentationEngine.
//    asr_mediated consumes these anchors via segmentation.anchorSegmentBuffer.
const anchorRef = await segmentOfflineBuffer(audioBuf, {
  evaluator: 'speech_vad_model',
  modelSource: VAD_MODEL,
  vadMinSpeechMs: 200,
  vadMinSilenceMs: 500,
});

// 5) H = ASR hypothesis buffer filled by STT.
//    Important: for asr_mediated, H must provide token timestamps.
const asrHypothesisOut = await createEmptyOfflineTextBuffer();
await stt.transcribe(audioBuf, asrHypothesisOut, {
  segmentation: { mode: 'off' },
});

// 6) accurate + auto + asr_mediated:
//    - textIn: reference text R
//    - audioIn: full offline audio
//    - anchorSegmentBuffer: speech anchors from step 4
//    - hypothesisTextBuffer: STT hypothesis H from step 5
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelSource: ALIGNMENT_MODEL,
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: anchorRef,
    mappingStrategy: 'asr_mediated',
    asr: {
      hypothesisTextBuffer: asrHypothesisOut,
    },
  },
});

// Optional: link map handle for cross-domain text<->speech relations.
console.log(write.outputSegmentBufferId, write.segmentsWritten, write.linkMap);

// 7) cleanup (important for long-running apps).
await engine.destroy().catch(() => {});
await stt.destroy().catch(() => {});
await releasePipelineTextBuffer(textBuf).catch(() => {});
await releasePipelineTextBuffer(asrHypothesisOut).catch(() => {});
await releasePipelineSegmentBuffer(anchorRef.segmentBufferId).catch(() => {});
await releasePipelineSegmentBuffer(segmentOut).catch(() => {});
await releasePipelineAudioBuffer(audioBuf).catch(() => {});
```

### `accurate + auto` chunkedForcedCtc (`chunked_forced_ctc`)

```ts
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelSource: { kind: 'fs', path: '/abs/path/to/model.onnx' },
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: vadSegmentOut,
    mappingStrategy: 'chunked_forced_ctc',
  },
});
```

### Read result segments + cleanup (all modes)

```ts
const segments = await getOfflineSegmentBufferSegments(segmentOut, 0, 256);
const alignmentSegments = segments.filter((s) => s.kind === 'alignment');
console.log(write.outputSegmentBufferId, write.segmentsWritten, write.warningCode);

await releasePipelineTextBuffer(textBuf).catch(() => {});
await releasePipelineAudioBuffer(audioBuf).catch(() => {});
await releasePipelineSegmentBuffer(segmentOut).catch(() => {});
await engine.destroy().catch(() => {});
```

### Derive subtitle rows from alignment segments (app-layer)

Derive subtitle rows from `alignment` segments:

```ts
const subtitleRows = alignmentSegments.map((segment) => ({
  text: segment.payload?.text ?? '',
  startSec: segment.startSample / Math.max(1, segment.sampleRate),
  endSec: segment.endSample / Math.max(1, segment.sampleRate),
}));
```

## Model detection

Unified cross-feature detection: [model-detect.md](model-detect.md).

`detectAlignmentModel` checks wav2vec2 alignment packs before `createAlignment` or per-call `modelSource` in `accurate` mode. See [`detectAlignmentModel`](#detectalignmentmodelsource-options) below.

## API reference

### `createAlignment(options?)`

```ts
function createAlignment(options?: object): {
  alignTextToAudio(
    textIn: OfflineTextBufferIdSource,
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource,
    options: AlignTextToAudioOptions
  ): Promise<AlignTextToAudioWriteResult>;
  destroy(): Promise<void>;
};
```

`segmentOut` must be an existing offline segment buffer (`seg_off_*`). The API does not auto-create output buffers.

### `detectAlignmentModel(source, options?)`

Alignment-specific layout detection. For category-unknown library scans, use [`detectModel`](model-detect.md) instead.

```ts
function detectAlignmentModel(
  source: FileSource,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectModelResult>;
```

### `assertAlignmentGranularityForMode(mode, granularity)`

```ts
function assertAlignmentGranularityForMode(
  mode: 'proportional' | 'estimated' | 'aligned' | 'vad' | 'off' ,
  granularity: AlignmentGranularity
): void;
```

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Transcript input | `OfflineTextBuffer` (`txt_off_*`) | Required text source for all alignment modes. |
| Audio input | `OfflineAudioBuffer` (`off_*`) | Required waveform source for all alignment modes. |
| VAD anchor path | `OfflineSegmentBuffer` (`seg_off_*`) | Needed for `mode: 'vad'` and anchor-based accurate auto modes. |
| ASR hypothesis timestamps | `OfflineTextBuffer` (`txt_off_*`) | Required for `accurate_auto_asr` mapping strategy. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Alignment output | `OfflineSegmentBuffer` (`seg_off_*`) | `segmentOut` must be a pre-created offline segment buffer. |
| Subtitle export | Segment rows from `alignment` payloads | Convert segment timings to SRT/VTT at app layer. |
| Timeline post-processing | `SegmentLinkMap` (optional) | Use link metadata for richer composition graphs. |

```mermaid
flowchart LR
  A[OfflineTextBuffer] --> C[createAlignment().alignTextToAudio]
  B[OfflineAudioBuffer] --> C
  C --> D[OfflineSegmentBuffer alignment segments]
  D --> E[Subtitle or timestamp export]
```

More end-to-end patterns: [feature-pipelines.md#alignment-offline-patterns](feature-pipelines.md#alignment-offline-patterns).

## Offline progress (`onProgress`)

Alignment supports optional coarse offline progress via `onProgress` on all `AlignTextToAudioOptions` variants.
The callback payload is `OrchestrationProgress` and follows offline orchestrator semantics:

- The event fires at the start of step `i` (before heavy work for that step).
- `fraction` follows `totalSegments > 0 ? currentSegment / totalSegments : 1`.
- This is not waveform-level progress and does not replace alignment warnings.

Quick per-mode summary:

| Mode path | `totalSegments` | Emission shape |
| --- | --- | --- |
| `accurate` + `segmentation.mode === 'auto'` + `chunked_forced_ctc` | `anchors.length` | multi-step (`currentSegment = anchor index`) |
| `accurate` + `segmentation.mode === 'auto'` + `asr_mediated` | `jobs.length` | multi-step (`currentSegment = job index`) |
| `accurate` without `auto` segmentation | `1` | single-shot (`currentSegment = 0`) |
| `proportional` | `1` | single-shot (`currentSegment = 0`) |
| `estimated` | `1` | single-shot (`currentSegment = 0`) |
| `vad` with speech anchors | `1` | single-shot (`currentSegment = 0`) |
| `vad` with zero speech anchors | n/a | no progress event (no alignment work) |

Example:

```ts
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelSource: { kind: 'fs', path: '/abs/path/to/model.onnx' },
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: anchorRef,
    mappingStrategy: 'chunked_forced_ctc',
  },
  onProgress: (p) => {
    console.log(
      `alignment progress ${p.currentSegment + 1}/${p.totalSegments} fraction=${p.fraction.toFixed(3)}`
    );
  },
});
```

Caveats:

- `onProgress` is coarse and step-based, not sample-accurate.
- In chunked paths, an invocation can terminate before reaching a conceptual final tick; callers should treat progress as a start-of-work signal, not completion proof.
- Use returned warnings / error codes for quality and failure diagnostics.

## Core types

| Type | Description |
| --- | --- |
| `AlignTextToAudioOptionsProportional` | `{ mode: 'proportional'; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsEstimated` | `{ mode: 'estimated'; chunks: AlignmentChunkTimeline; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsAccurate` | `{ mode: 'accurate'; modelSource: FileSource; granularity?: 'sentence' \\| 'word' \\| 'character'; language?: string; segmentation?: { mode: 'auto'; anchorSegmentBuffer: OfflineSegmentBufferIdSource; mappingStrategy: 'asr_mediated' \\| 'chunked_forced_ctc'; asr?: { hypothesisTextBuffer: OfflineTextBufferIdSource } } }` |
| `AlignTextToAudioOptionsVad` | `{ mode: 'vad'; granularity?: 'sentence' \\| 'word'; segmentation: { source: 'vad'; segmentBuffer: OfflineSegmentBufferIdSource } }` |
| `AlignTextToAudioWriteResult` | `{ outputSegmentBufferId: string; segmentsWritten: number; linkMap?: SegmentLinkMapRef; warningCode?: string; warnings?: AlignmentWarning[] }` |
| `OfflineTextBufferIdSource` | From `react-native-sherpa-onnx/textbuffer` |
| `OfflineAudioBufferIdSource` | From `react-native-sherpa-onnx/audiobuffer` |
| `OfflineSegmentBufferIdSource` | From `react-native-sherpa-onnx/segmentbuffer` |

## Error code quick table

| Code | Meaning |
| --- | --- |
| `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` | text buffer id not found |
| `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` | expected `txt_off_*`, wrong kind |
| `ALIGNMENT_TEXT_BUFFER_EMPTY` | text buffer empty or not populated |
| `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` | audio buffer id not found |
| `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` | expected `off_*`, wrong kind |
| `ALIGNMENT_AUDIO_BUFFER_EMPTY` | audio buffer has no samples |
| `SEGMENT_INVALID_ARGUMENT` | invalid or missing `segmentOutBufferId` |
| `SEGMENT_BUFFER_NOT_FOUND` | output segment buffer id not found |
| `SEGMENT_BUFFER_KIND_MISMATCH` | expected `seg_off_*` output buffer |
| `SEGMENT_INVALID_STATE` | output segment buffer already populated |
| `ALIGNMENT_MODEL_MISSING` | accurate mode without `modelSource` |
| `ALIGNMENT_CHUNKS_MISSING` | estimated mode without `segmentSampleCounts` |
| `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` | ASR-mediated strategy requires timestamped hypothesis tokens |
| `ALIGNMENT_LINKER_NO_MAPPING` | `asrMediated` linker produced no usable mapping units |
| `ALIGNMENT_FORCED_CTC_STUCK` | `chunkedForcedCtc` had no progress on three consecutive anchors |
| `ALIGNMENT_NATIVE_UNKNOWN` | native bridge returned unknown error shape |
| `OFFLINE_OOM` | Not enough memory for offline alignment; native message suggests smaller chunks / streaming-friendly pipelines and points to [segmentation-engine.md](./segmentation-engine.md). |

## Use case examples

<details>
<summary>Segmented accurate alignment with anchor mapping (`chunked_forced_ctc`)</summary>

Use alignment `mode: 'accurate'` with segmentation `mode: 'auto'` and anchor segments to avoid one giant forced-alignment pass on long files.

```ts
import { createAlignment } from 'react-native-sherpa-onnx/alignment';
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

const audio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/audio.wav' });
const transcript = await createOfflineTextBufferFromText('long transcript text ...');
const vadAnchors = await createEmptyOfflineSegmentBuffer({ sourceAudioBufferId: audio });
const alignedOut = await createEmptyOfflineSegmentBuffer({ sourceAudioBufferId: audio });

const vad = await createStreamingVAD({
  modelSource: { kind: 'fs', path: '/path/to/vad-model' },
  modelType: 'auto',
  sampleRate: 16000,
});

try {
  await vad.process({ audioIn: audio, segmentOut: vadAnchors, options: {} });

  const alignment = createAlignment();
  await alignment.alignTextToAudio(transcript, audio, alignedOut, {
    mode: 'accurate',
    granularity: 'word',
    modelSource: { kind: 'fs', path: '/path/to/wav2vec2-alignment-model' },
    segmentation: {
      mode: 'auto',
      anchorSegmentBuffer: vadAnchors,
      mappingStrategy: 'chunked_forced_ctc',
    },
  });
  await alignment.destroy();
} finally {
  await vad.destroy();
  await releasePipelineTextBuffer(transcript);
  await releasePipelineSegmentBuffer(vadAnchors);
  await releasePipelineSegmentBuffer(alignedOut);
  await releasePipelineAudioBuffer(audio);
}
```

See [segmentation-engine.md](segmentation-engine.md) for segmentation behavior and [memory-and-models.md](memory-and-models.md) for OOM planning.

</details>

## FAQ

### What does OOM look like?

Native OOM is passed through as `OFFLINE_OOM`. The SDK does not add extra guardrail warnings or hidden fallback behavior.

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

