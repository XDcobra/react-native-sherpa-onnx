/**
 * PCM streaming playback — native mono float player (`writePcmChunk`, pause, resume, …).
 *
 * Re-exports [`react-native-sherpa-onnx/pcm`](../pcm/index.ts). This path exists for a
 * stream-oriented import name; implementation lives in `src/pcm/`.
 *
 * For pipeline **offline/live audio buffers** (`off_…` / `live_…`, mic, ring, spool), use
 * **`react-native-sherpa-onnx/audiobuffer`**.
 */

export { createPcmPlayer } from '../pcm/pcmPlayer';
export type { PcmPlayer, PcmPlayerOptions, PcmPlayerFeed } from '../pcm/types';
