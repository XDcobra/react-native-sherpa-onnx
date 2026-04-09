# Alignment and subtitles (text + audio)

Use this module whenever you have **transcript text** and **audio** and need **timed subtitle lines**.

**Import path:** `react-native-sherpa-onnx/alignment`

## Modes

| Mode | Needs | `timingMode` in result |
|------|--------|-------------------------|
| **proportional** | Audio duration + text only | `proportional` |
| **estimated** | Audio + `segmentSampleCounts` timeline | `estimated` |
| **accurate** | Audio + wav2vec2 ONNX (`alignmentModelPath`) | `aligned` |

Granularity:
- `proportional` / `estimated`: `sentence` or `word`
- `accurate`: `sentence`, `word`, or `character`

## Quick Start

### 1) Proportional timing

```ts
import { alignTextToAudio } from 'react-native-sherpa-onnx/alignment';

const r = await alignTextToAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'proportional',
  granularity: 'sentence',
});

console.log(r.timingMode); // 'proportional'
console.log(r.subtitles);  // [{ text, start, end }, ...]
```

### 2) Accurate CTC (wav2vec2 ONNX)

```ts
import { alignTextToAudio, detectAlignmentModel } from 'react-native-sherpa-onnx/alignment';

const det = await detectAlignmentModel({
  type: 'file',
  path: '/path/to/alignment-pack',
});

if (!det.success || !det.paths?.model) {
  throw new Error(det.error ?? 'Alignment model not found');
}

// Path input
const r1 = await alignTextToAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'accurate',
  alignmentModelPath: det.paths.model,
  granularity: 'word',
});

// In-memory PCM input (Float32Array)
const r2 = await alignTextToAudio(
  'Hello world.',
  { samples: yourMonoSamplesFloat32, sampleRate: yourSampleRate },
  {
    mode: 'accurate',
    alignmentModelPath: det.paths.model,
    granularity: 'character',
  }
);
```

### 3) TTS sink integration (no PCM JS round-trip)

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import { alignTextToTtsSink } from 'react-native-sherpa-onnx/alignment';

const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await tts.generateSpeech('Hello world');

const aligned = await alignTextToTtsSink('Hello world', audio, {
  mode: 'proportional',
  granularity: 'sentence',
});

await tts.destroy();
```

Use this especially for `accurate` mode after TTS generation to avoid pulling full PCM into JS and pushing it back to native.

## API Reference

### `alignTextToAudio(text, audio, options)`

```ts
function alignTextToAudio(
  text: string,
  audio: string | { samples: Float32Array; sampleRate: number },
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

Native-first implementation for all modes.

### `alignTextToTtsSink(text, generatedAudio, options)`

```ts
function alignTextToTtsSink(
  text: string,
  generatedAudio: GeneratedAudio,
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

Align directly from the native TTS sink (best path for TTS-generated audio).

### `detectAlignmentModel(modelPath, options?)`

```ts
function detectAlignmentModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectModelResult>;
```

Inspects model folders and returns detection metadata following the unified detect shape:

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether at least one model was detected |
| `error` | `string?` | Error message on failure |
| `detectedModels` | `DetectedModelEntry[]?` | All candidate models found |
| `modelType` | `string?` | Resolved model type (e.g. `wav2vec2ctc`) |
| `paths` | `object?` | Resolved `model` path for `alignmentModelPath` |
| `languages` | `string[]?` | ISO 639-1 language codes derived from model ID |
| `quantization` | `string?` | Quantization level (e.g. `int8`) |
| `detectionSources` | `DetectionSource[]?` | How detection was performed (`fileListing`, `nameOnly`, …) |

## Notes

- `alignTextToAudio` now expects **`Float32Array`** for in-memory PCM.
- `getAudioDuration` is the only native duration/metrics method.
- Legacy low-level native methods (`alignAccurateFromPath`, `alignAccurateFromFloat32`) and the compatibility alias `getAlignmentAudioMetrics` were removed. Use `alignTextToAudio` / `alignTextToTtsSink` and the native-first TurboModule methods instead.

## STT status

A dedicated STT-to-alignment helper is still not shipped. The estimated mode already supports generic `segmentSampleCounts` timelines, so STT integration can map token timestamps to that shape in a future helper.
