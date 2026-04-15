# AudioBuffer migration: JSI + ArrayBuffer

This guide covers the breaking AudioBuffer API migration to synchronous JSI-backed sample transport.

Affected import path:

- `react-native-sherpa-onnx/audiobuffer`

## Why this changed

Large PCM payloads no longer cross the React Native bridge as `number[]`.
Sample-heavy APIs now use `Float32Array` + JSI `ArrayBuffer` for lower CPU and GC overhead.

## Breaking changes

| Before | After |
| --- | --- |
| `createOfflineAudioBufferFromSamples(samples: number[], ...) => Promise<...>` | `createOfflineAudioBufferFromSamples(samples: Float32Array, ...) => OfflineAudioBufferRef` |
| `appendSamplesToLiveAudioBuffer(..., samples: number[], ...) => Promise<void>` | `appendSamplesToLiveAudioBuffer(..., samples: Float32Array, ...) => void` |
| `getLiveAudioBufferSamplesSlice(...) => Promise<number[]>` | `getLiveAudioBufferSamplesSlice(...) => Float32Array` |
| Event `pipelineLiveAudioChunk` may include `samples?: number[]` | Event payload is metadata-only (no samples) |
| `CreateLiveAudioBufferOptions.emitAppendedSamples` | Removed |

New API:

- `getOfflineAudioBufferSamplesSlice(...) => Float32Array`

## Before / after examples

### 1) Create offline buffer from PCM

```ts
// Before
const offline = await createOfflineAudioBufferFromSamples(samplesArray, 16000, 1);

// After
const offline = createOfflineAudioBufferFromSamples(
  new Float32Array(samplesArray),
  16000,
  1
);
```

### 2) Append PCM to live buffer

```ts
// Before
await appendSamplesToLiveAudioBuffer(live, samplesArray, 16000);

// After
appendSamplesToLiveAudioBuffer(live, new Float32Array(samplesArray), 16000);
```

### 3) Pull samples from live buffer

```ts
// Before
const chunk = await getLiveAudioBufferSamplesSlice(live, 0, 320);

// After
const chunk = getLiveAudioBufferSamplesSlice(live, 0, 320); // Float32Array
```

### 4) Event-driven pull pattern (replaces event samples)

```ts
const live = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  onFramesAppended: (event) => {
    const start = Math.max(0, event.totalSamplesWritten - event.frameCount);
    const chunk = getLiveAudioBufferSamplesSlice(live, start, event.frameCount);
    // process chunk (Float32Array)
  },
});
```

## JSI install behavior

The module auto-installs JSI bindings during native initialization.
If your app has unusual startup ordering, you can use the fallback APIs:

```ts
import { installJSI, isJSIAvailable } from 'react-native-sherpa-onnx/audiobuffer';

if (!isJSIAvailable()) {
  const ok = installJSI();
  if (!ok) {
    throw new Error('SherpaOnnx JSI install failed');
  }
}
```

## Checklist

- Replace all `number[]` sample arguments with `Float32Array`.
- Remove `await` from synchronous sample APIs listed above.
- Remove use of `emitAppendedSamples`.
- Stop reading `event.samples` from live append events; pull slices explicitly.
- If needed, call `installJSI()` once before first sync sample operation.
