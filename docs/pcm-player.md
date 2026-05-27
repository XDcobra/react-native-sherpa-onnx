# PCM Player (Pipeline Audio Buffers)

## Introduction

Play mono float audio from pipeline buffers (offline or live) via native audio backends.

Import from `react-native-sherpa-onnx/pcm`.

## Quick start

### Offline buffer (file -> buffer -> player)

```ts
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  listAvailableInputDevices,
  listAvailableOutputDevices,
  setPipelineAudioRoutePreference,
} from 'react-native-sherpa-onnx/audio';

const audioBuffer = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});

// Optional: set global input/output preference before creating the player.
// See: [Pipeline Audio Session Coordination](audio-session.md)
const inputDevices = await listAvailableInputDevices();
const outputDevices = await listAvailableOutputDevices();
const preferredInput = inputDevices.find((d) => d.kind === 'built_in_mic') ?? inputDevices[0];
const preferredOutput =
  outputDevices.find((d) => d.kind === 'built_in_speaker') ?? outputDevices[0];

await setPipelineAudioRoutePreference({
  ...(preferredInput ? { inputDeviceId: preferredInput.id } : {}),
  ...(preferredOutput ? { outputDeviceId: preferredOutput.id } : {}),
});

const player = await createPcmPlayer(audioBuffer, {
  onEnded: (e) => {
    console.log('Playback ended', e.playerId, e.bufferId);
  },
});

await player.pause();
await player.seekToMs(1200);
await player.resume();
await player.restart();
const posMs = await player.getPlaybackPositionMs();
console.log('Position', posMs);
await player.destroy();
```

### Live buffer (streaming append/finalize)

```ts
import {
  createEmptyLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';

const live = await createEmptyLiveAudioBuffer({ sampleRate: 22050 });
const player = await createPcmPlayer(live, {
  onEnded: () => {
    // Fired only after live buffer is finalized and playback reaches true EOF.
  },
});

appendSamplesToLiveAudioBuffer(live, myFloat32Chunk, 22050);
appendSamplesToLiveAudioBuffer(live, myFloat32Chunk2, 22050);

// Marks EOS for the source, does not destroy the player.
const finished = await finalizeLiveAudioBuffer(live);
console.log(finished.info.durationMs);
```

## API reference

### `createPcmPlayer(audioBuffer, options?)`

Creates and starts a native playback session that consumes from a pipeline audio buffer.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audioBuffer` | `OfflineAudioBufferRef \| LiveAudioBufferRef \| OfflineBufferHandle \| LiveBufferHandle \| string` | required | Buffer ref/handle or raw `bufferId` |
| `options.volume` | `number` | `1.0` | Volume scale in range `[0, 1]` |
| `options.onEnded` | `(event: { playerId: string; bufferId: string }) => void` | `undefined` | Called once when playback run reaches EOF |

To choose playback hardware for this pipeline, enumerate devices via `react-native-sherpa-onnx/audio` and then set `outputDeviceId` through `setPipelineAudioRoutePreference(...)`.

```ts
function createPcmPlayer(
  audioBuffer:
    | OfflineAudioBufferRef
    | LiveAudioBufferRef
    | OfflineBufferHandle
    | LiveBufferHandle
    | string,
  options?: {
    volume?: number;
    onEnded?: (event: { playerId: string; bufferId: string }) => void;
  }
): Promise<PcmPlayer>;
```

```ts
const player = await createPcmPlayer(audioBuffer, {
  volume: 1.0,
  onEnded: (event) => console.log(event.playerId, event.bufferId),
});
```

### `player.pause()`

```ts
function pause(): Promise<void>;
```

```ts
await player.pause();
```

### `player.resume()`

```ts
function resume(): Promise<void>;
```

```ts
await player.resume();
```

### `player.seekToMs(positionMs)`

```ts
function seekToMs(positionMs: number): Promise<void>;
```

```ts
await player.seekToMs(1200);
```

### `player.restart()`

```ts
function restart(): Promise<void>;
```

```ts
await player.restart();
```

### `player.getPlaybackPositionMs()`

```ts
function getPlaybackPositionMs(): Promise<number>;
```

```ts
const posMs = await player.getPlaybackPositionMs();
console.log(posMs);
```

### `player.destroy()`

```ts
function destroy(): Promise<void>;
```

```ts
await player.destroy();
```

## Playback Semantics

### Offline buffer

- `seekToMs(positionMs)` is clamped to `[0, durationMs]`.
- Seeking to exact EOF is valid and may lead to immediate `onEnded` when resumed.
- `onEnded` fires once per playback run.
- `restart()` resets to beginning and clears ended-state.

### Live buffer

- While recording, seek is only valid inside the currently retained ring window.
- Out-of-range seek rejects with `PCM_PLAYER_SEEK_OUT_OF_RANGE`.
- `onEnded` does not fire while recording.
- `onEnded` fires after `finalizeLiveAudioBuffer(...)` and true EOF is reached.
- `restart()` seeks to oldest currently available retained sample.

## Error codes

| Code | Meaning |
| --- | --- |
| `PCM_PLAYER_NOT_FOUND` | Player id not found in native registry |
| `PCM_PLAYER_INVALID_STATE` | Operation not valid in current player state |
| `PCM_PLAYER_SEEK_OUT_OF_RANGE` | Seek target is outside current playable range |
| `PCM_PLAYER_BUFFER_NOT_FOUND` | Referenced audio buffer id does not exist |
| `PCM_PLAYER_BUFFER_INCOMPATIBLE_STATE` | Buffer state cannot be used for requested player operation |
| `OFFLINE_OOM` | Not enough memory for offline playback buffering. Use a streaming playback path for large audio inputs; for other large offline workloads, see the segmentation engine ([segmentation-engine.md](./segmentation-engine.md)). Native reject text references the same doc path. |

Other error codes may surface from dependent audio/session layers when playback pipelines are composed with additional modules.

## Types and constants

```ts
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm'; // create pipeline-buffer based PCM player

import type {
  PcmPlayer, // player handle with pause/resume/seek/restart/destroy
  PcmPlayerOptions, // create options (volume, onEnded)
  PcmPlayerAudioBuffer, // accepted audio-buffer id source for player input
  PcmPlayerEndedEvent, // onEnded callback payload
} from 'react-native-sherpa-onnx/pcm';
```

## Architecture Notes

PCM player reads directly from native pipeline buffers; PCM sample data is not marshaled through JS during playback.

| | Android | iOS |
|---|---------|-----|
| Backend | `AudioTrack` | `AVAudioEngine` + `AVAudioPlayerNode` |
| EOS signaling | Drain + playback-head completion | Scheduled-buffer completion callbacks |
| Live playback | Cursor-based ring-buffer draining | Cursor-based ring-buffer draining |

## See also

- [Offline Audio Buffers](audiobuffer-offline.md)
- [Live / Streaming Audio Buffers](audiobuffer-streaming.md)
- [Pipeline Audio Session Coordination](audio-session.md)

## Use case examples

<details>
<summary>Seek forward and backward on an OfflineAudioBuffer</summary>

```ts
const player = await createPcmPlayer(offlineAudioOut, { volume: 1.0 });

// Jump forward to preview a later section.
await player.seekToMs(8000);
await player.resume();

// Move backward from current position.
const currentPosMs = await player.getPlaybackPositionMs();
const backTargetMs = Math.max(0, currentPosMs - 3000);
await player.seekToMs(backTargetMs);

// Jump forward again.
await player.seekToMs(backTargetMs + 5000);

await player.pause();
await player.destroy();
```

</details>

<details>
<summary>Seek forward and backward on a LiveAudioBuffer</summary>

```ts
import {
  createEmptyLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';

const live = await createEmptyLiveAudioBuffer({ sampleRate: 22050 });
appendSamplesToLiveAudioBuffer(live, chunkA, 22050);
appendSamplesToLiveAudioBuffer(live, chunkB, 22050);

const player = await createPcmPlayer(live, {
  onEnded: (e) => console.log('ended', e.playerId, e.bufferId),
});

await player.resume();

// Seek forward inside the currently retained live window.
const posNow = await player.getPlaybackPositionMs();
await player.seekToMs(posNow + 1000);

// Seek backward inside the currently retained live window.
const posAfterForward = await player.getPlaybackPositionMs();
await player.seekToMs(Math.max(0, posAfterForward - 1500));

// After source finalization, playback can drain to true EOF and emit onEnded.
await finalizeLiveAudioBuffer(live); // returns LiveAudioBufferFinishedRef with fresh info
```

Note: live seek targets must remain inside the currently retained ring window. If the target falls outside that range, native rejects with `PCM_PLAYER_SEEK_OUT_OF_RANGE`.

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

