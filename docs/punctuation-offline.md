# Punctuation (offline)

## Introduction

**CT-Transformer** batch punctuation with a **pipeline-first** API. Reads populated plain text from an offline text buffer and writes punctuated text to a second buffer; for online CNN pipelines see [Punctuation (streaming)](punctuation-streaming.md). The offline engine also supports a [live overload](#live-overload-on-offline-punctuation-offline-weights-live-consumption) on `LiveTextBuffer` pairs.

Import path: **`react-native-sherpa-onnx/punctuation`**.

## Quick start

`textIn` is **populated**; `textOut` is **empty** before the call. Both are offline text buffers. Raw string ids are rejected early with **`TEXT_*`** or **`PUNCTUATION_*`** error codes as appropriate.

```ts
import {
  createOfflinePunctuation,
  detectPunctuationModel,
} from 'react-native-sherpa-onnx/punctuation';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

// Same directory: FileSource for detect and for init.
const modelDirFs = { kind: 'fs' as const, path: '/absolute/path/to/sherpa-onnx-punct-ct-en' };
const modelPath = { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-punct-ct-en' };

// Pre-flight: ensure the pack looks like a punctuation model and note ct vs cnn.
const det = await detectPunctuationModel(modelDirFs, { modelType: 'auto' });
if (!det.success) {
  throw new Error(det.error ?? 'Punctuation detection failed');
}

// Load the native OfflinePunctuation (ct_transformer only inside native).
const punct = await createOfflinePunctuation({
  modelSource: modelPath,
  modelType: 'auto', // native init uses ct_transformer — never picks CNN for this engine
  numThreads: 2,
  provider: 'cpu',
  debug: false,
});

// Input buffer: un-punctuated plain text (e.g. from STT). Optional lang is copied to the output.
const textIn = await createOfflineTextBufferFromText('hello world how are you', { lang: 'en' });
// Output buffer: must be empty, single-write target for the punctuated hypothesis.
const textOut = await createEmptyOfflineTextBuffer();

try {
  // Reads full text + lang from textIn, runs addPunctuation, populates textOut.
  const { processingTimeMs } = await punct.punctuate(textIn, textOut);
  console.log('Punctuation inference time (ms):', processingTimeMs);

  const outInfo = (await getPipelineTextBufferInfo(
    textOut
  )) as OfflineTextBufferInfo;
  const punctText = await getOfflineTextBufferTextSlice(textOut, 0, outInfo.utf16Length);
  console.log(punctText); // e.g. "Hello, world! How are you?"

  // If you set lang on textIn, it is preserved on textOut for TTS/alignment consumers.
} finally {
  // Release text buffers; destroy releases the native engine (ct_transformer instance).
  await releasePipelineTextBuffer(textIn);
  await releasePipelineTextBuffer(textOut);
  await punct.destroy();
}
```

**`punctuateString` (optional):** same populate rules, but the plain string is **not** read from a buffer; the output buffer must still be **empty**. **`lang` on the output** is **empty** for this path (no `textIn` to copy from).

```ts
const textOut2 = await createEmptyOfflineTextBuffer();
try {
  await punct.punctuateString('test sentence here', textOut2);
} finally {
  await releasePipelineTextBuffer(textOut2);
}
```

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Text in** | [`OfflineTextBuffer`](textbuffer-offline.md) | Populated plain text; `lang` is pass-through from input |
| **Text out** | [`OfflineTextBuffer`](textbuffer-offline.md) | Empty buffer before the call; filled once with punctuated text |
| **Engine** | `OfflinePunctuationEngine` via `createOfflinePunctuation` | `punctuate` / `punctuateString`, `destroy` |

---

## Segmentation (Optional)

Large text in one `punctuate` call can increase memory pressure. Auto mode splits text into bounded chunks, punctuates each, and merges output in order — lower peak RAM with a small quality tradeoff at boundaries.

**Modes:** `'off'` (default — full text in one pass) | `'auto'` (policy-driven chunks). `'manual'` is not supported.

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `text_synthetic_auto` | ✅ **Default** | Sentence / length splits; `maxLengthChars` default 500 |
| `text_punctuation_assisted` | ✅ | Needs `policy.punctuationInstanceId`; then same split as synthetic |
| Speech / frame evaluators | ❌ | Text-domain input only |

```ts
const result = await punct.punctuate(textIn, textOut, {
  segmentation: { mode: 'auto' },
  // policy defaults to text_synthetic_auto + maxLengthChars: 500
  errorRecovery: 'skip',
  maxRetriesPerSegment: 2,
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Memory planning: [memory-and-models.md](memory-and-models.md). Live path: [punctuation-streaming.md](punctuation-streaming.md#segmentation-optional).

---

## API reference

Signatures are exported from **`react-native-sherpa-onnx/punctuation`**. Types are defined in **`src/punctuation/types.ts`**; detection types mirror **`src/punctuation/detect.ts`**.

### `detectPunctuationModel(source, options?)`

File-based detection **without** initializing the engine. Use before `createOfflinePunctuation` to confirm pack layout and model family (ct vs cnn). Unified cross-feature detection: [model-detect.md](model-detect.md).

**`PunctuationModelType`:** `'ct_transformer' | 'cnn_bilstm' | 'auto'`

```ts
function detectPunctuationModel(
  source: FileSource,
  options?: { modelType?: PunctuationModelType; assetName?: string }
): Promise<PunctuationDetectModelResult>;
```

```ts
const pre = await detectPunctuationModel(
  { kind: 'fs', path: '/data/models/punct-pack' },
  { modelType: 'auto' }
);
if (pre.success) {
  console.log(pre.modelType, pre.paths?.ct_transformer);
}
```

### `createOfflinePunctuation(options)`

Creates an `OfflinePunctuationEngine`. Init modes: **`auto`** (default — `modelSource` + optional `modelType` / `quantization`) or **`custom`** (`initMode: 'custom'`, `modelType: 'ct_transformer'`, `customConfig: { ct_transformer }`). Shared tuning: `numThreads`, `provider`, `debug`.

If native init rejects (e.g. CNN-only pack), the promise rejects with a **`PUNCTUATION_*`** or detection-related code.

```ts
function createOfflinePunctuation(
  options: OfflinePunctuationInitializeOptions
): Promise<OfflinePunctuationEngine>;
```

```ts
const engine = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/abs/path/to/ct-punctuation-model' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
});
```

### `engine.punctuate(textIn, textOut, options?)`

Reads full text + `lang` from populated `textIn`, runs CT-Transformer punctuation, populates empty `textOut`. Both must be `OfflineTextBuffer` (`txt_off_*`).

```ts
punctuate(
  textIn: OfflineTextBufferIdSource,
  textOut: OfflineTextBufferIdSource,
  options?: OfflinePunctuateOptions
): Promise<OfflinePunctuateResult>;
```

```ts
const inBuf = /* populated OfflineTextBufferRef */;
const outBuf = await createEmptyOfflineTextBuffer();
const { processingTimeMs } = await engine.punctuate(inBuf, outBuf);
```

### `engine.punctuateString(plain, textOut, options?)`

Populates `textOut` from a raw string. `textOut` must be **empty** before the call. `lang` on the output stays **empty** (no `textIn` to copy from).

```ts
punctuateString(
  plain: string,
  textOut: OfflineTextBufferRef,
  options?: OfflinePunctuateOptions
): Promise<OfflinePunctuateResult>;
```

```ts
const out = await createEmptyOfflineTextBuffer();
await engine.punctuateString('unpunctuated input here', out);
```

### `engine.instanceId`

```ts
readonly instanceId: string;
```

```ts
console.log(engine.instanceId); // e.g. punc_off_1
```

### `engine.destroy()`

Releases the native CT-Transformer instance.

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

---

## Models and paths

- **`FileSource`** — [model-setup.md](model-setup.md)
- **Detection & init** — [model-detect.md](model-detect.md)
- Offline CT only — `createOfflinePunctuation` rejects CNN-only trees

## Validation required files

| `modelType` | Required files | Optional | Custom-init keys |
| --- | --- | --- | --- |
| `ct_transformer` | `*.onnx` (CT-Transformer) | — | `ct_transformer` |
| `cnn_bilstm` | `*.onnx`, `bpe_vocab` | — | `cnn_bilstm`, `bpe_vocab` (streaming only) |

`detectPunctuationModel` with `auto` may detect either family; **`createOfflinePunctuation`** accepts **`ct_transformer`** only.

## Model detection

`detectPunctuationModel` pre-check — no engine load. Unified catalog: [model-detect.md](model-detect.md). Returns `paths.*`, `detectionSources`; vocabs from ONNX.

## Custom initialization (`initMode: 'custom'`)

Concept: [model-detect.md — Init modes](model-detect.md#init-modes-auto-vs-custom).

| `modelType` | Custom-init keys |
| --- | --- |
| `ct_transformer` | `ct_transformer` |

```ts
import { createOfflinePunctuation } from 'react-native-sherpa-onnx/punctuation';

const engine = await createOfflinePunctuation({
  initMode: 'custom',
  modelType: 'ct_transformer',
  customConfig: {
    ct_transformer: { kind: 'fs', path: '/data/models/ct-punct.onnx' },
  },
});
```

## Live overload on offline punctuation (offline weights, live consumption)

> Mandatory `segmentation.policy`. Commit-only — no partials.

The offline punctuation engine can drive a live pipeline directly. This is useful when you want to punctuate a live stream of text (e.g. from an STT live buffer) using a high-quality CT-Transformer model without the latency/BPE-size constraints of streaming CNN models.

```ts
const punct = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-punct-ct-en' },
});

const handle = await punct.punctuate(liveTextIn, liveTextOut, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 500 },
  },
});

// handle.stop() / .flush() / .completed as usual
const completion = await handle.completed;
console.log(`Punctuated ${completion.unitsRead} characters`);
```

| Aspect | Live overload (`createOfflinePunctuation`) | Streaming engine (`createStreamingPunctuation`) |
| --- | --- | --- |
| Weights | CT-Transformer (Higher quality) | CNN-BiLSTM (Lower quality) |
| Latency | Per-segment (higher) | Per-token (lower) |
| Context | Global (per segment) | Local (sliding window) |

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| App text input | `OfflineTextBuffer` (`txt_off_*`) | Plain text source via `createOfflineTextBufferFromText(...)`. |
| Offline STT output | `OfflineTextBuffer` (`txt_off_*`) | Typical punctuation-restoration path for transcripts. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Punctuated batch output | `OfflineTextBuffer` (`txt_off_*`) | `textOut` must be empty before `punctuate(...)`. |
| Offline TTS | `OfflineTextBuffer` (`txt_off_*`) | Improves speech quality/readability. |
| Offline alignment | `OfflineTextBuffer` (`txt_off_*`) | Better sentence/word boundaries for subtitle generation. |

```mermaid
flowchart LR
  A[OfflineTextBuffer plain] --> B[createOfflinePunctuation().punctuate]
  B --> C[OfflineTextBuffer punctuated]
  C --> D[Offline TTS or alignment]
```

More end-to-end patterns: [feature-pipelines.md#punctuation-offline-patterns](feature-pipelines.md#punctuation-offline-patterns).

## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onProgress` | `OrchestrationProgress` | start of each offline segment step | segmented only (`mode: 'auto'`); single-pass: none |

Shapes: [Types](#types).

```ts
await engine.punctuate(textIn, textOut, {
  segmentation: { mode: 'auto' },
  onProgress: (p) => console.log(p.currentSegment, p.totalSegments),
});
```

Live overload uses `onSegment` only (no offline `onProgress`) — see [Live overload](#live-overload-on-offline-punctuation-offline-weights-live-consumption).

## Types

### Core punctuation types (`react-native-sherpa-onnx/punctuation`)

| Type | Description |
| --- | --- |
| `PunctuationModelType` | `'ct_transformer' \| 'cnn_bilstm' \| 'auto'` (detection) |
| `OfflinePunctuationModelType` | `'ct_transformer' \| 'auto'` (init) |
| `OfflinePunctuationConcreteModelType` | `'ct_transformer'` |
| `OfflinePunctuationInitOptionsShared` | Shared init fields: `numThreads?`, `provider?`, `debug?` |
| `OfflinePunctuationAutoInitializeOptions` | Auto init: `modelSource`, `quantization?`, `modelType?` + shared |
| `OfflinePunctuationCustomInitializeOptions` | Custom init: `initMode: 'custom'`, `modelType: 'ct_transformer'`, `customConfig` + shared |
| `OfflinePunctuationInitializeOptions` | Union of auto and custom init options |
| `PunctuationDetectModelResult` | Return of `detectPunctuationModel()` — shared detection base |
| `OfflinePunctuateResult` | `{ processingTimeMs, status?, totalSegments?, completedSegments?, skippedSegments?, failedSegment? }` |
| `OfflinePunctuateOptions` | `textInputNormalization?`, `segmentation?`, `errorRecovery?`, `maxRetriesPerSegment?`, `retryExhaustedFallback?`, `onProgress?`, `overlapChars?`, `textSkipPlaceholder?`, `linkMap?` |
| `PunctuationLivePipelineOptions` | Live overload options — mandatory segmentation, optional `textInputNormalization?`, `onSegment?` |
| `OfflinePunctuationEngine` | `punctuate` (offline / live overload), `punctuateString`, `destroy`; readonly `instanceId` |
| `OfflinePunctuationCustomConfig` | Custom init path map: `{ ct_transformer: FileSource }` |
| `PunctuationErrorCode` | Error code enum for punctuation operations |
| `TextInputNormalization` | `'lower' \| 'none'` — input casing normalization before inference |

Streaming types (`StreamingPunctuationEngine`, `StreamingPunctuationInitializeOptions`, `PunctuationPipelineHandle`, `OnlinePunctuationModelType`): [punctuation-streaming.md](punctuation-streaming.md#types).

### Related buffer types

| Type | Description |
| --- | --- |
| `OfflineTextBufferIdSource` | Offline text ref or handle passed to `punctuate` |
| `OfflineTextBufferRef` | `{ info, bufferId }` returned by `createOfflineTextBufferFromText` |

See [textbuffer-offline.md](textbuffer-offline.md).

---

## Error codes

| Error code | Explanation |
| --- | --- |
| `PUNCT_DETECT_ERROR` | `detectPunctuationModel` failed (null result, exception, or unusable layout for detection). |
| `PUNCTUATION_INIT_ERROR` | `createOfflinePunctuation` failed: not a CT layout, missing `ct_transformer` onnx path, unsupported `modelType` for offline, or native construct failure. |
| `PUNCTUATION_ERROR` | Punctuation **inference** or unexpected runtime failure (e.g. `addPunctuation` threw on native). |
| `PUNCTUATION_INSTANCE_NOT_FOUND` | `instanceId` does not match a loaded engine (e.g. wrong id or already **destroyed**). |
| `TEXT_BUFFER_NOT_FOUND` | `textIn` or `textOut` id is missing from the text registry. |
| `TEXT_BUFFER_KIND_MISMATCH` | Not an **offline** buffer id (`txt_off_*` required). |
| `TEXT_BUFFER_EMPTY` | `textIn` is not populated (input must have text). |
| `TEXT_ALREADY_POPULATED` | `textOut` was already populated; output must be **empty**. |
| `FILEIO_*` | File / URI resolution for **`FileSource`** before or during model init. |

---

## See also

- [Text buffers — offline](textbuffer-offline.md)
- [STT offline](stt-offline.md) (typical **source** of plain `textIn`)
- [TTS offline](tts-offline.md) (consumes punctuated + `lang` pass-through)
- [Punctuation (streaming)](punctuation-streaming.md)
- [Alignment](alignment-offline.md)
- [Model setup](model-setup.md)
- [Download manager](download-manager.md)
- [Execution providers](execution-providers.md)
- [Speech enhancement (offline)](enhancement-offline.md) (analogous buffer-based offline pattern for audio)

## Use case examples

<details>
<summary>Punctuate STT output before TTS</summary>

```ts
import { createOfflinePunctuation } from 'react-native-sherpa-onnx/punctuation';
import {
  createOfflineTextBufferFromText,
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const engine = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/path/to/punctuation-ct' },
  modelType: 'auto',
});

const plain = await createOfflineTextBufferFromText('hello world how are you today', { lang: 'en' });
const punctuated = await createEmptyOfflineTextBuffer();

try {
  await engine.punctuate(plain, punctuated);
  const info = await getPipelineTextBufferInfo(punctuated);
  console.log(await getOfflineTextBufferTextSlice(punctuated, 0, info.utf16Length));
} finally {
  await releasePipelineTextBuffer(plain);
  await releasePipelineTextBuffer(punctuated);
  await engine.destroy();
}
```

</details>

<details>
<summary>Punctuate long text with segmented offline processing</summary>

```ts
const result = await engine.punctuate(textIn, textOut, {
  segmentation: { mode: 'auto' },
  errorRecovery: 'skip',
  maxRetriesPerSegment: 2,
});

console.log(result.status, result.completedSegments, result.totalSegments);
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
