# Pipeline audio buffers — offline (`audiobuffer`)

## Introduction

**Immutable offline clips** (full PCM on the native side): file-backed or in-memory. Used as input/output for **batch** STT, TTS, alignment, and enhancement.

**Import path:** `react-native-sherpa-onnx/audiobuffer`

For decode/save helpers, see `react-native-sherpa-onnx/audio` and [audio-conversion.md](audio-conversion.md). For live/ring-buffer workflows, see [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md).

Practical default policy: buffers are `16000` Hz unless you explicitly choose a different rate (`targetSampleRateHz: 0` to keep source/native rate, or `targetSampleRateHz > 0` for an explicit target).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline buffer](audiobuffer-offline.md)** | One-shot, **immutable** clip: full PCM decoded on the native side (small clips in memory, large WAVs often **file-backed**). | Batch STT/TTS/alignment, preparing a file once, then feeding it into APIs via a **buffer ref/id** (prefer refs) instead of a huge float array in JS. |
| **[Live buffer](audiobuffer-streaming.md)** | **Rolling** window (ring) plus optional **spool** for long sessions; lifecycle **`recording` → `finished`**. Mic, file replay, and native pipeline workers all **append** on the native side. | Mic capture, streaming STT/enhancement, waveform UI, any stage that must grow over time while another native consumer **drains** the same buffer. |

**Offline and live work together:** both are referenced by **stable buffer ids** and the same TurboModule surface. From JS you can build **offline → live** (`appendOfflineToLiveAudioBuffer`, documented on the [live / streaming](audiobuffer-streaming.md) page) and **live → offline** with **`createOfflineAudioBufferFromLive`** below.

**Why this is fast:** apps orchestrate with **ids and small control calls**; bulk audio is not shuttled through the JS bridge sample-by-sample. Native code owns decode, resampling, and backing storage; live buffers add a native ring and optional spool I/O.

When this buffer is used in a playback or mic+playback pipeline, choose input/output devices through `react-native-sherpa-onnx/audio` with `setPipelineAudioRoutePreference(...)` (and `listAvailableInputDevices()` / `listAvailableOutputDevices()`).

---

## Main API (summary)

### General

- `getPipelineAudioBufferInfo`, `releasePipelineAudioBuffer`

### Offline buffer

- `createEmptyOfflineAudioBuffer`, `createOfflineAudioBufferFromFile`, `createOfflineAudioBufferFromSamples`, `createOfflineAudioBufferFromLive`
- `getOfflineAudioBufferSamplesSlice`
- `installJSI`, `isJSIAvailable`

Types: see [`src/audiobuffer/types.ts`](../src/audiobuffer/types.ts). Offline create helpers return **`OfflineAudioBufferRef`** (`info` + `OfflineBufferHandle`). Buffer parameters use **`OfflineAudioBufferIdSource`** or **`PipelineAudioBufferIdSource`**: pass the ref, last **`PipelineAudioBufferInfo`**, a branded handle, or a raw string id.

---

## Quick start

```ts
import {
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  createOfflineAudioBufferFromSamples,
  getPipelineAudioBufferInfo,
  getOfflineAudioBufferSamplesSlice,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

// 1) Decode once on native side (optional resample/downmix during decode).
const fromFile = await createOfflineAudioBufferFromFile(
  { kind: 'fs', path: '/tmp/input.wav' },
  { targetSampleRateHz: 16000, forceMono: true }
);

// 2) Prepare an empty output buffer for batch producers (for example TTS output).
const output = await createEmptyOfflineAudioBuffer(16000);

// 3) Read a small slice for UI/debug without copying full PCM into JS.
const head = getOfflineAudioBufferSamplesSlice(fromFile, 0, 320);
console.log(head.length);

// 4) Inspect metadata and release when done.
const info = await getPipelineAudioBufferInfo(fromFile);
console.log(info.kind, info.sampleRate, info.durationMs);

const fromSamples = createOfflineAudioBufferFromSamples(new Float32Array([0.1, 0.2, 0.3]), 16000);
await releasePipelineAudioBuffer(fromFile);
await releasePipelineAudioBuffer(fromSamples);
await releasePipelineAudioBuffer(output);
```

The common pattern is: create/decode once, pass refs/ids to batch feature APIs, then release buffers explicitly.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/audiobuffer`. Unless noted, buffer arguments accept the matching `*IdSource` union (ref, info snapshot, handle, or string).

Ref-first usage is recommended: pass the buffer ref directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT`.

### General

#### `getPipelineAudioBufferInfo(buffer)`

```ts
function getPipelineAudioBufferInfo(
  buffer: PipelineAudioBufferIdSource
): Promise<PipelineAudioBufferInfo>;
```

```ts
const info = await getPipelineAudioBufferInfo(offline);
console.log(info.kind, info.state);
```

`OfflineAudioBufferInfo` includes an optional `storageKind?: 'ram' | 'mmap'`.
- Default: `'ram'` (when `storageKind` is omitted / `undefined`)
- `storageKind: 'mmap'` indicates a file-backed / memory-mapped backing strategy.

#### `releasePipelineAudioBuffer(buffer)`

```ts
function releasePipelineAudioBuffer(buffer: PipelineAudioBufferIdSource): Promise<void>;
```

```ts
await releasePipelineAudioBuffer(offline);
```

### Offline buffer

#### `createOfflineAudioBufferFromFile(source, options?)`

```ts
function createOfflineAudioBufferFromFile(
  source: FileSource,
  options?: AudioDecodeOptions
): Promise<OfflineAudioBufferRef>;
```

```ts
const offline = await createOfflineAudioBufferFromFile(
  { kind: 'fs', path: '/tmp/input.wav' },
  { targetSampleRateHz: 16000, forceMono: true }
);
console.log(offline.info.sampleRate, offline.info.bufferId);

// From a content URI (Android):
const fromUri = await createOfflineAudioBufferFromFile({ kind: 'contentUri', uri: pickedUri });

// With progress + cancellation:
const controller = new AbortController();
const decoded = await createOfflineAudioBufferFromFile(
  { kind: 'fs', path: '/tmp/input.flac' },
  {
    targetSampleRateHz: 16000,
    onProgress: (event) => console.log(event.percent),
    signal: controller.signal,
  }
);
```

The decode path uses FFmpeg plus a WAV fast path internally. `FileSource` resolution is shared with `react-native-sherpa-onnx/fileio`, so `fs`, `app`, `contentUri`, `securityScoped`, and `pad` sources follow the same native resolver rules.

When you only need **duration** and not PCM, use [`probeAudioFileDuration`](./audio-conversion.md#probeaudiofiledurationsource) from `react-native-sherpa-onnx/audio` instead of creating an offline buffer. To read **container format and codec** from file content before decode, use [`probeAudioFileContainer`](./audio-conversion.md#probeaudiofilecontainersource).

Options:

- `targetSampleRateHz`: decode target rate semantics:
  - omit / `undefined` → `16000` Hz
  - `0` → keep source rate
  - `> 0` → resample to that exact rate
- `forceMono`: downmix during decode; default `true`
- `onProgress`: receives `DecodeProgressEvent`
- `signal`: aborts decode and rejects with `DECODE_CANCELLED`

#### `createOfflineAudioBufferFromSamples(samples, inputSampleRateHz, channelCountOrOptions?, options?)`

```ts
function createOfflineAudioBufferFromSamples(
  samples: Float32Array,
  inputSampleRateHz: number,
  channelCountOrOptions?: number | { targetSampleRateHz?: number },
  options?: { targetSampleRateHz?: number }
): OfflineAudioBufferRef;
```

```ts
const offline = createOfflineAudioBufferFromSamples(
  new Float32Array([0.1, 0.2, 0.3]),
  16000,
  1,
  { targetSampleRateHz: 0 }
);
```

This path is synchronous and uses JSI (`ArrayBuffer`/`Float32Array`) for bulk sample transport.

`targetSampleRateHz` semantics for samples import:

- omit / `undefined` → `16000` Hz
- `0` → keep `inputSampleRateHz`
- `> 0` → resample to that exact rate before writing to the offline buffer

#### `createEmptyOfflineAudioBuffer(sampleRate, channelCount?)`

```ts
function createEmptyOfflineAudioBuffer(
  sampleRate: number,
  channelCount?: 1
): Promise<OfflineAudioBufferRef>;
```

```ts
const emptyOut = await createEmptyOfflineAudioBuffer(22050);
console.log(emptyOut.info.numSamples); // 0
```

Creates an empty offline buffer that can be populated by native pipeline producers (for example TTS/Enhancement output).
The buffer starts unpopulated (`numSamples = 0`) and remains immutable once native writing completes.

#### `getOfflineAudioBufferSamplesSlice(offlineBuffer, startFrame, frameCount)`

```ts
function getOfflineAudioBufferSamplesSlice(
  offlineBuffer: OfflineAudioBufferIdSource,
  startFrame: number,
  frameCount: number
): Float32Array;
```

```ts
const head = getOfflineAudioBufferSamplesSlice(offline, 0, 320);
```

Supports both in-memory offline buffers (`info.storageKind === 'ram'`) and file-backed offline buffers (`info.storageKind === 'mmap'`).

#### Convert offline buffer to file

Use the audio save module for all output formats, including WAV:

```ts
import { saveAudioAsFile, saveAudioAsWav16k } from 'react-native-sherpa-onnx/audio';

await saveAudioAsFile(offline, { kind: 'fs', path: '/tmp/offline.wav' }, 'wav');
await saveAudioAsWav16k(offline, { kind: 'fs', path: '/tmp/offline_16k.wav' });
await saveAudioAsFile(offline, { kind: 'fs', path: '/tmp/offline.flac' }, 'flac');
```

### Conversion: Offline buffer <--> Live buffer

#### `createOfflineAudioBufferFromLive(liveBuffer, mode?)`

```ts
function createOfflineAudioBufferFromLive(
  liveBuffer: LiveAudioBufferIdSource,
  mode?: OfflineFromLiveMode
): Promise<OfflineAudioBufferRef>;
```

```ts
const offlineFromLive = await createOfflineAudioBufferFromLive(live, 'fullIfSpooled');
```

## Types and constants

```ts
import type {
  OfflineAudioBufferRef, // created offline buffer ref { info, bufferId }
  OfflineAudioBufferInfo, // metadata for immutable offline PCM buffer
  OfflineAudioBufferIdSource, // ref/handle/id accepted by offline APIs
  PipelineAudioBufferInfo, // discriminated union for offline/live info
  PipelineAudioBufferIdSource, // ref/info/handle/id accepted by shared APIs
  OfflineFromLiveMode, // 'fullIfSpooled' | 'windowSnapshot'
  AudioDecodeOptions, // decode options for createOfflineAudioBufferFromFile
  DecodeProgressEvent, // progress payload during decode
  PipelineAudioErrorCodeValue, // string union of audio error codes
} from 'react-native-sherpa-onnx/audiobuffer';

import {
  PipelineAudioErrorCode, // runtime constants for error-code checks
  isJSIAvailable, // check whether JSI path is available
} from 'react-native-sherpa-onnx/audiobuffer';
```

---

## Error codes

| Code | Meaning |
| --- | --- |
| `AUDIO_BUFFER_NOT_FOUND` | Referenced pipeline audio buffer id does not exist |
| `AUDIO_BUFFER_KIND_MISMATCH` | Buffer kind does not match the called API (offline vs live) |
| `AUDIO_BUFFER_EMPTY` | Buffer has no samples for the requested operation |
| `AUDIO_INVALID_ARGUMENT` | Invalid buffer id/argument passed to API |
| `DECODE_NOT_FOUND` | Source file not found or not accessible |
| `DECODE_OPEN_FAILED` | Input could not be opened/probed by native decode |
| `DECODE_NO_AUDIO_STREAM` | Input file/container has no audio stream |
| `DECODE_CODEC_UNSUPPORTED` | Codec could not be initialized/decoded |
| `DECODE_DECODE_ERROR` | Decode loop failed while reading audio frames |
| `DECODE_RESAMPLE_ERROR` | Resample/downmix stage failed |
| `DECODE_CANCELLED` | Decode cancelled via `AbortSignal` or cancel call |
| `DECODE_PERMISSION_DENIED` | Platform denied permission to read source |
| `DECODE_INTERNAL_ERROR` | Generic native decode failure |

---

## See also

- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)
- [Offline STT](stt-offline.md)
- [PCM Player (`react-native-sherpa-onnx/pcm`)](pcm-player.md)

## Use case examples

<details>
<summary>Decode large audio once and reuse across multiple offline engines</summary>

```ts
const audio = await createOfflineAudioBufferFromFile(
  { kind: 'fs', path: '/tmp/meeting.wav' },
  { targetSampleRateHz: 16000, forceMono: true }
);

// Reuse `audio` for multiple offline passes (STT, alignment, enhancement, etc.).
// Release once all consumers are finished.
await releasePipelineAudioBuffer(audio);
```

</details>

<details>
<summary>Snapshot a finalized live session into an offline buffer</summary>

```ts
// `live` is a finalized live audio buffer from a long recording session.
const snapshot = await createOfflineAudioBufferFromLive(live, 'fullIfSpooled');
const info = await getPipelineAudioBufferInfo(snapshot);
console.log(info.durationMs, info.sampleRate);
await releasePipelineAudioBuffer(snapshot);
```

</details>
