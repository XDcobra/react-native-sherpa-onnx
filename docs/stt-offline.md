# Offline Speech-to-Text (STT)

## Introduction

On-device batch transcription with a **pipeline-first** API.

| Role | Type | Notes |
| --- | --- | --- |
| **Input** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | File-backed or in-memory PCM |
| **Output** | [`OfflineTextBuffer`](textbuffer-offline.md) | Empty buffer from `createEmptyOfflineTextBuffer`; STT writes the hypothesis and optional token/timestamp metadata |
| **Engine** | `SttEngine` via `createSTT` | `transcribe(audio, textOut)`, `setConfig`, `destroy`; returns `SttTranscribeResult` with orchestration stats (segments, time). Read transcript data via textbuffer slice APIs |

Import path: `react-native-sherpa-onnx/stt`

For live/real-time recognition, see [Streaming STT](stt-streaming.md).

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
  modelSource: { kind: 'fs', path: '/absolute/path/to/stt-model-dir' },
  modelType: 'whisper', // or 'transducer', 'paraformer', … — see STTInitializeOptions / STT_MODEL_TYPES
  quantization: 'int8',
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

const modelPath = { kind: 'app', base: 'apkAsset', path: 'models/sherpa-onnx-whisper-tiny-en' };

const det = await detectSttModel({ kind: 'app', base: 'apkAsset', path: 'models/sherpa-onnx-whisper-tiny-en' });
if (!det.success) throw new Error(det.error ?? 'STT detection failed');

const engine = await createSTT({
  modelSource: modelPath,
  modelType: (det.modelType as any) ?? 'auto',
  quantization: 'int8',
  numThreads: 2,
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

  // Token ids (use getOfflineTextBuffer* for timestamps, etc.):
  const tokens = await getOfflineTextBufferTokensSlice(textOut, 0, info.tokenCount);
  console.log(tokens.slice(0, 8));
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
}
await engine.destroy();
```

`transcribe` accepts **`OfflineAudioBufferRef`**, a branded offline handle, or a raw **`bufferId` string**; the same applies to **`textOut`**. Prefer passing **refs** so call sites stay typed (see [audiobuffer — offline](audiobuffer-offline.md) / [textbuffer — offline](textbuffer-offline.md)). Timestamps, durations, lang, emotion, and other dimensions use the matching **`getOfflineTextBuffer*`** helpers; see [textbuffer-offline.md](textbuffer-offline.md).

## API reference

### `detectSttModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createSTT` to get `modelType` and confirm pack layout. Unified cross-feature detection: [model-detect.md](model-detect.md).

On folder scans, `paths` contains resolved non-empty config keys (`encoder`, `tokens`, `whisperEncoder`, …) suitable for custom init or `validateCustomModelPaths`. For `FileSource` resolution problems, the promise can reject with `FILEIO_*` errors before native detection runs.

```ts
function detectSttModel(
  source: FileSource,
  options?: { quantization?: QuantizationPreference; modelType?: STTModelType; assetName?: string; debug?: boolean }
): Promise<SttDetectModelResult>;
```

```ts
const det = await detectSttModel({ kind: 'fs', path: '/absolute/path/to/sherpa-onnx-whisper-tiny-en' });
console.log(det.success, det.modelType, det.detectedModels, det.paths);
```

### `createSTT(options)`

Creates an offline `SttEngine`. Accepts `STTInitializeOptions` (full config) or a bare `FileSource` (auto-detect shorthand). Each engine gets a unique `instanceId`; call **`destroy()`** when done.

```ts
function createSTT(options: STTInitializeOptions | FileSource): Promise<SttEngine>;
```

```ts
const engine = await createSTT({
  modelSource: { kind: 'fs', path: '/absolute/path/model' },
  modelType: 'auto',
});
```

### `engine.transcribe(audio, textOut, options?)`

Writes recognition output into the given **offline text buffer**. Resolves when native transcription finishes (or throws on failure).

```ts
transcribe(
  audio: OfflineAudioBufferRef | OfflineBufferHandle | string,
  textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string,
  options?: SttTranscribeOptions
): Promise<SttTranscribeResult>;
```

```ts
await engine.transcribe(audio, textOut);
```

### `engine.setConfig(options)`

Update decoding method, hotwords, rules, or blank penalty without re-creating the engine.

```ts
setConfig(options: SttRuntimeConfig): Promise<void>;
```

```ts
await engine.setConfig({ decodingMethod: 'modified_beam_search', maxActivePaths: 8 });
```

### `engine.destroy()`

Releases the native offline recognizer. Does not release pipeline buffers you still own.

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

## Models and required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `transducer`, `nemo_transducer` | `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt` | `bpeVocab` | `encoder`, `decoder`, `joiner`, `tokens` |
| `paraformer` | `model*.onnx` or paraformer model, `tokens.txt` | `paraformerModel`, `encoder`, `decoder` | `paraformerModel` or `encoder`+`decoder`, `tokens` |
| `zipformer_ctc`, `ctc`, `nemo_ctc`, `wenet_ctc`, `sense_voice`, `telespeech_ctc` | `model*.onnx`, `tokens.txt` | — | `ctcModel`, `tokens` |
| `whisper` | `encoder*.onnx`, `decoder*.onnx`, `tokens.txt` | — | `whisperEncoder`, `whisperDecoder`, `tokens` |
| `qwen3_asr` | qwen3 frontend / encoder / decoder / tokenizer files | — | family-specific keys |
| `cohere_transcribe` | cohere encoder / decoder, `tokens.txt` | — | family-specific keys |
| `fire_red_asr`, `canary` | encoder, decoder | — | family-specific keys |
| `moonshine`, `dolphin`, `omnilingual`, `medasr`, `funasr_nano` | model-family specific | — | query `getCustomModelPathRequirements('stt', modelType)` |

Query exact keys: `getCustomModelPathRequirements('stt', modelType)` from `react-native-sherpa-onnx/detect`.

- **`FileSource`** — see [model-setup.md](model-setup.md)
- **Detection & init modes** — [model-detect.md](model-detect.md) (preflight, auto vs custom)
- **Downloads:** [download-manager.md](download-manager.md) · category `ModelCategory.Stt`
- **Hotwords:** [hotwords.md](hotwords.md)

## Custom initialization (`initMode: 'custom'`)

Use when files are scattered or folder detection fails. Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom).

| `modelType` | Custom-init keys |
| --- | --- |
| `transducer` | `encoder`, `decoder`, `joiner`, `tokens` |
| `whisper` | `whisperEncoder`, `whisperDecoder`, `tokens` |
| `paraformer` | `paraformerModel` or `encoder`+`decoder`, `tokens` |
| CTC families | `ctcModel`, `tokens` |

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';

const engine = await createSTT({
  initMode: 'custom',
  modelType: 'transducer',
  customConfig: {
    encoder: { kind: 'fs', path: '/data/models/encoder.onnx' },
    decoder: { kind: 'fs', path: '/data/models/decoder.onnx' },
    joiner: { kind: 'fs', path: '/data/models/joiner.onnx' },
    tokens: { kind: 'fs', path: '/data/models/tokens.txt' },
  },
  hotwordsFile: { kind: 'fs', path: '/data/hotwords.txt' },
});
```

Auxiliary paths (`hotwordsFile`, `bpeVocab`, `ruleFsts`, `ruleFars`) also accept `FileSource`. Full key list: `getCustomModelPathRequirements('stt', modelType)`.

## Segmentation

Most STT models in this SDK are **offline-only** — they have no streaming variant and process the entire input buffer at once. On mobile devices with limited RAM, transcribing long audio files can exhaust available memory (**OOM**). The segmentation engine splits the offline audio buffer into **smaller chunks** and runs the STT model repeatedly on each one, bounding peak RAM at the cost of a small quality tradeoff at segment boundaries.

Supported modes for offline STT:

- `'off'` (default) — no segmentation; the whole buffer is processed in one pass.
- `'auto'` — the engine splits the audio using the configured policy.

> `'manual'` mode is not supported for offline STT.

Default policy evaluator: **`speech_energy_silence`** — detects silence/low-energy boundaries to find natural split points.

```ts
const result = await engine.transcribe(audio, textOut, {
  segmentation: {
    mode: 'auto',
    // policy defaults to { evaluator: 'speech_energy_silence' } — override if needed
  },
  errorRecovery: 'skip',
  maxRetriesPerSegment: 2,
});
console.log(result.totalSegments, result.completedSegments, result.skippedSegments);
```

The `SttTranscribeResult` returned by `transcribe` includes `totalSegments`, `completedSegments`, `skippedSegments`, and `processingTimeMs`.

See [segmentation-engine.md](segmentation-engine.md) for the full segmentation reference (policies, evaluators, `SegmentLink`, `SegmentLinkMap`). For memory planning and OOM mitigation, see [memory-and-models.md](memory-and-models.md).

### Whisper and the 30-second window

Whisper's encoder processes audio in a fixed 30-second mel-spectrogram window. Segments that exceed this length cause Whisper to truncate or hallucinate text. When using a Whisper model, keep `maxSegmentMs` in your segmentation policy at or below 30 000 ms:

```ts
const result = await engine.transcribe(audio, textOut, {
  segmentation: {
    mode: 'auto',
    policy: {
      evaluator: 'speech_energy_silence',
      maxSegmentMs: 25000, // keep well under Whisper's 30 s window
    },
  },
});
```

See [openai/whisper#1118](https://github.com/openai/whisper/discussions/1118) for background. This constraint does not apply to transducer, paraformer, SenseVoice, or other non-Whisper models.

## Live overload (offline weights, live consumption)

> Mandatory `segmentation.policy`. Commit-only — no partials.

The offline STT engine can drive a live pipeline (mic input) directly. This is useful when you have a high-quality offline model (like Whisper) and want to use it for live transcription without a separate streaming-optimized model.

```ts
const engine = await createSTT({ /* offline init */ });
const pipeline = await engine.transcribe(liveAudio, liveText, {
  segmentation: { 
    mode: 'auto',
    policy: { evaluator: 'speech_energy_silence', maxSegmentMs: 10000 } 
  },
});

// pipeline.stop() / .flush() / .completed as usual
const completion = await pipeline.completed;
console.log(`Processed ${completion.unitsRead} audio samples`);
```

| Aspect | Live overload (`createSTT`) | Streaming engine (`createStreamingSTT`) |
| --- | --- | --- |
| Decoder | offline (monolithic) | online (incremental) |
| Partials | no (commit-only) | yes (mid-utterance hypotheses) |
| Latency | Per-segment (higher) | Per-chunk (lower) |
| Accuracy | Usually higher (full context) | Balanced for speed |

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

## Types

### Core STT types (`react-native-sherpa-onnx/stt`)

| Type | Description |
| --- | --- |
| `STTModelType` | `'transducer' \| 'nemo_transducer' \| 'paraformer' \| 'whisper' \| 'sense_voice' \| …` (includes `'auto'`) |
| `STTConcreteModelType` | `STTModelType` excluding `'auto'` |
| `STT_MODEL_TYPES` | Readonly runtime list of model types |
| `STT_HOTWORDS_MODEL_TYPES` | Runtime list of hotword-capable types (`transducer`, `nemo_transducer`) |
| `sttSupportsHotwords(modelType)` | Runtime guard for hotword support |
| `SttDetectModelResult` | Return of `detectSttModel()` |
| `STTInitializeOptions` | Auto or custom init union for `createSTT` |
| `STTInitializeOptionsBase` | Shared fields: `modelSource`, `numThreads?`, `provider?`, `debug?`, `hotwordsFile?`, `modelOptions?`, `ruleFsts?`, … |
| `SttModelOptions` | Aggregate model-specific options (`whisper?`, `senseVoice?`, `canary?`, `funasrNano?`, `qwen3Asr?`, `cohereTranscribe?`) |
| `SttWhisperModelOptions` | `{ language?, task?, tailPaddings?, enableTokenTimestamps?, enableSegmentTimestamps? }` |
| `SttSenseVoiceModelOptions` | `{ language?, useItn? }` |
| `SttCanaryModelOptions` | `{ srcLang?, tgtLang?, usePnc? }` |
| `SttFunAsrNanoModelOptions` | `{ systemPrompt?, userPrompt?, maxNewTokens?, temperature?, topP?, seed?, language?, itn?, hotwords? }` |
| `SttQwen3AsrModelOptions` | `{ hotwords?, maxTotalLen?, maxNewTokens?, temperature?, topP?, seed? }` |
| `SttCohereTranscribeModelOptions` | `{ language?, usePunct?, useItn? }` |
| `SttRuntimeConfig` | Arg to `setConfig()` — `decodingMethod?`, `maxActivePaths?`, `hotwordsFile?`, `hotwordsScore?`, `blankPenalty?`, `ruleFsts?`, `ruleFars?` |
| `SttTranscribeOptions` | Optional segmentation, `errorRecovery`, `maxRetriesPerSegment`, `onProgress`, `linkMap`, `textSkipPlaceholder` |
| `SttTranscribeResult` | `{ status, totalSegments, completedSegments, skippedSegments, failedSegment?, processingTimeMs, linkMap? }` |
| `SttLivePipelineOptions` | Live-overload options: mandatory `segmentation.policy`, optional `onSegment` |
| `SttEngine` | `transcribe` (offline / live overload), `setConfig`, `destroy` |
| `SttErrorCode` | Error code object |
| `OrchestrationProgress` | Shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …) |

Streaming-only types (`LiveSttEngine`, `SttPipelineHandle`, `SttPipelineOptions`, `StreamingSttInitOptions`, `EndpointConfig`, …): [stt-streaming.md](stt-streaming.md#types).

### Related buffer types

| Type | Description |
| --- | --- |
| `OfflineAudioBufferIdSource` | Offline audio ref or handle passed to `transcribe` |
| `OfflineTextBufferIdSource` | Offline text ref or handle for output |

See [audiobuffer-offline.md](audiobuffer-offline.md) · [textbuffer-offline.md](textbuffer-offline.md).

---

## Error codes

| Code | Typical reason |
| --- | --- |
| `STT_INSTANCE_NOT_FOUND` | Unknown or destroyed engine instance |
| `STT_NOT_INITIALIZED` | Engine not ready |
| `STT_TRANSCRIBE_FAILED` | Native decode / recognizer failure |
| `STT_BUFFER_NOT_FOUND` | Invalid or released **audio** buffer id |
| `STT_BUFFER_KIND_MISMATCH` | Wrong buffer kind passed to transcribe |
| `STT_BUFFER_EMPTY` | Empty or unusable audio buffer |
| `OFFLINE_OOM` | Not enough memory for offline processing. Prefer streaming STT for large inputs, or chunk offline work with the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). |
| `TEXT_BUFFER_NOT_FOUND` | Invalid or released **text** buffer id |
| `TEXT_ALREADY_POPULATED` | `textOut` already filled; use a new empty buffer |

Text slice / validation errors are reported via the **textbuffer** pipeline; see **`PipelineTextErrorCode`** in [`src/textbuffer/types.ts`](../src/textbuffer/types.ts).

---

## See also

- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md) · [live / streaming](audiobuffer-streaming.md)
- [Pipeline text buffers — offline](textbuffer-offline.md)
- [Pipeline text buffers — live / streaming](textbuffer-streaming.md)
- [Alignment](alignment-offline.md)
- [Hotwords](hotwords.md)
- [Model Setup](model-setup.md)
- [Execution Providers](execution-providers.md)
- [Audio Conversion](audio-conversion.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
