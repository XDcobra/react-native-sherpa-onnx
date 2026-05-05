# Punctuation (offline)

## Introduction

**CT-Transformer** batch punctuation: **Input** = populated [offline text buffer](textbuffer-offline.md) (`lang` pass-through, not from the model). **Output** = empty buffer, one write; v1 leaves tokens/timestamps/etc. empty. **Return value** in JS always includes `processingTimeMs`; when segmentation is enabled it also includes orchestration fields (`status`, segment counters, optional failed/skipped segment details). Engine: `createOfflinePunctuation` → `punctuate` / `punctuateString`.

`react-native-sherpa-onnx/punctuation` — loads **offline CT** only; online CNN is out of scope here ([`detectPunctuationModel`](#model-detection) for family checks). The offline engine supports both batch `txt_off_*` and the Phase-3 live overload `punctuate(txt_live_*, txt_live_*, { segmentation })`. For online CNN pipelines, see [punctuation-streaming.md](punctuation-streaming.md).

Live-overload contract references:

- Design note: [offline-stt-live-pipeline-mandatory-segmentation.md](migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md)
- Overview: [live_overload_overview.md](migration/liveOverload/live_overload_overview.md)
- Phase plan: [sub-04-punctuation-live-overload.md](migration/liveOverload/sub-04-punctuation-live-overload.md)

---

## Models and paths

**`FileSource`** (`{ kind: 'fs' | 'app' | 'pad', path, ... }`) for **`createOfflinePunctuation`**. **`FileSource`** for **`detectPunctuationModel`**. See [download-manager.md](download-manager.md), [model-setup.md](model-setup.md). **Init** always re-runs **ct_transformer** detect (no CNN fallback) — online-only trees **fail** init.

## Model detection

`detectPunctuationModel` = **pre-check** only (no engine load). Splits **ct_transformer** vs **cnn_bilstm**+bpe; `modelType` = `auto` | `ct_transformer` | `cnn_bilstm`. Optional `assetName` for catalog hints. Returns `paths.*`, `isStreaming` (reserved), `detectionSources`; vocabs come from **ONNX**, not a separate tokens arg.

`detectPunctuationModel` with `auto` can succeed while **still** not CT-only — `createOfflinePunctuation` only accepts a valid **CT offline** directory. `FILEIO_*` if `FileSource` resolution fails.

---

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

// Same directory, two path shapes: FileSource for detect, FileSource for init/resolveModelPath.
const modelDirFs = { kind: 'fs' as const, path: '/absolute/path/to/sherpa-onnx-punct-ct-en' };
const modelPath = { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-punct-ct-en' };

// Pre-flight: ensure the pack looks like a punctuation model and note ct vs cnn.
const det = await detectPunctuationModel(modelDirFs, { modelType: 'auto' });
if (!det.success) {
  throw new Error(det.error ?? 'Punctuation detection failed');
}

// Load the native OfflinePunctuation (ct_transformer only inside native).
// resolveModelPath turns FileSource into an absolute path the native side can open.
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

---

## Live overload (Phase 3)

`createOfflinePunctuation()` now also supports a live-buffer overload:

- Input: `LiveTextBuffer` (`txt_live_*`)
- Output: `LiveTextBuffer` (`txt_live_*`)
- Required option: `segmentation.policy` (mode must not be `off`)
- Return type: `PunctuationPipelineHandle` (`stop`, `flush`, `reset`, `getStatus`, `completed`)
- Output semantics: commit-only segments (`onSegment` optional mirror callback), no partials

```ts
const punct = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/absolute/path/to/sherpa-onnx-punct-ct-en' },
});

const handle = await punct.punctuate(
  'txt_live_11111111-1111-1111-1111-111111111111',
  'txt_live_22222222-2222-2222-2222-222222222222',
  {
    segmentation: {
      mode: 'auto',
      policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 500 },
    },
    onSegment: (segment) => {
      console.log('Committed punctuated segment:', segment.text);
    },
  }
);

await handle.flush();
await handle.stop();
await punct.destroy();
```

For live-overload validation, missing/invalid segmentation uses `LIVE_OFFLINE_SEGMENTATION_REQUIRED` (shared with other live-overload features per the design/overview docs above).

---

## Data model and lifetime

| Item | Behaviour |
| --- | --- |
| **Offline punctuation engine** | Created with **`createOfflinePunctuation`**. Holds native **`OfflinePunctuation`**. Call **`destroy()`** when done. |
| **`OfflineTextBuffer` (input)** | **Populated** (immutable). Must contain the **plain** text to punctuate. |
| **`OfflineTextBuffer` (output)** | **Empty** before **`punctuate` / `punctuateString`**. Filled **once** with punctuated `text` and `lang` **from input** (buffer path only for `lang`). |
| **Result in JS** | **`{ processingTimeMs: number }`** only (native add-punctuation duration). Read full text with **`getOfflineTextBufferTextSlice`**. |

---

## Setup (iOS and Android)

| Topic | Requirement |
| --- | --- |
| **Execution provider** | Optional **`provider`** on init (e.g. **`cpu`**); see [execution-providers.md](execution-providers.md). |
| **Model layout** | **Offline CT-Transformer** only. Online CNN packs **cannot** drive **`createOfflinePunctuation`**. |
| **Instance lifetime** | Always **`destroy()`** the engine; **`releasePipelineTextBuffer()`** on created buffers. |

On module teardown, native text registry invalidation and offline engine teardown follow the same ordering as other features (see native **`invalidate`** ordering).

---

## API reference

Signatures are exported from **`react-native-sherpa-onnx/punctuation`**. Types are defined in **`src/punctuation/types.ts`**; detection types mirror **`src/punctuation/detect.ts`** and **`PunctuationDetectModelResult`**.

### Detection

#### `detectPunctuationModel(source, options?)`

```ts
function detectPunctuationModel(
  source: FileSource,
  options?: { modelType?: PunctuationModelType; assetName?: string }
): Promise<PunctuationDetectModelResult>;
```

**`PunctuationModelType`:** `'ct_transformer' | 'cnn_bilstm' | 'auto'`

```ts
const pre = await detectPunctuationModel(
  { kind: 'fs', path: '/data/models/punct-pack' },
  { modelType: 'auto' }
);
if (pre.success) {
  console.log(pre.modelType, pre.paths?.ct_transformer);
}
```

### Factory

#### `createOfflinePunctuation(options)`

```ts
function createOfflinePunctuation(
  options: OfflinePunctuationInitializeOptions
): Promise<OfflinePunctuationEngine>;
```

```ts
// OfflinePunctuationInitializeOptions (see src/punctuation/types.ts)
type OfflinePunctuationInitializeOptions = {
  modelSource: FileSource;
  modelType?: 'ct_transformer' | 'auto';
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};
```

```ts
const engine = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/abs/path/to/ct-punctuation-model' },
  modelType: 'auto',
  numThreads: 1,
  provider: 'cpu',
  debug: false,
});
```

- If native init **rejects** (e.g. not CT), the promise **rejects** with a **`PUNCTUATION_*`** or **`PUNCT_DETECT_ERROR`**-related code. If a legacy bridge ever **resolves** with `{ success: false }`, **`createOfflinePunctuation`** throws a **`Error`** with a short message so callers do not get a no-op engine.

### Offline engine (`OfflinePunctuationEngine`)

#### `engine.punctuate(textIn, textOut)`

```ts
punctuate(
  textIn: OfflineTextBufferIdSource,
  textOut: OfflineTextBufferIdSource
): Promise<OfflinePunctuateResult>;
```

- **`textIn`:** **Populated** **`OfflineTextBuffer`**. `txt_off_*` id.
- **`textOut`:** **Empty** **`OfflineTextBuffer`**. `txt_off_*` id. Written **once**.

```ts
import {
  createEmptyOfflineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const inBuf = /* populated OfflineTextBufferRef */;
const outBuf = await createEmptyOfflineTextBuffer();
const { processingTimeMs } = await engine.punctuate(inBuf, outBuf);
```

#### `engine.punctuateString(plain, textOut)`

```ts
punctuateString(plain: string, textOut: OfflineTextBufferRef): Promise<OfflinePunctuateResult>;
```

- **`textOut`:** must be **empty** before the call. **`lang` on the output** is not taken from a buffer (stays **empty** unless you later edit buffer metadata in your app, which the engine does not do in v1).

```ts
const out = await createEmptyOfflineTextBuffer();
await engine.punctuateString('unpunctuated input here', out);
```

#### `engine.instanceId`

```ts
readonly instanceId: string;
```

```ts
console.log(engine.instanceId); // e.g. punc_off_1
```

#### `engine.destroy()`

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

---

## Pipeline text buffers (input and output)

```ts
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
```

See [textbuffer — offline](textbuffer-offline.md) and [textbuffer — streaming](textbuffer-streaming.md) for the live side of the pipeline.

## Segmentation

Offline punctuation runs CT-Transformer in batch mode. For very large texts, a single pass can increase memory pressure on constrained devices. Segmentation splits text into bounded chunks, runs punctuation chunk-by-chunk, then merges output order-preservingly. This reduces peak memory, with a possible small quality tradeoff around chunk boundaries.

Supported modes for offline punctuation:

- `'off'` (default): process full input text in one pass.
- `'auto'`: split text by policy and punctuate each segment.

`'manual'` is not supported for offline punctuation.

Default policy evaluator: `text_synthetic_auto` (`sentenceBoundary: true`, `maxLengthChars: 500`).

```ts
import { createOfflinePunctuation } from 'react-native-sherpa-onnx/punctuation';
import {
  createOfflineTextBufferFromText,
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

const punct = await createOfflinePunctuation({
  modelSource: { kind: 'fs', path: '/path/to/punctuation-ct' },
  modelType: 'auto',
});

const textIn = await createOfflineTextBufferFromText(longPlainText, { lang: 'en' });
const textOut = await createEmptyOfflineTextBuffer();

try {
  const result = await punct.punctuate(textIn, textOut, {
    segmentation: { mode: 'auto' },
    errorRecovery: 'skip',
    maxRetriesPerSegment: 2,
  });
  console.log(result.processingTimeMs, result.completedSegments, result.totalSegments);

  const info = await getPipelineTextBufferInfo(textOut);
  console.log(await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length));
} finally {
  await releasePipelineTextBuffer(textIn);
  await releasePipelineTextBuffer(textOut);
  await punct.destroy();
}
```

See [segmentation-engine.md](segmentation-engine.md) for shared segmentation behavior and [memory-and-models.md](memory-and-models.md) for memory tradeoffs.

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

## Types and constants

```ts
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import type {
  OfflinePunctuateResult,
  OfflinePunctuationEngine,
  OfflinePunctuationInitializeOptions,
  PunctuationDetectModelResult,
  PunctuationModelType,
} from 'react-native-sherpa-onnx/punctuation';
```

- **`PunctuationModelType` (detection):** includes **`'ct_transformer' | 'cnn_bilstm' | 'auto'`** (see `src/punctuation/detect.ts`). Init-only types use **`OfflinePunctuationModelType`** (`'ct_transformer' | 'auto'`).

- **`OfflinePunctuateResult`:** `{ processingTimeMs: number }`
- **`OfflinePunctuationModelType` (init):** `'ct_transformer' | 'auto'`

---

## Error codes

Typical **promise rejection `code`** strings (Android / iOS native). User-visible **message** text can vary; prefer **`code`** for branching. **`FILEIO_*`** may appear when resolving paths before native runs.

| Error code | Explanation |
| --- | --- |
| `PUNCT_DETECT_ERROR` | `detectPunctuationModel` failed (null result, exception, or unusable layout for detection). |
| `PUNCTUATION_INIT_ERROR` | `createOfflinePunctuation` / `initializeOfflinePunctuation` failed: not a CT layout, missing `ct_transformer` onnx path, unsupported `modelType` for offline, or native construct failure. |
| `PUNCTUATION_ERROR` | Punctuation **inference** or unexpected runtime failure (e.g. `addPunctuation` threw on native). |
| `PUNCTUATION_INSTANCE_NOT_FOUND` | `instanceId` does not match a loaded engine (e.g. wrong id or already **destroyed**). |
| `TEXT_BUFFER_NOT_FOUND` | `textIn` or `textOut` id is missing from the text registry. |
| `TEXT_BUFFER_KIND_MISMATCH` | Not an **offline** buffer id (`txt_off_*` required). |
| `TEXT_BUFFER_EMPTY` | `textIn` is not populated (input must have text). |
| `TEXT_ALREADY_POPULATED` | `textOut` was already populated; output must be **empty**. |
| `FILEIO_*` | File / URI resolution for **`FileSource`** before or during `resolveModelPath` (if applicable to your `modelPath` kind). |

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
