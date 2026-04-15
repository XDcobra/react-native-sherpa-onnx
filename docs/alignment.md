# Alignment and subtitles (OfflineTextBuffer + OfflineAudioBuffer)

Use this module when you already have:
- transcript in an `OfflineTextBuffer`
- audio in an `OfflineAudioBuffer`

It returns subtitle timing items (`text`, `start`, `end`).

**Import path:** `react-native-sherpa-onnx/alignment`

## Modes

| Mode | Needs | `timingMode` in result |
| --- | --- | --- |
| `proportional` | text + audio duration | `proportional` |
| `estimated` | text + `segmentSampleCounts` timeline | `estimated` |
| `accurate` | text + audio + wav2vec2 ONNX | `aligned` |

Granularity rules:
- `proportional` / `estimated`: `sentence` or `word`
- `accurate`: `sentence`, `word`, or `character`

## Quick Start

All buffer parameters accept refs directly. Raw string ids are optional; malformed ids are rejected early with `TEXT_INVALID_ARGUMENT` or `AUDIO_INVALID_ARGUMENT`.

### 1) Proportional alignment (buffer-to-buffer)

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const textBuf = await createOfflineTextBufferFromText('Hello world.');
const audioBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});

try {
  const r = await alignTextToAudio(textBuf, audioBuf, {
    mode: 'proportional',
    granularity: 'sentence',
  });

  console.log(r.timingMode); // 'proportional'
  console.log(r.subtitles);  // [{ text, start, end }, ...]
} finally {
  await releasePipelineTextBuffer(textBuf).catch(() => {});
  await releasePipelineAudioBuffer(audioBuf).catch(() => {});
}
```

### 2) Accurate CTC (wav2vec2 ONNX)

```ts
import {
  alignTextToAudio,
  detectAlignmentModel,
} from 'react-native-sherpa-onnx/alignment';

const det = await detectAlignmentModel({
  kind: 'fs',
  path: '/path/to/alignment-pack',
});

if (!det.success || !det.paths?.model) {
  throw new Error(det.error ?? 'Alignment model not found');
}

// Uses native forced alignment over the offline audio buffer
const r = await alignTextToAudio(textBuf, audioBuf, {
  mode: 'accurate',
  alignmentModelPath: det.paths.model,
  granularity: 'word',
});
```

### 3) Estimated mode (external timeline)

Estimated mode does **not** derive `segmentSampleCounts` from the waveform alone: you pass **one integer sample count per subtitle segment** after the transcript is split with `granularity` (`sentence` or `word`). Typical sources are **offline STT** timelines (text buffer slices) or **TTS** synthesis metadata (per chunk / per segment sample spans at the engine sample rate). The same `alignTextToAudio` call works once you have that array; only the producer of the counts changes.

Below, **`segmentSampleCounts` comes from offline STT** after `transcribe` fills the text buffer. **TTS** is analogous: build the same array from your batch or streaming pipeline’s per-segment sample lengths (native timeline, summed chunk sizes, etc.) at the same `sampleRate` as `audioBuf`.

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferDurationsSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

const modelPath = { type: 'asset' as const, path: 'models/sherpa-onnx-whisper-tiny-en' };
const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

const stt = await createSTT({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
});

const audioBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});
const textBuf = await createEmptyOfflineTextBuffer();

try {
  await stt.transcribe(audioBuf, textBuf);

  const audioInfo = await getPipelineAudioBufferInfo(audioBuf);
  const ti = (await getPipelineTextBufferInfo(textBuf)) as OfflineTextBufferInfo;

  // STT: per-token durations (seconds in typical sherpa-onnx setups — confirm for your model).
  const dursSec = await getOfflineTextBufferDurationsSlice(textBuf, 0, ti.durationCount);
  // Map to sample counts at the *same* rate as the offline audio buffer.
  // For `granularity: 'word'`, counts must align with how the alignment engine splits words; if you have
  // sub-word tokens, merge durations per word boundary before building `segmentSampleCounts`.
  const segmentSampleCounts = dursSec.map((sec) =>
    Math.round(sec * audioInfo.sampleRate)
  );

  // Manual: when you already know segment lengths (e.g. from an editor), skip STT/TTS and pass literals:
  // const segmentSampleCounts = [12000, 9000, 8000];

  // TTS: same idea — fill `segmentSampleCounts` from your synthesis timeline (per meta segment / summed
  // chunk PCM lengths) at `audioInfo.sampleRate`; then call `alignTextToAudio` exactly as below.

  const r = await alignTextToAudio(textBuf, audioBuf, {
    mode: 'estimated',
    granularity: 'word',
    chunks: {
      sampleRate: audioInfo.sampleRate,
      segmentSampleCounts,
    },
  });

  console.log(r.timingMode, r.subtitles);
} finally {
  await releasePipelineTextBuffer(textBuf).catch(() => {});
  await releasePipelineAudioBuffer(audioBuf).catch(() => {});
  await stt.destroy();
}
```

### 4) TTS -> Alignment pipeline

**Offline STT** fits the same pattern: you already have an `OfflineAudioBuffer` (input) and an `OfflineTextBuffer` filled by `stt.transcribe(audio, textOut)` — call `alignTextToAudio(textOut, audio, options)` with the same modes as below. See [stt-offline.md](./stt-offline.md).

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';

const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const sr = await tts.getSampleRate();

const textBuf = await createOfflineTextBufferFromText('Hello world');
const audioBuf = await createEmptyOfflineAudioBuffer(sr);

try {
  await tts.synthesize(textBuf, audioBuf);
  const aligned = await alignTextToAudio(textBuf, audioBuf, {
    mode: 'proportional',
    granularity: 'sentence',
  });
  console.log(aligned.subtitles);
} finally {
  await releasePipelineTextBuffer(textBuf).catch(() => {});
  await releasePipelineAudioBuffer(audioBuf).catch(() => {});
  await tts.destroy();
}
```

## API reference

### Alignment

#### `alignTextToAudio(textIn, audioIn, options)`

```ts
function alignTextToAudio(
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

```ts
const result = await alignTextToAudio(textBuf, audioBuf, {
  mode: 'proportional',
  granularity: 'sentence',
});
```

### Detection

#### `detectAlignmentModel(source, options?)`

```ts
function detectAlignmentModel(
  source: FileSource,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectModelResult>;
```

The result includes `isStreaming: false` (alignment is always offline).

```ts
const det = await detectAlignmentModel({
  kind: 'fs',
  path: '/absolute/path/to/alignment-wav2vec2',
});
if (det.success) {
  console.log(det.modelType, det.isStreaming, det.paths?.model);
}
```

### Validation

#### `assertAlignmentGranularityForMode(mode, granularity)`

```ts
function assertAlignmentGranularityForMode(
  mode: 'proportional' | 'estimated' | 'aligned' | 'off',
  granularity: AlignmentGranularity
): void;
```

```ts
// throws if granularity='character' but mode is not aligned/accurate
assertAlignmentGranularityForMode('aligned', 'character');
```

## Pipeline buffers (audio + text)
See [audiobuffer — offline](audiobuffer-offline.md) and [overview](audiobuffer.md).
See [textbuffer.md](textbuffer.md).

## Types (core)

| Type | Description |
| --- | --- |
| `AlignTextToAudioOptionsProportional` | `{ mode: 'proportional'; granularity?: 'sentence' \| 'word'; language?: string }` |
| `AlignTextToAudioOptionsEstimated` | `{ mode: 'estimated'; chunks: AlignmentChunkTimeline; granularity?: 'sentence' \| 'word'; language?: string }` |
| `AlignTextToAudioOptionsAccurate` | `{ mode: 'accurate'; alignmentModelPath: string; granularity?: 'sentence' \| 'word' \| 'character'; language?: string }` |
| `AlignmentChunkTimeline` | `{ sampleRate: number; segmentSampleCounts: readonly number[] }` |
| `AlignTextToAudioResult` | `{ subtitles: SubtitleTimingItem[]; timingMode: 'proportional' \| 'estimated' \| 'aligned' }` |
| `OfflineTextBufferIdSource` | From `react-native-sherpa-onnx/textbuffer` |
| `OfflineAudioBufferIdSource` | From `react-native-sherpa-onnx/audiobuffer` |

## Error code quick table

| Code | Meaning |
| --- | --- |
| `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` | text buffer id not found |
| `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` | expected `txt_off_*`, got wrong buffer kind |
| `ALIGNMENT_TEXT_BUFFER_EMPTY` | text buffer empty or not populated |
| `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` | audio buffer id not found |
| `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` | expected `off_*`, got wrong buffer kind |
| `ALIGNMENT_AUDIO_BUFFER_EMPTY` | audio buffer has no samples |
| `ALIGNMENT_MODEL_MISSING` | accurate mode without `alignmentModelPath` |
| `ALIGNMENT_CHUNKS_MISSING` | estimated mode without `segmentSampleCounts` |
| `ALIGNMENT_ERROR` | generic native alignment failure |

## Notes

- Input API is now **buffer-only** (`OfflineTextBuffer` + `OfflineAudioBuffer`).
- `alignTextToTtsSink` is removed.
- Path/PCM overloads are removed.
