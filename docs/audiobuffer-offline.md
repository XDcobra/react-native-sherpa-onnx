# Pipeline audio buffers — offline (`audiobuffer`)

**Immutable offline clips** (full PCM on the native side): file-backed or in-memory. Used as input/output for **batch** STT, TTS, alignment, and enhancement.

**Import path:** `react-native-sherpa-onnx/audiobuffer`

For decode helpers (FFmpeg, WAV conversion), see `react-native-sherpa-onnx/audio` and [audio-conversion.md](audio-conversion.md). Overview of both buffer kinds: [Pipeline audio buffers — overview](audiobuffer.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline buffer](audiobuffer-offline.md)** | One-shot, **immutable** clip: full PCM decoded on the native side (small clips in memory, large WAVs often **file-backed**). | Batch STT/TTS/alignment, preparing a file once, then feeding it into APIs via a **buffer ref/id** (prefer refs) instead of a huge float array in JS. |
| **[Live buffer](audiobuffer-streaming.md)** | **Rolling** window (ring) plus optional **spool** for long sessions; lifecycle **`recording` → `finished`**. Mic, file replay, and native pipeline workers all **append** on the native side. | Mic capture, streaming STT/enhancement, waveform UI, any stage that must grow over time while another native consumer **drains** the same buffer. |

**Offline and live work together:** both are referenced by **stable buffer ids** and the same TurboModule surface. From JS you can build **offline → live** (`appendOfflineToLiveAudioBuffer`, documented on the [live / streaming](audiobuffer-streaming.md) page) and **live → offline** with **`createOfflineAudioBufferFromLive`** below.

**Why this is fast:** apps orchestrate with **ids and small control calls**; bulk audio is not shuttled through the JS bridge sample-by-sample. Native code owns decode, resampling, and backing storage; live buffers add a native ring and optional spool I/O.

---

## Main API (summary)

### General

- `getPipelineAudioBufferInfo`, `releasePipelineAudioBuffer`

### Offline buffer

- `createOfflineAudioBufferFromFile`, `createOfflineAudioBufferFromSamples`, `createOfflineAudioBufferFromLive`, `saveOfflineAudioBufferToWav`

Types: see [`src/audiobuffer/types.ts`](../src/audiobuffer/types.ts). Offline create helpers return **`OfflineAudioBufferRef`** (`info` + `OfflineBufferHandle`). Buffer parameters use **`OfflineAudioBufferIdSource`** or **`PipelineAudioBufferIdSource`**: pass the ref, last **`PipelineAudioBufferInfo`**, a branded handle, or a raw string id.

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

#### `releasePipelineAudioBuffer(buffer)`

```ts
function releasePipelineAudioBuffer(buffer: PipelineAudioBufferIdSource): Promise<void>;
```

```ts
await releasePipelineAudioBuffer(offline);
```

### Offline buffer

#### `createOfflineAudioBufferFromFile(sourcePath, targetSampleRateHz?, forceMono?)`

```ts
function createOfflineAudioBufferFromFile(
  sourcePath: string,
  targetSampleRateHz?: number,
  forceMono?: boolean
): Promise<OfflineAudioBufferRef>;
```

```ts
const offline = await createOfflineAudioBufferFromFile('/tmp/input.wav', 16000, true);
console.log(offline.info.sampleRate, offline.info.bufferId);
```

#### `createOfflineAudioBufferFromSamples(samples, sampleRate, channelCount?)`

```ts
function createOfflineAudioBufferFromSamples(
  samples: number[],
  sampleRate: number,
  channelCount?: number
): Promise<OfflineAudioBufferRef>;
```

```ts
const offline = await createOfflineAudioBufferFromSamples([0.1, 0.2, 0.3], 16000, 1);
```

#### `saveOfflineAudioBufferToWav(buffer, outputPath)`

```ts
function saveOfflineAudioBufferToWav(
  buffer: OfflineAudioBufferIdSource,
  outputPath: string
): Promise<void>;
```

```ts
await saveOfflineAudioBufferToWav(offline, '/tmp/offline.wav');
```

### Conversion: Offline buffer <--> Online buffer

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

---

## See also

- [Pipeline audio buffers — overview](audiobuffer.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)
- [Offline STT](stt-offline.md)
- [PCM Player & `pcm-stream` import](pcm-stream.md)
