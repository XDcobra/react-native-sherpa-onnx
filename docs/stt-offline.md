# Offline Speech-to-Text (STT)

## Introduction

On-device batch transcription with a **pipeline-first** API:

- **Input:** offline pipeline audio buffer ([`audiobuffer` — offline](audiobuffer-offline.md)) — file-backed or in-memory PCM.
- **Output:** offline pipeline text buffer ([`textbuffer` — offline](textbuffer-offline.md)) — STT writes the hypothesis and optional token/timestamp metadata into a buffer you allocate (`createEmptyOfflineTextBuffer`).
- **Engine:** `createSTT` exposes **`transcribe(audio, textOut)`** (plus `setConfig` / `destroy`). There are **no** JS-side `getSttResult*` methods or `resultId`-based lazy getters anymore; all transcript payload access goes through **textbuffer** slice APIs. `transcribe` writes directly into the output buffer and returns a `SttTranscribeResult` with orchestration stats (segments, time).

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

const audio = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/audio.wav',
});
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
const det = await detectSttModel({ kind: 'app', base: 'files', path: 'models/sherpa-onnx-whisper-tiny-en' });
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

// Loads the offline recognizer; tune threads / int8 / provider per device.
const engine = await createSTT({
  modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  preferInt8: true,
  numThreads: 2,
});

// Native decode: WAV (etc.) → immutable offline PCM handle (not a giant JS float[]).
const audio = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/audio.wav',
});
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

`transcribe` accepts **`OfflineAudioBufferRef`**, a branded offline handle, or a raw **`bufferId` string** for the first argument; the same idea applies to **`textOut`** (`OfflineTextBufferRef` | handle | string). Prefer passing **refs** so call sites stay typed (see [audiobuffer — offline](audiobuffer-offline.md) / [textbuffer — offline](textbuffer-offline.md)). Raw strings are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT` or `TEXT_INVALID_ARGUMENT`. Timestamps, durations, lang, emotion, and other dimensions use the matching **`getOfflineTextBuffer*`** helpers; see [textbuffer-offline.md](textbuffer-offline.md).

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

Signatures below are exported from **`react-native-sherpa-onnx/stt`**. Reading transcript data is documented under **`react-native-sherpa-onnx/textbuffer`** ([textbuffer-offline.md](textbuffer-offline.md)).

### Detection and factory

#### `detectSttModel(source, options?)`

```ts
function detectSttModel(
  source: FileSource,
  options?: { preferInt8?: boolean; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/sherpa-onnx-whisper-tiny-en' });
console.log(det.success, det.modelType, det.detectedModels);
```

For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native model detection runs.

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
): Promise<SttTranscribeResult>;
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

See [audiobuffer — offline](audiobuffer-offline.md) and [audiobuffer — live / streaming](audiobuffer-streaming.md).

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

See [textbuffer-offline.md](textbuffer-offline.md).

## Segmentation

Most STT models in this SDK are **offline-only** — they have no streaming variant and process the entire input buffer at once. On mobile devices with limited RAM, transcribing long audio files can exhaust available memory (**OOM**). The segmentation engine splits the offline audio buffer into **smaller chunks** and runs the STT model repeatedly on each one, bounding peak RAM at the cost of a small quality tradeoff at segment boundaries.

Supported modes for offline STT:

- `'off'` (default) — no segmentation; the whole buffer is processed in one pass.
- `'auto'` — the engine splits the audio using the configured policy.

> `'manual'` mode is not supported for offline STT.

Default policy evaluator: **`speech_energy_silence`** — detects silence/low-energy boundaries to find natural split points.

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';
import { createOfflineAudioBufferFromFile, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const engine = await createSTT({
  modelPath: { type: 'file', path: '/path/to/whisper' },
  modelType: 'whisper',
  numThreads: 2,
});
const audio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/long-audio.wav' });
const textOut = await createEmptyOfflineTextBuffer();
try {
  const result = await engine.transcribe(audio, textOut, {
    segmentation: {
      mode: 'auto',
      // policy defaults to { evaluator: 'speech_energy_silence' } — override if needed
    },
    errorRecovery: 'skip',       // skip a failed segment and continue
    maxRetriesPerSegment: 2,     // retry before applying errorRecovery
  });
  console.log(result.totalSegments, result.completedSegments, result.skippedSegments);
  const info = await getPipelineTextBufferInfo(textOut);
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}
await engine.destroy();
```

The `SttTranscribeResult` returned by `transcribe` includes:

- `totalSegments` — number of segments the engine processed.
- `completedSegments` — segments that produced valid output.
- `skippedSegments` — count of segments skipped due to errors (when `errorRecovery: 'skip'`).
- `processingTimeMs` — wall-clock time for the full transcription.

See [segmentation-engine.md](segmentation-engine.md) for the full segmentation reference (policies, evaluators, `SegmentLink`, `SegmentLinkMap`). For memory planning and OOM mitigation, see [memory-and-models.md](memory-and-models.md).

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| File decode path | `OfflineAudioBuffer` (`off_*`) | Typical batch source via `createOfflineAudioBufferFromFile(...)`. |
| Sample ingestion path | `OfflineAudioBuffer` (`off_*`) | Use `createOfflineAudioBufferFromSamples(...)` for app-owned PCM. |
| Offline enhancement | `OfflineAudioBuffer` (`off_*`) | Common denoise-before-STT chain for noisy recordings. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Transcript storage | `OfflineTextBuffer` (`txt_off_*`) | `textOut` must be empty before `transcribe(...)`. |
| Offline punctuation | `OfflineTextBuffer` (`txt_off_*`) | Normalize punctuation before voice or subtitle pipelines. |
| Offline TTS or alignment | `OfflineTextBuffer` (`txt_off_*`) | Reuse transcript in synthesis or timestamp generation flows. |

```mermaid
flowchart LR
  A[OfflineAudioBuffer] --> B[createSTT().transcribe]
  B --> C[OfflineTextBuffer]
  C --> D[Offline punctuation or offline TTS or alignment]
```

More end-to-end patterns: [feature-pipelines.md#stt-offline-patterns](feature-pipelines.md#stt-offline-patterns).

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

For buffer/ref unions (`OfflineAudioBufferIdSource`, `OfflineTextBufferIdSource`, …), import from **`audiobuffer`** / **`textbuffer`** as needed.

## Error codes

Typical `SttErrorCode` values from the STT layer (exact strings match native):

| Code | Typical reason |
| --- | --- |
| `STT_INSTANCE_NOT_FOUND` | Unknown or destroyed engine instance |
| `STT_NOT_INITIALIZED` | Engine not ready |
| `STT_TRANSCRIBE_FAILED` | Native decode / recognizer failure |
| `STT_BUFFER_NOT_FOUND` | Invalid or released **audio** buffer id |
| `STT_BUFFER_KIND_MISMATCH` | Wrong buffer kind passed to transcribe |
| `STT_BUFFER_EMPTY` | Empty or unusable audio buffer |
| `OFFLINE_OOM` | Not enough memory for offline processing. Prefer streaming STT for large inputs, or chunk offline work with the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). Native reject text references the same doc path. |
| `TEXT_BUFFER_NOT_FOUND` | Invalid or released **text** buffer id |
| `TEXT_ALREADY_POPULATED` | `textOut` already filled; use a new empty buffer |

Text slice / validation errors (e.g. invalid UTF-16 range) are reported via the **textbuffer** pipeline; see **`PipelineTextErrorCode`** in [`src/textbuffer/types.ts`](../src/textbuffer/types.ts).

## Use case examples

<details>
<summary>Transcribe a file with auto-detected model type</summary>

```ts
import { createSTT, detectSttModel } from 'react-native-sherpa-onnx/stt';
import { createOfflineAudioBufferFromFile, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const modelDir = '/path/to/model';
const det = await detectSttModel({ kind: 'fs', path: modelDir });
if (!det.success) throw new Error(det.error ?? 'Detection failed');

const engine = await createSTT({
  modelPath: { type: 'file', path: modelDir },
  modelType: det.modelType ?? 'auto',
});

const audio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/audio.wav' });
const textOut = await createEmptyOfflineTextBuffer();
try {
  await engine.transcribe(audio, textOut);
  const info = await getPipelineTextBufferInfo(textOut);
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}
await engine.destroy();
```

</details>

<details>
<summary>Transcribe a long audio file with segmentation (OOM mitigation)</summary>

Run the offline STT model repeatedly over bounded audio chunks instead of one monolithic pass — reduces peak RAM at the cost of a small quality tradeoff at segment boundary points.

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';
import { createOfflineAudioBufferFromFile, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const engine = await createSTT({
  modelPath: { type: 'file', path: '/path/to/whisper' },
  modelType: 'whisper',
  numThreads: 2,
});
const audio = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/path/to/long-interview.wav' });
const textOut = await createEmptyOfflineTextBuffer();
try {
  const result = await engine.transcribe(audio, textOut, {
    segmentation: { mode: 'auto' }, // default policy: speech_energy_silence
    errorRecovery: 'skip',
    maxRetriesPerSegment: 2,
  });
  console.log(`${result.completedSegments}/${result.totalSegments} segments completed`);
  const info = await getPipelineTextBufferInfo(textOut);
  console.log(await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length));
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}
await engine.destroy();
```

Quality may degrade slightly at segment boundaries. See [segmentation-engine.md](segmentation-engine.md) for policy tuning.

</details>

## See also

- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md) · [live / streaming](audiobuffer-streaming.md)
- [Pipeline text buffers — offline](textbuffer-offline.md)
- [Pipeline text buffers — live / streaming](textbuffer-streaming.md)
- [Alignment](alignment-offline.md)
- [Hotwords](hotwords.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
