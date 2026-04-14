# PCM Player (Pipeline Audio Buffers)

Play mono float audio from pipeline buffers (offline or live) via native audio backend.

**Import:** `react-native-sherpa-onnx/pcm`

## Quick Start

### Play offline buffer (file-based)

```ts
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';

const audioBuffer = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/path/to/audio.wav',
});
const player = await createPcmPlayer(audioBuffer);

await player.pause();
await player.resume();
await player.destroy();
```

### Play live buffer (streaming)

```ts
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  createEmptyLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const audioBuffer = await createEmptyLiveAudioBuffer({ sampleRate: 22050 });
const player = await createPcmPlayer(audioBuffer);

// Append samples from your source
appendSamplesToLiveAudioBuffer(audioBuffer, myFloat32Samples, 22050);
// ... continue feeding ...

// Playback starts immediately as samples are appended.
// Finalize only signals end-of-stream (EOS).
await finalizeLiveAudioBuffer(audioBuffer);

await player.pause();
await player.resume();
await player.destroy();
```

### Play TTS-generated audio (pipeline model)

```ts
import { createIncrementalStreamingTTS } from 'react-native-sherpa-onnx/tts';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { createEmptyLiveAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

const audioOut = await createEmptyLiveAudioBuffer({ sampleRate: 22050 });
const tts = await createIncrementalStreamingTTS({
  source: {
    engineOptions: { modelPath: { type: 'asset', path: 'models/vits' } },
  },
});

const session = await tts.startSession(audioOut);
session.pushText('Hello from streaming TTS.');
await session.flush();

// TTS writes to audioOut automatically
// Create player to play it
const player = await createPcmPlayer(audioOut);

// ... Pause/resume/destroy as needed ...
await player.destroy();
await tts.destroy();
```

## Architecture

The PCM Player plays audio from **pipeline buffers**:
- **Offline buffer**: fully populated, immutable audio (file-based)
- **Live buffer**: streaming, mutable audio with append/finalize API

Audio is streamed **directly from native buffer→native playback** — no JS bridge traffic for audio samples.

## API Reference

### `createPcmPlayer(audioBuffer, options?)`

Creates a player session. Returns `PcmPlayer`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audioBuffer` | `OfflineAudioBufferRef \| LiveAudioBufferRef \| string` | required | Buffer ref or ID |
| `options?.volume` | `number` | `1.0` | Volume scale [0, 1] |

Prefer passing refs directly. Raw string ids are optional; malformed ids are rejected early with `AUDIO_INVALID_ARGUMENT`.

### `PcmPlayer`

| Method | Description |
|--------|-------------|
| `pause()` | Pause playback. Buffered samples are retained. |
| `resume()` | Resume paused playback. |
| `destroy()` | Stop + release resources. |

| Property | Type | Description |
|----------|------|-------------|
| `playerId` | `string` | Unique player identifier |

### Buffer sources

The player accepts **any pipeline audio buffer**:
- **OfflineAudioBufferRef**: File-based buffers from `createOfflineAudioBufferFromFile`
- **LiveAudioBufferRef**: Streaming buffers from `createEmptyLiveAudioBuffer`
- **String**: Raw buffer ID (`off_…` or `live_…`)

## Platform details

| | Android | iOS |
|---|---------|-----|
| Audio backend | `AudioTrack` (pipeline buffer consumer) | `AVAudioEngine` + `AVAudioPlayerNode` (pipeline buffer consumer) |
| Category | `USAGE_MEDIA` / `CONTENT_TYPE_SPEECH` | `AVAudioSessionCategoryPlayback` |
| Native playback | Cursor-based draining from ring buffer | Cursor-based draining from ring buffer |

## See also

- [Pipeline Audio Buffers — Overview](audiobuffer.md)
- [Offline Audio Buffers](audiobuffer-offline.md)
- [Live / Streaming Audio Buffers](audiobuffer-streaming.md)
- [Incremental Streaming TTS](../tts/incremental.md)

- [migration.md](migration.md) — migrating from old PCM player API
