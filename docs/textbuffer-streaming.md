# Pipeline text buffers — live / streaming (`textbuffer`)

## Introduction

**Live native text buffers** for incremental pipelines with partial text, committed segments, and optional spool-backed full history.

**Import path:** `react-native-sherpa-onnx/textbuffer`

For streaming STT pipelines that write into live text buffers, see [stt-streaming.md](stt-streaming.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline text buffer](textbuffer-offline.md)** | Immutable snapshot for batch readers and metadata slicing. | Offline STT output, alignment input, post-processing. |
| **[Live text buffer](textbuffer-streaming.md)** | Incremental stream (`recording` -> `finished`) with partial window, segment log, optional spool. | Streaming STT/TTS, partial captions, session-local text state. |

Live buffers are **window-first** for low-latency reads.  
When you need full-history guarantees beyond the active window, enable spooling and snapshot with `createOfflineTextBufferFromLive(..., 'fullIfSpooled')`.

---

## Quick start

### Streaming STT -> LiveTextBuffer

```ts
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';

// Track the highest already-printed committed segment index.
let lastSegmentIndex = 0;
const liveAudio = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
});

const liveText = await createLiveTextBuffer({
  spooling: { mode: 'on' },
  streamEvents: { partial: { enabled: true, minIntervalMs: 0 } },
  // Event-driven partial stream: no polling timer required.
  onPartial: async (event) => {
    if (event.partialText.length > 0) {
      console.log('[partial]', event.partialText);
    }

    // Endpoint is a good checkpoint to pull newly committed segments.
    if (!event.isEndpoint) return;

    const total = await getLiveTextBufferSegmentCount(liveText);
    if (total <= lastSegmentIndex) return;

    const fresh = await getLiveTextBufferSegments(
      liveText,
      lastSegmentIndex,
      total - lastSegmentIndex
    );
    for (const segment of fresh) {
      console.log(`[segment ${segment.segmentIndex}]`, segment.text);
    }
    lastSegmentIndex = total;
  },
});

const stt = await createStreamingSTT({
  modelSource: { kind: 'app', base: 'apkAsset', path: 'models/my-streaming-model' },
  modelType: 'transducer',
});
const pipeline = await stt.transcribe(liveAudio, liveText, { chunkSize: 3200 });

await startMicToLiveAudioBuffer(liveAudio);
// ... capture ...
await stopMicToLiveAudioBuffer();

await pipeline.flush();

const segmentCount = await getLiveTextBufferSegmentCount(liveText);
const segments = segmentCount > 0 ? await getLiveTextBufferSegments(liveText, 0, segmentCount) : [];
// Final consolidated view after streaming completes.
console.log('[final segments]', segments.map((s) => s.text).join(' '));

await pipeline.stop();
await stt.destroy();
await releasePipelineTextBuffer(liveText);
await releasePipelineAudioBuffer(liveAudio);
```

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/textbuffer`.

Ref-first usage is recommended: pass `LiveTextBufferRef` directly.

Partial events: optional `streamEvents.partial` (`enabled` + `minIntervalMs`); if omitted, registering `onPartial` opts in to events (see [`CreateLiveTextBufferOptions`](../src/textbuffer/types.ts)).

### General

#### `getPipelineTextBufferInfo(buffer)`

```ts
function getPipelineTextBufferInfo(
  buffer: PipelineTextBufferIdSource
): Promise<PipelineTextBufferInfo>;
```

```ts
const info = await getPipelineTextBufferInfo(liveText);
if (info.kind === 'liveTextBuffer') {
  console.log(info.state, info.spool.mode, info.spool.ready, info.spool.bytes);
}
```

#### `releasePipelineTextBuffer(buffer)`

```ts
function releasePipelineTextBuffer(
  buffer: PipelineTextBufferIdSource
): Promise<void>;
```

```ts
await releasePipelineTextBuffer(liveText);
```

Release guarantees:
- live spool handles are closed
- temporary spool files are deleted best-effort
- module teardown releases remaining live buffers and temporary spool files

### Live buffer lifecycle

#### `createLiveTextBuffer(options?)`

```ts
function createLiveTextBuffer(
  options?: CreateLiveTextBufferOptions
): Promise<LiveTextBufferRef>;
```

```ts
const live = await createLiveTextBuffer({
  spooling: { mode: 'auto', thresholdBytes: 262144 },
  streamEvents: { partial: { enabled: true, minIntervalMs: 0 } },
  onPartial: (e) => console.log(e.partialText),
  onError: (e) => console.warn(e.message),
});
```

Spooling options:
- `mode`: `'off' | 'auto' | 'on'` (default: `'on'`)
- `path`: explicit spool file path
- `temporary`: delete spool on release (default true for auto temp paths)
- `thresholdBytes`: activation threshold for `mode: 'auto'`

**Listener cleanup:** `createLiveTextBuffer` returns a ref with an `unsubscribeEvents` function. Calling `live.unsubscribeEvents()` removes **only** the callbacks passed during this `createLiveTextBuffer` call.

#### `subscribeLiveTextBufferEvents(liveBuffer, callbacks)`

```ts
function subscribeLiveTextBufferEvents(
  liveBuffer: LiveTextBufferIdSource,
  callbacks: LiveTextBufferCallbacks
): () => void;
```

```ts
const unsub = subscribeLiveTextBufferEvents(live, {
  onPartial: (e) => console.log(e.partialText),
  onSegment: (e) => console.log(e.segment.text),
  onError: (e) => console.error(e.message),
});

// later:
unsub();
```

Use this for the **advanced "two-level" event story** (shared with `audiobuffer`):
1. **Default:** Pass callbacks to `createLiveTextBuffer` and use `live.unsubscribeEvents()`.
2. **Advanced:** Attach additional listeners later (e.g. from a different UI component) using `subscribeLiveTextBufferEvents`. The returned function unregisters **only** the listeners from that specific call.

#### `createLiveTextBufferFromOffline(offlineBuffer)`

```ts
function createLiveTextBufferFromOffline(
  offlineBuffer: OfflineTextBufferIdSource
): Promise<LiveTextBufferRef>;
```

```ts
const liveFromOffline = await createLiveTextBufferFromOffline(offlineSnapshot);
```

#### `finalizeLiveTextBuffer(liveBuffer)`

```ts
function finalizeLiveTextBuffer(
  liveBuffer: LiveTextBufferRecordingSource
): Promise<LiveTextBufferHandleFinished>;
```

```ts
const finished = await finalizeLiveTextBuffer(live);
console.log(finished);
```

### Live buffer readers and segment APIs

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

#### `appendLiveTextSegment(liveBuffer, text, tokens?, timestamps?, meta?)`

```ts
function appendLiveTextSegment(
  liveBuffer: LiveTextBufferRecordingSource,
  text: string,
  tokens?: string[],
  timestamps?: number[],
  meta?: Record<string, unknown>
): Promise<{ segmentIndex: number }>;
```

```ts
await appendLiveTextSegment(live, 'hello world', ['h', 'e', 'l', 'l', 'o']);
```

#### `getLiveTextBufferSegments(liveBuffer, startIndex, maxCount)`

```ts
function getLiveTextBufferSegments(
  liveBuffer: LiveTextBufferIdSource,
  startIndex: number,
  maxCount: number,
  options?: {
    includeTokens?: boolean;
    includeTimestamps?: boolean;
  }
): Promise<LiveTextSegment[]>;
```

```ts
const segments = await getLiveTextBufferSegments(live, 0, 32);
```

#### `getLiveTextBufferSegmentCount(liveBuffer)`

```ts
function getLiveTextBufferSegmentCount(
  liveBuffer: LiveTextBufferIdSource
): Promise<number>;
```

```ts
const count = await getLiveTextBufferSegmentCount(live);
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
```

Strict mode semantics:
- `windowSnapshot`: current in-memory live window
- `fullIfSpooled`: full text from spool only; rejects with `TEXT_SPOOL_*` errors when unavailable

## Segmentation

Live text buffers support built-in segmentation configuration through `CreateLiveTextBufferOptions.segmentation`.

- `off`: no segmentation attachment.
- `manual` (default): boundary management is external.
- `auto`: segmentation engine auto-attaches with text policy (default evaluator: `text_synthetic_auto`).

Use this when streaming text should be segmented at consistent boundaries before downstream consumers (for example streaming TTS) process segments.

```ts
const live = await createLiveTextBuffer({
  segmentation: {
    mode: 'auto',
    policy: { evaluator: 'text_synthetic_auto', sentenceBoundary: true, maxLengthChars: 500 },
  },
});
```

See [segmentation-engine.md](segmentation-engine.md) for full segmentation semantics and [memory-and-models.md](memory-and-models.md) for memory/OOM context.

---

## Types and constants

```ts
import type {
  LiveTextBufferRef, // live text buffer ref with info + recording handle
  LiveTextBufferInfo, // live buffer metadata including spool status
  LiveTextBufferIdSource, // ref/handle/id accepted by live text APIs
  LiveTextBufferRecordingSource, // recording-only source for append/finalize
  LiveTextSegment, // committed segment shape from live segment log
  LiveTextBufferPartialEvent, // partial event payload for streaming updates
  LiveTextBufferErrorEvent, // error event payload for live buffer
  CreateLiveTextBufferOptions, // options for createLiveTextBuffer
  OfflineTextBufferFromLiveMode, // conversion mode from live to offline
  PipelineTextBufferInfo, // offline/live metadata union
  PipelineTextErrorCodeValue, // string union of textbuffer error codes
} from 'react-native-sherpa-onnx/textbuffer';

import {
  PipelineTextErrorCode, // runtime constants for code-based error handling
  subscribeLiveTextBufferEvents, // attach additional listeners after buffer creation
  TEXT_DEFAULT_SLICE_COUNT, // default safe slice count for reads
  TEXT_MAX_SLICE_COUNT, // maximum safe slice count for reads
} from 'react-native-sherpa-onnx/textbuffer';
```

## Error codes

The following codes are the relevant runtime outcomes for live/streaming text-buffer operations in this document (`create`, `append`, `finalize`, `slice`, `createOfflineFromLive`, `release`).

| Code | Meaning |
| --- | --- |
| `TEXT_BUFFER_NOT_FOUND` | Referenced text buffer id does not exist |
| `TEXT_BUFFER_KIND_MISMATCH` | Buffer kind does not match called API (offline vs live) |
| `TEXT_INVALID_ARGUMENT` | Invalid argument or malformed buffer id |
| `TEXT_INVALID_STATE` | Operation is not allowed in the current buffer state |
| `TEXT_ALREADY_FINALIZED` | Operation requires `recording` buffer but live buffer is already finished |
| `TEXT_SLICE_INVALID` | Live partial/segment slice range is invalid |
| `TEXT_SLICE_TOO_LARGE` | Requested live slice exceeds native safety limits |
| `TEXT_SPOOL_UNAVAILABLE` | Spool-required operation requested but spool is disabled/unavailable |
| `TEXT_SPOOL_WRITE_FAILED` | Writing to live text spool failed |
| `TEXT_SPOOL_READ_FAILED` | Reading live text spool failed |
| `TEXT_SPOOL_CORRUPTED` | Spool content is corrupted or inconsistent |
| `TEXT_INTERNAL_ERROR` | Generic native text buffer failure |

---

## See also

- [Pipeline text buffers — offline](textbuffer-offline.md)
- [Streaming STT](stt-streaming.md)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)

## Use case examples

<details>
<summary>Event-driven partial rendering with endpoint-triggered segment reads</summary>

```ts
let last = 0;
const liveText = await createLiveTextBuffer({
  streamEvents: { partial: { enabled: true, minIntervalMs: 0 } },
  onPartial: async (event) => {
    console.log('[partial]', event.partialText);
    if (!event.isEndpoint) return;

    const total = await getLiveTextBufferSegmentCount(liveText);
    if (total <= last) return;
    const fresh = await getLiveTextBufferSegments(liveText, last, total - last);
    fresh.forEach((s) => console.log('[segment]', s.text));
    last = total;
  },
});
```

</details>

<details>
<summary>Convert finished live session to strict full-history offline snapshot</summary>

```ts
await finalizeLiveTextBuffer(liveText);
const offline = await createOfflineTextBufferFromLive(liveText, 'fullIfSpooled');
const info = await getPipelineTextBufferInfo(offline);
const text = await getOfflineTextBufferTextSlice(offline, 0, info.utf16Length);
console.log(text);
await releasePipelineTextBuffer(offline);
```

</details>
