# Punctuation (streaming)

## Introduction

On-device streaming punctuation with a **pipeline-first** API. A native worker reads committed text segments from a live input buffer and writes punctuated segments to a live output buffer; for batch offline punctuation see [Punctuation (offline)](punctuation-offline.md).

Import path: **`react-native-sherpa-onnx/punctuation`**.

## Streaming pipeline system

`punctuate` starts a **native worker** that reads **committed text segments** from the live **input** buffer and writes punctuated segments to the live **output** buffer (not the raw partial window). Shared **`stop` / `flush` / `reset` / `getStatus` / `completed`** semantics are in **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**; punctuation additionally requires a **post-input-finalize `flush()`** barrier — see Quick start and **`pipeline.flush()`** below.

## Quick start

```ts
import {
  createStreamingPunctuation,
  detectPunctuationModel,
} from 'react-native-sherpa-onnx/punctuation';
import {
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const modelDir = '/path/to/punctuation-online-pack';
const det = await detectPunctuationModel({ kind: 'fs', path: modelDir }, { modelType: 'auto' });
if (!det.success || det.modelType !== 'cnn_bilstm' || !det.isStreaming) {
  throw new Error(det.error ?? 'Expected online cnn_bilstm punctuation model');
}

const engine = await createStreamingPunctuation({
  modelSource: { kind: 'fs', path: modelDir },
  modelType: 'auto',
  numThreads: 2,
  provider: 'cpu',
});

const textIn = await createLiveTextBuffer({ maxSegments: 2048 });
const textOut = await createLiveTextBuffer({ maxSegments: 2048 });

const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: { mode: 'off' },
});

await appendLiveTextSegment(textIn, 'hello world how are you');
await appendLiveTextSegment(textIn, 'this is a second sentence');
await finalizeLiveTextBuffer(textIn);

await pipeline.flush();
await pipeline.stop();
await pipeline.completed;

const outCount = await getLiveTextBufferSegmentCount(textOut);
const outSegments =
  outCount > 0 ? await getLiveTextBufferSegments(textOut, 0, outCount) : [];
console.log(outSegments.map((s) => s.text).join(' '));

await engine.destroy();
await releasePipelineTextBuffer(textIn);
await releasePipelineTextBuffer(textOut);
```

After the live input is finalized, call **`pipeline.flush()`** (then **`stop()`** and **`completed`** as in the snippet). The native worker treats the post-finalize **`flush()`** as the barrier that allows it to finish draining tail segments before shutting down.

**Order (recommended):** `finalizeLiveTextBuffer(textIn)` (live **text** buffer, no more writes / optional last partial → segment) → **`pipeline.flush()`** (pipeline **handle**, drain segment log through the model) → **`pipeline.stop()`** → **`pipeline.completed`**. That is **not** the same as "flush before finalize": if you `flush()` while the input is still `recording`, more segments can still arrive afterward (e.g. last segment at finalize), so **`finalize` first** is the stable cut.

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Text in** | [`LiveTextBuffer`](textbuffer-streaming.md) | Committed text segments from upstream (e.g. live STT) |
| **Text out** | [`LiveTextBuffer`](textbuffer-streaming.md) | Punctuated committed segments |
| **Engine** | `StreamingPunctuationEngine` via `createStreamingPunctuation` | `punctuate(textIn, textOut)` returns `PunctuationPipelineHandle` |
| **Pipeline handle** | `PunctuationPipelineHandle` | `stop` / `flush` / `reset` / `getStatus` / `completed` |

---

## Segmentation (Optional)

Streaming punctuation can attach segmentation to a live text stream. Useful for policy-driven commit boundaries or manual segment control around an active pipeline.

**Modes:** `'off'` (default — consume committed segments as-is) | `'auto'` (policy-driven boundaries) | `'manual'` (external boundary control).

| Evaluator | Supported | Notes |
| --- | --- | --- |
| `text_punctuation_assisted` | ✅ **Default** | Sentence boundary + length; `maxLengthChars: 500` |
| `text_synthetic_auto` | ✅ | Synthetic sentence / length splits |
| Speech / frame evaluators | ❌ | Text-domain input only |

```ts
const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_punctuation_assisted', maxLengthChars: 500 },
  },
});
```

Full policy reference: [segmentation-engine.md](segmentation-engine.md). Offline path: [punctuation-offline.md](punctuation-offline.md#segmentation-optional).

## Models

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `cnn_bilstm` | `*.onnx`, `bpe_vocab` | `cnn_bilstm`, `bpe_vocab` |

Validate category: **`punctuation`**. Streaming requires online `cnn_bilstm` (`det.isStreaming`); offline `ct_transformer` is not valid here. Detection: [model-detect.md](model-detect.md) · downloads: [download-manager.md](download-manager.md) (`ModelCategory.Punctuation`).

```ts
import { createStreamingPunctuation } from 'react-native-sherpa-onnx/punctuation';

const engine = await createStreamingPunctuation({
  initMode: 'custom',
  modelType: 'cnn_bilstm',
  customConfig: {
    cnn_bilstm: { kind: 'fs', path: '/data/models/cnn.onnx' },
    bpe_vocab: { kind: 'fs', path: '/data/models/bpe.vocab' },
  },
});
```

## API reference

Signatures are exported from `react-native-sherpa-onnx/punctuation`.

### `detectPunctuationModel(source, options?)`

Shared with offline. File-based detection **without** initializing the engine. Require `det.modelType === 'cnn_bilstm' && det.isStreaming` for streaming use. Unified cross-feature detection: [model-detect.md](model-detect.md).

```ts
function detectPunctuationModel(
  source: FileSource,
  options?: { modelType?: 'ct_transformer' | 'cnn_bilstm' | 'auto'; assetName?: string }
): Promise<PunctuationDetectModelResult>;
```

```ts
const det = await detectPunctuationModel({ kind: 'fs', path: '/path/to/punctuation-model' });
console.log(det.success, det.modelType, det.isStreaming);
```

### `createStreamingPunctuation(options)`

Creates a `StreamingPunctuationEngine`. Init modes: **`auto`** (default — `modelSource` + optional `modelType` / `quantization`) or **`custom`** (`initMode: 'custom'`, `modelType: 'cnn_bilstm'`, `customConfig: { cnn_bilstm, bpe_vocab }`). Shared tuning: `numThreads`, `provider`, `debug`.

```ts
function createStreamingPunctuation(
  options: StreamingPunctuationInitializeOptions
): Promise<StreamingPunctuationEngine>;
```

```ts
const engine = await createStreamingPunctuation({
  modelSource: { kind: 'fs', path: '/path/to/punctuation-online-pack' },
  modelType: 'auto',
});
```

### `engine.punctuate(textIn, textOut, options?)`

Starts a native worker that reads committed text segments from `textIn` and writes punctuated segments to `textOut`. Both must be live text buffers (`txt_live_*`). Input/output kind mismatch is rejected with `PUNCTUATION_INVALID_ARGUMENT`.

```ts
punctuate(
  textIn: LiveTextBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options?: StreamingPunctuationOptions
): Promise<PunctuationPipelineHandle>;
```

```ts
const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: { mode: 'off' },
});
```

Notes:
- `segmentation.mode: 'auto'` attaches the segmentation engine to input text.
- `textInputNormalization` (default `'lower'`): lowercases each input segment before inference. Use `'none'` to keep upstream casing (not recommended for ALL-CAPS ASR).
- `text_punctuation_assisted` segmentation commits at the **first** sentence boundary in punctuated text (not the last), so partial buffers are not re-committed wholesale on every STT update once punctuation inserts `.?!`.
- **Do not** attach `text_punctuation_assisted` to a live buffer that already receives upstream `commitSegment` rows (e.g. pipelined `stt → punctuation`). Use `segmentation: { mode: 'off' }` and let the punctuation worker drain upstream segments only.

### `engine.destroy()`

Releases the native online punctuation instance.

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

### `pipeline.stop()`

**Hard teardown** of the punctuation worker. Use when cancelling or before releasing buffers if the worker might still be running.

```ts
stop(): Promise<void>;
```

### `pipeline.flush()`

**Drain barrier on the segment log:** drains any **unread committed segments** on the live **input**, runs **`addPunctuation`**, and commits results to **`textOut`**. After the live **input** is **`finalizeLiveTextBuffer`**, you **must** call **`flush()`** (then **`stop()`** / **`completed`**) so the worker can finish.

**Contract:** after **`finalizeLiveTextBuffer`** on the live **input** text buffer, call **`pipeline.flush()`** so the worker can drain any tail segments and exit. Then **`pipeline.stop()`** and **`await pipeline.completed`**. Omitting **`flush()`** after a finished input leaves the worker running until **`stop()`**.

```ts
flush(): Promise<void>;
```

### `pipeline.reset()`

Clears **online punctuation** internal stream state where supported; pipeline may **continue running**. Prefer **`stop()`** for full teardown.

```ts
reset(): Promise<void>;
```

### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

### `pipeline.completed`

Await after **`flush()`** / **`stop()`** in the recommended order so teardown and buffer release do not race.

```ts
readonly completed: Promise<StreamingPipelineCompletion>;
```

---

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| App text commits | `LiveTextBuffer` (`txt_live_*`) | Incremental input segments for online punctuation. |
| Streaming STT output | `LiveTextBuffer` (`txt_live_*`) | Common chain: STT first, punctuation second. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Punctuated live output | `LiveTextBuffer` (`txt_live_*`) | Produced while pipeline is running. |
| Streaming TTS | `LiveTextBuffer` (`txt_live_*`) | Feed punctuated segments directly into streaming synthesis. |
| Transcript UI/export | `LiveTextBuffer` (`txt_live_*`) | Render committed punctuated segments in near real time. |

```mermaid
flowchart LR
  A[LiveTextBuffer plain] --> B[createStreamingPunctuation().punctuate]
  B --> C[LiveTextBuffer punctuated]
  C --> D[Streaming TTS or transcript UI]
```

More end-to-end patterns: [feature-pipelines.md#punctuation-streaming-patterns](feature-pipelines.md#punctuation-streaming-patterns).

## JS Events

No pipeline-level JS event callbacks. The native worker processes committed segments automatically; monitor output via the live text buffer's segment events — see [textbuffer-streaming.md](textbuffer-streaming.md).

## Types

### Core streaming punctuation types (`react-native-sherpa-onnx/punctuation`)

| Type | Description |
| --- | --- |
| `PunctuationModelType` | `'ct_transformer' \| 'cnn_bilstm' \| 'auto'` (detection) |
| `OnlinePunctuationModelType` | `'cnn_bilstm' \| 'auto'` (init) |
| `StreamingPunctuationConcreteModelType` | `'cnn_bilstm'` |
| `StreamingPunctuationInitOptionsShared` | Shared init fields: `numThreads?`, `provider?`, `debug?` |
| `StreamingPunctuationAutoInitializeOptions` | Auto init: `modelSource`, `quantization?`, `modelType?` + shared |
| `StreamingPunctuationCustomInitializeOptions` | Custom init: `initMode: 'custom'`, `modelType: 'cnn_bilstm'`, `customConfig` + shared |
| `StreamingPunctuationInitializeOptions` | Union of auto and custom init options |
| `StreamingPunctuationOptions` | `textInputNormalization?`, `segmentation?` (mode + policy) |
| `PunctuationPipelineHandle` | `stop`, `flush`, `reset`, `getStatus`, `completed`; readonly `instanceId`, `pipelineId` |
| `StreamingPunctuationEngine` | `punctuate`, `destroy`; readonly `instanceId` |
| `PunctuationDetectModelResult` | Return of `detectPunctuationModel()` — shared detection base |
| `StreamingPunctuationCustomConfig` | Custom init path map: `{ cnn_bilstm, bpe_vocab }` |
| `TextInputNormalization` | `'lower' \| 'none'` — input casing normalization before inference |

### Related pipeline types

| Type | Description |
| --- | --- |
| `StreamingPipelineStatus` | `{ pipelineId, isRunning, chunksProcessed, unitsRead, unitsWritten, error }` |
| `StreamingPipelineCompletion` | Settles when the worker fully stops |

Offline types (`OfflinePunctuationEngine`, `OfflinePunctuationInitializeOptions`, `OfflinePunctuateResult`): [punctuation-offline.md](punctuation-offline.md#types).

---

## Error codes

| Code | Typical reason |
| --- | --- |
| `PUNCTUATION_INVALID_ARGUMENT` | Non-live buffer passed, or model is not online-capable `cnn_bilstm` for streaming |
| `PUNCTUATION_INIT_ERROR` | Native online punctuation initialization failed |
| `PUNCTUATION_ERROR` | Runtime inference/pipeline failure in native punctuation processing |
| `PUNCTUATION_INSTANCE_NOT_FOUND` | Engine instance id is unknown or already destroyed |
| `TEXT_BUFFER_NOT_FOUND` | Input or output live text buffer id is missing or released |
| `TEXT_BUFFER_KIND_MISMATCH` | Buffer kind is not `txt_live_*` where live text is required |
| `STREAMING_PIPELINE_NOT_FOUND` | Pipeline id is unknown (already stopped, reset, or invalid handle) |
| `STREAMING_PIPELINE_ERROR` | Generic streaming pipeline runtime failure |

Additional `FILEIO_*` errors can occur during model path/source resolution before native init.

---

## Use case examples

<details>
<summary>Punctuate ASR commits as they arrive (no wait for session end)</summary>

Start the punctuation pipeline first, then append ASR segments into `textIn`. Punctuated output shows up on `textOut` while more ASR text is still being appended.

```ts
import { createStreamingPunctuation } from 'react-native-sherpa-onnx/punctuation';
import {
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const engine = await createStreamingPunctuation({
  modelSource: { kind: 'fs', path: '/path/to/punct-cnn-bilstm' },
  modelType: 'auto',
});
const textIn = await createLiveTextBuffer({ maxSegments: 2048 });
const textOut = await createLiveTextBuffer({
  maxSegments: 2048,
  onSegment: (e) => console.log('[punct]', e.segment.text),
});

const pipeline = await engine.punctuate(textIn, textOut, { segmentation: { mode: 'off' } });

await appendLiveTextSegment(textIn, 'hello this is an asr output segment');
await appendLiveTextSegment(textIn, 'it has no punctuation markers yet');
// more appends can continue here — do not await completed yet

await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.stop();
await pipeline.completed;

await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineTextBuffer(textIn);
```

</details>

<details>
<summary>Finalize → flush barrier → await `completed`</summary>

After the upstream ASR text buffer is finalized, call `flush` as the required drain barrier before stop/await so trailing punctuation commits land in `textOut`.

```ts
await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.stop();
const done = await pipeline.completed;
console.log('units written', done.unitsWritten);
```

</details>

<details>
<summary>Read punctuated segments after the pipeline settles</summary>

Once `completed` resolves, inspect the output live text buffer for UI freeze-frames or handoff into TTS.

```ts
import { getLiveTextBufferSegments } from 'react-native-sherpa-onnx/textbuffer';

await finalizeLiveTextBuffer(textIn);
await pipeline.flush();
await pipeline.completed;
const segs = await getLiveTextBufferSegments(textOut);
console.log(segs.map((s) => s.text).join(' '));
```

</details>

## See also

- [Punctuation (offline)](punctuation-offline.md)
- [Text buffers — streaming](textbuffer-streaming.md)
- [Text buffers — offline](textbuffer-offline.md)
- [STT streaming](stt-streaming.md)
- [TTS offline](tts-offline.md)
- [Segmentation engine](segmentation-engine.md)
- [Model setup](model-setup.md)
- [Execution providers](execution-providers.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
