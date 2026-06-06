# Offline Text-to-Speech (TTS)

## Introduction

On-device **batch** synthesis with a **pipeline-first** API.

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`OfflineTextBuffer`](textbuffer-offline.md) | Populated text buffer |
| **Output** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Empty buffer at model sample rate; synthesis fills it once |
| **Engine** | `TtsEngine` via `createTTS` | Instance-based — call `destroy()` when done |

For live synthesis with PCM playback, see [Live overload](#live-overload-on-offline-tts-offline-weights-live-consumption) below.

**Import paths:**
```ts
import { createTTS, detectTtsModel, ... } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import { createEmptyOfflineAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
```

## Quick start

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

const modelPath = { kind: 'app', base: 'apkAsset', path: 'models/vits-piper-en_US-lessac-medium' };

// Detect without loading the engine — cheap pre-check that gives you `modelType` and model info.
const det = await detectTtsModel({ kind: 'app', base: 'apkAsset', path: 'models/vits-piper-en_US-lessac-medium' });
if (!det.success || det.modelType !== 'vits') throw new Error(det.error ?? 'Expected VITS model');

// Create engine. Explicit modelType required when you want modelOptions.
const tts = await createTTS({
  modelSource: modelPath,
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

## API reference

### `detectTtsModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createTTS` to get `modelType` and init the right `modelOptions`. Unified cross-feature detection: [model-detect.md](model-detect.md).

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
// det.paths           → { ttsModel, tokens, dataDir, voices, ... } on folder scans
// det.lexiconLanguages → [{ id: 'us-en', path: '.../lexicon-us-en.txt' }, ...] (vits/matcha/kokoro/zipvoice)
// det.languages       → [{ iso6391Hint: 'en', id: 'us-en' }, ...]
// det.quantization    → 'int8' | 'fp32' | ...
// det.sizeTier        → 'small' | 'medium' | 'large'
```

### `createTTS(options)`

```ts
function createTTS(options: TTSInitializeOptions | FileSource): Promise<TtsEngine>
```

```ts
// With explicit modelType (required for modelOptions):
const tts = await createTTS({
  modelSource: { kind: 'fs', path: '/models/vits-piper-en' },
  modelType: 'vits',
  numThreads: 2,
  modelOptions: { vits: { noiseScale: 0.667 } },
});

// With auto-detect (no modelOptions available):
const tts = await createTTS({ kind: 'app', base: 'apkAsset', path: 'models/vits-piper-en' });
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

> The output buffer's `sampleRate` must equal the model output rate — read it with `tts.getSampleRate()` before allocating. Each `createTTS()` has a unique `instanceId`; do not use it after `destroy()`. Voice cloning (Zipvoice / Pocket only) requires an `OfflineAudioBuffer` reference, not raw samples.

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

## Model detection

`detectTtsModel` is a cheap pre-check before `createTTS` (family, lexicons, required files). Unified catalog detect: [model-detect.md](model-detect.md).

## Validation required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `vits` | `ttsModel`, `tokens` | `dataDir`, `lexicon` | `ttsModel`, `tokens` (+ optional `dataDir`, `lexicon`) |
| `matcha` | `acousticModel`, `vocoder`, `tokens` | `dataDir`, `lexicon` | `acousticModel`, `vocoder`, `tokens` |
| `kokoro`, `kitten` | `ttsModel`, `tokens`, `voices`, `dataDir` | `lexicon` (kokoro) | same as required |
| `pocket` | `lmFlow`, `lmMain`, `encoder`, `decoder`, `textConditioner`, `vocabJson`, `tokenScoresJson` | — | same as required |
| `zipvoice` | `encoder`, `decoder`, `vocoder`, `tokens`, `dataDir`, `lexicon` | — | same as required |
| `supertonic` | `durationPredictor`, `textEncoder`, `vectorEstimator`, `vocoder`, `ttsJson`, `unicodeIndexer`, `voiceStyle` | — | same as required |

Query keys: `getCustomModelPathRequirements('tts', modelType)`.

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom). **`lexiconLanguageId`** is auto-only; pass `lexicon` in `customConfig` when needed.

| `modelType` | Custom-init keys |
| --- | --- |
| `vits` | `ttsModel`, `tokens` (+ optional `dataDir`, `lexicon`) |
| `matcha` | `acousticModel`, `vocoder`, `tokens` |
| `kokoro`, `kitten` | `ttsModel`, `tokens`, `voices`, `dataDir` |
| `pocket` | 7 keys — see table above |
| `zipvoice` | `encoder`, `decoder`, `vocoder`, `tokens`, `dataDir`, `lexicon` |
| `supertonic` | 7 keys — see table above |

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({
  initMode: 'custom',
  modelType: 'vits',
  customConfig: {
    ttsModel: { kind: 'fs', path: '/data/models/model.onnx' },
    tokens: { kind: 'fs', path: '/data/models/tokens.txt' },
    lexicon: { kind: 'fs', path: '/data/models/lexicon.txt' },
  },
  modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } },
});
```

## Segmentation

TTS models in this SDK are **offline-only** — there is no acoustic streaming at the character level. Generating audio from very long texts in a single call can exhaust device RAM (**OOM**). The segmentation engine splits the text buffer into **smaller chunks**, synthesizes each chunk with the offline engine, and stitches the resulting PCM into the output audio buffer in order — bounding peak RAM at the cost of a small quality tradeoff at segment boundaries.

Supported modes for offline TTS:

- `'off'` (default) — no segmentation; the entire text is synthesized in one pass.
- `'auto'` — the engine segments the text using the configured policy.

> `'manual'` mode is not supported for offline TTS.

Default policy evaluator: **`text_synthetic_auto`** — splits on sentence boundaries, with a `maxLengthChars` cap of 500 characters.

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import { createEmptyOfflineAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

const tts = await createTTS({ modelSource: { kind: 'fs', path: '/path/to/vits' }, modelType: 'vits' });
const sr = await tts.getSampleRate();

const textBuf = await createOfflineTextBufferFromText(longText); // multiple sentences
const audioBuf = await createEmptyOfflineAudioBuffer(sr);
try {
  const result = await tts.synthesize(textBuf, audioBuf, {
    segmentation: {
      mode: 'auto',
      // policy defaults to { evaluator: 'text_synthetic_auto', sentenceBoundary: true, maxLengthChars: 500 }
    },
    errorRecovery: 'skip',
    onProgress: (p) => console.log(`segment ${p.completedSegments}/${p.totalSegments}`),
  });
  console.log(result.status, result.totalSegments, result.completedSegments);
} finally {
  await releasePipelineTextBuffer(textBuf);
  await releasePipelineAudioBuffer(audioBuf);
}
await tts.destroy();
```

See [segmentation-engine.md](segmentation-engine.md) for the full segmentation reference (policies, evaluators, `SegmentLink`, `SegmentLinkMap`). For memory planning and OOM mitigation, see [memory-and-models.md](memory-and-models.md).

## Live overload on offline TTS (offline weights, live consumption)

> Mandatory `segmentation.policy`. Commit-only — no partials.

The offline TTS engine can drive a live pipeline directly. This is useful when you want to use a high-fidelity offline model (like VITS or Kokoro) against a live stream of text (e.g. from a live STT buffer) without the sample-level incremental generation of the native streaming engine.

```ts
const tts = await createTTS({
  modelSource: { kind: 'fs', path: '/absolute/path/to/vits-piper-en' },
  modelType: 'vits',
});

const handle = await tts.synthesize(liveTextIn, liveAudioOut, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 500 },
  },
});

// handle.stop() / .flush() / .completed as usual
const completion = await handle.completed;
console.log(`Synthesized ${completion.unitsWritten} samples`);
```

| Aspect | Live overload (`createTTS`) |
| --- | --- |
| Weights | Offline (VITS, Kokoro, Pocket, Zipvoice, Matcha, Supertonic) |
| Incremental | No (Per-segment synthesis) |
| Latency | Per-segment (higher) |



## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| App-authored script | `OfflineTextBuffer` (`txt_off_*`) | Typical source via `createOfflineTextBufferFromText(...)`. |
| Offline STT output | `OfflineTextBuffer` (`txt_off_*`) | Common speech-to-speech and narration workflows. |
| Offline punctuation output | `OfflineTextBuffer` (`txt_off_*`) | Improves readability/prosody before synthesis. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Synthesized output | `OfflineAudioBuffer` (`off_*`) | `audioOut` must be empty and sample-rate matched to the model. |
| Audio save/export | `saveAudioAsFile(...)` | Persist WAV/MP3/Opus after synthesis. |
| Offline STT/alignment loopback | `OfflineAudioBuffer` (`off_*`) | Optional QA/transcript verification loop. |

```mermaid
flowchart LR
  A[OfflineTextBuffer] --> B[createTTS().synthesize]
  B --> C[OfflineAudioBuffer]
  C --> D[Playback or saveAudioAsFile]
```

More end-to-end patterns: [feature-pipelines.md#tts-offline-patterns](feature-pipelines.md#tts-offline-patterns).

## Types

### Core TTS types (`react-native-sherpa-onnx/tts`)

`FileSource` (used in `createTTS` / init options) is imported from **`react-native-sherpa-onnx/fileio`**, not from the TTS entry.

| Type | Description |
| --- | --- |
| `TTSModelType` | `'vits' \| 'matcha' \| 'kokoro' \| 'kitten' \| 'pocket' \| 'zipvoice' \| 'supertonic' \| 'auto'` |
| `TTS_MODEL_TYPES` | Readonly runtime list |
| `isTtsModelType` | Runtime guard |
| `TTSInitializeOptions` | Discriminated union: concrete `modelType` required for `modelOptions` |
| `TTSInitializeOptionsBase` | Shared fields: `modelSource`, `provider?`, `numThreads?`, `debug?`, `ruleFsts?`, `ruleFars?`, `maxNumSentences?`, `silenceScale?` |
| `TtsUpdateOptions` | Arg to `updateParams()` — same per-`modelType` coupling as init |
| `TtsSynthesisOptions` | `{ sid?, speed?, silenceScale?, numSteps?, extra?, voiceClone?, segmentation?, errorRecovery?, maxRetriesPerSegment?, retryExhaustedFallback?, abortSignal?, onProgress?, overlapChars?, textSkipPlaceholder?, linkMap? }` — `silenceScale`/`numSteps` only apply when `voiceClone` is set; `segmentation` fields: `mode?` and `policy?` |
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

## Error codes

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
| `OFFLINE_OOM` | `synthesize` | Not enough memory for offline synthesis. Prefer streaming TTS for large inputs, or chunk offline work with the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). Native reject text references the same doc path. |

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

## Use case examples

<details>
<summary>Synthesize and save to WAV (standard flow)</summary>

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import { createEmptyOfflineAudioBuffer, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const tts = await createTTS({
  modelSource: { kind: 'fs', path: '/path/to/kokoro' },
  modelType: 'kokoro',
  numThreads: 2,
});
const sr = await tts.getSampleRate();

const textBuf = await createOfflineTextBufferFromText('Good morning, how can I help you today?');
const audioBuf = await createEmptyOfflineAudioBuffer(sr);
try {
  await tts.synthesize(textBuf, audioBuf, { sid: 0, speed: 1.0 });
  await saveAudioAsFile(audioBuf, { kind: 'fs', path: '/output/speech.wav' }, 'wav');
} finally {
  await releasePipelineTextBuffer(textBuf);
  await releasePipelineAudioBuffer(audioBuf);
}
await tts.destroy();
```

</details>

<details>
<summary>Synthesize a long document with segmentation (OOM mitigation)</summary>

Split a large text buffer into sentence-level chunks and synthesize each with the offline engine, keeping peak RAM bounded. Quality may degrade slightly at segment boundaries.

```ts
const tts = await createTTS({ modelSource: { kind: 'fs', path: '/path/to/vits' }, modelType: 'vits' });
const sr = await tts.getSampleRate();

const longText = '...'; // several hundred words
const textBuf = await createOfflineTextBufferFromText(longText);
const audioBuf = await createEmptyOfflineAudioBuffer(sr);
try {
  const result = await tts.synthesize(textBuf, audioBuf, {
    segmentation: { mode: 'auto' }, // default policy: text_synthetic_auto, maxLengthChars: 500
    errorRecovery: 'skip',
    onProgress: (p) => console.log(`${p.completedSegments}/${p.totalSegments}`),
  });
  console.log(result.status, result.totalSegments);
  await saveAudioAsFile(audioBuf, { kind: 'fs', path: '/output/long.wav' }, 'wav');
} finally {
  await releasePipelineTextBuffer(textBuf);
  await releasePipelineAudioBuffer(audioBuf);
}
await tts.destroy();
```

See [segmentation-engine.md](segmentation-engine.md) for policy tuning.

</details>

<details>
<summary>Voice cloning with Pocket model</summary>

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import { createOfflineTextBufferFromText, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineAudioBuffer,
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const tts = await createTTS({ modelSource: { kind: 'fs', path: '/path/to/pocket' }, modelType: 'pocket' });
const sr = await tts.getSampleRate();

const refAudio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/reference.wav' });
const textBuf = await createOfflineTextBufferFromText('Cloning this voice for the demo.');
const audioBuf = await createEmptyOfflineAudioBuffer(sr);
try {
  await tts.synthesize(textBuf, audioBuf, {
    voiceClone: { kind: 'pocket', referenceAudio: refAudio },
  });
} finally {
  await releasePipelineAudioBuffer(refAudio);
  await releasePipelineTextBuffer(textBuf);
  await releasePipelineAudioBuffer(audioBuf);
}
await tts.destroy();
```

</details>

## See also

- [alignment-offline.md](alignment-offline.md) — `alignTextToAudio`, subtitle timing, alignment models
- [execution-providers.md](execution-providers.md) — ORT execution providers
- [download-manager.md](download-manager.md) — downloading TTS models (`ModelCategory.Tts`)
- [model-languages.md](model-languages.md) — language hint helpers and `detectTtsModel(...).languages`
- [README — Breaking changes](../README.md#breaking-changes-upgrading-to-100)


## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

