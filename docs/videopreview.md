# Video preview

Preview a `VideoBuffer` (offline or live) with play, pause, seek, frame step, and optional synced audio.

Import from `react-native-sherpa-onnx/videopreview`. The player object is independent of the view: create it first, then attach `<VideoPreviewView player={player} />`.

## Create

```ts
import {
  createVideoPreviewPlayer,
  VideoPreviewView,
} from 'react-native-sherpa-onnx/videopreview';

const player = await createVideoPreviewPlayer(video, {
  audio: { source: 'track' }, // default; use { source: 'none' } for silent video
  onAudioUnavailable: (e) => {
    if (e.reason === 'unsupportedCodec') {
      // show a hint — video keeps playing
    }
  },
});
```

`player.initialSnapshot.audio` already reflects create-time audio (absent / unsupported / playing). Playback rate is `1.0` in v1. Reverse playback is not supported; seek backwards instead.

## Controls

| UI | API |
|---|---|
| Play / resume / restart after ended | `player.play()` |
| Pause | `player.pause()` |
| Seek | `player.seekTo(ms)` / `player.seekBy(deltaMs)` |
| Scrub | `seekTo(ms, { mode: 'closestKeyframe' })` while dragging, `seekTo(ms)` on release |
| Frame step (paused) | `player.stepFrame(1)` / `player.stepFrame(-1)` |
| Live edge | `player.seekToLiveEdge()` |

## Audio unavailable

When the buffer has no track, an unsupported codec (for example AC-3), or decode/output fails, **video continues**. You get:

1. `initialSnapshot.audio.status === 'unavailable'`
2. `options.onAudioUnavailable` (registered before native create)
3. `player.addListener('audioUnavailable', …)`

Strict mode: `audio: { source: 'track', required: true }` rejects create instead.

## View

```tsx
<VideoPreviewView
  player={player}
  resizeMode="contain"
  androidViewType="surfaceView"
/>
```

`androidViewType: 'textureView'` is for overlays, animations, and rounded corners. iOS ignores it.

## Export audio into AudioBuffer

Use `createOfflineAudioBufferFromVideo` / `createLiveAudioBufferFromLiveVideo` from `react-native-sherpa-onnx/videobuffer` for STT and other pipeline features ([offline](videobuffer-offline.md), [live](videobuffer-streaming.md)). Preview does not play through an AudioBuffer.

## Decoder budget

Preview uses the **display** decoder class (default 1). OCR/export use **cpu** (default 1). Configure with `configureVideoBuffer({ decoderBudget: { cpu, display } })`. A busy display decoder returns `VIDEO_PREVIEW_DECODER_BUSY`; audio-only play is still allowed.
