# TTS Subtitles and Timestamps

Subtitle generation was redesigned to provide consistent behavior across Android and iOS and to support both TTS generation and standalone audio subtitle estimation.

## Overview

You can generate subtitle/timestamp entries in two ways:

1. During TTS generation with tts.generateSpeechWithTimestamps().
2. From existing audio with generateSubtitlesFromAudio().

Both APIs return subtitle items in this shape:

```ts
{ text: string; start: number; end: number }
```

Times are in seconds.

## Subtitle Modes

SubtitleMode values:

- off: Disable subtitle generation.
- fast: Generate estimated subtitle timing.
- accurate: Reserved for future forced alignment (currently not implemented).

Timing result modes:

- off: No subtitle timing generated.
- estimated: Fast mode timing.
- aligned: Future accurate alignment mode.

## How Fast Mode Works

Fast mode uses native TTS callback chunking with max sentence chunks and maps chunk sample counts to sentence boundaries.

- Android: generateWithCallback / generateWithConfigAndCallback.
- iOS: generateStream callback variant.

This is deterministic and significantly better than naive equal splitting.

For word granularity, each sentence chunk is further distributed across words using text-length weighting.

## Accurate Mode

Accurate mode is currently a stub.

- tts.generateSpeechWithTimestamps(): rejects with TTS_SUBTITLE_ERROR.
- generateSubtitlesFromAudio(): rejects with an "not yet implemented" error.

This keeps the API stable so native forced-alignment can be added later without changing app-side contracts.

## API: generateSpeechWithTimestamps

```ts
const audio = await tts.generateSpeechWithTimestamps(text, {
  subtitles: {
    mode: 'fast',
    granularity: 'sentence', // or 'word'
  },
});
```

Returned fields:

- samples: number[]
- sampleRate: number
- subtitles: TtsSubtitleItem[]
- timingMode: 'off' | 'estimated' | 'aligned'

Default behavior:

- generateSpeechWithTimestamps() defaults to subtitles.mode = 'fast'.
- generateSpeech() forces subtitles.mode = 'off'.

## API: generateSubtitlesFromAudio

```ts
import { generateSubtitlesFromAudio } from 'react-native-sherpa-onnx/tts';

const result = await generateSubtitlesFromAudio(
  text,
  '/absolute/path/audio.wav',
  {
    mode: 'fast',
    granularity: 'sentence',
  }
);
```

Supported input types:

- File path string.
- In-memory samples object: { samples: number[]; sampleRate: number }.

Standalone fast mode estimates timings from total audio duration and text weighting.

## Platform Consistency

- Android and iOS now share the same subtitle mode semantics.
- Both return timingMode with the same semantics.
- Text segmentation rules are aligned for sentence-level subtitle generation.

## Examples

Sentence subtitles:

```ts
const audio = await tts.generateSpeechWithTimestamps('Hello world. How are you?', {
  subtitles: { mode: 'fast', granularity: 'sentence' },
});
```

Word subtitles:

```ts
const audio = await tts.generateSpeechWithTimestamps('Hello world', {
  subtitles: { mode: 'fast', granularity: 'word' },
});
```

Standalone estimation:

```ts
const subtitleResult = await generateSubtitlesFromAudio(
  transcript,
  { samples, sampleRate },
  { mode: 'fast', granularity: 'sentence' }
);
```
