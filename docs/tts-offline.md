# Offline Text-to-Speech (TTS)

On-device **batch** synthesis: full-buffer `generateSpeech`, optional subtitle timing on the same path, WAV save/share helpers, and standalone subtitle alignment from existing audio. The API is **instance-based** — create an engine with `createTTS()`, then call `destroy()` when done.

**For incremental chunks, PCM playback while generating, and `generateSpeechStream`:** see [Streaming TTS](tts-streaming.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below scans the model directory and returns kinds **without** initializing the engine (see [Detection](#detection)).

## Quick Start

### 1) Batch: create engine, synthesize, destroy

```ts
import {
  createTTS,
  saveAudioFromGeneration,
  detectTtsModel,
  type GeneratedAudio,
} from 'react-native-sherpa-onnx/tts';

// Example folder: Piper VITS from the download manager (`vits-piper-en_US-lessac-medium` — see download-manager.md / Model ids).
const modelPath = { type: 'asset' as const, path: 'models/vits-piper-en_US-lessac-medium' };

// detectTtsModel does not load the TTS engine — it only inspects files. That keeps CPU/memory low and is ideal as a pre-check before createTTS. Use the returned modelType (and optional lexiconLanguageCandidates for Kokoro/Kitten) so you can pass matching modelOptions when creating the engine.
const det = await detectTtsModel(modelPath);
if (!det.success || det.modelType !== 'vits') {
  throw new Error(det.error ?? 'This example expects a VITS (e.g. Piper) model');
}

// createTTS --> Promise<TtsEngine>. Pass an explicit modelType (here from detection) if you need modelOptions for that engine.
// If you use modelType: 'auto' or omit modelType entirely, createTTS still auto-detects the stack on init, but modelOptions is not available in that mode.
const tts = await createTTS({
  modelPath,
  modelType: det.modelType,
  numThreads: 2,
  modelOptions: {
    vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 },
  },
});

// generateSpeech --> Promise<GeneratedAudio> — subtitles are forced off internally.
const audio: GeneratedAudio = await tts.generateSpeech('Hello, world.', {
  sid: 0,
  speed: 1.0,
});
console.log(audio.sampleRate, audio.numSamples);
const pcm = await audio.getSamples(); // Float32Array - only call if you really need samples

// saveAudioFromGeneration — `target.kind`: `'file'` = absolute filesystem path; `'androidContent'` = SAF directory URI + filename (Android only).
// If you omit `options` or do not pass `format`, output defaults to WAV (`'wav'`). Non-WAV (e.g. mp3) needs FFmpeg; see disable-ffmpeg.md.
const mp3Path = await saveAudioFromGeneration(
  audio,
  { kind: 'file', path: '/path/to/hello.mp3' },
  { format: 'mp3' }
);
console.log(mp3Path);

await tts.destroy();
```

### 2) Batch with timestamps (`proportional`, `estimated`, or `accurate`)

```ts
import {
  createTTS,
  detectTtsModel,
  type GeneratedAudioWithTimestamps,
} from 'react-native-sherpa-onnx/tts';

// e.g. `ensureModel` → extracted VITS Piper folder on disk (same id as in §1).
const modelPath = { type: 'file' as const, path: '/path/to/vits-piper-en_US-lessac-medium' };

const det = await detectTtsModel(modelPath);
if (!det.success || det.modelType !== 'vits') {
  throw new Error(det.error ?? 'This example expects a VITS (e.g. Piper) model');
}

const tts = await createTTS({
  modelPath,
  modelType: det.modelType,
  modelOptions: {
    vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 },
  },
});

// Proportional timing (default subtitle mode): duration × text weight in JS.
const est: GeneratedAudioWithTimestamps = await tts.generateSpeechWithTimestamps(
  'Hello.',
  { subtitles: { mode: 'proportional', granularity: 'sentence' } }
);
console.log(est.timingMode, est.subtitles.length);

// Accurate alignment requires a wav2vec2 ONNX path — see [alignment.md](alignment.md).
const aligned: GeneratedAudioWithTimestamps = await tts.generateSpeechWithTimestamps(
  'Hello.',
  {
    subtitles: {
      mode: 'accurate',
      alignmentModelPath: '/absolute/path/to/alignment.onnx',
      granularity: 'word',
    },
  }
);

await tts.destroy();
```

`modelType: 'auto'` (or omitted `modelType`) is still valid, but an explicit detected `modelType` is recommended when you need model-specific `modelOptions`.

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via root helpers (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Accurate subtitles | Alignment ONNX from `react-native-sherpa-onnx/alignment`; see [alignment.md](alignment.md) |
| Multi-instance | Each `createTTS` / `createStreamingTTS` gets a unique native `instanceId`; do not use an engine after `destroy()` |

## API Reference

Each entry below uses a one-line TypeScript signature (exported names match `react-native-sherpa-onnx/tts`). `ModelPathConfig` is imported from `react-native-sherpa-onnx` when you use the path-only `createTTS` shorthand.

## Detection

### `detectTtsModel(modelPath, options?)`

```ts
function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  error?: string;
  detectedModels: TtsDetectedModelEntry[];
  modelType?: TTSModelType;
  // only available for Kokoro/Kitten; otherwise empty
  lexiconLanguageCandidates?: string[];
  languages?: string[];
  quantization?: string;
  sizeTier?: string;
  /** When present, how native code chose the model kind (e.g. `fileListing` after a scan, `dirName` from the folder name, `fallbackOrder`, `explicitModelType`, or `nameOnly` for the empty-file-list test path). */
  detectionSources?: readonly TtsDetectionSource[];
}>;
```

File-based detection and validation **without** initializing the TTS engine: no native synthesizer is created, so this call is comparatively cheap and suitable as a **pre-check** before `createTTS` — for example to obtain a concrete `modelType` (and Kokoro/Kitten `lexiconLanguageCandidates`) so you can pass the right `modelOptions` on init.

**`detectionSources`** is an optional, ordered trace of mechanisms used (stable string literals; see `TtsDetectionSource` in `react-native-sherpa-onnx/tts`). The host-only **name-only** path (empty file list in C++ tests) never validates paths and is not used by production `detectTtsModel` after a real directory scan.

```ts
const result = await detectTtsModel({ type: 'asset', path: 'models/my-tts-model' });
if (!result.success) console.warn(result.error);
```

## Factories

### `createTTS(options)`

```ts
function createTTS(options: TTSInitializeOptions | ModelPathConfig): Promise<TtsEngine>;
```

Creates a **batch** TTS engine. You must call `tts.destroy()` when finished.

With **`modelType: 'auto'`** or **no `modelType`**, the native layer picks the stack on first init, but **`modelOptions` is not available** in that mode — pass a concrete `modelType` (e.g. from `detectTtsModel`) if you need engine-specific options.

```ts
const tts = await createTTS({
  modelPath: { type: 'asset', path: 'models/vits' },
  modelType: 'vits',
  modelOptions: { vits: { noiseScale: 0.667 } },
});
```

## Batch engine (`TtsEngine`)

### `tts.generateSpeech(text, options?)`

```ts
generateSpeech(text: string, options?: TtsGenerationOptions): Promise<GeneratedAudio>;
```

Synthesizes full utterance; **subtitle options are ignored** (forced `off` for native).

```ts
const audio = await tts.generateSpeech('Hi', { sid: 0, speed: 1.0 });
```

### `tts.generateSpeechWithTimestamps(text, options?)`

```ts
generateSpeechWithTimestamps(
  text: string,
  options?: TtsGenerationOptions
): Promise<GeneratedAudioWithTimestamps>;
```

Synthesizes with subtitle metadata; `subtitles.mode` **`proportional`**, **`estimated`** (synthesis chunk timeline), or **`accurate`** (alignment ONNX on `subtitles`).

```ts
const out = await tts.generateSpeechWithTimestamps('Test.', {
  subtitles: { mode: 'proportional', granularity: 'word' },
});
```

### `tts.updateParams(options)`

```ts
updateParams(options: TtsUpdateOptions): Promise<{
  success: boolean;
  detectedModels: TtsDetectedModelEntry[];
}>;
```

Updates noise/length scales for the loaded model type; use `{}` or `{ modelType: 'auto' }` for no-op style calls. When passing `modelOptions`, include a **concrete** `modelType` matching the block.

```ts
await tts.updateParams({
  modelType: 'vits',
  modelOptions: { vits: { noiseScale: 0.7 } },
});
```

### `tts.getModelInfo()`

```ts
getModelInfo(): Promise<TTSModelInfo>;
```

Returns `{ sampleRate, numSpeakers }`.

```ts
const info = await tts.getModelInfo();
```

### `tts.getSampleRate()`

```ts
getSampleRate(): Promise<number>;
```

```ts
const sr = await tts.getSampleRate();
```

### `tts.getNumSpeakers()`

```ts
getNumSpeakers(): Promise<number>;
```

```ts
const n = await tts.getNumSpeakers();
```

### `tts.destroy()`

```ts
destroy(): Promise<void>;
```

Releases native resources; the instance must not be used afterward.

```ts
await tts.destroy();
```

## Persistence & sharing

### `saveAudioFromGeneration(audio, target, options?)`

```ts
function saveAudioFromGeneration(
  audio: GeneratedAudio,
  target: SaveAudioTarget,
  options?: SaveAudioOptions
): Promise<string>;
```

Use this for `GeneratedAudio` from `generateSpeech(...)` / `generateSpeechWithTimestamps(...)`.
This is the preferred path because it writes from the native sink and avoids JS PCM round-trips.

```ts
await saveAudioFromGeneration(audio, { kind: 'file', path: '/tmp/out.wav' });
await saveAudioFromGeneration(audio, { kind: 'file', path: '/tmp/out.mp3' }, { format: 'mp3' });
const uri = await saveAudioFromGeneration(
  audio,
  { kind: 'androidContent', directoryUri: dirUri, filename: 'speech.mp3' },
  { format: 'mp3' }
);
```

### `saveAudioFromPCM(audio, target, options?)`

```ts
function saveAudioFromPCM(
  audio: { samples: number[] | Float32Array; sampleRate: number },
  target: SaveAudioTarget,
  options?: SaveAudioOptions
): Promise<string>;
```

Use this when you already have raw PCM samples in JS and want to save them.
This path is less preferred than `saveAudioFromGeneration` for TTS output, because PCM must exist in JS first.

```ts
await saveAudioFromPCM(
  { samples, sampleRate },
  { kind: 'file', path: '/tmp/out.wav' }
);
```

### File path vs `content://` directory URI

| Use | When |
| --- | --- |
| **Absolute file path** (`{ kind: 'file', path }`) | iOS and Android: app-controlled destination (sandbox, cache, documents). |
| **Directory `content://` URI** (`{ kind: 'androidContent', directoryUri, filename }`) | Android only: write into user-selected SAF directory. |

See also [TTS save example](audio-conversion.md#tts-save-example).

## Subtitles (standalone audio)

Use **`alignTextToAudio`** from **`react-native-sherpa-onnx/alignment`** (see [alignment.md](alignment.md)). Modes: `proportional`, `estimated` (requires `AlignmentChunkTimeline`), `accurate` (CTC).

## Types

### Core

| Type | Notes |
| --- | --- |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly list of model type literals |
| `TtsEngine` | Batch engine interface |
| `StreamingTtsEngine` | Streaming engine interface |
| `GeneratedAudio` | `{ sampleRate: number; numSamples: number; generation: number; getSamples(): Promise<Float32Array> }` |
| `GeneratedAudioWithTimestamps` | Extends `GeneratedAudio` with `subtitles`, `timingMode` |
| `TtsSubtitleItem` | `{ text, start, end }` (seconds) |
| `TTSModelInfo` | `{ sampleRate, numSpeakers }` |
| `TtsDetectedModelEntry` | `{ type: TTSModelType \| string; modelDir: string }` |
| `TtsStreamChunk` | Streaming chunk payload |
| `TtsStreamEnd` | `{ cancelled: boolean }` + optional ids |
| `TtsStreamError` | `{ message: string }` + optional ids |
| `TtsStreamHandlers` | `{ onChunk?, onEnd?, onError? }` |
| `TtsStreamController` | `cancel()`, `unsubscribe()` |
| `ModelPathConfig` | From `react-native-sherpa-onnx` |

### Init, update, generation

| Type | Notes |
| --- | --- |
| `TTSInitializeOptions` | Discriminated union: with `modelType` omitted/`'auto'`, **`modelOptions` is disallowed**; otherwise only the matching `modelOptions` key (`vits`, `matcha`, …) |
| `TTSInitializeOptionsBase` | Shared fields: `modelPath`, `provider?`, `numThreads?`, `debug?`, `ruleFsts?`, `ruleFars?`, `maxNumSentences?`, `silenceScale?` |
| `TtsUpdateOptions` | Union including `{}` and per-`modelType` variants (same coupling rules as init) |
| `TtsGenerationOptions` | Base fields + optional **`voiceClone`**: `{ kind: 'zipvoice', referenceAudio, referenceText }` or `{ kind: 'pocket', referenceAudio, referenceText? }` |
| `TtsReferenceAudio` | `{ samples: number[]; sampleRate: number }` |
| `TtsVoiceClone` / `TtsVoiceCloneZipvoice` / `TtsVoiceClonePocket` | Cloning discriminant types |
| `TtsExecutionProvider` | `'cpu' \| 'coreml' \| 'xnnpack' \| 'nnapi' \| 'qnn' \| (string & {})` |
| `TtsModelOptions` | Internal aggregate for native flattening; prefer init/update unions in app code |
| `TtsVitsModelOptions`, `TtsMatchaModelOptions`, … | Per-architecture scale options |

### Subtitles

| Type | Notes |
| --- | --- |
| `SubtitleMode` | `'off' \| 'proportional' \| 'estimated' \| 'accurate'` |
| `SubtitleGranularity` | `'sentence' \| 'word' \| 'character'` (character only with accurate) |
| `SubtitleOptions` | Proportional/estimated vs accurate (see TypeScript unions) |
| Alignment standalone | `alignTextToAudio`, types in `react-native-sherpa-onnx/alignment` |

Breaking type history: [migration.md](migration.md) → **Text-to-Speech: strict types (0.4.0)** under the 0.4.0 section.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ALIGNMENT_MODEL_MISSING` | `accurate` without `alignmentModelPath` | Pass absolute path to wav2vec2 ONNX; see [alignment.md](alignment.md) |
| `TTS_GENERATE_ERROR` / cloning | `voiceClone` on non–Zipvoice/Pocket model | Remove `voiceClone` or switch model |
| Zipvoice clone fails | Missing / empty `referenceText` | Use `voiceClone: { kind: 'zipvoice', referenceAudio, referenceText }` with non-empty text |
| Init throws with `modelOptions` | `modelType` is `'auto'` or omitted | Set explicit `modelType` before passing `modelOptions` |
| Methods throw after `destroy` | Engine already released | Create a new engine |
| Streaming error on Android + Zipvoice + ref audio | Unsupported combination | Use batch `generateSpeech` for Zipvoice cloning |
| Wrong or slow inference | Provider not built / unavailable | Check [execution-providers.md](execution-providers.md) and native logs |

## Mapping to Native API

If you call the **`NativeSherpaOnnx`** TurboModule directly instead of `createTTS()` / `createStreamingTTS()`, instance-bound TTS methods take **`instanceId`** as the first argument. Prefer the factory APIs in this document unless you manage native instances yourself.

## See also

- [tts-streaming.md](tts-streaming.md) — incremental synthesis, PCM player, `generateSpeechStream`  
- [alignment.md](alignment.md) — `alignTextToAudio`, modes, alignment models  
- [execution-providers.md](execution-providers.md) — ORT execution providers  
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)  
- [audio-conversion.md](audio-conversion.md) — WAV → MP3/FLAC for Android save flows  
- [migration.md](migration.md) — strict TTS TypeScript unions (0.4.0)
