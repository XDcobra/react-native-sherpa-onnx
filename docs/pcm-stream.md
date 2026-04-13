# PCM stream import (`pcm-stream`)

**Import path:** `react-native-sherpa-onnx/pcm-stream`

This entry re-exports the **PCM player** API — native playback of mono float PCM via `writePcmChunk` (see [`pcm-player.md`](pcm-player.md)). It is an alias of **`react-native-sherpa-onnx/pcm`** with a stream-oriented path name; implementation lives in [`src/pcm/`](../src/pcm/).

```typescript
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm-stream';
// equivalent: import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
```

---

## Not pipeline buffers

**Offline / live registry buffers** (`off_…`, `live_…`, mic → ring, spool, `createOfflineAudioBufferFromFile`, …) are **not** part of this module. Use:

**`react-native-sherpa-onnx/audiobuffer`** — see [Pipeline audio buffers — overview](audiobuffer.md); [offline](audiobuffer-offline.md) · [live / streaming](audiobuffer-streaming.md).

---

## See also

- [PCM Player](pcm-player.md) — full options and TTS integration
- [Pipeline buffers — overview](audiobuffer.md) — offline and live handles for STT and pipelines
