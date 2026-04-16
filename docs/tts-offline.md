# Offline Text-to-Speech (TTS)

On-device **batch** synthesis via a buffer-to-buffer pipeline: text goes in as an `OfflineTextBuffer`, audio comes out in an `OfflineAudioBuffer`. The engine is **instance-based** — create with `createTTS()`, call `destroy()` when done.

**For streaming synthesis with PCM playback:** see [tts-streaming.md](tts-streaming.md). **For incremental streaming sessions:** see [tts-streaming-incremental.md](tts-streaming-incremental.md).

**Import paths:**
```ts
import { createTTS, detectTtsModel, ... } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import { createEmptyOfflineAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
```

## Quick Start

All buffer parameters accept refs directly. Prefer refs over raw string ids. If you pass raw ids, malformed values are rejected early with `AUDIO_INVALID_ARGUMENT` or `TEXT_INVALID_ARGUMENT`.

### 1) Synthesize and save to WAV

```ts
import { createTTS, detectTtsModel } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const modelPath = { type: 'asset' as const, path: 'models/vits-piper-en_US-lessac-medium' };

// Detect without loading the engine — cheap pre-check that gives you `modelType` and model info.
const det = await detectTtsModel({ kind: 'app', base: 'files', path: 'models/vits-piper-en_US-lessac-medium' });
if (!det.success || det.modelType !== 'vits') throw new Error(det.error ?? 'Expected VITS model');

// Create engine. Explicit modelType required when you want modelOptions.
const tts = await createTTS({
  modelPath,
  modelType: 'vits',
  numThreads: 2,
  modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } },
});

// Step 1: get model sample rate (audioOut must match exactly)
const sr = await tts.getSampleRate(); // e.g. 22050

// Step 2: allocate buffers
const textBuf = await createOfflineTextBufferFromText('Hello, world.');
const audioBuf = await createEmptyOfflineAudioBuffer(sr); // empty output target

// Step 3: synthesize (buffer-to-buffer, no JS round-trip)
await tts.synthesize(textBuf, audioBuf, { sid: 0, speed: 1.0 });

// Step 4: inspect result
const info = await getPipelineAudioBufferInfo(audioBuf);
console.log(info.numSamples, info.sampleRate); // e.g. 44100, 22050

// Step 5: save to WAV
await saveAudioAsFile(audioBuf, { kind: 'fs', path: '/path/to/output.wav' }, 'wav');

// Step 6: release buffers (free native memory)
await releasePipelineTextBuffer(textBuf);
await releasePipelineAudioBuffer(audioBuf);

await tts.destroy();
```

### 2) Voice cloning (Zipvoice / Pocket)

```ts
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';

// Load reference audio into a buffer first
const refAudio = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/reference.wav',
});

const textBuf = await createOfflineTextBufferFromText('Clone this voice.');
const audioBuf = await createEmptyOfflineAudioBuffer(sr);

await tts.synthesize(textBuf, audioBuf, {
  voiceClone: {
    kind: 'zipvoice',
    referenceAudio: refAudio, // OfflineAudioBufferRef — not raw samples
    referenceText: 'Transcript of the reference recording.', // required for Zipvoice
  },
  // silenceScale and numSteps only apply when voiceClone is set
  silenceScale: 0.2,
  numSteps: 5,
});

await releasePipelineAudioBuffer(refAudio);
await releasePipelineTextBuffer(textBuf);
// keep audioBuf until you've saved/played it, then release
```

### 3) Multi-speaker model

```ts
// Get speaker count from model info
const { numSpeakers } = await tts.getModelInfo(); // e.g. { sampleRate: 22050, numSpeakers: 8 }

const textBuf = await createOfflineTextBufferFromText('Speaker two here.');
const audioBuf = await createEmptyOfflineAudioBuffer(22050);

await tts.synthesize(textBuf, audioBuf, { sid: 2, speed: 1.0 }); // sid 0..numSpeakers-1

await releasePipelineTextBuffer(textBuf);
// save / play audioBuf, then:
await releasePipelineAudioBuffer(audioBuf);
```

### 4) Buffer lifecycle & cleanup pattern

```ts
// Always release what you allocate.
// Best practice: try/finally to avoid leaks on error.

const textBuf = await createOfflineTextBufferFromText(inputText);
const audioBuf = await createEmptyOfflineAudioBuffer(modelSampleRate);
try {
  await tts.synthesize(textBuf, audioBuf);
  await saveAudioAsFile(audioBuf, { kind: 'fs', path: outputPath }, 'wav');
} finally {
  await releasePipelineTextBuffer(textBuf).catch(() => {});
  await releasePipelineAudioBuffer(audioBuf).catch(() => {});
}
```

## Setup

| Topic | Notes |
| --- | --- |
| `audioOut.sampleRate` | Must equal model output rate. Get it via `tts.getSampleRate()` before allocating. |
| Execution providers | Optional `provider` on init — see [execution-providers.md](execution-providers.md) |
| Multi-instance | Each `createTTS()` has a unique `instanceId`; do not use after `destroy()` |
| Voice cloning | Zipvoice and Pocket only; requires `OfflineAudioBuffer` as reference (not raw samples) |

## API Reference

### `detectTtsModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createTTS` to get `modelType` and init the right `modelOptions`.

For `FileSource` resolution problems, this promise can reject with `FILEIO_*` errors before native model detection runs.

```ts
function detectTtsModel(
  source: FileSource,
  options?: { modelType?: TTSModelType }
): Promise<TtsDetectModelResult>
```

```ts
const det = await detectTtsModel({ kind: 'fs', path: '/absolute/path/to/kokoro' });
// det.modelType       → e.g. 'kokoro'
// det.isStreaming     → true
// det.lexiconLanguageCandidates → ['us-en', 'gb-en', 'zh'] (Kokoro/Kitten only)
// det.languages       → [{ iso6391Hint: 'en', id: 'us-en' }, ...]
// det.quantization    → 'int8' | 'fp32' | ...
// det.sizeTier        → 'small' | 'medium' | 'large'
```

### `createTTS(options)`

```ts
function createTTS(options: TTSInitializeOptions | ModelPathConfig): Promise<TtsEngine>
```

```ts
// With explicit modelType (required for modelOptions):
const tts = await createTTS({
  modelPath: { type: 'file', path: '/models/vits-piper-en' },
  modelType: 'vits',
  numThreads: 2,
  modelOptions: { vits: { noiseScale: 0.667 } },
});

// With auto-detect (no modelOptions available):
const tts = await createTTS({ type: 'asset', path: 'models/vits-piper-en' });
```

### `tts.synthesize(textIn, audioOut, options?)`

Buffer-to-buffer synthesis. Reads text from `textIn`, writes PCM into the empty `audioOut`. The `audioOut` must be created with `createEmptyOfflineAudioBuffer(sampleRate)` where `sampleRate` exactly matches the model output rate.

```ts
synthesize(
  textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
  audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
  options?: TtsSynthesisOptions
): Promise<void>
```

```ts
await tts.synthesize(textBuf, audioBuf);                          // defaults
await tts.synthesize(textBuf, audioBuf, { sid: 1, speed: 0.9 }); // speaker + speed
```

### `tts.updateParams(options)`

Update noise/length scales without re-creating the engine. Pass `{}` for a no-op.

```ts
updateParams(options: TtsUpdateOptions): Promise<{ success: boolean; detectedModels: DetectedModelEntry[] }>
```

```ts
await tts.updateParams({ modelType: 'vits', modelOptions: { vits: { lengthScale: 1.2 } } });
```

### `tts.getModelInfo()`

```ts
getModelInfo(): Promise<TTSModelInfo>  // { sampleRate: number; numSpeakers: number }
```

```ts
const { sampleRate, numSpeakers } = await tts.getModelInfo();
```

### `tts.getSampleRate()` / `tts.getNumSpeakers()`

```ts
const sr = await tts.getSampleRate();    // e.g. 22050
const n  = await tts.getNumSpeakers();  // 0 or 1 = single-speaker
```

### `tts.destroy()`

```ts
await tts.destroy(); // frees native TTS engine; do not call any method after this
```

## Buffer helpers (audiobuffer / textbuffer)

These are imported from their own sub-paths, not from `react-native-sherpa-onnx/tts`.

### `createOfflineTextBufferFromText(text, options?)`

```ts
// react-native-sherpa-onnx/textbuffer
createOfflineTextBufferFromText(
  text: string,
  options?: { lang?: string; emotion?: string; event?: string }
): Promise<OfflineTextBufferRef>
```

```ts
const buf = await createOfflineTextBufferFromText('Hello.');
// buf.bufferId → 'txt_off_...'
// buf.info.utf16Length → character count
await releasePipelineTextBuffer(buf); // when done
```

### `createEmptyOfflineAudioBuffer(sampleRate)`

```ts
// react-native-sherpa-onnx/audiobuffer
createEmptyOfflineAudioBuffer(sampleRate: number, channelCount?: 1): Promise<OfflineAudioBufferRef>
```

```ts
const buf = await createEmptyOfflineAudioBuffer(22050);
// buf.info.numSamples === 0 — synthesis fills it exactly once
```

### Convert output buffer to file

Use audio save helpers from `react-native-sherpa-onnx/audio`:

```ts
import { saveAudioAsFile, saveAudioAsWav16k } from 'react-native-sherpa-onnx/audio';

await saveAudioAsFile(audioBuf, { kind: 'fs', path: `${DocumentDirectoryPath}/speech.wav` }, 'wav');
await saveAudioAsFile(
  audioBuf,
  { kind: 'fs', path: `${DocumentDirectoryPath}/speech.mp3` },
  'mp3',
  { outputSampleRateHz: 44100 }
);
await saveAudioAsWav16k(audioBuf, { kind: 'fs', path: `${DocumentDirectoryPath}/speech_16k.wav` });
```

### `createOfflineAudioBufferFromFile(source, options?)`

```ts
createOfflineAudioBufferFromFile(
  source: FileSource,
  options?: AudioDecodeOptions
): Promise<OfflineAudioBufferRef>
```

```ts
// Load reference audio for voice cloning
const refBuf = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/ref.wav',
});
await releasePipelineAudioBuffer(refBuf); // after synthesize
```

### `getPipelineAudioBufferInfo(bufferId)`

```ts
getPipelineAudioBufferInfo(bufferId: PipelineAudioBufferIdSource): Promise<PipelineAudioBufferInfo>
```

```ts
const info = await getPipelineAudioBufferInfo(audioBuf);
// info.numSamples, info.sampleRate, info.durationMs, info.channelCount
```

### `releasePipelineAudioBuffer(bufferId)` / `releasePipelineTextBuffer(bufferId)`

```ts
await releasePipelineAudioBuffer(audioBuf); // frees native audio buffer
await releasePipelineTextBuffer(textBuf);   // frees native text buffer
```

## Types

### Core TTS types (`react-native-sherpa-onnx/tts`)

| Type | Description |
| --- | --- |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly runtime list |
| `isTtsModelType` | Runtime guard |
| `TTSInitializeOptions` | Discriminated union: concrete `modelType` required for `modelOptions` |
| `TTSInitializeOptionsBase` | Shared fields: `modelPath`, `provider?`, `numThreads?`, `debug?`, `ruleFsts?`, `ruleFars?`, `maxNumSentences?`, `silenceScale?` |
| `TtsUpdateOptions` | Arg to `updateParams()` — same per-`modelType` coupling as init |
| `TtsSynthesisOptions` | `{ sid?, speed?, silenceScale?, numSteps?, extra?, voiceClone? }` — `silenceScale`/`numSteps` only apply when `voiceClone` is set |
| `TtsVoiceClone` | `TtsVoiceCloneZipvoice \| TtsVoiceClonePocket` |
| `TtsVoiceCloneZipvoice` | `{ kind: 'zipvoice'; referenceAudio: OfflineAudioBufferRef \| OfflineBufferHandle; referenceText: string }` |
| `TtsVoiceClonePocket` | `{ kind: 'pocket'; referenceAudio: OfflineAudioBufferRef \| OfflineBufferHandle; referenceText?: string }` |
| `TtsExecutionProvider` | `'cpu' \| 'coreml' \| 'xnnpack' \| 'nnapi' \| 'qnn' \| (string & {})` |
| `TtsModelOptions` | Aggregate for native flattening — prefer init/update unions in app code |
| `TtsVitsModelOptions` | `{ noiseScale?, noiseScaleW?, lengthScale? }` |
| `TtsMatchaModelOptions` | `{ noiseScale?, lengthScale? }` |
| `TtsKokoroModelOptions` / `TtsKittenModelOptions` | `{ lengthScale? }` |
| `TtsEngine` | `synthesize`, `updateParams`, `getModelInfo`, `getSampleRate`, `getNumSpeakers`, `destroy` |
| `TTSModelInfo` | `{ sampleRate: number; numSpeakers: number }` |
| `TtsDetectModelResult` | Return of `detectTtsModel()` |
| `DetectedModelEntry` | `{ type: string; modelDir: string }` |
| `DetectionSource` | Trace literals from native detection |
| `SubtitleMode` | `'off' \| 'proportional' \| 'estimated' \| 'accurate'` (streaming path only) |
| `SubtitleGranularity` | `'sentence' \| 'word' \| 'character'` (streaming path only) |
| `SaveAudioTarget` / `SaveAudioTargetFile` / `SaveAudioTargetAndroidContent` | File-path or Android SAF targets used by app-level persistence flows |

### Buffer types (`react-native-sherpa-onnx/audiobuffer` / `react-native-sherpa-onnx/textbuffer`)

| Type | Description |
| --- | --- |
| `OfflineAudioBufferRef` | `{ info: OfflineAudioBufferInfo; bufferId: OfflineBufferHandle }` |
| `OfflineAudioBufferInfo` | `{ bufferId, sampleRate, channelCount, numSamples, durationMs }` |
| `OfflineBufferHandle` | Branded string `off_*` |
| `OfflineTextBufferRef` | `{ info: OfflineTextBufferInfo; bufferId: OfflineTextBufferHandle }` |
| `OfflineTextBufferHandle` | Branded string `txt_off_*` |
| `PipelineAudioBufferInfo` | Union of offline + live info |

## Error code reference

| Code | Thrown by | Cause |
| --- | --- | --- |
| `TTS_TEXT_BUFFER_NOT_FOUND` | `synthesize` | `textInBufferId` not in registry — buffer was released or never created |
| `TTS_TEXT_BUFFER_KIND_MISMATCH` | `synthesize` | Buffer ID does not start with `txt_off_` — wrong buffer type passed |
| `TTS_TEXT_BUFFER_EMPTY` | `synthesize` | Text buffer has no text content |
| `TTS_AUDIO_OUT_NOT_FOUND` | `synthesize` | `audioOutBufferId` not in registry — released too early or never created |
| `TTS_AUDIO_OUT_KIND_MISMATCH` | `synthesize` | Buffer ID does not start with `off_` or is file-backed (must be in-memory) |
| `TTS_AUDIO_OUT_ALREADY_POPULATED` | `synthesize` | `audioOut` already has samples — create a new `createEmptyOfflineAudioBuffer` each call |
| `TTS_OUTPUT_SAMPLE_RATE_MISMATCH` | `synthesize` | `audioOut.sampleRate` ≠ model output rate — use `tts.getSampleRate()` to allocate |
| `TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND` | `synthesize` (voice clone) | `referenceAudioBufferId` not in registry — released before synthesis |
| `TTS_REFERENCE_AUDIO_BUFFER_KIND_MISMATCH` | `synthesize` (voice clone) | Reference buffer is not an offline audio buffer |
| `TTS_GENERATE_ERROR` | `synthesize` | Model-level synthesis failed, or voice clone on unsupported model type, or empty audio result |
| `OFFLINE_OOM` | `synthesize` | Not enough memory for offline synthesis. Prefer streaming TTS for large inputs. |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `TTS_OUTPUT_SAMPLE_RATE_MISMATCH` | Wrong sample rate on `createEmptyOfflineAudioBuffer` | Call `tts.getSampleRate()` first and pass that value |
| `TTS_AUDIO_OUT_ALREADY_POPULATED` | Reusing the same `audioBuf` for a second call | Create a fresh buffer per `synthesize` call |
| `TTS_TEXT_BUFFER_NOT_FOUND` | Buffer released before `synthesize` | Release **after** synthesis in a `finally` block |
| `TTS_GENERATE_ERROR` + Zipvoice | `referenceText` empty or missing | `voiceClone.referenceText` must be non-empty for Zipvoice |
| `TTS_GENERATE_ERROR` + cloning | Non-Zipvoice/Pocket model with `voiceClone` | Only Zipvoice and Pocket support voice cloning |
| Memory grows over time | Buffers not released | Always call `releasePipelineAudioBuffer` / `releasePipelineTextBuffer` after use |
| Init throws with `modelOptions` | `modelType: 'auto'` or omitted | Set explicit `modelType` before passing `modelOptions` |
| Methods throw after `destroy` | Engine already released | Create a new engine via `createTTS()` |

## See also

- [tts-streaming.md](tts-streaming.md) — incremental synthesis, PCM player, `generateSpeechStream`
- [alignment.md](alignment.md) — `alignTextToAudio`, subtitle timing, alignment models
- [execution-providers.md](execution-providers.md) — ORT execution providers
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)
- [model-languages.md](model-languages.md) — language hint helpers and `detectTtsModel(...).languages`
- [migration.md](migration.md) — breaking changes history

