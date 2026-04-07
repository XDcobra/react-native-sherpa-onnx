# Offline Text-to-Speech (TTS)

On-device **batch** synthesis: full-buffer `generateSpeech`, optional subtitle timing on the same path, WAV save/share helpers, and standalone subtitle alignment from existing audio. The API is **instance-based** — create an engine with `createTTS()`, then call `destroy()` when done.

**For incremental chunks, PCM playback while generating, and `generateSpeechStream`:** see [Streaming TTS](tts-streaming.md).

**Import path:** `react-native-sherpa-onnx/tts`

## Models & paths

- **`ModelPathConfig`** (from `react-native-sherpa-onnx`): `{ type: 'asset' | 'file' | 'auto', path: string }` — directory that contains the TTS model files.
- **Downloaded models:** use the [Download Manager](download-manager.md) with **`ModelCategory.Tts`**. Valid **`modelId`** values and the GitHub release tag are listed in [Model ids](download-manager.md#model-ids) (`tts-models`).
- **`detectTtsModel()`** below validates layout and returns detected stacks without loading the engine.

## Quick Start

### 1) Batch: create engine, synthesize, destroy

```ts
import { createTTS, type GeneratedAudio } from 'react-native-sherpa-onnx/tts';

// createTTS --> Promise<TtsEngine>. Omit modelType for auto-detect (no modelOptions then).
const tts = await createTTS({
  modelPath: { type: 'asset', path: 'models/my-tts-model' },
  numThreads: 2,
});

// generateSpeech --> Promise<GeneratedAudio> — subtitles are forced off internally.
const audio: GeneratedAudio = await tts.generateSpeech('Hello, world.', {
  sid: 0,
  speed: 1.0,
});
console.log(audio.sampleRate, audio.samples.length);

await tts.destroy();
```

### 2) Batch with timestamps (`fast` or `accurate`)

```ts
import { createTTS, type GeneratedAudioWithTimestamps } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({
  modelPath: { type: 'file', path: '/path/to/model-dir' },
});

// Fast estimated timing (default subtitle mode).
const est: GeneratedAudioWithTimestamps = await tts.generateSpeechWithTimestamps(
  'Hello.',
  { subtitles: { mode: 'fast', granularity: 'sentence' } }
);
console.log(est.timingMode, est.subtitles.length);

// Accurate alignment requires a wav2vec2 ONNX path — see tts-alignment.md.
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

## Setup (iOS & Android)

| Topic | Requirement |
| --- | --- |
| Execution providers | Optional `provider` on init; check availability via root helpers (e.g. `getCoreMlSupport`) — [execution-providers.md](execution-providers.md) |
| Accurate subtitles | Alignment ONNX from `react-native-sherpa-onnx/alignment`; see [tts-alignment.md](tts-alignment.md) |
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
  modelType?: TTSModelType | string;
  lexiconLanguageCandidates?: string[];
}>;
```

File-based detection and validation without loading the engine; Kokoro/Kitten may return `lexiconLanguageCandidates` for language UI.

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

Synthesizes with subtitle metadata; `subtitles.mode` **`fast`** (estimated) or **`accurate`** (alignment ONNX required on `subtitles`).

```ts
const out = await tts.generateSpeechWithTimestamps('Test.', {
  subtitles: { mode: 'fast', granularity: 'word' },
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

**`saveAudio`** (below) takes `GeneratedAudio` and writes **WAV by default** or another format when FFmpeg is enabled (same format strings as [`convertAudioToFormat`](audio-conversion.md)). Additional file-related helpers ship under **`react-native-sherpa-onnx/files`**; see [Files (persistence & sharing)](files.md).

### File path vs `content://` directory URI

| Use | When |
| --- | --- |
| **Absolute file path** (`saveAudio` with `{ kind: 'file', path }`, or paths from your app cache/documents) | iOS and Android: you control the destination (app sandbox, temp files, RNFS paths). No user-picked folder. |
| **Directory `content://` URI** (`saveAudio` with `{ kind: 'androidContent', ... }`) | **Android:** user (or your app) granted access to a folder via SAF; you write **into** that tree. `androidContent` is rejected on iOS. |

Rule of thumb: need **Files** / **Downloads** / a user-chosen folder on Android → obtain a **tree** or document URI, then use **`saveAudio`** for PCM from TTS into that tree. Everything else (playback, file-based conversion, sharing from a temp file) → **normal path** first, then optionally copy or share.

### `saveAudio(audio, target, options?)`

```ts
function saveAudio(
  audio: GeneratedAudio,
  target: SaveAudioTarget,
  options?: SaveAudioOptions
): Promise<string>;
```

`SaveAudioTarget` is a discriminated union:

- `{ kind: 'file'; path: string }` — absolute path including filename and extension (should match `options.format`, e.g. `.mp3` when `format: 'mp3'`).
- `{ kind: 'androidContent'; directoryUri: string; filename: string }` — **Android only**; writes into a SAF directory.

`SaveAudioOptions`:

- `format` — default `'wav'`. Other values need native FFmpeg (see [disable-ffmpeg.md](disable-ffmpeg.md)).
- `outputSampleRateHz` — optional encoder hint; `0` uses native defaults. MP3/Opus allow only specific rates (see [audio-conversion.md](audio-conversion.md)).

Returns the absolute file path, or on Android SAF a `content://` URI string.

```ts
await saveAudio(audio, { kind: 'file', path: '/tmp/out.wav' });
await saveAudio(audio, { kind: 'file', path: '/tmp/out.mp3' }, { format: 'mp3' });
const uri = await saveAudio(
  audio,
  { kind: 'androidContent', directoryUri: dirUri, filename: 'speech.mp3' },
  { format: 'mp3' }
);
```

See also [TTS save example](audio-conversion.md#tts-save-example).

## Subtitles (standalone audio)

### `generateSubtitlesFromAudio(text, audioPathOrSamples, options)`

```ts
function generateSubtitlesFromAudio(
  text: string,
  audioPathOrSamples: string | { samples: number[]; sampleRate: number },
  options: SubtitleFromAudioOptions
): Promise<SubtitleResult>;
```

Builds subtitle timelines from transcript + existing audio (`fast` heuristic or `accurate` CTC alignment).

```ts
const r = await generateSubtitlesFromAudio('Hello world.', '/path/to/audio.wav', {
  mode: 'fast',
  granularity: 'sentence',
});
```

## Types

### Core

| Type | Notes |
| --- | --- |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly list of model type literals |
| `TtsEngine` | Batch engine interface |
| `StreamingTtsEngine` | Streaming engine interface |
| `GeneratedAudio` | `{ samples: number[]; sampleRate: number }` |
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
| `SubtitleMode` | `'off' \| 'fast' \| 'accurate'` |
| `SubtitleGranularity` | `'sentence' \| 'word' \| 'character'` (character only with accurate) |
| `SubtitleOptions` | `SubtitleOptionsFast` \| `SubtitleOptionsAccurate` |
| `SubtitleFromAudioOptions` | `mode: 'fast'` vs `mode: 'accurate'` + required `alignmentModelPath` when accurate |
| `SubtitleResult` | `{ subtitles: TtsSubtitleItem[]; timingMode: 'estimated' \| 'aligned' }` |

Breaking type history: [migration.md](migration.md) → **Text-to-Speech: strict types (0.4.0)** under the 0.4.0 section.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ALIGNMENT_MODEL_MISSING` | `accurate` without `alignmentModelPath` | Pass absolute path to wav2vec2 ONNX; see [tts-alignment.md](tts-alignment.md) |
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
- [tts-alignment.md](tts-alignment.md) — alignment models, accurate subtitles  
- [execution-providers.md](execution-providers.md) — ORT execution providers  
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)  
- [audio-conversion.md](audio-conversion.md) — WAV → MP3/FLAC for Android save flows  
- [migration.md](migration.md) — strict TTS TypeScript unions (0.4.0)
