# Pipeline text buffers — offline (`textbuffer`)

**Immutable offline text payloads** with optional metadata (tokens, timestamps, durations, lang, emotion, event). Used for **batch** STT outputs and consumers like alignment or offline TTS.

**Import path:** `react-native-sherpa-onnx/textbuffer`

For offline transcription writing into text buffers, see [stt-offline.md](stt-offline.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline text buffer](textbuffer-offline.md)** | Immutable text snapshot with optional token/time metadata. | Batch STT result sink, post-processing, alignment input, lazy slice reads. |
| **[Live text buffer](textbuffer-streaming.md)** | Incremental text stream (`recording` -> `finished`) with in-memory window and optional spool-backed full history. | Streaming STT/TTS pipelines, partial UI updates, segment-oriented flows. |

Offline buffers are read-heavy: you create/populate once, then access content with **slice APIs** instead of copying large payloads through JS.

---

## Quick start: STT -> OfflineTextBuffer

```ts
import { createSTT } from 'react-native-sherpa-onnx/stt';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getPipelineTextBufferInfo,
  getOfflineTextBufferTextSlice,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-whisper-tiny-en' },
  modelType: 'auto',
});

const audio = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/tmp/input.wav',
});
const textOut = await createEmptyOfflineTextBuffer();

try {
  await stt.transcribe(audio, textOut);
  const info = (await getPipelineTextBufferInfo(textOut)) as OfflineTextBufferInfo;
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(audio);
  await releasePipelineTextBuffer(textOut);
  await stt.destroy();
}
```

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/textbuffer`.

Ref-first usage is recommended: pass `OfflineTextBufferRef` directly.

### General

#### `getPipelineTextBufferInfo(buffer)`

```ts
function getPipelineTextBufferInfo(
  buffer: PipelineTextBufferIdSource
): Promise<PipelineTextBufferInfo>;
```

```ts
const info = await getPipelineTextBufferInfo(textOut);
console.log(info.kind, info.state);
```

#### `releasePipelineTextBuffer(buffer)`

```ts
function releasePipelineTextBuffer(
  buffer: PipelineTextBufferIdSource
): Promise<void>;
```

```ts
await releasePipelineTextBuffer(textOut);
```

### Offline buffer creation

#### `createEmptyOfflineTextBuffer()`

```ts
function createEmptyOfflineTextBuffer(): Promise<OfflineTextBufferRef>;
```

```ts
const out = await createEmptyOfflineTextBuffer();
console.log(out.info.kind, out.bufferId);
```

### Offline buffer getters

#### `getOfflineTextBufferTextSlice(buffer, startUtf16, maxUtf16)`

```ts
function getOfflineTextBufferTextSlice(
  buffer: OfflineTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string>;
```

```ts
const text = await getOfflineTextBufferTextSlice(out, 0, 512);
```

#### `getOfflineTextBufferTokensSlice(buffer, start, maxCount)`

```ts
function getOfflineTextBufferTokensSlice(
  buffer: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<string[]>;
```

```ts
const tokens = await getOfflineTextBufferTokensSlice(out, 0, 128);
```

#### `getOfflineTextBufferTimestampsSlice(buffer, start, maxCount)`

```ts
function getOfflineTextBufferTimestampsSlice(
  buffer: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]>;
```

```ts
const timestamps = await getOfflineTextBufferTimestampsSlice(out, 0, 128);
```

#### `getOfflineTextBufferDurationsSlice(buffer, start, maxCount)`

```ts
function getOfflineTextBufferDurationsSlice(
  buffer: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]>;
```

```ts
const durations = await getOfflineTextBufferDurationsSlice(out, 0, 128);
```

#### `getOfflineTextBufferLang(buffer)` / `getOfflineTextBufferEmotion(buffer)` / `getOfflineTextBufferEvent(buffer)`

```ts
function getOfflineTextBufferLang(buffer: OfflineTextBufferIdSource): Promise<string>;
function getOfflineTextBufferEmotion(buffer: OfflineTextBufferIdSource): Promise<string>;
function getOfflineTextBufferEvent(buffer: OfflineTextBufferIdSource): Promise<string>;
```

```ts
const [lang, emotion, event] = await Promise.all([
  getOfflineTextBufferLang(out),
  getOfflineTextBufferEmotion(out),
  getOfflineTextBufferEvent(out),
]);
```

### Conversion: LiveTextBuffer --> OfflineTextBuffer

#### `createOfflineTextBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineTextBufferFromLive(
  liveBuffer: LiveTextBufferIdSource,
  mode?: OfflineTextBufferFromLiveMode
): Promise<OfflineTextBufferRef>;
```

```ts
const full = await createOfflineTextBufferFromLive(live, 'fullIfSpooled');
const windowOnly = await createOfflineTextBufferFromLive(live, 'windowSnapshot');
```

`mode` semantics:
- `windowSnapshot`: current live in-memory window.
- `fullIfSpooled`: full text from live spool only (strict; rejects if spool unavailable/corrupt).

---

## Error code quick table

The following codes are the relevant runtime outcomes for offline text-buffer reads and live-to-offline conversion in this document.

| Code | Meaning |
| --- | --- |
| `TEXT_BUFFER_NOT_FOUND` | Referenced text buffer id does not exist |
| `TEXT_BUFFER_KIND_MISMATCH` | Buffer kind does not match called API (offline vs live) |
| `TEXT_INVALID_ARGUMENT` | Invalid argument or malformed buffer id |
| `TEXT_INVALID_STATE` | Operation is not allowed in the current buffer state |
| `TEXT_ALREADY_FINALIZED` | A recording-only operation was called on a finished live buffer during conversion flows |
| `TEXT_SLICE_INVALID` | Slice range is invalid (e.g. negative or out of bounds) |
| `TEXT_SLICE_TOO_LARGE` | Requested slice exceeds native safety limits |
| `TEXT_SPOOL_UNAVAILABLE` | `fullIfSpooled` requested but spool is disabled/unavailable |
| `TEXT_SPOOL_WRITE_FAILED` | Live text spool write failed while producing text |
| `TEXT_SPOOL_READ_FAILED` | Reading spool data for snapshot failed |
| `TEXT_SPOOL_CORRUPTED` | Spool content/format is corrupted or inconsistent |
| `TEXT_INTERNAL_ERROR` | Generic native text buffer failure |

---

## See also

- [Pipeline text buffers — live / streaming](textbuffer-streaming.md)
- [Offline STT](stt-offline.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
