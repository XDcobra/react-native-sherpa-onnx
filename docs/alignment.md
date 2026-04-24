# Alignment (buffer-first)

Alignment is offline and buffer-first:
- input transcript from `OfflineTextBuffer`
- input waveform from `OfflineAudioBuffer`
- output written into a caller-provided `OfflineSegmentBuffer` as `kind: 'alignment'`

**Import path:** `react-native-sherpa-onnx/alignment`

## Modes

| Mode | Needs | Segment payload `timingMode` |
| --- | --- | --- |
| `proportional` | text + audio duration | `proportional` |
| `estimated` | text + `segmentSampleCounts` | `estimated` |
| `accurate` | text + audio + wav2vec2 ONNX | `accurate` |
| `vad` | text + VAD `speech` anchors from `seg_off_*` | `vad` |

Granularity rules:
- `proportional` / `estimated`: `sentence` or `word`
- `accurate`: `sentence`, `word`, or `character`
- `vad`: `sentence` or `word` (`character` rejected)

## Quick start

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';
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

const textBuf = await createOfflineTextBufferFromText('Hello world.');
const audioBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});
const segmentOut = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: audioBuf,
});

try {
  const write = await alignTextToAudio(textBuf, audioBuf, segmentOut, {
    mode: 'proportional',
    granularity: 'sentence',
  });

  const segments = await getOfflineSegmentBufferSegments(segmentOut, 0, 256);
  const alignmentSegments = segments.filter((s) => s.kind === 'alignment');

  console.log(write.outputSegmentBufferId, write.segmentsWritten);
  console.log(alignmentSegments.map((s) => s.payload?.text));
} finally {
  await releasePipelineTextBuffer(textBuf).catch(() => {});
  await releasePipelineAudioBuffer(audioBuf).catch(() => {});
  await releasePipelineSegmentBuffer(segmentOut).catch(() => {});
}
```

## API reference

### `alignTextToAudio(textIn, audioIn, segmentOut, options)`

```ts
function alignTextToAudio(
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  segmentOut: OfflineSegmentBufferIdSource,
  options: AlignTextToAudioOptions
): Promise<{ outputSegmentBufferId: string; segmentsWritten: number }>;
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
  mode: 'proportional' | 'estimated' | 'aligned' | 'off',
  granularity: AlignmentGranularity
): void;
```

## Core types

| Type | Description |
| --- | --- |
| `AlignTextToAudioOptionsProportional` | `{ mode: 'proportional'; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsEstimated` | `{ mode: 'estimated'; chunks: AlignmentChunkTimeline; granularity?: 'sentence' \\| 'word'; language?: string }` |
| `AlignTextToAudioOptionsAccurate` | `{ mode: 'accurate'; alignmentModelPath: string; granularity?: 'sentence' \\| 'word' \\| 'character'; language?: string }` |
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
| `ALIGNMENT_MODEL_MISSING` | accurate mode without `alignmentModelPath` |
| `ALIGNMENT_CHUNKS_MISSING` | estimated mode without `segmentSampleCounts` |
| `ALIGNMENT_ERROR` | generic native alignment failure |
| `OFFLINE_OOM` | not enough memory for offline alignment |
