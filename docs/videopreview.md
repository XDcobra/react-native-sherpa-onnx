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
| Frame step | `player.stepFrame(1)` / `player.stepFrame(-1)` (playing pauses) |
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

## JS Events

Native channel `SherpaOnnxVideoPreviewEvent`. Subscribe with `player.addListener(type, handler)` (returns an unsubscribe). `useVideoPreviewStatus(player)` already listens for UI state.

Create-time (no listener race): `onAudioUnavailable`, `onError` on `createVideoPreviewPlayer`.

| `type` | When | Notes |
| --- | --- | --- |
| `stateChanged` | idle → preparing → ready / playing / paused / seeking / buffering / ended / error / released | `state`, `previousState`, `positionMs` |
| `progress` | while playing (interval `progressIntervalMs`, default 250) | `positionMs`, `seekableRange`, `liveEdgeMs` |
| `firstFrameRendered` | first decoded frame after create or seek | `positionMs` |
| `seekCompleted` | seek finished | `result`, `mode` |
| `seekClamped` | request was clamped to the seekable window | `requestedMs`, `actualMs`, `reason` |
| `positionEvicted` | live ring dropped the current PTS | `previousMs`, `newMs` |
| `liveEdgeResync` | live play jumped to stay near the edge | `lagMs`, `newMs` |
| `audioUnavailable` | no track / unsupported codec / decode or output failed | video continues; also `onAudioUnavailable` |
| `audioInterrupted` | focus / session interruption | `reason` |
| `ended` | playhead reached EOS and `loop` is off | with `loop: true` the player seeks to start instead |
| `error` | renderer / invalid state | `code`, `message`; also `onError` |

```ts
const off = player.addListener('progress', (e) => {
  console.log(e.positionMs, e.seekableRange);
});
const offEnded = player.addListener('ended', () => {
  /* show Restart; loop already handled natively when setLoop(true) */
});
// …
off();
offEnded();
```

Buffer ingest events (live ring) are on the videobuffer API: [videobuffer-streaming.md — JS Events](videobuffer-streaming.md#js-events).

## Decoder budget

Preview uses the **display** resource (`hwVideoDisplay`, default 1). OCR/export use `hwVideoDecode`. Configure with `configureCodecs({ budgets, video: { display } })` — see [codecs.md](./codecs.md). Pass `decodePolicy` on `createVideoPreviewPlayer` to override. A busy display decoder returns `VIDEO_PREVIEW_DECODER_BUSY`; audio-only play is still allowed. `software` preview on iOS uses decoded NV12 frames (`DecodedSampleBufferRenderer`); `hardware` keeps the system `SampleBufferVideoRenderer`.
