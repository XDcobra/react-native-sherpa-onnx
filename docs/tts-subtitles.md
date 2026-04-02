# TTS Subtitles and Timestamps

Subtitle generation supports two timing strategies and two entry points:

1. During TTS generation with `tts.generateSpeechWithTimestamps()`.
2. From an existing audio file/samples with `generateSubtitlesFromAudio()`.

Each subtitle item has this shape:

```ts
{ text: string; start: number; end: number }
```

Times are in seconds.

## Overview

Subtitle modes:

- `off`: No subtitles.
- `fast`: Estimated timing.
- `accurate`: wav2vec2 CTC forced alignment.

Timing result modes:

- `off`: No subtitle timing generated.
- `estimated`: Fast mode timing.
- `aligned`: Accurate mode alignment.

Granularity:

- `sentence`
- `word`
- `character` (only with `mode: 'accurate'`)

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

1. Ensure the alignment model is available locally.
2. Generate audio (or use existing audio input).
3. Run native CTC alignment via `runCTCForcedAlignment`.
4. Return aligned word/char timestamps.
5. Map timestamps to requested granularity.

The default alignment model target is:

`https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX/resolve/main/onnx/model_int8.onnx`

Stored path:

`DocumentDirectoryPath/sherpa-onnx/alignment/model.onnx`

## API: generateSpeechWithTimestamps

```ts
const audio = await tts.generateSpeechWithTimestamps(text, {
  subtitles: {
    mode: 'accurate',
    granularity: 'character',
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

## API: generateSubtitlesFromAudio

```ts
import { generateSubtitlesFromAudio } from 'react-native-sherpa-onnx/tts';

const result = await generateSubtitlesFromAudio(
  text,
  '/absolute/path/audio.wav',
  {
    mode: 'accurate',
    granularity: 'character',
  }
);
```

Supported input types:

- File path string.
- In-memory samples object: { samples: number[]; sampleRate: number }.

## API: Alignment Model Management

```ts
import {
  downloadAlignmentModel,
  isAlignmentModelReady,
  getAlignmentModelPath,
  deleteAlignmentModel,
} from 'react-native-sherpa-onnx/alignment';

await downloadAlignmentModel({
  onProgress: ({ bytesWritten, contentLength }) => {
    // update progress UI
  },
});

const ready = await isAlignmentModelReady();
const path = await getAlignmentModelPath();

await deleteAlignmentModel();
```

You can override the default URL:

```ts
await downloadAlignmentModel({
  url: 'https://your-host/path/to/model.onnx',
});
```

## Errors

- `ALIGNMENT_MODEL_MISSING`: Accurate mode requested without a downloaded/provided model.
- `ALIGNMENT_ERROR`: Native alignment failed (bad model/audio format/runtime failure).
- `Character granularity is only supported when subtitles.mode is 'accurate'.`: thrown when `granularity: 'character'` is used with `mode: 'fast'` or `mode: 'off'`.

## Platform Notes

- Android and iOS share the same mode semantics and return `timingMode` consistently.
- Accurate mode is compute-intensive and best for short-to-medium clips.
- For best alignment quality, use WAV mono 16 kHz.

## Examples

Fast sentence subtitles during TTS:

```ts
const audio = await tts.generateSpeechWithTimestamps(
  'Hello world. How are you?',
  {
    subtitles: { mode: 'fast', granularity: 'sentence' },
  }
);
```

Accurate character subtitles from existing audio:

```ts
const subtitleResult = await generateSubtitlesFromAudio(
  transcript,
  '/absolute/path/to/audio.wav',
  { mode: 'accurate', granularity: 'character' }
);
```

Accurate subtitles while generating TTS:

```ts
const aligned = await tts.generateSpeechWithTimestamps(transcript, {
  subtitles: { mode: 'accurate', granularity: 'sentence' },
});
```
