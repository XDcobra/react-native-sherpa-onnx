# Offline Speech-to-Text (STT)

On-device batch transcription with a **pipeline-first** API:

- **Input:** offline pipeline audio buffer ([`audiobuffer` — offline](audiobuffer-offline.md)) — file-backed or in-memory PCM.
- **Output:** offline pipeline text buffer ([`textbuffer`](textbuffer.md)) — STT writes the hypothesis and optional token/timestamp metadata into a buffer you allocate (`createEmptyOfflineTextBuffer`).
- **Engine:** `createSTT` exposes **`transcribe(audio, textOut)`** (plus `setConfig` / `destroy`). There are **no** JS-side `getSttResult*` methods or `resultId`-based lazy getters anymore; all transcript payload access goes through **textbuffer** slice APIs.

Import path: `react-native-sherpa-onnx/stt`

For live/real-time recognition, see [Streaming STT](stt-streaming.md). 

## Models and paths

- `ModelPathConfig`: `{ type: 'asset' | 'file' | 'auto', path: string }`
- In-app model downloads: [download-manager.md](download-manager.md) with category `ModelCategory.Stt`
- Model detection without engine init: `detectSttModel(...)`
- Model setup and expected files: [model-setup.md](model-setup.md)
- Hotwords details: [hotwords.md](hotwords.md)

## Validation required files

`detectSttModel(...)` and `createSTT(...)` both validate required files per detected model type.

| Model type | Typical required files |
| --- | --- |
| `transducer`, `nemo_transducer` | `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt` |
| `paraformer` | `model*.onnx` or paraformer model file, plus `tokens.txt` |
| `zipformer_ctc`, `ctc`, `nemo_ctc`, `wenet_ctc`, `sense_voice`, `telespeech_ctc` | `model*.onnx`, `tokens.txt` |
| `whisper` | `encoder*.onnx`, `decoder*.onnx`, `tokens.txt` |
| `qwen3_asr` | qwen3 frontend/encoder/decoder/tokenizer files |
| `cohere_transcribe` | cohere encoder/decoder files, plus `tokens.txt` |
| `fire_red_asr`, `canary` | encoder and decoder files |
| `moonshine`, `dolphin`, `omnilingual`, `medasr`, `funasr_nano` | model-family specific required files |

If validation fails, `success` is `false` and `error` contains the missing-file reason.

## Quick start

### `createSTT`, `modelOptions`, and `setConfig`

This example skips most buffer ceremony; it shows **how to initialize** the offline engine and **where model-specific knobs live**. Only the `modelOptions.*` block that matches **`modelType`** is applied (e.g. `modelOptions.whisper` is ignored for a paraformer pack).

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

// --- Init-time: paths, hardware, hotwords (transducer / NeMo transducer), rules, debug ---
const engine = await createSTT({
  modelPath: { type: 'file', path: '/absolute/path/to/stt-model-dir' },
  modelType: 'whisper', // or 'transducer', 'paraformer', … — see STTInitializeOptions / STT_MODEL_TYPES
  preferInt8: true,
  numThreads: 4,
  provider: 'cpu',
  debug: false,
  // hotwordsFile / hotwordsScore / modelingUnit / bpeVocab — when model supports hotwords; see hotwords.md
  // ruleFsts / ruleFars — optional WFST resources
  modelOptions: {
    // Only the branch matching `modelType` is read by native (others ignored).
    whisper: {
      language: 'en',
      task: 'transcribe', // or 'translate' → English text for multilingual Whisper
      enableTokenTimestamps: false,
      enableSegmentTimestamps: false,
    },
    // senseVoice: { language: 'auto', useItn: true },
    // canary: { srcLang: 'en', tgtLang: 'en', usePnc: true },
    // … see SttModelOptions in `react-native-sherpa-onnx/stt`
  },
});

// --- Runtime (same engine): decoding / hotwords / rules without reloading weights ---
// Relevant for transducer / CTC-style decoders; some fields no-op on other families.
await engine.setConfig({
  decodingMethod: 'modified_beam_search',
  maxActivePaths: 8,
  blankPenalty: 0.0,
  // hotwordsFile / hotwordsScore / ruleFsts / ruleFars can also be updated here
});

const audio = await createOfflineAudioBufferFromFile('/absolute/path/audio.wav');
const textOut = await createEmptyOfflineTextBuffer();
try {
  await engine.transcribe(audio, textOut);
  const info = (await getPipelineTextBufferInfo(textOut)) as OfflineTextBufferInfo;
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}

await engine.destroy();
```

Types: **`STTInitializeOptions`** (init), **`SttModelOptions`** / per-family options (**`SttWhisperModelOptions`**, …), **`SttRuntimeConfig`** (**`setConfig`**). Full signatures: [API reference](#api-reference) below; hotword fields: [hotwords.md](hotwords.md).

### Detect, transcribe, read text (tokens optional)

```ts
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  getOfflineTextBufferTokensSlice,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

// Same shape as createSTT / detectSttModel expect (bundled assets vs filesystem).
const modelPath = { type: 'asset' as const, path: 'models/sherpa-onnx-whisper-tiny-en' };

// Cheap check of required files / model type before loading weights.
const det = await detectSttModel(modelPath);
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

// Loads the offline recognizer; tune threads / int8 / provider per device.
const engine = await createSTT({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  preferInt8: true,
  numThreads: 2,
});

// Native decode: WAV (etc.) → immutable offline PCM handle (not a giant JS float[]).
const audio = await createOfflineAudioBufferFromFile('/absolute/path/audio.wav');
// Empty sink; transcribe will reject if you reuse a buffer that already has text.
const textOut = await createEmptyOfflineTextBuffer();

try {
  // Blocks until decode finishes; fills textOut on the native side.
  await engine.transcribe(audio, textOut);

  // Lengths for slices (utf16 code units, token ids, timestamp rows, …).
  const info = (await getPipelineTextBufferInfo(textOut)) as OfflineTextBufferInfo;
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  console.log(text);
  // Example output: Hello world.

  // Alternative — token ids (same `info`; use getOfflineTextBuffer* for timestamps, etc.):
  const tokens = await getOfflineTextBufferTokensSlice(textOut, 0, info.tokenCount);
  console.log(tokens.slice(0, 8));
  // Example output: [50258, 50363, 2425, 11, 2326, 11, 728, 628]

} finally {
  // transcribe does not take ownership; release native buffers when JS is done reading.
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}

// Unloads model; does not release pipeline buffers (handled above).
await engine.destroy();
```

`transcribe` accepts **`OfflineAudioBufferRef`**, a branded offline handle, or a raw **`bufferId` string** for the first argument; the same idea applies to **`textOut`** (`OfflineTextBufferRef` | handle | string). Prefer passing **refs** so call sites stay typed (see [audiobuffer — offline](audiobuffer-offline.md) / [textbuffer](textbuffer.md)). Raw strings are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT` or `TEXT_INVALID_ARGUMENT`. Timestamps, durations, lang, emotion, and other dimensions use the matching **`getOfflineTextBuffer*`** helpers; see [textbuffer.md](textbuffer.md).

## Data model and lifetime

| Item | Behavior |
| --- | --- |
| **Audio buffer** | Created via `audiobuffer` (e.g. `createOfflineAudioBufferFromFile`). Released with `releasePipelineAudioBuffer` when no longer needed. |
| **Text output buffer** | Empty offline buffer from `createEmptyOfflineTextBuffer`. **`transcribe`** fills it on the native side. Read via **`getPipelineTextBufferInfo`** + textbuffer getters. Released with **`releasePipelineTextBuffer`**. |
| **Re-transcription** | Use a **new** empty offline text buffer per decode unless your app explicitly manages buffer reuse; writing again into the same populated buffer is rejected natively (`TEXT_ALREADY_POPULATED` / `SttErrorCode.TEXT_ALREADY_POPULATED`). |
| **STT engine** | Holds the loaded offline model. Call **`destroy()`** when done. Destroying the engine does **not** release pipeline buffers you still own. |

Slice defaults and limits for **text** payloads are defined on the textbuffer module:

| Area | Constants (import from `react-native-sherpa-onnx/textbuffer`) |
| --- | --- |
| Default / max slice sizes | `TEXT_DEFAULT_SLICE_COUNT`, `TEXT_MAX_SLICE_COUNT` |

Use **`getPipelineTextBufferInfo(textOut)`** to obtain `utf16Length`, `tokenCount`, `timestampCount`, etc., then request slices with explicit `start` / `maxCount` (or full range up to limits).

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| Execution provider | Optional `provider` on init; details: [execution-providers.md](execution-providers.md) |
| Audio preprocessing | Use [audio-conversion.md](audio-conversion.md) when the source is not suitable PCM/WAV |
| Instance lifetime | Always call **`destroy()`** on the STT engine when done |

## API reference

Signatures below are exported from **`react-native-sherpa-onnx/stt`**. Reading transcript data is documented under **`react-native-sherpa-onnx/textbuffer`** ([textbuffer.md](textbuffer.md)).

### Detection and factory

#### `detectSttModel(modelPath, options?)`

```ts
function detectSttModel(
  modelPath: ModelPathConfig,
  options?: { preferInt8?: boolean; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' });
console.log(det.success, det.modelType, det.detectedModels);
```

#### `createSTT(options)`

```ts
function createSTT(options: STTInitializeOptions | ModelPathConfig): Promise<SttEngine>;
```

```ts
const engine = await createSTT({
  modelPath: { type: 'file', path: '/absolute/path/model' },
  modelType: 'auto',
});
```

### Engine (`SttEngine`)

#### `engine.transcribe(audio, textOut)`

Writes recognition output into the given **offline text buffer**. Resolves when native transcription finished (or throws on failure).

```ts
transcribe(
  audio: OfflineAudioBufferRef | OfflineBufferHandle | string,
  textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string
): Promise<void>;
```

```ts
await engine.transcribe(audio, textOut);
```

#### `engine.setConfig(options)`

```ts
setConfig(options: SttRuntimeConfig): Promise<void>;
```

```ts
await engine.setConfig({ decodingMethod: 'modified_beam_search', maxActivePaths: 8 });
```

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

## Pipeline buffers (audio + text)

**Audio input**

```ts
import {
  createOfflineAudioBufferFromFile,
  createOfflineAudioBufferFromSamples,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
```

See [audiobuffer — offline](audiobuffer-offline.md) and [overview](audiobuffer.md).

**Text output**

```ts
import {
  createEmptyOfflineTextBuffer,
  getPipelineTextBufferInfo,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTokensSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferDurationsSlice,
  getOfflineTextBufferLang,
  getOfflineTextBufferEmotion,
  getOfflineTextBufferEvent,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
```

See [textbuffer.md](textbuffer.md).

## Types and constants

```ts
import {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
} from 'react-native-sherpa-onnx/stt';

import type {
  STTModelType,
  STTInitializeOptions,
  SttEngine,
  SttRuntimeConfig,
  SttModelOptions,
  SttErrorCodeValue,
} from 'react-native-sherpa-onnx/stt';
```

`SttTranscribeRef` remains in TypeScript types only as a **deprecated** shape for migration notes; **`transcribe` no longer returns it**. Prefer **`OfflineTextBufferRef`** + **`getPipelineTextBufferInfo`**.

For buffer/ref unions (`OfflineAudioBufferIdSource`, `OfflineTextBufferIdSource`, …), import from **`audiobuffer`** / **`textbuffer`** as needed.

## Error code quick table

Typical `SttErrorCode` values from the STT layer (exact strings match native):

| Code | Typical reason |
| --- | --- |
| `STT_INSTANCE_NOT_FOUND` | Unknown or destroyed engine instance |
| `STT_NOT_INITIALIZED` | Engine not ready |
| `STT_TRANSCRIBE_FAILED` | Native decode / recognizer failure |
| `STT_BUFFER_NOT_FOUND` | Invalid or released **audio** buffer id |
| `STT_BUFFER_KIND_MISMATCH` | Wrong buffer kind passed to transcribe |
| `STT_BUFFER_EMPTY` | Empty or unusable audio buffer |
| `TEXT_BUFFER_NOT_FOUND` | Invalid or released **text** buffer id |
| `TEXT_ALREADY_POPULATED` | `textOut` already filled; use a new empty buffer |

Text slice / validation errors (e.g. invalid UTF-16 range) are reported via the **textbuffer** pipeline; see **`PipelineTextErrorCode`** in [`src/textbuffer/types.ts`](../src/textbuffer/types.ts).

## See also

- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md) · [overview](audiobuffer.md)
- [Pipeline text buffers (`textbuffer`)](textbuffer.md)
- [TextBuffer pipeline spec (migration)](migration/textbuffer/textbuffer-pipeline-spec.md)
- [Alignment](alignment.md)
- [Hotwords](hotwords.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
