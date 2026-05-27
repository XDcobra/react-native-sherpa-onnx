# Punctuation (streaming)

## Introduction

On-device streaming punctuation with a pipeline-first API:

- Pipeline handle: `PunctuationPipelineHandle` provides `stop`, `flush`, `reset`, `getStatus`, and `completed`.

Import path: `react-native-sherpa-onnx/punctuation`

For batch punctuation with offline text buffers, see [punctuation-offline.md](punctuation-offline.md).

## Streaming pipeline system

`punctuate` starts a **native worker** that reads **committed text segments** from the live **input** buffer and writes punctuated segments to the live **output** buffer (not the raw partial window). Shared **`stop` / `flush` / `reset` / `getStatus` / `completed`** semantics are in **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**; punctuation additionally requires a **post-input-finalize `flush()`** barrier — see Quick start and **`pipeline.flush()`** below.

## Models and paths

- `FileSource` (type from `react-native-sherpa-onnx/fileio`): `FileSource`
- `FileSource` is used by `detectPunctuationModel(...)` for preflight checks.
- Streaming punctuation requires an online-capable `cnn_bilstm` layout. Offline `ct_transformer` models are not valid for this API.
- **Input normalization:** `textInputNormalization` defaults to `'lower'` so ALL-CAPS ASR text is normalized before inference. Pass `'none'` to disable.
- Download/catalog setup: [download-manager.md](download-manager.md), [model-setup.md](model-setup.md)

## Model detection

Use `detectPunctuationModel` as preflight before initialization:
- `modelType: 'auto'` may detect either offline `ct_transformer` or online `cnn_bilstm`.
- Streaming initialization requires `modelType === 'cnn_bilstm'` with `isStreaming === true`.

```ts
import { detectPunctuationModel } from 'react-native-sherpa-onnx/punctuation';

const det = await detectPunctuationModel(
  { kind: 'fs', path: '/path/to/punctuation-online-pack' },
  { modelType: 'auto' }
);

if (!det.success || det.modelType !== 'cnn_bilstm' || !det.isStreaming) {
  throw new Error(det.error ?? 'Streaming punctuation requires cnn_bilstm');
}
```

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

**Order (recommended):** `finalizeLiveTextBuffer(textIn)` (live **text** buffer, no more writes / optional last partial → segment) → **`pipeline.flush()`** (pipeline **handle**, drain segment log through the model) → **`pipeline.stop()`** → **`pipeline.completed`**. That is **not** the same as “flush before finalize”: if you `flush()` while the input is still `recording`, more segments can still arrive afterward (e.g. last segment at finalize), so **`finalize` first** is the stable cut.

## API reference

Signatures are exported from `react-native-sherpa-onnx/punctuation`.

### Detection

#### `detectPunctuationModel(source, options?)`

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

### Factory

#### `createStreamingPunctuation(options)`

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

### Engine (`StreamingPunctuationEngine`)

#### `engine.punctuate(textIn, textOut, options?)`

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

- Both `textIn` and `textOut` must be live text buffers (`txt_live_*`).
- Input/output kind mismatch is rejected with `PUNCTUATION_INVALID_ARGUMENT`.
- `segmentation.mode: 'auto'` attaches the segmentation engine to input text.
- `textInputNormalization` (default `'lower'`): lowercases each input segment before inference. Use `'none'` to keep upstream casing (not recommended for ALL-CAPS ASR).
- `text_punctuation_assisted` segmentation commits at the **first** sentence boundary in punctuated text (not the last), so partial buffers are not re-committed wholesale on every STT update once punctuation inserts `.?!`.
- **Do not** attach `text_punctuation_assisted` to a live buffer that already receives upstream `commitSegment` rows (e.g. pipelined `stt → punctuation`). Use `segmentation: { mode: 'off' }` and let the punctuation worker drain upstream segments only.

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

### Pipeline handle (`PunctuationPipelineHandle`)

Typed like other streaming handles (`stop`, `flush`, `reset`, `getStatus`). **`completed`** resolves with **`StreamingPipelineCompletion`** when the native worker finishes (same contract as STT/TTS; see [streaming-pipelines-overview.md](streaming-pipelines-overview.md)).

#### `pipeline.stop()`

```ts
stop(): Promise<void>;
```

**Hard teardown** of the punctuation worker. Use when cancelling or before releasing buffers if the worker might still be running.

#### `pipeline.flush()`

```ts
flush(): Promise<void>;
```

**Drain barrier on the segment log:** drains any **unread committed segments** on the live **input**, runs **`addPunctuation`**, and commits results to **`textOut`**. After the live **input** is **`finalizeLiveTextBuffer`**, you **must** call **`flush()`** (then **`stop()`** / **`completed`**) so the worker can finish and so `flush()` does not race a worker that already exited — see Quick start.

**Contract:** after **`finalizeLiveTextBuffer`** on the live **input** text buffer, call **`pipeline.flush()`** so the worker can drain any tail segments and exit. Then **`pipeline.stop()`** and **`await pipeline.completed`**. Omitting **`flush()`** after a finished input leaves the worker running until **`stop()`**. This is **not** “pipeline flush before text finalize”: finalize the **buffer** first, then pipeline **`flush`** — flushing while the input is still `recording` does not prevent later segments (e.g. committed at finalize).

#### `pipeline.reset()`

```ts
reset(): Promise<void>;
```

Clears **online punctuation** internal stream state where supported; pipeline may **continue running**. Prefer **`stop()`** for full teardown.

#### `pipeline.getStatus()`

```ts
getStatus(): Promise<StreamingPipelineStatus>;
```

```ts
const status = await pipeline.getStatus();
console.log(status.isRunning, status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

#### `pipeline.completed`

Await after **`flush()`** / **`stop()`** in the recommended order so teardown and buffer release do not race.

## Segmentation

Streaming punctuation supports all segmentation modes because it operates on live text streams and can attach/detach segmentation around an active pipeline.

- `'off'` (default): input live text segments are consumed as committed.
- `'manual'`: boundaries come from external segment control.
- `'auto'`: segmentation engine auto-attaches to input and uses policy boundaries.

Default streaming punctuation policy evaluator: `text_punctuation_assisted`.

```ts
const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: {
    mode: 'auto',
    policy: {
      evaluator: 'text_punctuation_assisted',
      sentenceBoundary: true,
      maxLengthChars: 500,
    },
  },
});
```

See [segmentation-engine.md](segmentation-engine.md) for full policy/lifecycle semantics.

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

## Types and constants

```ts
import {
  createStreamingPunctuation, // create streaming punctuation engine
  detectPunctuationModel, // detect punctuation model family/layout
} from 'react-native-sherpa-onnx/punctuation';

import type {
  StreamingPunctuationEngine, // streaming punctuation engine interface
  StreamingPunctuationInitializeOptions, // init options for online punctuation
  StreamingPunctuationOptions, // pipeline options including segmentation
  PunctuationPipelineHandle, // control handle for running punctuation pipeline
  OnlinePunctuationModelType, // 'cnn_bilstm' | 'auto'
  PunctuationModelType, // 'ct_transformer' | 'cnn_bilstm' | 'auto' (detection)
  PunctuationDetectModelResult, // detect result shape from native/model scan
} from 'react-native-sherpa-onnx/punctuation';

import type {
  StreamingPipelineStatus, // common status payload for streaming pipeline handles
} from 'react-native-sherpa-onnx/audiobuffer';
```

## Error codes

Typical error codes surfaced by JS/native layers for streaming punctuation.

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

## See also

- [Punctuation (offline)](punctuation-offline.md)
- [Text buffers — streaming](textbuffer-streaming.md)
- [Text buffers — offline](textbuffer-offline.md)
- [STT streaming](stt-streaming.md)
- [TTS offline](tts-offline.md)
- [Segmentation engine](segmentation-engine.md)
- [Model setup](model-setup.md)
- [Execution providers](execution-providers.md)

## Use case examples

<details>
<summary>Live punctuation for ASR partial/final segment feed</summary>

```ts
// textIn receives plain ASR segments; punctuation pipeline writes punctuated segments to textOut
const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: { mode: 'off' },
});

await appendLiveTextSegment(textIn, 'hello this is an asr output segment');
await appendLiveTextSegment(textIn, 'it has no punctuation markers yet');
await finalizeLiveTextBuffer(textIn);

await pipeline.flush();
```

</details>

<details>
<summary>Auto segmentation for long live text streams</summary>

```ts
const pipeline = await engine.punctuate(textIn, textOut, {
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_punctuation_assisted', maxLengthChars: 500 },
  },
});

const status = await pipeline.getStatus();
console.log(status.chunksProcessed, status.unitsRead, status.unitsWritten);
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

