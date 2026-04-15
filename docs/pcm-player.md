# PCM Player (Pipeline Audio Buffers)

Play mono float audio from pipeline buffers (offline or live) via native audio backends.

Import from `react-native-sherpa-onnx/pcm`.

## Quick Start

### Offline buffer (file -> buffer -> player)

```ts
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';

const audioBuffer = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
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
await finalizeLiveAudioBuffer(live);
```

## API Reference

### `createPcmPlayer(audioBuffer, options?)`

Creates and starts a native playback session that consumes from a pipeline audio buffer.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audioBuffer` | `OfflineAudioBufferRef \| LiveAudioBufferRef \| OfflineBufferHandle \| LiveBufferHandle \| string` | required | Buffer ref/handle or raw `bufferId` |
| `options.volume` | `number` | `1.0` | Volume scale in range `[0, 1]` |
| `options.outputDeviceId` | `string` | `undefined` | Preferred output route id from `listAvailableOutputDevices()` (best effort) |
| `options.onEnded` | `(event: { playerId: string; bufferId: string }) => void` | `undefined` | Called once when playback run reaches EOF |

Platform note: Android attempts direct AudioTrack routing to the requested device id where supported.
iOS applies route preferences within AVAudioSession constraints, so `outputDeviceId` is capability-based best effort.

### `listAvailableOutputDevices()`

```ts
function listAvailableOutputDevices(): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    selected: boolean;
    default: boolean;
    canSelect: boolean;
  }>
>;
```

```ts
import {
  createPcmPlayer,
  listAvailableOutputDevices,
} from 'react-native-sherpa-onnx/pcm';

const outputs = await listAvailableOutputDevices();
const preferred = outputs.find((d) => d.canSelect && d.kind === 'bluetooth');

const player = await createPcmPlayer(audioBuffer, {
  outputDeviceId: preferred?.id,
});
```

On Android, enumeration is robust and includes routable hardware endpoints.
On iOS, routable outputs are limited by current audio session/route policy; inspect `selected` after start to confirm the effective route.

### `PcmPlayer`

| Method | Description |
|--------|-------------|
| `pause()` | Pause playback. Buffered data remains intact. |
| `resume()` | Resume paused playback. |
| `seekToMs(positionMs)` | Seek to position in milliseconds. |
| `restart()` | Restart playback from the beginning/start-of-available. |
| `getPlaybackPositionMs()` | Return current playback position in milliseconds. |
| `destroy()` | Stop playback and release native resources. |

| Property | Type | Description |
|----------|------|-------------|
| `playerId` | `string` | Unique player identifier |

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

## Error Codes

Common player errors:

- `PCM_PLAYER_NOT_FOUND`
- `PCM_PLAYER_INVALID_STATE`
- `PCM_PLAYER_SEEK_OUT_OF_RANGE`
- `PCM_PLAYER_BUFFER_NOT_FOUND`
- `PCM_PLAYER_BUFFER_INCOMPATIBLE_STATE`

## Architecture Notes

PCM player reads directly from native pipeline buffers; PCM sample data is not marshaled through JS during playback.

| | Android | iOS |
|---|---------|-----|
| Backend | `AudioTrack` | `AVAudioEngine` + `AVAudioPlayerNode` |
| EOS signaling | Drain + playback-head completion | Scheduled-buffer completion callbacks |
| Live playback | Cursor-based ring-buffer draining | Cursor-based ring-buffer draining |

## See Also

- [Pipeline Audio Buffers — Overview](audiobuffer.md)
- [Offline Audio Buffers](audiobuffer-offline.md)
- [Live / Streaming Audio Buffers](audiobuffer-streaming.md)
- [Migration guide](migration.md)
