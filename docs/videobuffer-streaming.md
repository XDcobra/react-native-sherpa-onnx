# Pipeline video buffers — live / streaming (`videobuffer`)

## Introduction

**Live** native video buffers: encoded ring plus optional spool, file ingest (or a native producer), and a lifecycle **`recording` → `finished`**. Used for live preview, a live AudioBuffer tap, and then **offline** OCR/STT/export after finalize.

**Import path:** `react-native-sherpa-onnx/videobuffer`

For immutable file-backed clips, see [Pipeline video buffers — offline](videobuffer-offline.md). After **`finalizeLiveVideoBuffer`**, the same id is a **finished** live buffer and is accepted by the offline APIs.

| Constraint | Effect on API use |
| --- | --- |
| **HW decode only** | Preview and post-finalize frame APIs need a device HW codec. File **ingest** still works without HW (packets are stored, not decoded). |
| **FFmpeg required for file ingest** | `ingestFileToLiveVideoBuffer` rejects with `VIDEO_FFMPEG_DISABLED` when FFmpeg is compiled out. A live buffer filled by a native producer (no file demux) still works. See [disable-ffmpeg.md](disable-ffmpeg.md). |
| **Time axis** | Events and keyframes use **microseconds** (`liveEdgeUs`, `fromUs` / `toUs`). Live audio tap is an AudioBuffer (PCM). |

---

## Concepts

| Kind | Id prefix | State | Typical use |
| --- | --- | --- | --- |
| **[Offline buffer](videobuffer-offline.md)** | `vid_off_<uuid>` | `immutable` | Batch OCR/STT, export, preview of a completed take. |
| **[Live buffer](videobuffer-streaming.md)** | `vid_live_<uuid>` | `recording` → `finished` | Ingest while previewing; tap audio live; finalize → treat as offline. |

**Offline and live work together:** ingest or camera → live id → [preview](videopreview.md) / `createLiveAudioBufferFromLiveVideo` while recording → `finalizeLiveVideoBuffer` → pass the **finished** ref into [offline](videobuffer-offline.md) image/audio/export APIs.

**Why this is fast:** JS sends **ids and control calls**. Encoded packets stay native. JS events carry metadata (`liveEdgeUs`, frame counts), not pixels.

| Containers (file ingest) | Video codecs (v1) | Rejects |
| --- | --- | --- |
| MP4, MOV, M4V, 3GP, MKV, WebM | H.264, HEVC | Same as offline: `VIDEO_CODEC_UNSUPPORTED` / `VIDEO_NO_VIDEO_TRACK` / `VIDEO_CONTAINER_UNSUPPORTED`. |

---

## `info` lifecycle (live buffers)

`LiveVideoBufferRef.info` is **not** a live view of native state.

| When | What `info` means |
| --- | --- |
| **`createEmptyLiveVideoBuffer`** | Snapshot at creation (`state: 'recording'`, `frameCount: 0`). |
| **While recording** | Stale unless you call `getVideoBufferInfo`. Prefer **`subscribeLiveVideoBufferEvents`** (`liveEdgeUs`, `totalFramesWritten`) for UI. `ingestFileToLiveVideoBuffer` returns a fresh info snapshot when ingest completes. |
| **`finalizeLiveVideoBuffer`** | Returns **`LiveVideoBufferFinishedRef`** with **fresh** `info` (`state: 'finished'`). Use this — not the recording ref’s cached `info`. |
| **Any time** | `getVideoBufferInfo` re-queries native metadata. |

While `state === 'recording'`, seekable media is the **ring + spool window** (`seekableStartUs` / `seekableEndUs`), not always the full session. Evicted prefix → `VIDEO_FRAME_EVICTED` on decode of old PTS.

---

## Quick start

Typical session: create a live buffer, subscribe, ingest a file (stand-in for a camera producer), tap audio, then finalize and run the same offline OCR/STT path.

```ts
import {
  createEmptyLiveVideoBuffer,
  createLiveAudioBufferFromLiveVideo,
  createOfflineAudioBufferFromVideo,
  createOfflineImageBufferFromVideo,
  finalizeLiveVideoBuffer,
  getVideoBufferInfo,
  getVideoKeyframeTimes,
  ingestFileToLiveVideoBuffer,
  releaseVideoBuffer,
  subscribeLiveVideoBufferEvents,
} from 'react-native-sherpa-onnx/videobuffer';
import { releaseOfflineImageBuffer } from 'react-native-sherpa-onnx/imagebuffer';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

// Ring = last 10s encoded in RAM. `session` keeps a spool for the JS session so
// finalize / OCR can see more than the ring. `'none'` = ring only (old frames evict).
const live = await createEmptyLiveVideoBuffer({
  ringSeconds: 10,
  retention: 'session',
});

// One callback for all live events. Filter by `type` (see table below).
const stopEvents = subscribeLiveVideoBufferEvents(live, (e) => {
  if (e.type === 'packetsAppended') console.log('edge', e.liveEdgeUs, e.totalFramesWritten);
  if (e.type === 'spoolOverflow') console.warn('spool capped');
  if (e.type === 'spoolError') console.warn('spool I/O');
  if (e.type === 'finished') console.log('finalized', e.frameCount);
});

// File → live (FFmpeg). Default pacing is `asFast`. `realtime` sleeps to wall-clock.
// `includeAudio: true` (default) keeps the audio track for preview + live tap.
// Resolves with a fresh LiveVideoBufferInfo when ingest finishes.
const ingested = await ingestFileToLiveVideoBuffer(
  { kind: 'fs', path: '/tmp/clip.mp4' },
  live,
  {
    pacing: 'asFast',
    includeAudio: true,
  }
);

// Re-query while recording if you need a later snapshot than `ingested`.
const recordingInfo = await getVideoBufferInfo(live);
const keys = await getVideoKeyframeTimes(
  live,
  {
    fromUs: recordingInfo.seekableStartUs ?? 0,
    toUs: recordingInfo.seekableEndUs ?? recordingInfo.liveEdgeUs ?? 0,
  },
  64
);

// Live PCM tap → live AudioBuffer (streaming STT). Needs FFmpeg. Recording only.
const tap = await createLiveAudioBufferFromLiveVideo(live, { targetSampleRateHz: 16000 });
// pass tap.audio into streaming STT; call tap.stop() when the tap should end

// Seal the session. After this, offline image/audio/export APIs accept `finished`.
const finished = await finalizeLiveVideoBuffer(live);
stopEvents();
await tap.stop();

const images = await createOfflineImageBufferFromVideo(finished, {
  sampling: 'keyframes',
  maxSide: 1280,
});
const extract = await createOfflineAudioBufferFromVideo(finished, {
  targetSampleRateHz: 16000,
});

await releaseVideoBuffer(finished);
await releaseOfflineImageBuffer(images.imageBufferId);
await releasePipelineAudioBuffer(extract.audio);
await releasePipelineAudioBuffer(tap.audio);
```

Pattern: **create empty → subscribe → ingest/produce → (optional live audio/preview) → finalize → offline APIs → release**.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/videobuffer`. Live arguments accept `LiveVideoBufferIdSource` (ref, recording/finished handle, or string) unless noted.

Ref-first usage is recommended. Malformed ids reject early with `VIDEO_INVALID_ARGUMENT`.

Tables under each function are labeled **Parameters** (arguments), **`options`** (fields of the options object), or **Returns** (resolved value).

### General

#### `getVideoBufferInfo(buffer)`

```ts
function getVideoBufferInfo(
  buffer: PipelineVideoBufferIdSource
): Promise<PipelineVideoBufferInfo>;
```

```ts
const info = await getVideoBufferInfo(live);
// info ≈ {
//   bufferId: 'vid_live_4e21…',
//   kind: 'liveVideoBuffer',
//   state: 'recording',
//   frameCount: 120,
//   totalFramesWritten: 180,
//   ringEvictedFrames: 60,
//   hasActiveSpool: true,
//   liveEdgeUs: 5_999_000,
//   seekableStartUs: 2_000_000,
//   seekableEndUs: 5_999_000,
//   audio: {
//     codec: 'aac',
//     decodable: true,
//     sampleRate: 48000,
//     channels: 2,
//     startMs: 0,
//     durationMs: 6000,
//   },
// }
```

For live buffers, `ref.info` from create/finalize is a snapshot — see [`info` lifecycle](#info-lifecycle-live-buffers).

**Returns** (`LiveVideoBufferInfo`)

| Field | Meaning |
| --- | --- |
| `kind` / `state` | `'liveVideoBuffer'` / `'recording'` \| `'finished'`. |
| `frameCount` | Frames currently indexed in the **window** (ring + spool). |
| `totalFramesWritten` | Session total, including evicted prefix. |
| `ringEvictedFrames` | Frames that left the RAM ring. |
| `hasActiveSpool` | `true` when retention is not `'none'`. |
| `liveEdgeUs` | Last appended video PTS (recording). |
| `seekableStartUs` / `seekableEndUs` | Currently seekable window (µs). |
| `audio` | Same shape as offline; `null` until the first audio packet. |

#### `getVideoKeyframeTimes(buffer, range, maxCount?)`

```ts
function getVideoKeyframeTimes(
  buffer: PipelineVideoBufferIdSource,
  range: { fromUs: number; toUs: number },
  maxCount?: number
): Promise<number[]>;
```

```ts
const ptsUs = await getVideoKeyframeTimes(live, { fromUs: 0, toUs: info.liveEdgeUs ?? 0 }, 64);
// ptsUs ≈ [2_000_000, 2_500_000, 3_000_000, 3_500_000]  // µs in the current window
```

Keys in `[fromUs, toUs]` of the **currently seekable** range, capped by `maxCount` (default `64`). After finalize, the window is the finished session (subject to retention).

#### `releaseVideoBuffer(buffer)`

```ts
function releaseVideoBuffer(buffer: PipelineVideoBufferIdSource): Promise<void>;
```

```ts
await releaseVideoBuffer(live);
```

Stops ingest, drops the ring/spool, invalidates the id. Unsubscribe events first. Release preview players before the buffer ([videopreview.md](videopreview.md)).

### Live buffer

#### `createEmptyLiveVideoBuffer(options?)`

```ts
function createEmptyLiveVideoBuffer(
  options?: CreateEmptyLiveVideoBufferOptions
): Promise<LiveVideoBufferRef>;
```

```ts
const live = await createEmptyLiveVideoBuffer({ ringSeconds: 10, retention: 'session' });
// live ≈ {
//   bufferId: 'vid_live_4e21…',
//   unsubscribeEvents: () => {},
//   info: {
//     bufferId: 'vid_live_4e21…',
//     kind: 'liveVideoBuffer',
//     state: 'recording',
//     frameCount: 0,
//     totalFramesWritten: 0,
//     ringEvictedFrames: 0,
//     hasActiveSpool: true,
//     audio: null,
//   },
// }
```

Creates `state: 'recording'` with no packets yet. A native camera/producer or `ingestFileToLiveVideoBuffer` appends afterwards.

**`options`** (`CreateEmptyLiveVideoBufferOptions`)

| Field | Default | Meaning |
| --- | --- | --- |
| `ringSeconds` | `10` | Seconds of **encoded** video kept in the RAM ring. Smaller → less RAM, more `VIDEO_FRAME_EVICTED` if retention does not spool. |
| `retention: 'session'` | default | Spool for the JS session so finalize / OCR can see more than the ring. |
| `retention: 'none'` | — | Ring only. Old PTS decode → `VIDEO_FRAME_EVICTED`. Lowest disk. |
| `retention: { mode: 'maxSeconds', seconds }` | — | Spool capped at `seconds` (plus the ring). Overflow → event `spoolOverflow`. |
| `retention: { mode: 'path', directory }` | — | Spool files under `directory`. |

Decoder budgets and policies live in [`configureCodecs`](./codecs.md) (preview = `display`, OCR/export after finalize = `cpu`). See the [offline](videobuffer-offline.md) page.

#### `ingestFileToLiveVideoBuffer(source, live, options?)`

```ts
function ingestFileToLiveVideoBuffer(
  source: FileSource,
  live: LiveVideoBufferIdSource,
  options?: IngestFileToLiveOptions
): Promise<LiveVideoBufferInfo>;
```

```ts
const info = await ingestFileToLiveVideoBuffer(
  { kind: 'fs', path: '/tmp/clip.mp4' },
  live,
  { pacing: 'realtime' }
);
// info ≈ {
//   bufferId: 'vid_live_4e21…',
//   kind: 'liveVideoBuffer',
//   state: 'recording',
//   frameCount: 300,
//   totalFramesWritten: 300,
//   ringEvictedFrames: 0,
//   hasActiveSpool: true,
//   liveEdgeUs: 9_966_667,
//   seekableStartUs: 0,
//   seekableEndUs: 10_000_000,
//   audio: {
//     codec: 'aac',
//     decodable: true,
//     sampleRate: 48000,
//     channels: 2,
//     startMs: 0,
//     durationMs: 10000,
//   },
// }
```

`source` is a `FileSource` (see [fileio.md](fileio.md)). Same resolver as [`createOfflineVideoBufferFromFile`](videobuffer-offline.md#createofflinevideobufferfromfilesource). Needs FFmpeg. Resolves with a fresh `LiveVideoBufferInfo` when ingest completes. Finished / unknown buffer → `VIDEO_BUFFER_INVALID_STATE` / `VIDEO_BUFFER_NOT_FOUND`.

| Kind | How the file is opened |
| --- | --- |
| `fs` / `app` (`cache`, `files`, …) / `pad` / iOS `appBundle` / iOS `securityScoped` | Direct path. |
| Android `app` + `apkAsset` | APK zip entry has no fd. Copied to `<cache>/fileio_apkasset/…` on first open; later opens are a cache hit. |
| Android `contentUri` with ParcelFileDescriptor | Opened via `/proc/self/fd/N` (seekable). |
| Android `contentUri` stream (no PFD) | Copied to `<cache>/fileio_nofd/<sha256>` on first open; later opens of the same URI are a cache hit. Unpinned copies follow the [fileio_nofd policy](fileio.md#configurefileiooptions) (default 512 MiB / 24 h). |

A string path is rejected (`VIDEO_INVALID_ARGUMENT`).

**`options`** (`IngestFileToLiveOptions`)

| Field | Default | Meaning |
| --- | --- | --- |
| `pacing: 'asFast'` | default | Writes packets as fast as demux allows (tests, catch-up). |
| `pacing: 'realtime'` | — | Sleeps so ingest tracks file duration (preview looks like playback). |
| `includeAudio` | `true` | When `false`, video-only; live audio tap / preview audio will be absent. |

#### `subscribeLiveVideoBufferEvents(live, onEvent)`

```ts
function subscribeLiveVideoBufferEvents(
  live: LiveVideoBufferIdSource,
  onEvent: (event: LiveVideoBufferEvent) => void
): () => void;
```

```ts
const stop = subscribeLiveVideoBufferEvents(live, (e) => console.log(e.type, e.liveEdgeUs));
// e ≈ {
//   type: 'packetsAppended',
//   liveBufferId: 'vid_live_4e21…',
//   liveEdgeUs: 333_333,
//   frameCount: 10,
//   totalFramesWritten: 10,
// }
```

Returns an unsubscribe function. Events for other live ids are ignored.

**`onEvent`** (`LiveVideoBufferEvent`)

| `event.type` | When | Fields to read |
| --- | --- | --- |
| `packetsAppended` | Encoded packets appended | `liveEdgeUs`, `frameCount`, `totalFramesWritten` |
| `gopCommitted` | A GOP became seekable | `liveEdgeUs`, `frameCount` |
| `spoolOverflow` | Spool hit its cap (`maxSeconds`) | `totalFramesWritten` |
| `spoolError` | Spool I/O failed | — (also expect `VIDEO_SPOOL_IO` on a later call) |
| `finished` | After a successful finalize | `frameCount` |

Shared on every event: `liveBufferId`.

#### `finalizeLiveVideoBuffer(live)`

```ts
function finalizeLiveVideoBuffer(
  live: LiveVideoBufferIdSource
): Promise<LiveVideoBufferFinishedRef>;
```

```ts
const finished = await finalizeLiveVideoBuffer(live);
// finished ≈ {
//   bufferId: 'vid_live_4e21…',
//   info: {
//     bufferId: 'vid_live_4e21…',
//     kind: 'liveVideoBuffer',
//     state: 'finished',
//     frameCount: 300,
//     totalFramesWritten: 300,
//     ringEvictedFrames: 0,
//     hasActiveSpool: true,
//     liveEdgeUs: 9_966_667,
//     seekableStartUs: 0,
//     seekableEndUs: 10_000_000,
//     audio: {
//       codec: 'aac',
//       decodable: true,
//       sampleRate: 48000,
//       channels: 2,
//       startMs: 0,
//       durationMs: 10000,
//     },
//   },
// }
```

Stops ingest, `state: 'finished'`. The returned ref is an `OfflineVideoBufferIdSource`: use [offline](videobuffer-offline.md) `createOfflineImageBufferFromVideo`, `createOfflineAudioBufferFromVideo`, `exportVideoFrame`, `exportVideo`, and preview.

Calling finalize twice → `VIDEO_BUFFER_INVALID_STATE`.

#### `createLiveAudioBufferFromLiveVideo(live, options?)`

```ts
function createLiveAudioBufferFromLiveVideo(
  live: LiveVideoBufferIdSource,
  options?: { targetSampleRateHz?: number; windowSeconds?: number; startAt?: 'oldest' | 'liveEdge' }
): Promise<{ audio: LiveAudioBufferRef; mediaStartMs: number; stop(): Promise<void> }>;
```

```ts
const tap = await createLiveAudioBufferFromLiveVideo(live, { targetSampleRateHz: 16000 });
// tap ≈ {
//   audio: {
//     bufferId: 'live_7c88…',
//     unsubscribeEvents: () => {},
//     info: {
//       bufferId: 'live_7c88…',
//       kind: 'livePcmBuffer',
//       state: 'recording',
//       sampleRate: 16000,
//       channelCount: 1,
//       numSamples: 0,
//       durationMs: 0,
//       totalSamplesWritten: 0,
//       ringEvictedSamples: 0,
//       hasActiveSpool: true,
//     },
//   },
//   mediaStartMs: 0,
//   stop: async () => { … },
// }
```

Taps the **recording** live buffer’s audio into a [live AudioBuffer](audiobuffer-streaming.md) (streaming STT / waveform). Needs FFmpeg. Finished live → use `createOfflineAudioBufferFromVideo` instead (`VIDEO_BUFFER_INVALID_STATE` here).

**`options`**

| Field | Default | Meaning |
| --- | --- | --- |
| `targetSampleRateHz` omitted | `16000` | Resample tap to 16 kHz. |
| `targetSampleRateHz: 0` | — | Keep source rate. |
| `targetSampleRateHz > 0` | — | Exact tap rate. |

`windowSeconds` and `startAt` are accepted on the options object; only `targetSampleRateHz` changes the tap today.

**Returns**

| Field | Meaning |
| --- | --- |
| `audio` | Live AudioBuffer ref. Release with `releasePipelineAudioBuffer` after `stop()`. |
| `mediaStartMs` | Video-timeline time of PCM sample 0. |
| `stop()` | Ends the tap and finalizes the live AudioBuffer. |

No audio / unsupported codec → `VIDEO_NO_AUDIO_TRACK` / `VIDEO_AUDIO_CODEC_UNSUPPORTED`.

---

## Formats

File ingest uses the same container/codec table as [offline](videobuffer-offline.md#formats). Packets stay encoded; HW H.264 / HEVC is required later for preview / OCR. A native live producer (no file) still works with FFmpeg compiled out.

After **`finalizeLiveVideoBuffer`**, clip export is the same [`exportVideo`](videobuffer-offline.md) call as offline (HW transcode + FFmpeg mux). Recording live is rejected (`VIDEO_BUFFER_INVALID_STATE`).

Out of scope: public JS packet-append of VP8 / AV1; camera MIME is not a JS API.

## JS Events

Live video does **not** push pixels to JS. Native emits metadata on `SherpaOnnxVideoEvent`; subscribe with `subscribeLiveVideoBufferEvents`. Events for other live ids are ignored. Call the returned function to unsubscribe.

`LiveVideoBufferRef.unsubscribeEvents` is currently a no-op (create does not attach listeners). Always keep the unsubscribe from `subscribeLiveVideoBufferEvents`.

**`onEvent`** (`LiveVideoBufferEvent`)

| `event.type` | When | Fields |
| --- | --- | --- |
| `packetsAppended` | Encoded packets appended to the ring | `liveEdgeUs`, `frameCount`, `totalFramesWritten` |
| `gopCommitted` | A GOP became seekable | `liveEdgeUs`, `frameCount` |
| `spoolOverflow` | Spool hit its cap (`maxSeconds`) | `totalFramesWritten` |
| `spoolError` | Spool I/O failed | — (a later call may reject `VIDEO_SPOOL_IO`) |
| `finished` | After a successful `finalizeLiveVideoBuffer` | `frameCount` |

Shared on every event: `liveBufferId`.

```ts
const stop = subscribeLiveVideoBufferEvents(live, (e) => {
  if (e.type === 'packetsAppended') {
    console.log(e.liveEdgeUs, e.totalFramesWritten);
  }
});
// …
stop();
```

While recording, prefer these events for UI over the create-time `info` snapshot (it goes stale). After finalize, use the returned `LiveVideoBufferFinishedRef.info`.

Audio extract from a **finished** clip uses the offline `onProgress` / `signal` path — see [videobuffer-offline.md — JS Events](videobuffer-offline.md#js-events). Preview: [videopreview.md](videopreview.md) (`player.addListener`).

---

## Types and constants

Canonical TypeScript types: [`src/videobuffer/types.ts`](../src/videobuffer/types.ts).

| Name | Role |
| --- | --- |
| `LiveVideoBufferHandleRecording` / `Finished` | Branded ids (`vid_live_…`). |
| `LiveVideoBufferRef` | `{ bufferId, info }` while `recording`. |
| `LiveVideoBufferFinishedRef` | `{ bufferId, info }` after finalize; accepted by offline APIs. |
| `LiveVideoBufferIdSource` | Ref, recording/finished handle, or raw id. |
| `LiveVideoBufferInfo` | Metadata (`kind: 'liveVideoBuffer'`, `state`). |
| `VideoRetention` | `'session'` \| `'none'` \| `{ mode: 'maxSeconds', seconds }` \| `{ mode: 'path', directory }`. |
| `CreateEmptyLiveVideoBufferOptions` | `ringSeconds`, `retention`. |
| `IngestFileToLiveOptions` | `pacing`, `includeAudio`. |
| `LiveVideoBufferEvent` / `LiveVideoBufferEventType` | `packetsAppended` \| `gopCommitted` \| `spoolOverflow` \| `spoolError` \| `finished`. |

---

## Error codes

Thrown / rejected as `VIDEO_…`.

| Code | Typical cause |
| --- | --- |
| `VIDEO_INVALID_ARGUMENT` | Malformed id, bad `ringSeconds` / retention / pacing. |
| `VIDEO_BUFFER_NOT_FOUND` | Released or unknown id. |
| `VIDEO_BUFFER_KIND_MISMATCH` | Offline id passed to a live-only API. |
| `VIDEO_BUFFER_INVALID_STATE` | Ingest/tap on **finished**; finalize twice; offline extract on **recording**. |
| `VIDEO_FFMPEG_DISABLED` | File ingest or live audio tap with FFmpeg compiled out. |
| `VIDEO_CONTAINER_UNSUPPORTED` | Ingest container not in the v1 set. |
| `VIDEO_NO_VIDEO_TRACK` | Ingest file has no video. |
| `VIDEO_NO_AUDIO_TRACK` | Live audio tap but no audio packets. |
| `VIDEO_CODEC_UNSUPPORTED` | Video codec not H.264/HEVC. |
| `VIDEO_AUDIO_CODEC_UNSUPPORTED` | Tap/extract codec not in the SDK FFmpeg build. |
| `VIDEO_FRAME_EVICTED` | Decode of a PTS that left the ring (and was not spooled). Raise `ringSeconds` or use `retention: 'session'` / `maxSeconds`. |
| `VIDEO_SPOOL_IO` | Spool read/write failed (`retention` session/path/maxSeconds). |
| `VIDEO_FILE_CORRUPT` | Ingest demux failed. |
| `VIDEO_MEMORY_BUDGET_EXCEEDED` | Process decode/RGB budget exceeded. |

Offline extract/export codes after finalize: [videobuffer-offline.md](videobuffer-offline.md#error-codes). Preview: [videopreview.md](videopreview.md).

---

## See also

- [Pipeline video buffers — offline](videobuffer-offline.md)
- [Video preview](videopreview.md) (`seekToLiveEdge`, display decoder budget)
- [Pipeline audio buffers — live / streaming](audiobuffer-streaming.md)
- [fileio.md](fileio.md) (`FileSource`)
- [Disabling FFmpeg](disable-ffmpeg.md)

---

<details>
<summary>Use case examples</summary>

**Live preview while ingesting in realtime**

```ts
const live = await createEmptyLiveVideoBuffer({ retention: 'session' });
const player = await createVideoPreviewPlayer(live, { audio: { source: 'track' } });
await player.play();
await ingestFileToLiveVideoBuffer(
  { kind: 'fs', path: '/tmp/clip.mp4' },
  live,
  { pacing: 'realtime' }
);
await player.seekToLiveEdge();
```

**Keep only the last 30 seconds**

```ts
const live = await createEmptyLiveVideoBuffer({
  ringSeconds: 8,
  retention: { mode: 'maxSeconds', seconds: 30 },
});
```

**Streaming STT from a recording take**

```ts
const live = await createEmptyLiveVideoBuffer();
await ingestFileToLiveVideoBuffer(
  { kind: 'fs', path: '/tmp/clip.mp4' },
  live,
  { pacing: 'realtime', includeAudio: true }
);
const tap = await createLiveAudioBufferFromLiveVideo(live, { targetSampleRateHz: 16000 });
// pass tap.audio into streaming STT (see audiobuffer-streaming.md)
await tap.stop();
```

</details>

---

## Native crash diagnostics

If the process dies in native code (TOCTOU, use-after-release), capture a tombstone / logcat crash dump and include it with the buffer ids and the API sequence (create → ingest/events → finalize/release).
