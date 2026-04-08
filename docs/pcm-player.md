# PCM Player

Standalone PCM playback — play mono float audio from any source.

**Import:** `react-native-sherpa-onnx/pcm`

## Quick Start

### Manual feed (JS → player)

```ts
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';

const player = await createPcmPlayer({ sampleRate: 22050, feed: 'js' });
await player.writePcmChunk(myFloat32Samples);
// ... feed more chunks ...
await player.pause();
await player.resume();
await player.destroy();
```

### With TTS streaming (native playback)

```ts
import { createStreamingTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createStreamingTTS(opts);
const ctrl = await tts.generateSpeechStream(text, genOpts, {
  onEnd: () => { /* playback finished */ },
}, { playback: true, emitChunks: false });

// Pause / resume during playback:
await ctrl.player?.pause();
await ctrl.player?.resume();

// ctrl.cancel() stops synthesis + destroys player in one call
```

No `createPcmPlayer` call needed — `playback: true` manages the player internally.

### Batch TTS playback (native sink)

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';

const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await tts.generateSpeech('Hello world');

// Play directly from native sink — no getSamples() needed
// Returns a controller with a .player handle
const playback = await tts.playFromSink(audio.generation);

// Pause / resume / destroy via player handle
await playback.player.pause();
await playback.player.resume();
await playback.player.destroy();

await tts.destroy();
```

## API Reference

### `createPcmPlayer(options)`

Creates a player session. Returns `PcmPlayer`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sampleRate` | `number` | required | Sample rate in Hz |
| `channels` | `number` | `1` | Only mono supported in v1 |
| `feed` | `'js' \| 'native'` | `'js'` | How PCM reaches the player |
| `ttsInstanceId` | `string?` | `undefined` | Optional TTS engine binding |

### `PcmPlayer`

| Method | Description |
|--------|-------------|
| `writePcmChunk(samples)` | Enqueue float PCM. Only when `feed='js'`. |
| `pause()` | Pause playback. Buffered samples are retained. |
| `resume()` | Resume paused playback. |
| `destroy()` | Stop + release resources. |

| Property | Type | Description |
|----------|------|-------------|
| `playerId` | `string` | Unique player identifier |

### Feed modes

- **`'js'`**: App feeds samples via `writePcmChunk()`. Typical for mic PCM, test audio, or manual relay from `onChunk`.
- **`'native'`**: Only native producers may enqueue. `writePcmChunk()` from JS is rejected. Used internally by `playback: true` streaming.

## Platform details

| | Android | iOS |
|---|---------|-----|
| Audio backend | `AudioTrack` (`MODE_STREAM`, `ENCODING_PCM_FLOAT`) | `AVAudioEngine` + `AVAudioPlayerNode` |
| Category | `USAGE_MEDIA` / `CONTENT_TYPE_SPEECH` | `AVAudioSessionCategoryPlayback` |
| Thread safety | `ConcurrentHashMap` registry | `std::mutex` + `std::unordered_map` |

## See also

- [tts-streaming.md](tts-streaming.md) — streaming TTS with `playback` option
- [tts-offline.md](tts-offline.md) — batch TTS with `playFromSink`
- [migration.md](migration.md) — migrating from old PCM player API
