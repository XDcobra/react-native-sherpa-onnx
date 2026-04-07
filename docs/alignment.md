# Alignment and subtitles (text + audio)

Public API: `react-native-sherpa-onnx/alignment`.

Use this module whenever you have **transcript text** and **audio** (file path, float PCM, or samples from TTS) and need **timed subtitle lines**.

## Modes

| Mode | Needs | `timingMode` in result |
|------|--------|-------------------------|
| **proportional** | Audio length + text only | `proportional` |
| **estimated** | Same + [`AlignmentChunkTimeline`](#alignmentchunktimeline) (segment sample counts from TTS synthesis, or future STT) | `estimated` |
| **accurate** | Same + wav2vec2 ONNX path (`ModelCategory.Alignment`) | `aligned` |

Granularity is `sentence` or `word` for proportional / estimated; **character** is only valid for **accurate** (CTC).

## API

### `alignTextToAudio(text, audio, options)`

```ts
import {
  alignTextToAudio,
  type AlignTextToAudioOptions,
} from 'react-native-sherpa-onnx/alignment';

// Proportional (file path or { samples, sampleRate })
const r = await alignTextToAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'proportional',
  granularity: 'sentence',
});

// Accurate (absolute path to ONNX from detectAlignmentModel)
const r2 = await alignTextToAudio('Hello.', audioPath, {
  mode: 'accurate',
  alignmentModelPath: '/path/to/model.onnx',
  granularity: 'word',
});
```

### `detectAlignmentModel`

Same as before: resolve a downloaded alignment pack and read `paths.model` for `alignmentModelPath`. See [download-manager.md](download-manager.md) (`ModelCategory.Alignment`).

### `AlignmentChunkTimeline`

Engine-agnostic structure for **estimated** mode:

- `sampleRate`: Hz of the mono PCM timeline.
- `segmentSampleCounts`: one non-negative integer per text segment after splitting `text` with the chosen `granularity` (`sentence` or `word`). The sum should match the audio length in samples (small rounding differences are tolerated).

TTS supplies this via native synthesis when using `createTTS().generateSpeechWithTimestamps` with `subtitles: { mode: 'estimated', ... }` (see [Offline TTS](tts-offline.md)).

## TTS integration

`generateSpeechWithTimestamps` delegates to `alignTextToAudio` for all non-`off` modes:

- `proportional`: one `generateTts` pass, then proportional alignment in JS.
- `estimated`: `generateTtsWithTimestamps` with `exportChunkTimelineOnly` to obtain `segmentSampleCounts`, then estimated alignment in JS.
- `accurate`: `generateTts` then native CTC alignment on the **in-memory** PCM buffer (no temp WAV).

### Native TurboModule (direct callers)

If you bypass `alignTextToAudio` and call **`NativeSherpaOnnx`**:

| Method | Purpose |
|--------|---------|
| **`alignAccurateFromPath`** | wav2vec2 CTC; `audioPath` is read natively |
| **`alignAccurateFromFloat32`** | Same, with `{ samples, sampleRate }` already in JS (no disk round-trip) |
| **`getAlignmentAudioMetrics`** | Fast **16-bit mono PCM WAV** `sampleRate` + `totalSamples` without decoding floats; other formats: decode first or use proportional with full decode |

Implementation detail (native maintainers): accurate CTC is one shared C++ core on Android and iOS; see [internal/ctc-alignment-core.md](internal/ctc-alignment-core.md).

The old **`runCTCForcedAlignment`** entry point was removed in favor of the above.

## Appendix: STT → `AlignmentChunkTimeline` (future)

Offline STT (`transcribeFile`) returns `tokens`, `timestamps`, and `durations` (seconds). A dedicated helper is **not** shipped yet; the intended mapping for `mode: 'estimated'` when the transcript matches the audio is:

1. Choose `granularity` (`sentence` or `word`) and split the aligned text the same way as `alignTextToAudio` (sentence/word segmenters must stay consistent).
2. For each segment, sum the **durations** of the tokens that belong to that segment (or derive end−start from `timestamps`), then convert to samples: `Math.round(durationSeconds * sampleRate)`.
3. Build `{ sampleRate, segmentSampleCounts }` where `segmentSampleCounts[i]` is the sample length for segment `i`. The sum should match the decoded mono PCM length (within rounding).

Until that helper exists, use **proportional** or **accurate** for arbitrary WAV + text, or supply chunk metadata from **TTS** synthesis as documented above.

## Migration from older API

- Standalone helper **`generateSubtitlesFromAudio`** was removed; use **`alignTextToAudio`**.
- Subtitle mode **`fast`** was renamed to **`proportional`**.
- Result **`timingMode: 'estimated'`** for the old standalone “fast” path is now **`proportional`** when using duration weighting only; chunk-based estimation uses **`estimated`**.

See [CHANGELOG.md](../CHANGELOG.md) for the major release notes.
