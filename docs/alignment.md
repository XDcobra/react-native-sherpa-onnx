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
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { createStreamingVAD } from 'react-native-sherpa-onnx/vad';

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
  modelPath: { type: 'file', path: '/abs/path/to/model.onnx' },
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
// 1) VAD standalone: create speech anchors in an offline segment buffer.
const vadSegmentOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: audioBuf,
});

const vad = await createStreamingVAD({
  modelPath: { type: 'file', path: '/abs/path/to/vad/model' },
  modelType: 'auto',
  sampleRate: 16000,
});
await vad.process({
  audioIn: audioBuf,
  segmentOut: vadSegmentOut, // VAD writes speech-anchor segments into this offline segment buffer
  options: { chunkSize: 512 },
});

// 2) Alignment asrMediated: caller provides anchors + hypothesis buffer with timestamps.
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelPath: { type: 'file', path: '/abs/path/to/model.onnx' },
  segmentation: {
    mode: 'auto',
    anchorSegmentBuffer: vadSegmentOut,
    mappingStrategy: 'asr_mediated',
    asr: {
      hypothesisTextBuffer: asrHypothesisOut,
    },
  },
});
```

### `accurate + auto` chunkedForcedCtc (`chunked_forced_ctc`)

```ts
const write = await engine.alignTextToAudio(textBuf, audioBuf, segmentOut, {
  mode: 'accurate',
  granularity: 'word',
  modelPath: { type: 'file', path: '/abs/path/to/model.onnx' },
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

## Core types

| Type | Description |
| --- | --- |
| `AlignTextToAudioOptionsProportional` | `{ mode: 'proportional'; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsEstimated` | `{ mode: 'estimated'; chunks: AlignmentChunkTimeline; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsAccurate` | `{ mode: 'accurate'; modelPath: ModelPathConfig; granularity?: 'sentence' \\| 'word' \\| 'character'; language?: string; segmentation?: { mode: 'auto'; anchorSegmentBuffer: OfflineSegmentBufferIdSource; mappingStrategy: 'asr_mediated' \\| 'chunked_forced_ctc'; asr?: { hypothesisTextBuffer: OfflineTextBufferIdSource } } }` |
| `AlignTextToAudioOptionsVad` | `{ mode: 'vad'; granularity?: 'sentence' \\| 'word'; segmentation: { source: 'vad'; segmentBuffer: OfflineSegmentBufferIdSource } }` |
| `AlignTextToAudioWriteResult` | `{ outputSegmentBufferId: string; segmentsWritten: number }` |
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
| `ALIGNMENT_MODEL_MISSING` | accurate mode without `modelPath` |
| `ALIGNMENT_CHUNKS_MISSING` | estimated mode without `segmentSampleCounts` |
| `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` | ASR-mediated strategy requires timestamped hypothesis tokens |
| `ALIGNMENT_LINKER_NO_MAPPING` | `asrMediated` linker produced no usable mapping units |
| `ALIGNMENT_FORCED_CTC_STUCK` | `chunkedForcedCtc` had no progress on two consecutive anchors |
| `ALIGNMENT_NATIVE_UNKNOWN` | native bridge returned unknown error shape |
| `OFFLINE_OOM` | not enough memory for offline alignment |

## FAQ

### What does OOM look like?

Native OOM is passed through as `OFFLINE_OOM`. The SDK does not add extra guardrail warnings or hidden fallback behavior.
