# Alignment and subtitles (text + audio)

Use this module whenever you have **transcript text** and **audio** (file path, float PCM, or samples from TTS) and need **timed subtitle lines**.

**Import path:** `react-native-sherpa-onnx/alignment`

## Modes

| Mode | Needs | `timingMode` in result |
|------|--------|-------------------------|
| **proportional** | Audio length + text only | `proportional` |
| **estimated** | Same + [`AlignmentChunkTimeline`](#alignmentchunktimeline) (segment sample counts from TTS synthesis, or future STT) | `estimated` |
| **accurate** | Same + wav2vec2 ONNX path (`ModelCategory.Alignment`) | `aligned` |

Granularity is `sentence` or `word` for proportional / estimated; **character** is only valid for **accurate** (CTC).

## Quick Start

### 1) Proportional timing (no ONNX model)

Spreads the total audio duration across segments by **text weight** only — no wav2vec2 model and no native CTC. Good for previews when you only have WAV + transcript.

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';

// `audioPath`: absolute file path (WAV or other formats supported by the audio decoder; WAV can use a fast metrics path on native).
const r = await alignTextToAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'proportional',
  granularity: 'sentence', // or 'word'
});

console.log(r.timingMode); // 'proportional'
console.log(r.subtitles); // [{ text, start, end }, ...] in seconds
```

### 2) Accurate CTC (wav2vec2 ONNX)

Requires an alignment model (`ModelCategory.Alignment`). Resolve a path with **`detectAlignmentModel`** (inspect only) or **`ensureModel`** from [Download Manager](download-manager.md), then pass **`paths.model`** (or equivalent) as **`alignmentModelPath`**.

```ts
import { alignTextToAudio, detectAlignmentModel } from 'react-native-sherpa-onnx/alignment';
import type { ModelPathConfig } from 'react-native-sherpa-onnx';

// Example: folder containing the alignment pack (asset, file, or auto — same as elsewhere).
const modelPath: ModelPathConfig = {
  type: 'file',
  path: '/path/to/extracted-alignment-folder',
};

const det = await detectAlignmentModel(modelPath);
if (!det.success || !det.paths?.model) {
  throw new Error(det.error ?? 'Alignment model not found');
}

// Option 1: absolute file path (native reads the file)
const r = await alignTextToAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'accurate',
  alignmentModelPath: det.paths.model,
  granularity: 'word', // 'sentence' | 'word' | 'character' (character ⇒ accurate only)
});

// Option 2: mono float PCM — second argument `{ samples: number[], sampleRate: number }` instead of a path
// (e.g. `samples` / `sampleRate` from `generateSpeech` or your decoder)
const r2 = await alignTextToAudio('Hello world.', { samples: yourMonoSamples, sampleRate: yourSampleRate }, {
  mode: 'accurate',
  alignmentModelPath: det.paths.model,
  granularity: 'word', // 'sentence' | 'word' | 'character' (character ⇒ accurate only)
});

console.log(r.timingMode, r2.timingMode); // 'aligned', 'aligned'
```

### 3) Estimated timing (chunk timeline)

Use when you already know **how many samples** belong to each text segment (e.g. from **`generateSpeechWithTimestamps`** with `exportChunkTimelineOnly`). See [Offline TTS](tts-offline.md#2-batch-with-timestamps-proportional-estimated-or-accurate) and [`AlignmentChunkTimeline`](#alignmentchunktimeline) below.

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';

const r = await alignTextToAudio(longText, '/path/to/audio.wav', {
  mode: 'estimated',
  granularity: 'sentence',
  chunks: {
    sampleRate: 22050,
    segmentSampleCounts: [12000, 8000, 15000], // one count per segment; sum ≈ audio length in samples
  },
});
```

## API Reference

Each entry below uses a one-line TypeScript signature (exported names match `react-native-sherpa-onnx/alignment`). Import **`ModelPathConfig`** from `react-native-sherpa-onnx` when you pass a path config to **`detectAlignmentModel`**. Full walkthroughs: [Quick Start](#quick-start).

### `alignTextToAudio(text, audio, options)`

```ts
function alignTextToAudio(
  text: string,
  audio: string | { samples: number[]; sampleRate: number },
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

Builds subtitle cues from transcript + audio. **`options.mode`** picks **`proportional`**, **`estimated`**, or **`accurate`** (discriminated union — use **`AlignTextToAudioOptions`** for correct fields per mode).

```ts
const out = await alignTextToAudio('Hello.', '/path/a.wav', { mode: 'proportional', granularity: 'sentence' });
```

### `detectAlignmentModel(modelPath, options?)`

```ts
function detectAlignmentModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectResult>;
```

Inspects an alignment model directory **without** loading the CTC engine; use **`paths.model`** as **`alignmentModelPath`**. See [download-manager.md](download-manager.md) (`ModelCategory.Alignment`) and [§2 Accurate CTC](#2-accurate-ctc-wav2vec2-onnx).

```ts
const det = await detectAlignmentModel({ type: 'file', path: '/path/to/alignment-pack' });
```

### `AlignmentChunkTimeline`

```ts
interface AlignmentChunkTimeline {
  sampleRate: number;
  segmentSampleCounts: readonly number[];
}
```

Used with **`alignTextToAudio`** when **`options.mode === 'estimated'`**: one sample count per text segment after splitting with **`granularity`** (`sentence` or `word`). The sum of **`segmentSampleCounts`** should match the mono PCM length (small rounding differences are tolerated). Often filled from **`generateSpeechWithTimestamps`** with **`exportChunkTimelineOnly`** (see [Offline TTS](tts-offline.md)).

```ts
const chunks: AlignmentChunkTimeline = { sampleRate: 22050, segmentSampleCounts: [12000, 8000] };
```

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
