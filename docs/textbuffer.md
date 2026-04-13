# Pipeline text buffers (`textbuffer`)

Unified **offline** and **live** native text buffers for pipeline workflows:

- Offline text buffer: immutable text payload (STT result, imported text)
- Live text buffer: rolling/streaming partial text with `recording` -> `finished`

**Import path:** `react-native-sherpa-onnx/textbuffer`

For offline transcription writing into text buffers, see [stt-offline.md](stt-offline.md).

---

## Concepts

| Kind | Meaning |
| --- | --- |
| **Offline text buffer** | Immutable text snapshot with optional tokens/timestamps/durations/lang/emotion/event metadata. |
| **Live text buffer** | Incremental partial text stream with revision counter and optional partial/error callbacks. |

Typical flow for offline STT:

1. Create empty offline text buffer.
2. Run `stt.transcribe(audioBuffer, textOutBuffer)`.
3. Read payload lazily via text slice getters.
4. Release buffer.

---

## Quick start: STT -> TextBuffer

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

const audioBuffer = await createOfflineAudioBufferFromFile('/tmp/input.wav');
const textBuffer = await createEmptyOfflineTextBuffer();

try {
  await stt.transcribe(audioBuffer, textBuffer);

  const info = (await getPipelineTextBufferInfo(textBuffer)) as OfflineTextBufferInfo;
  const text = await getOfflineTextBufferTextSlice(textBuffer, 0, info.utf16Length);
  console.log(text);
} finally {
  await releasePipelineAudioBuffer(audioBuffer);
  await releasePipelineTextBuffer(textBuffer);
  await stt.destroy();
}
```

---

## Main API (summary)

Exported from `react-native-sherpa-onnx/textbuffer`:

**General**

- `getPipelineTextBufferInfo`, `releasePipelineTextBuffer`

**Offline buffer**

- `createEmptyOfflineTextBuffer`, `createOfflineTextBufferFromLive`
- `getOfflineTextBufferTextSlice`, `getOfflineTextBufferTokensSlice`, `getOfflineTextBufferTimestampsSlice`, `getOfflineTextBufferDurationsSlice`, `getOfflineTextBufferLang`, `getOfflineTextBufferEmotion`, `getOfflineTextBufferEvent`

**Live buffer**

- `createLiveTextBuffer`, `createLiveTextBufferFromOffline`, `finalizeLiveTextBuffer`, `getLiveTextBufferPartialSlice`

Types: see [`src/textbuffer/types.ts`](../src/textbuffer/types.ts). Buffer parameters use **`OfflineTextBufferIdSource`**, **`LiveTextBufferIdSource`**, or **`PipelineTextBufferIdSource`**: you can pass the **`OfflineTextBufferRef` / `LiveTextBufferRef`**, a **`PipelineTextBufferInfo`** (e.g. last `getPipelineTextBufferInfo` result), a branded handle, or a raw string id.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/textbuffer`. Unless noted, the first buffer argument accepts the matching `*IdSource` union (ref, info snapshot, handle, or string).

### General

#### `getPipelineTextBufferInfo(buffer)`

```ts
function getPipelineTextBufferInfo(
  buffer: PipelineTextBufferIdSource
): Promise<PipelineTextBufferInfo>;
```

```ts
const info = await getPipelineTextBufferInfo(out);
console.log(info.kind, info.state);
```

#### `releasePipelineTextBuffer(buffer)`

```ts
function releasePipelineTextBuffer(buffer: PipelineTextBufferIdSource): Promise<void>;
```

```ts
await releasePipelineTextBuffer(out);
await releasePipelineTextBuffer(live);
```

### Offline buffer

#### `createEmptyOfflineTextBuffer()`

```ts
function createEmptyOfflineTextBuffer(): Promise<OfflineTextBufferRef>;
```

```ts
const out = await createEmptyOfflineTextBuffer();
console.log(out.info.kind, out.bufferId);
```

#### `createOfflineTextBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineTextBufferFromLive(
  liveBuffer: LiveTextBufferIdSource,
  mode?: OfflineTextBufferFromLiveMode
): Promise<OfflineTextBufferRef>;
```

```ts
const snapshot = await createOfflineTextBufferFromLive(live, 'fullIfSpooled');
```

#### `getOfflineTextBufferTextSlice(buffer, startUtf16, maxUtf16)`

```ts
function getOfflineTextBufferTextSlice(
  buffer: OfflineTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string>;
```

```ts
const info = (await getPipelineTextBufferInfo(out)) as OfflineTextBufferInfo;
const text = await getOfflineTextBufferTextSlice(out, 0, info.utf16Length);
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
const times = await getOfflineTextBufferTimestampsSlice(out, 0, 128);
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
const durs = await getOfflineTextBufferDurationsSlice(out, 0, 128);
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

### Live buffer

#### `createLiveTextBuffer(options?)`

```ts
function createLiveTextBuffer(
  options?: CreateLiveTextBufferOptions
): Promise<LiveTextBufferRef>;
```

```ts
const live = await createLiveTextBuffer({
  emitPartialEvents: true,
  onPartial: (e) => console.log(e.partialText),
  onError: (e) => console.warn(e.message),
});
```

#### `createLiveTextBufferFromOffline(offlineBuffer)`

```ts
function createLiveTextBufferFromOffline(
  offlineBuffer: OfflineTextBufferIdSource
): Promise<LiveTextBufferRef>;
```

```ts
const liveFromOffline = await createLiveTextBufferFromOffline(snapshot);
```

#### `finalizeLiveTextBuffer(liveBuffer)`

```ts
function finalizeLiveTextBuffer(
  liveBuffer: LiveTextBufferRecordingSource
): Promise<LiveTextBufferHandleFinished>;
```

```ts
const finished = await finalizeLiveTextBuffer(live);
```

#### `getLiveTextBufferPartialSlice(liveBuffer, startUtf16, maxUtf16)`

```ts
function getLiveTextBufferPartialSlice(
  liveBuffer: LiveTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string>;
```

```ts
const partial = await getLiveTextBufferPartialSlice(live, 0, 256);
```

---

## See also

- [Offline STT](stt-offline.md)
- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers — overview](audiobuffer.md) · [offline](audiobuffer-offline.md) · [live / streaming](audiobuffer-streaming.md)
