# TTS Alignment and Timestamps

Alignment timestamp generation supports two timing strategies and two entry points:

1. During TTS generation with `tts.generateSpeechWithTimestamps()`.
2. From an existing audio file/samples with `generateSubtitlesFromAudio()`.

Current API names still use `subtitles` terminology for compatibility.

Each alignment item (`TtsSubtitleItem`) has this shape:

```ts
{ text: string; start: number; end: number }
```

Times are in seconds.

## Overview

Alignment modes (configured via `subtitles.mode`):

- `off`: No alignment timestamps.
- `fast`: Estimated timing.
- `accurate`: wav2vec2 CTC forced alignment.

Timing result values (`timingMode`):

- `off`: No timing generated.
- `estimated`: Fast mode timing.
- `aligned`: Accurate mode alignment.

Granularity:

- `sentence`
- `word`
- `character` (only with `mode: 'accurate'`)

Model handling now follows the same pattern as STT:

- Download alignment models via `ModelCategory.Alignment` in the Download API/screen.
- Select a model in your UI.
- Resolve and validate it via `detectAlignmentModel(...)`.
- Pass the detected `.onnx` path to `alignmentModelPath` in accurate mode.

## How Fast Mode Works

Fast mode uses native TTS callback chunking and maps chunk sample counts to sentence boundaries.

- Android: `generateWithCallback` / `generateWithConfigAndCallback`
- iOS: `generateStream` callback variant

For word granularity, sentence chunks are distributed across words by text-weight.

`character` granularity is not supported in fast mode and throws a validation error.

Standalone fast mode (`generateSubtitlesFromAudio`) estimates timings from total audio duration and text-weighting.

## How Accurate Mode Works

Accurate mode uses wav2vec2 CTC forced alignment (`onnx-community/wav2vec2-base-960h-ONNX`) against a transcript.

Flow:

1. Ensure an alignment model from `ModelCategory.Alignment` is downloaded.
2. Resolve and validate the model with `detectAlignmentModel(...)`.
3. Get `paths.model` from detection result.
4. Generate audio (or use existing audio input).
5. Run native CTC alignment via `runCTCForcedAlignment`.
6. Return aligned word/char timestamps.
7. Map timestamps to requested granularity.

## API: generateSpeechWithTimestamps

```ts
const audio = await tts.generateSpeechWithTimestamps(text, {
  subtitles: {
    mode: 'accurate',
    granularity: 'character',
    alignmentModelPath: '/absolute/path/to/model.onnx',
  },
});
```

Returned fields:

- samples: number[]
- sampleRate: number
- subtitles: TtsSubtitleItem[]
- timingMode: 'off' | 'estimated' | 'aligned'

Default behavior:

- `generateSpeechWithTimestamps()` defaults to `subtitles.mode = 'fast'`.
- `generateSpeech()` forces `subtitles.mode = 'off'`.
- `mode: 'accurate'` requires `subtitles.alignmentModelPath`.

## API: generateSubtitlesFromAudio

```ts
import { generateSubtitlesFromAudio } from 'react-native-sherpa-onnx/tts';

const result = await generateSubtitlesFromAudio(
  text,
  '/absolute/path/audio.wav',
  {
    mode: 'accurate',
    granularity: 'character',
    alignmentModelPath: '/absolute/path/to/model.onnx',
  }
);
```

Supported input types:

- File path string.
- In-memory samples object: { samples: number[]; sampleRate: number }.

## API: Alignment Model Selection

```ts
import {
  ModelCategory,
  getLocalModelPathByCategory,
  listDownloadedModelsByCategory,
  type ModelMetaBase,
} from 'react-native-sherpa-onnx/download';
import { detectAlignmentModel } from 'react-native-sherpa-onnx/alignment';

const alignmentModels =
  await listDownloadedModelsByCategory<ModelMetaBase>(
    ModelCategory.Alignment
  );

const selectedModelId = alignmentModels[0]?.id;
if (!selectedModelId) {
  throw new Error('No alignment model downloaded');
}

const selectedModelDir = await getLocalModelPathByCategory(
  ModelCategory.Alignment,
  selectedModelId
);

if (!selectedModelDir) {
  throw new Error('Selected alignment model directory is missing');
}

const detected = await detectAlignmentModel({
  type: 'file',
  path: selectedModelDir,
});

const alignmentModelPath = detected.paths?.model;
if (!detected.success || !alignmentModelPath) {
  throw new Error(detected.error || 'Failed to detect alignment model');
}

const aligned = await generateSubtitlesFromAudio(
  transcript,
  '/absolute/path/to/audio.wav',
  {
    mode: 'accurate',
    granularity: 'word',
    alignmentModelPath,
  }
);
```

There is no alignment-specific download helper in `react-native-sherpa-onnx/alignment`.
Use the generic Download API (`ModelCategory.Alignment`) exactly like other model categories.

## Errors

- `ALIGNMENT_MODEL_MISSING`: Accurate mode requested without `alignmentModelPath`.
- `ALIGNMENT_ERROR`: Native alignment failed (bad model/audio format/runtime failure).
- `Character granularity is only supported when subtitles.mode is 'accurate'.`: thrown when `granularity: 'character'` is used with `mode: 'fast'` or `mode: 'off'`.

## Platform Notes

- Android and iOS share the same mode semantics and return `timingMode` consistently.
- Accurate mode is compute-intensive and best for short-to-medium clips.
- For best alignment quality, use WAV mono 16 kHz.

## Examples

Fast sentence timestamps during TTS:

```ts
const audio = await tts.generateSpeechWithTimestamps(
  'Hello world. How are you?',
  {
    subtitles: { mode: 'fast', granularity: 'sentence' },
  }
);
```

Accurate character alignment from existing audio:

```ts
const subtitleResult = await generateSubtitlesFromAudio(
  transcript,
  '/absolute/path/to/audio.wav',
  {
    mode: 'accurate',
    granularity: 'character',
    alignmentModelPath: '/absolute/path/to/model.onnx',
  }
);
```

Accurate alignment while generating TTS:

```ts
const aligned = await tts.generateSpeechWithTimestamps(transcript, {
  subtitles: {
    mode: 'accurate',
    granularity: 'sentence',
    alignmentModelPath: '/absolute/path/to/model.onnx',
  },
});
```
