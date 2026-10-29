# VideoPreview — implementation plan (incl. audio)

Branch: `feat/add-videopreview-komponent` (based on `feat/videobuffer`). Status: **plan for joint review, nothing implemented**. The example-app screen is a separate later step and not part of this branch's commits.

Prerequisite reading: [videobuffer-implementation-plan.md](videobuffer-implementation-plan.md) (§10 is the behaviour contract this plan implements), [videobuffer-internal.md](videobuffer-internal.md).

## 0. Requirements this plan answers

1. A React component that previews the content of a `VideoBuffer` (offline and live) on Android and iOS.
2. Controls: play, pause, resume, seek forward / backward (absolute and relative), frame step, scrubbing, jump to live edge.
3. **Audio in v1**, in sync with video, and a way to bring the audio track of a video into the SDK's `AudioBuffer` pipeline (STT, enhancement, …).
4. Self-built player in C++ (no RN player library), so performance work stays in our hands.
5. OCR (CPU decode) and preview **may** run at the same time; neither may silently break the other.
6. Strict TypeScript API; free to deviate from older view patterns where a better shape exists.
7. Same rules as VideoBuffer: HW-only video decode (no silent SW fallback), FFmpeg LGPL-only (no `--enable-gpl` / `--enable-nonfree` / `--enable-version3`), debug-first logging.

## 1. Decisions (proposed — confirm or change in review)

| # | Topic | Proposal | Short reason |
|---|---|---|---|
| D1 | Player engine | Own C++ player on top of `VideoPacketReader`; platform renderers only | Live ring/spool and eviction semantics do not fit any URI/container-based player |
| D2 | Video render, Android | NDK `AMediaCodec` configured with the view's `ANativeWindow` (surface mode); we time `AMediaCodec_releaseOutputBufferAtTime` ourselves | Zero-copy, HW, no CPU frames; same codec catalog as OCR decoder |
| D3 | Video render, iOS | `AVSampleBufferDisplayLayer` fed AVCC `CMSampleBuffer`s (layer decodes with VideoToolbox) | Zero-copy, HW, built-in timebase; no own `VTDecompressionSession` for preview |
| D4 | Audio storage | VideoBuffer keeps the **encoded** audio track (index for offline, packets in ring/spool for live) next to the video track | 1 MB/min (AAC 128k) instead of 11–23 MB/min PCM; same timeline, seek, eviction as video |
| D5 | Audio decode | FFmpeg SW decoders already in the prebuilts (`aac, mp3, opus, vorbis, flac, pcm_*`), shared C++ for both platforms | Already shipped and LGPL; AAC stereo decode is ~1 % of one core |
| D6 | Preview audio output, Android | `android.media.AudioTrack` (float, created in Kotlin, driven from C++ via JNI with a direct `ByteBuffer`) | `AudioTrack.getTimestamp` works on API 19+; Oboe/AAudio lack timestamps and device selection on API 24–26 (see §2.4) |
| D7 | Preview audio output, iOS | `AVSampleBufferAudioRenderer` + `AVSampleBufferRenderSynchronizer` (same synchronizer as the display layer), LPCM float32 | One audio-mastered timebase drives audio and video; no own sync code on iOS |
| D8 | Master clock | Audio when an audio track is playing (also when muted — volume 0, sink keeps running); monotonic clock otherwise | Standard A/V sync; mute/unmute never jumps |
| D9 | AudioBuffer integration | **Export**, not internal storage: `createOfflineAudioBufferFromVideo` (offline + finished live) and later `createLiveAudioBufferFromLiveVideo` (tap). Preview does **not** play through an AudioBuffer by default | Pipeline buffers are mono / 16 kHz analysis PCM; preview needs stereo at source rate, low start latency, seek inside compressed data (§2.2) |
| D10 | Optional audio source override | API shape reserved now: `audio: { source: 'audioBuffer', buffer }` (e.g. play denoised / dubbed audio against the video). Implemented in a later phase | Non-breaking extension of a discriminated union |
| D11 | Decoder budget | Split `DecoderPool` into classes: `cpu` (OCR, export, image bridge) default 1, `display` (preview) default 1 — total stays 2. Configurable. Exhausted → explicit error, never silent sharing | OCR + preview concurrently by default, deterministic failure otherwise |
| D12 | Playback rate | v1: `1.0` only. Rate ≠ 1 is a later phase (needs audio time-stretch on Android) | Keeps v1 sync simple and correct |
| D13 | Reverse | No reverse playback (HW decoders are forward-only). "Zurückspulen" = relative seek back / scrub / step back | Explicit in docs |
| D14 | TS shape | Player object (lifetime independent of the view) + thin `<VideoPreviewView player={…} />`; new subpath `react-native-sherpa-onnx/videopreview` | Like `expo-video`'s player/view split; no prop/command races; `videobuffer` stays UI-free |
| D15 | Native view, Android | Default `SurfaceView`; prop `androidViewType: 'surfaceView' \| 'textureView'` for overlays/animations/rounded corners | SurfaceView is the efficient HW overlay path; TextureView composes with RN transforms |
| D16 | Native component kind | Legacy `ViewManager` + `requireNativeComponent` like `OfflineImageBufferFrameView` (RN interop on new arch). Codegen Fabric component later, hidden behind the same TS component | Matches repo (`codegenConfig.type: "modules"`); control path is the TurboModule anyway |
| D17 | Unsupported audio codec with `audio` default | Plays video-only and reports `audio.status: 'unsupported'` + `audioUnavailable` event + warning log; `required: true` makes it a hard error | Explicit, observable — not a silent fallback |

## 2. Research summary

### 2.1 Off-the-shelf players (rejected)

| Candidate | Why not |
|---|---|
| `react-native-video` (ExoPlayer / AVPlayer) | Needs a URI/container. Custom `DataSource` plugins exist on Android, but AVPlayer has no packet-level feed; live ring eviction, `seekClamped`/`positionEvicted`, and spool-vs-ring reads cannot be expressed. Two engines with different behaviour. |
| `expo-video` | Same URI model (ExoPlayer/AVPlayer). The **API shape** (player object + view) is adopted (D14). |
| ExoPlayer/Media3 with a custom `MediaSource` (Android only) | Possible on Android, but iOS has no equivalent; duplicates our demux/timeline; Java-side buffer management. |
| FFmpeg-based players (ffplay-style, IJKPlayer, mpv/libmpv) | Video decode would be FFmpeg SW (violates HW-only) or extra hwaccel builds; IJK/mpv pull GPL-sensitive parts and large binaries. |
| VLC (libVLC) | LGPL but huge, own demux/decode stack, no packet feed from our buffers. |

Libraries that **do** help and are adopted: platform media APIs (NDK `AMediaCodec`, `AudioTrack`, `AVSampleBufferDisplayLayer`, `AVSampleBufferAudioRenderer`, `AVSampleBufferRenderSynchronizer`), FFmpeg (`libavformat`, `libavcodec` audio decoders, `libswresample`) already shipped.

### 2.2 Where audio lives — the three options

| | A. VideoBuffer has no audio; separate AudioBuffer created at ingest | B. VideoBuffer owns encoded audio track; export to AudioBuffer on demand (**proposed**) | C. VideoBuffer owns a decoded PCM AudioBuffer internally |
|---|---|---|---|
| Memory | Pipeline PCM: 16 kHz mono 3.8 MB/min (bad preview quality) or 48 kHz stereo 23 MB/min | Encoded: ~1 MB/min; PCM only when exported, in the format the consumer asks for | Same as A, always |
| Startup | Full decode at create (offline), before preview can play | Nothing decoded at create (matches video: "container + index only") | Full decode at create |
| Sync / seek | Two buffers, two timelines to keep aligned; live eviction must be mirrored | One timeline, one seek, one eviction policy | One owner, but PCM eviction ≠ GOP eviction |
| Pipeline fit | Direct | Explicit export returns a normal `OfflineAudioBufferRef` / `LiveAudioBufferRef` + `mediaStartMs` to align results with video time | Direct, but forces mono/16k or a second copy |
| Preview quality | Mono / downsampled unless a second full-quality copy | Source rate and channels | Same as A |

B keeps the VideoBuffer design principles (encoded storage, lazy decode) and still makes the audio a first-class pipeline input. It also gives cross-modal alignment: STT segment times + `mediaStartMs` and OCR `ptsMs` share the same video timeline.

Works already today (no new code): `createOfflineAudioBufferFromFile(sameMp4)` decodes the audio of an MP4/MKV file through the existing FFmpeg path. It does not report the media start offset (edit lists, audio starting late) and cannot work for live buffers — hence the new export API.

### 2.3 Audio decode

FFmpeg prebuilts (`third_party/ffmpeg_prebuilt/build_ffmpeg*.sh`) already enable `aac, mp3, vorbis, flac, opus, pcm_*` decoders, `mov, matroska, …` demuxers and `swresample`. Zero configure changes needed. Not available (by design, stays so): `ac3/eac3/dts/alac-decoder` → reported as unsupported (D17). Android MediaCodec / AudioToolbox HW audio decode was considered: no gain for a ~1 %-CPU task, adds per-platform paths and AAC-only coverage.

### 2.4 Android audio output

| Option | Clock (timestamp) API 24–26 | Device selection API 24–26 | Fit |
|---|---|---|---|
| Oboe (AAudio on API 27+, OpenSL ES below) | OpenSL ES: `getTimestamp`, `getFramesRead/Written` return `ErrorUnimplemented` (Oboe FullGuide "Known issues") | OpenSL ES ignores `setDeviceId` | New vendored dependency, broken clock on 3 supported API levels |
| AAudio direct (dlopen) | Not available below 26; 26 has the RefBase crash Oboe avoids | — | Needs a second path anyway |
| **`AudioTrack` (float, `WRITE_BLOCKING`)** | `getTimestamp(AudioTimestamp)` since API 19; `getPlaybackHeadPosition` | `setPreferredDevice` (API 23) via `PaAudioSessionCoordinator.applyPreferredDevice(track)` | Same backend as `PcmPlayer`; coordinator focus/routing reused; latency irrelevant for video |

ExoPlayer uses the same `AudioTrack` timestamp + head-position approach (`AudioTrackPositionTracker`). JNI cost: one `write(ByteBuffer)` per ~20–40 ms chunk from the C++ audio thread with a preallocated direct buffer — negligible.

### 2.5 iOS

`AVSampleBufferRenderSynchronizer` with the display layer and the audio renderer added: its timebase defaults to the audio renderer's clock; without an audio renderer it is the host clock (D8 falls out for free). `setRate:time:` drives play/pause/seek. LPCM `CMSampleBuffer`s with correct, advancing PTS (frames/sampleRate) are required. Both classes exist on macOS 10.13+, so a macOS host test can prove the format choice without a device (§15).

Known pitfalls to design for: display layer enters `AVQueuedSampleBufferRenderingStatusFailed` after background/media-server reset → flush and re-enqueue from the keyframe at the current position; audio renderer auto-flush on route change (`AVSampleBufferAudioRendererWasFlushedAutomaticallyNotification`) → re-enqueue from `flushTime`.

## 3. Architecture

```
TS  src/videopreview/*   createVideoPreviewPlayer, hooks, <VideoPreviewView>, strict types, events
TS  src/videobuffer/*    + VideoBufferInfo.audio, createOfflineAudioBufferFromVideo, (later) live audio tap
     │ TurboModule (NativeSherpaOnnx.ts)  +  view managers (playerId prop only)
Android Kotlin VideoPreviewService/View ─ JNI ─┐      iOS ObjC++ SherpaOnnx+VideoPreview.mm / VideoPreviewView
                                               ▼            ▼
C++ core android/src/main/cpp/video/
   OfflineVideoEntry / LiveVideoEntry ── video track + audio track (encoded)
   preview/
     PreviewRegistry ── PreviewPlayer
                          ├─ PlaybackController   (pure state machine, injected clock)
                          ├─ VideoFeeder ── VideoPacketReader ── IVideoRenderer
                          │                                       ├─ android/MediaCodecSurfaceRenderer (AMediaCodec + ANativeWindow)
                          │                                       └─ ios/SampleBufferVideoRenderer (AVSampleBufferDisplayLayer)
                          ├─ AudioFeeder ── AudioPacketReader ── FfmpegAudioDecoder ── PcmRing ── IAudioRenderer
                          │                                       ├─ android/JniAudioTrackRenderer (AudioTrack via JNI)
                          │                                       └─ ios/SampleBufferAudioRenderer (AVSampleBufferAudioRenderer)
                          └─ IPlaybackClock   (android: AudioTrackClock | MonotonicClock;  ios: SynchronizerClock)
   audio/
     FfmpegAudioDecoder, AudioTimeline, VideoAudioExtractor (→ .f32 → platform AudioBuffer registry)
```

The controller and feeders are shared C++. Platform code is limited to "put this packet/PCM on screen/speaker" and "what time is it".

### 3.1 Source layout (new / changed)

```
android/src/main/cpp/video/
  VideoTypes.h                      + AudioCodec, AudioTrackInfo, VideoBufferInfo.audio, preview error codes
  audio/AudioTimeline.{h,cpp}        audio packet index (all packets are sync points)
  audio/FfmpegAudioDecoder.{h,cpp}   packet → float interleaved; priming/skip-samples; swr for channel/format
  audio/VideoAudioExtractor.{h,cpp}  range decode → target rate/mono → .f32 file (+ progress, cancel)
  audio/AudioPacketReader.{h,cpp}    SeekTo(tUs) / Next(timeoutMs) on offline + live (mirrors VideoPacketReader)
  demux/FfmpegDemuxer.{h,cpp}        + audio stream selection + index; MKV audio via second discard-context
  live/EncodedPacketRing, PacketSpool (v2), LiveVideoEntry, LiveIngest   + audio track
  decode/DecoderPool.{h,cpp}         + DecoderClass { Cpu, Display } budgets
  preview/PlaybackController.{h,cpp} pure state machine
  preview/PlaybackClock.{h,cpp}      IPlaybackClock, MonotonicClock, AudioClockEstimator (pure math)
  preview/FrameScheduler.{h,cpp}     render / drop / wait decision (pure)
  preview/VideoFeeder.{h,cpp}        reader + generation + preroll target + Annex-B rewrite
  preview/AudioFeeder.{h,cpp}        reader + decoder + trim/pad + PcmRing writer
  preview/PcmRing.h                  lock-free SPSC float ring with pts segments
  preview/Renderers.h                IVideoRenderer, IAudioRenderer interfaces
  preview/PreviewPlayer.{h,cpp}      composition, threads, command queue, events
  preview/PreviewRegistry.{h,cpp}    ids `vprev_<uuid>`, event sink, lifecycle
  platform/android/MediaCodecSurfaceRenderer.{h,cpp}
  platform/android/JniAudioTrackRenderer.{h,cpp}
android/src/main/cpp/jni/video/sherpa-onnx-videopreview-jni.cpp
android/src/main/java/com/sherpaonnx/video/preview/{VideoPreviewNative.kt, VideoPreviewService.kt,
    VideoPreviewAudioTrack.kt, VideoPreviewView.kt, VideoPreviewViewManager.kt}
ios/videobuffer/preview/{SherpaOnnx+VideoPreview.mm, SampleBufferVideoRenderer.{h,mm},
    SampleBufferAudioRenderer.{h,mm}, SynchronizerClock.{h,mm}, VideoPreviewView.{h,mm}, VideoPreviewViewManager.mm}
src/videopreview/{index.ts, types.ts, player.ts, hooks.ts, VideoPreviewView.tsx, __tests__/…}
test/cpp/videobuffer/{audio_demux_test.cpp, audio_decode_test.cpp, preview_controller_test.cpp,
    preview_sync_test.cpp, pcm_ring_test.cpp, sb_host_test.mm}
```

## 4. Audio track in the VideoBuffer core

### 4.1 Types

```cpp
enum class AudioCodec { Aac, Mp3, Opus, Vorbis, Flac, Pcm, Unsupported };
struct AudioTrackInfo {
  AudioCodec codec; std::string codecName;   // avcodec_get_name, also for Unsupported
  int ffmpegCodecId;                          // AVCodecID, serialized as codec enum in spool
  int sampleRate; int channels; uint64_t channelLayoutMask;
  int frameSize;                              // samples per packet when constant (AAC 1024)
  int64_t initialPaddingSamples;              // codecpar->initial_padding (priming)
  std::vector<uint8_t> extradata;             // AudioSpecificConfig / OpusHead / Vorbis headers
  Rational timeBase;
  bool decodable;                             // decoder present in this FFmpeg build
};
struct AudioPacketEntry { int64_t ptsUs; int64_t durationUs; int64_t fileOffset; uint32_t size; };
struct VideoBufferInfo { … ; std::optional<AudioTrackInfo> audio; TimeRange audioRange; };
```

`AudioTimeline`: sorted entries; `IndexAtOrBefore(tUs)`, `startUs()`, `endUs()`; segment-chunked append for live (same reader-snapshot rule as `Timeline`). Memory: 47 packets/s at 48 kHz AAC → 1 h ≈ 170 k entries × 32 B ≈ 5.4 MB; acceptable, documented. Compact 16-B entry (delta pts) is a later optimisation if needed.

### 4.2 Offline demux

- Stream selection: video as today; audio via `av_find_best_stream(AVMEDIA_TYPE_AUDIO, -1, videoIndex)` (related to the selected video stream). No audio stream → `audio = nullopt` (not an error). Audio-only files still → `VIDEO_NO_VIDEO_TRACK`.
- `decodable = avcodec_find_decoder(id) != nullptr` evaluated once at open with the shipped FFmpeg.
- **MP4/MOV:** audio index from the mov index entries of the audio stream (pts, pos, size) → `FileIo::pread` per packet, independent from video reads. Edit list / `start_time` already applied by mov; `initialPaddingSamples` from codecpar.
- **Matroska/WebM:** Cues reference video only. Audio uses a **second `AVFormatContext`** on the same file with every non-audio stream set to `AVDISCARD_ALL`, seek with `av_seek_frame(audioStream, ts, AVSEEK_FLAG_BACKWARD)` + `av_read_frame`. Video context sets the audio stream to `AVDISCARD_ALL` (today's context reads interleaved audio payloads it throws away — small win for OCR too). Rule decided at open and logged, like video.
- Open still reads no packet payloads (existing AVIO byte-counter test extended).

### 4.3 Live

- Writer API: `LiveVideoWriter::SetAudioConfig(const AudioTrackInfo&)`, `AppendAudioPacket(const EncodedPacket&)`. Audio packets before the first video keyframe are dropped (seekable range is defined by video).
- `EncodedPacketRing`: one byte budget for both tracks; eviction stays GOP-driven for video; after each video eviction, audio packets with `pts < ringStartUs − 100 ms` are evicted (tiny margin so seek-to-ring-start has audio from the first sample).
- `PacketSpool` **v2**: header gains an optional audio-track block (codec enum, rate, channels, layout, extradata, timeBase, padding). Record layout unchanged; `flags` bits 8–15 carry the track index (0 = video, 1 = audio). v1 segments read as video-only. Segment rotation still at video keyframes; audio records simply interleave. Recovery logic unchanged (record CRC).
- `LiveIngest` (file → live): forwards audio packets of the selected audio stream too (`IngestFileToLiveOptions.includeAudio`, default `true`), paced with the same wall-clock mapping as video in `realtime`.
- Info: `audioRange` alongside `seekableRange`; `packetsAppended` event unchanged (video counters), plus `audioPacketsAppended` counter in info, no extra event.

## 5. Audio decode and pipeline export

### 5.1 `FfmpegAudioDecoder` (shared by preview and export)

- `Configure(const AudioTrackInfo&)`: `avcodec_alloc_context3`, codecpar from stored fields, `avcodec_open2`.
- `Submit(packet)` / `Receive(PcmChunk*)`: `PcmChunk { int64 ptsUs; int frames; float interleaved[] }` (pooled buffers, no per-packet malloc).
- Output format: `AV_SAMPLE_FMT_FLT` packed via `swr` only when the decoder's native format differs (AAC is `FLTP` → swr interleave); channels > 2 are downmixed to stereo; **sample rate unchanged** (sinks handle device rate).
- Priming and trims: honour `AV_PKT_DATA_SKIP_SAMPLES` / `initialPaddingSamples`, so audio sample 0 maps exactly to the track's first presentation time (edit-list aware). Tested with an AAC fixture.
- `Flush()` → `avcodec_flush_buffers` (seek).

### 5.2 `createOfflineAudioBufferFromVideo` (Phase 2)

```ts
function createOfflineAudioBufferFromVideo(
  video: OfflineVideoBufferIdSource,          // offline or finished live
  options?: {
    targetSampleRateHz?: number;               // omit → 16000 (SDK default), 0 → keep source, >0 → exact
    rangeMs?: { startMs: number; endMs: number };
    onProgress?: (e: { percent: number; decodedMs: number }) => void;
    signal?: AbortSignal;
  }
): Promise<VideoAudioExtractResult>;

interface VideoAudioExtractResult {
  audio: OfflineAudioBufferRef;   // normal pipeline buffer (mono, like every offline AudioBuffer)
  mediaStartMs: number;           // video-timeline time of sample 0 (edit list / late audio / range start)
  sourceCodec: string;
  sourceSampleRate: number;
  sourceChannels: number;
}
```

- Native: `VideoAudioExtractor` decodes the packets of the range → swr (rate + downmix to mono) → writes a raw `.f32` temp file (`vid_aud_<uuid>.f32`, swept like other `vid_` files) → the platform bridge creates the AudioBuffer with the **existing** builders used by `createOfflineAudioBufferFromFile` (Android: `PipelineAudioRegistry.createOfflineFromMmapFile` above `MmapThresholdPolicy` FILE_ORIGIN threshold, else heap copy; iOS: equivalent builder in `SherpaOnnx+PipelineAudio.mm`).
- Errors: `VIDEO_NO_AUDIO_TRACK`, `VIDEO_AUDIO_CODEC_UNSUPPORTED` (with `codecName`), `VIDEO_BUFFER_INVALID_STATE` (recording live), `VIDEO_CANCELLED`, plus existing `DECODE_*`-style resample errors mapped to `VIDEO_AUDIO_DECODE_FAILED`.
- Does not use any HW video decoder → no interaction with the decoder budget.

### 5.3 Live tap `createLiveAudioBufferFromLiveVideo` (Phase 7)

```ts
function createLiveAudioBufferFromLiveVideo(
  live: LiveVideoBufferIdSource,
  options?: { targetSampleRateHz?: number; windowSeconds?: number; startAt?: 'oldest' | 'liveEdge' }
): Promise<{ audio: LiveAudioBufferRef; mediaStartMs: number; stop(): Promise<void> }>;
```

Native worker: `AudioPacketReader` in tail mode → decoder → resample → `LiveEntry.appendSamples` with a `LiveAudioPipelineWriter` origin (existing append-event machinery). Finalizes the LiveAudioBuffer when the video buffer finishes. Registered as a `StreamingPipelineWorker` so streaming STT can consume it like mic input.

## 6. Preview core (C++)

### 6.1 Threads per player

| Platform | Threads / queues |
|---|---|
| Android | `vprev-ctl-<id>` command executor; `vprev-video-<id>` (read packet → Annex-B → codec input; dequeue output → `FrameScheduler`); `vprev-audio-<id>` (read → decode → `PcmRing` → `AudioTrack.write` blocking) |
| iOS | serial `ctl` queue; display layer `requestMediaDataWhenReadyOnQueue` (video feeder); audio renderer `requestMediaDataWhenReadyOnQueue` (audio feeder + decoder) |

All feeder work is pulled by readiness (codec input buffers / `isReadyForMoreMediaData`), so no thread spins. Commands from JS never block the JS thread: TurboModule enqueues on `ctl`, promise resolves when the controller applied the command (seek: when the target frame is shown).

### 6.2 `PlaybackController` (pure, host-tested)

States: `idle → preparing → ready → playing ⇄ paused`, transient `seeking` (remembers `resumeAfter`), `buffering` (live tail / underrun, remembers `resumeAfter`), `ended`, `error` (terminal), `released`.

Inputs: `Play, Pause, Seek(tUs, mode), SeekBy(dUs, mode), SeekToLiveEdge, StepFrame(±1), SurfaceAttached, SurfaceDetached, FirstFrameShown(gen), VideoEos(gen), AudioEos(gen), DataStarved, DataAvailable, Evicted(range), BufferFinished, AudioInterrupted(reason), AudioUnavailable(reason), AppBackground, AppForeground, RendererFailed(code), Release`.

Effects (returned, not executed, so tests assert them): `ClockSetRate(rate, atMediaUs)`, `FlushAll(gen)`, `StartFeed(targetUs, mode, gen)`, `StopFeed`, `RequestDecoder(class)`, `ReleaseDecoder`, `Emit(event)`.

Rules:
- Every flush increments `generation`; feeders/renderers drop work tagged with an older generation (no locks across threads for cancellation).
- **Seek coalescing**: while `seeking`, a newer seek replaces the pending one; the replaced promise resolves `{ status: 'superseded' }`. Scrub sends many `closestKeyframe` seeks; only the newest is decoded.
- Illegal commands → `VIDEO_PREVIEW_INVALID_STATE` (e.g. `play` in `error`, any command after `released`). `play` in `ended` restarts from start (offline) / from `seekableRange.startUs` (finished live).
- `SurfaceDetached` while playing: video feed stops and the display decoder is released (budget freed); audio + clock continue. `SurfaceAttached`: request decoder, `StartFeed(clockNow, exact)`.
- `AppBackground` with `pauseOnBackground` (default true) → `Pause`.

### 6.3 Clock

```cpp
class IPlaybackClock { public:
  virtual int64_t NowMediaUs() = 0;                 // monotonic non-decreasing while playing
  virtual void SetRate(double rate, int64_t atMediaUs) = 0;   // 0 = paused
  virtual bool audioMastered() const = 0; };
```

- `MonotonicClock`: `anchorMedia + (now − anchorHost) × rate` (`CLOCK_MONOTONIC` / `mach_absolute_time`).
- Android `AudioTrackClock` wraps `AudioClockEstimator` (pure math, tested):
  - Inputs: frames written per segment (seek resets segment: `anchorPtsUs`, `anchorFrame`), `getTimestamp` samples (polled every 200 ms from the audio thread, not per frame), `getPlaybackHeadPosition` as interim source until the first valid timestamp after start/flush (logged branch `clock.src=head|ts`).
  - `media(now) = anchorPts + (tsFrame − anchorFrame)/sr + (now − tsTimeNs)` while playing; clamp to `≤ written frames` (never ahead of written audio); monotonic guard; correction slewed (≤ 5 ms per update) unless error > 80 ms (then snap + log).
- iOS `SynchronizerClock`: `CMTimebaseGetTime(synchronizer.timebase)`; `SetRate` → `setRate:time:`.

### 6.4 A/V sync

- Audio master: audio is written continuously (ring 300 ms target fill, like `PcmPlayer`'s `DEFAULT_MAX_BUFFERED_MS`); video follows the clock.
- Android `FrameScheduler::Decide(framePtsUs, clockUs, nowNs, vsyncNs)`:
  - `late = clockUs − framePtsUs`; `late > max(1 frame, 40 ms)` → **drop** (`release(render=false)`, `framesDropped++`).
  - `framePtsUs − clockUs > 2 × vsync` → **wait** (hold ≤ 2 output buffers; sleep until due − 2 vsync).
  - else **render at** `nowNs + (framePtsUs − clockUs)·1000` via `AMediaCodec_releaseOutputBufferAtTime` (SurfaceFlinger presents on the matching vsync). Vsync period from `Display.getRefreshRate()` passed at attach / on change. Vsync snapping (ExoPlayer `VideoFrameReleaseHelper` style) is a later refinement.
- iOS: video `CMSampleBuffer`s carry PTS; the synchronizer presents them. Frames before the seek target get `kCMSampleAttachmentKey_DoNotDisplay`.
- Audio start/gaps: after a seek, decoded samples with pts < target are trimmed sample-accurately; if audio starts after the target (late audio / gap / discontinuity) explicit silence is written so the clock mapping stays linear (logged `audio.pad`). Audio behind (overlap) is trimmed.
- Measured stats exposed in the snapshot: `framesRendered`, `framesDropped`, `audioUnderruns`, `avOffsetMs` (rolling mean of `framePts − clock` at render).

### 6.5 Seek, scrub, step

| Operation | Algorithm |
|---|---|
| `seekTo(t, 'exact')` (default) | `FlushAll(gen)`; video: `SeekToKeyframe(t)`, decode forward, frames `< t` released without render (Android) / `DoNotDisplay` (iOS), first frame `≥ t` is shown (also when paused); audio: `AudioPacketReader.SeekTo(t − 1 packet)`, decode, trim to `t`; clock anchored at the **shown frame's pts**; resume if `resumeAfter`. |
| `seekTo(t, 'keyframe')` | `KeyframeAtOrBefore(t)`; show it; position = keyframe pts. |
| `seekTo(t, 'closestKeyframe')` (scrub while dragging) | `ClosestKeyframe(t)`; decode the IDR only; show it; coalesced. On drag end the UI sends one `exact` seek. Uses the **display** decoder, not `KeyframeThumbCache` (no CPU decoder contention with OCR). |
| `seekBy(Δ)` ("vor-/zurückspulen") | `seekTo(clamp(position + Δ), mode)`; default mode `exact`. |
| `stepFrame(+1)` (paused) | decode next frame in presentation order and show; no audio. |
| `stepFrame(−1)` (paused) | exact seek to the previous frame's pts from the timeline (costs one GOP decode-through). |
| Cost bound | exact seek = keyframe + ≤ GOP frames HW-decoded without rendering (2 s GOP @30 fps ≈ 60 frames; HW 1080p ≫ 200 fps → < 300 ms). Logged: `seek target, keyframe, decodedThrough, ms`. |

### 6.6 Live behaviour (implements VideoBuffer plan §10)

| Case | Behaviour |
|---|---|
| Start on a recording buffer | `live.startAt: 'liveEdge'` (default) → exact seek to `liveEdge − targetLatencyMs` (default 1000 ms); `'oldest'` → `seekableRange.startUs`. `atLiveEdge = true`. |
| Target inside `seekableRange` | Normal seek (ring fast, spool slow). |
| Target older than `seekableRange.startUs` | Clamp to start, `seekClamped { requestedMs, actualMs, reason: 'beforeStart' }`. |
| Target after live edge | Clamp to `liveEdge − targetLatencyMs`, `seekClamped { reason: 'afterLiveEdge' }`. |
| Reader tail-waits (no data) | `buffering` (clock rate 0, audio paused, last frame stays) → resume when ≥ 300 ms of video ahead of the clock. |
| Following and lag > `maxLatencyMs` (default 3000) | Seek to `liveEdge − targetLatencyMs`, emit `liveEdgeResync`. |
| User pauses / seeks back | `atLiveEdge = false`; `seekToLiveEdge()` resumes following. |
| Paused (or behind) and overtaken by eviction | `VIDEO_FRAME_EVICTED` from the reader or a range check on `packetsAppended` → jump to oldest available keyframe, `positionEvicted { previousMs, newMs }`. |
| Buffer finishes | `BufferFinished`; durations become known; at EOS → `ended`. Finished with spool = offline behaviour. |

### 6.7 Packet hand-off performance

- Packet payload buffers come from a per-feeder pool (`EncodedPacket` reuse), no per-packet heap allocation in steady state.
- Android Annex-B: when the AVCC length size is 4 (common case), length prefixes are rewritten **in place** to `00 00 00 01` directly in the codec input buffer (one copy: file/ring → codec buffer). Other length sizes use `BitstreamUtil`.
- iOS: `CMBlockBuffer` wraps the pooled payload with a custom block source that returns it to the pool on free — zero-copy into the layer.
- Audio: decode output written straight into `PcmRing`; the Android JNI write uses one preallocated direct `ByteBuffer` per player.

## 7. Android platform

- **`MediaCodecSurfaceRenderer`** (C++): codec chosen by name from `VideoCodecCatalog` (HW-only, existing global names); `AMediaFormat` with codec config (`csd-0/1`), `rotation-degrees` from `VideoTransform` (honoured in surface mode), `AMediaCodec_configure(…, window, …)`; synchronous mode (minSdk 24). Mirror is applied by the view (scaleX = −1). Emulator: same as OCR decode — `VIDEO_DECODER_UNAVAILABLE`, no fallback.
- **Surface lifecycle** (Kotlin `VideoPreviewView`): `SurfaceHolder.Callback` / `TextureView.SurfaceTextureListener` → JNI `nativeAttachSurface(playerId, Surface, refreshRateHz)` → `ANativeWindow_fromSurface`; `surfaceDestroyed` → `nativeDetachSurface` **synchronously** (renderer stops and releases the codec before returning, otherwise the codec writes into a dead window).
- **Layout**: `resizeMode: 'contain' | 'cover' | 'stretch'` computed natively from `displayWidth/height` (+ SAR) in the view's `onLayout` — inner SurfaceView sized/centred (AspectRatioFrameLayout-style) or `TextureView.setTransform` matrix. No JS geometry.
- **`VideoPreviewAudioTrack.kt`**: creates `AudioTrack` (`ENCODING_PCM_FLOAT`, source rate, mono/stereo, `USAGE_MEDIA`, `CONTENT_TYPE_MOVIE`, buffer = 2 × `getMinBufferSize`), registers `PaAudioSessionCoordinator.acquireIntent("vprev:<id>", needsOutput)` and `applyPreferredDevice(track)`; JNI-called methods: `write(ByteBuffer, bytes)`, `play`, `pause`, `flush`, `getTimestamp(long[2])`, `headPosition()`, `setVolume`, `release`.
- **Focus**: the coordinator's focus listener is log-only today → add a listener fan-out (`addFocusListener`) — loss / transient loss → `AudioInterrupted` → pause + `audioInterrupted` event; duck → volume 0.2 (API < 26; system ducks on 26+). Small, separate commit.
- **Lifecycle**: `LifecycleEventListener.onHostPause/onHostResume` → `AppBackground/AppForeground`.
- **Events**: fix the known gap first — Android never set `VideoRegistry::SetEventSink`. JNI installs a sink that calls `VideoBufferService.emit(name, json)` → `RCTDeviceEventEmitter` for both `SherpaOnnxVideoEvent` and the new `SherpaOnnxVideoPreviewEvent`.
- Registration: `VideoPreviewViewManager` in `SherpaOnnxPackage.kt` (like `OfflineImageBufferFrameViewManager`).

## 8. iOS platform

- **`VideoPreviewView`**: `UIView` with `+layerClass = AVSampleBufferDisplayLayer`; `videoGravity` from `resizeMode` (`resizeAspect` / `resizeAspectFill` / `resize`); rotation/mirror via the layer's `affineTransform` with swapped bounds for 90/270.
- **`SampleBufferVideoRenderer`**: `CMVideoFormatDescriptionCreateFromH264/HEVCParameterSets` from the stored config; HW check `VTIsHardwareDecodeSupported` at prepare (HW-only rule; else `VIDEO_DECODER_UNAVAILABLE`); enqueue on readiness; `flush` on seek; observe `status == Failed` and `AVSampleBufferDisplayLayerFailedToDecodeNotification` → `RendererFailed` → controller re-feeds from the keyframe at the current position (one retry, then `error`).
- **`SampleBufferAudioRenderer`**: LPCM float32 interleaved `CMAudioFormatDescription`, buffers of ~1024–4096 frames with advancing PTS; volume/mute via `volume`/`muted`; auto-flush notification → re-feed from `flushTime`.
- **`SynchronizerClock`**: one `AVSampleBufferRenderSynchronizer` per player with both renderers added (only the layer when no audio).
- **Session**: `PaAudioSessionCoordinator acquireIntent:"vprev:<id>" needsOutput:YES` on play with audio, release on pause/ended/release; `AVAudioSessionInterruptionNotification` → `AudioInterrupted`.
- **Lifecycle**: `UIApplicationDidEnterBackground/WillEnterForeground` → controller inputs; on foreground check layer status.
- Events: `@"SherpaOnnxVideoPreviewEvent"` added to `supportedEvents`; same `gVideoModule` sink as VideoBuffer events.

## 9. Decoder and resource budget

- `DecoderPool` gets `DecoderClass { Cpu, Display }` with independent limits: `cpu = 1`, `display = 1` (defaults; total HW = 2 as before). Public option: `configureVideoBuffer({ decoderBudget: { cpu?: number; display?: number } })`.
- Display decoder acquired on `SurfaceAttached` + prepare, released on detach/release (not on pause — resume stays instant). Pool never closes an in-use display decoder for idleness.
- Busy → `VIDEO_PREVIEW_DECODER_BUSY` (event + rejected `play`), with the current holders in the message; no waiting, no preemption in v1.
- OCR + preview on the same buffer: independent readers and decoders, both read-only on the entry → safe by the existing `shared_ptr` + generation rules. Concurrency is a configuration, not a requirement.
- Audio: SW decoder per player (and per export job); not budget-limited; one `AudioTrack` / audio renderer per playing player.
- Memory: preview uses no `DecodedFrameCache`/`FrameSlab` (frames stay in GPU memory); packet pools ≈ 2 × max packet size; `PcmRing` 500 ms (48 kHz stereo float ≈ 190 KB).

## 10. TypeScript API (`react-native-sherpa-onnx/videopreview`)

```ts
export type VideoPreviewPlayerId = string & { readonly __brand: 'VideoPreviewPlayerId' };

export type VideoPreviewAudioOption =
  | { source: 'track'; required?: boolean }              // default { source: 'track', required: false }
  | { source: 'none' }
  | { source: 'audioBuffer'; buffer: PipelineAudioBufferIdSource; mediaOffsetMs?: number }; // later phase

export interface VideoPreviewPlayerOptions {
  audio?: VideoPreviewAudioOption;
  startAtMs?: number;                    // offline / finished live; default 0
  live?: {
    startAt?: 'liveEdge' | 'oldest';     // default 'liveEdge'
    targetLatencyMs?: number;            // default 1000
    maxLatencyMs?: number;               // default 3000
  };
  volume?: number;                       // [0, 1], default 1
  muted?: boolean;                       // default false
  loop?: boolean;                        // offline only, default false
  pauseOnBackground?: boolean;           // default true
  progressIntervalMs?: number;           // default 250, min 50
}

export type VideoPreviewState =
  | 'idle' | 'preparing' | 'ready' | 'playing' | 'paused'
  | 'seeking' | 'buffering' | 'ended' | 'error' | 'released';

export type VideoPreviewSeekMode = 'exact' | 'keyframe' | 'closestKeyframe';

export interface VideoPreviewSeekResult {
  status: 'completed' | 'clamped' | 'superseded';
  requestedMs: number;
  actualMs: number;
}

export type VideoPreviewAudioStatus =
  | { status: 'playing' | 'muted'; codec: string; sampleRate: number; channels: number }
  | { status: 'off' }                                   // source: 'none'
  | { status: 'absent' }                                // no audio track
  | { status: 'unsupported'; codec: string }            // D17
  | { status: 'interrupted'; reason: 'focusLoss' | 'sessionInterruption' };

export interface VideoPreviewSnapshot {
  playerId: VideoPreviewPlayerId;
  bufferId: string;
  bufferKind: PipelineVideoBufferKind;
  state: VideoPreviewState;
  positionMs: number;
  durationMs: number | null;             // null while a live buffer is recording
  seekableRange: { startMs: number; endMs: number };
  liveEdgeMs: number | null;
  atLiveEdge: boolean;
  videoAttached: boolean;
  audio: VideoPreviewAudioStatus;
  stats: { framesRendered: number; framesDropped: number; audioUnderruns: number; avOffsetMs: number };
}

export type VideoPreviewEvent =
  | { type: 'stateChanged'; state: VideoPreviewState; previousState: VideoPreviewState }
  | { type: 'progress'; positionMs: number; seekableRange: { startMs: number; endMs: number }; liveEdgeMs: number | null }
  | { type: 'firstFrameRendered'; positionMs: number }
  | { type: 'seekCompleted'; result: VideoPreviewSeekResult; mode: VideoPreviewSeekMode }
  | { type: 'seekClamped'; requestedMs: number; actualMs: number; reason: 'beforeStart' | 'afterLiveEdge' }
  | { type: 'positionEvicted'; previousMs: number; newMs: number }
  | { type: 'liveEdgeResync'; lagMs: number; newMs: number }
  | { type: 'audioUnavailable'; reason: 'absent' | 'unsupported'; codec?: string }
  | { type: 'audioInterrupted'; reason: 'focusLoss' | 'sessionInterruption' }
  | { type: 'ended' }
  | { type: 'error'; code: VideoPreviewErrorCode; message: string };

export interface VideoPreviewPlayer {
  readonly playerId: VideoPreviewPlayerId;
  readonly bufferId: string;
  play(): Promise<void>;                         // start, resume after pause, restart after ended
  pause(): Promise<void>;
  seekTo(positionMs: number, options?: { mode?: VideoPreviewSeekMode }): Promise<VideoPreviewSeekResult>;
  seekBy(deltaMs: number, options?: { mode?: VideoPreviewSeekMode }): Promise<VideoPreviewSeekResult>;
  seekToLiveEdge(): Promise<VideoPreviewSeekResult>;   // rejects VIDEO_PREVIEW_INVALID_STATE on offline
  stepFrame(direction: 1 | -1): Promise<VideoPreviewSeekResult>;  // paused only
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setLoop(loop: boolean): Promise<void>;
  getSnapshot(): Promise<VideoPreviewSnapshot>;
  addListener<T extends VideoPreviewEvent['type']>(
    type: T,
    listener: (event: Extract<VideoPreviewEvent, { type: T }>) => void
  ): () => void;
  release(): Promise<void>;                      // idempotent; afterwards every method rejects VIDEO_PREVIEW_RELEASED
}

export function createVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource,
  options?: VideoPreviewPlayerOptions
): Promise<VideoPreviewPlayer>;

/** Creates on mount / source change, releases on unmount; StrictMode-safe. null until created. */
export function useVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource | null,
  options?: VideoPreviewPlayerOptions
): VideoPreviewPlayer | null;

/** useSyncExternalStore over events; `smoothPosition` interpolates positionMs per animation frame while playing. */
export function useVideoPreviewStatus(
  player: VideoPreviewPlayer | null,
  options?: { smoothPosition?: boolean }
): VideoPreviewSnapshot | null;

export interface VideoPreviewViewProps extends ViewProps {
  player: VideoPreviewPlayer | null;
  resizeMode?: 'contain' | 'cover' | 'stretch';      // default 'contain'
  androidViewType?: 'surfaceView' | 'textureView';   // default 'surfaceView'
}
export function VideoPreviewView(props: VideoPreviewViewProps): React.JSX.Element;
```

Mapping of requested controls: play → `play()`; pause → `pause()`; resume → `play()` (one method, state decides); vorspulen/zurückspulen → `seekBy(±ms)` or `seekTo`; scrubbing → `seekTo(ms, { mode: 'closestKeyframe' })` while dragging + `seekTo(ms)` on release; frame step → `stepFrame(±1)`; live → `seekToLiveEdge()`.

Strictness: options validated in TS before the native call (ranges, mutually exclusive fields) with `VIDEO_PREVIEW_INVALID_ARGUMENT`; ids branded; events are a discriminated union parsed and validated from the native payload (unknown types dropped with a dev warning, not cast); no `any` in public types.

Usage sketch:

```tsx
const video = await createOfflineVideoBufferFromFile({ kind: 'fs', path });
function Preview({ video }: { video: OfflineVideoBufferRef }) {
  const player = useVideoPreviewPlayer(video, { audio: { source: 'track' } });
  const status = useVideoPreviewStatus(player, { smoothPosition: true });
  return (
    <>
      <VideoPreviewView player={player} resizeMode="contain" style={{ aspectRatio: 16 / 9 }} />
      <Button title="⏪ 10 s" onPress={() => player?.seekBy(-10_000)} />
      <Button title={status?.state === 'playing' ? 'Pause' : 'Play'}
              onPress={() => (status?.state === 'playing' ? player?.pause() : player?.play())} />
      <Button title="10 s ⏩" onPress={() => player?.seekBy(10_000)} />
    </>
  );
}
```

`videobuffer` subpath additions: `VideoBufferInfo.audio: VideoAudioTrackInfo | null` (`{ codec, decodable, sampleRate, channels, startMs, durationMs }`), `createOfflineAudioBufferFromVideo`, later `createLiveAudioBufferFromLiveVideo`, `configureVideoBuffer({ decoderBudget })`, `IngestFileToLiveOptions.includeAudio`.

## 11. Native bridges

TurboModule (`src/NativeSherpaOnnx.ts`, codegen option structs — never `NSDictionary *` on iOS, harness lesson): `videoPreviewCreate(bufferId, options) → { playerId, snapshot }`, `videoPreviewPlay`, `videoPreviewPause`, `videoPreviewSeek(playerId, positionMs, mode, relative)`, `videoPreviewSeekToLiveEdge`, `videoPreviewStepFrame`, `videoPreviewSetVolume/SetMuted/SetLoop`, `videoPreviewGetSnapshot`, `videoPreviewRelease`, `createOfflineAudioBufferFromVideo(bufferId, options, operationId)`, `configureVideoBuffer(options)`.

View managers expose only `playerId`, `resizeMode`, (`androidViewType` is a different native view class chosen in TS). Attach/detach is native-to-native (view → `PreviewRegistry`), never through JS.

Events: `SherpaOnnxVideoPreviewEvent` `{ playerId, type, … }`; TS listener filters by `playerId`. Progress only while playing at `progressIntervalMs`, plus on every state change / seek.

## 12. Errors

New: `VIDEO_PREVIEW_NOT_FOUND`, `VIDEO_PREVIEW_RELEASED`, `VIDEO_PREVIEW_INVALID_STATE`, `VIDEO_PREVIEW_INVALID_ARGUMENT`, `VIDEO_PREVIEW_DECODER_BUSY`, `VIDEO_PREVIEW_RENDER_FAILED`, `VIDEO_PREVIEW_AUDIO_UNSUPPORTED` (only with `required: true`), `VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED`, `VIDEO_NO_AUDIO_TRACK`, `VIDEO_AUDIO_CODEC_UNSUPPORTED`, `VIDEO_AUDIO_DECODE_FAILED`. Reused: `VIDEO_DECODER_UNAVAILABLE`, `VIDEO_CODEC_UNSUPPORTED`, `VIDEO_FRAME_EVICTED`, `VIDEO_BUFFER_NOT_FOUND`, `VIDEO_BUFFER_INVALID_STATE`, `VIDEO_CANCELLED`.

## 13. Logging (debug-first)

Tags `[SherpaOnnx:video.preview]`, `video.preview.sync`, `video.preview.audio`, `video.audio` (demux/decode/extract). Same runtime gate as VideoBuffer. Log at: create (buffer, tracks, codec names, decodable), surface attach/detach (size, refresh, view type), decoder acquire/release/busy, every state transition (from → to, input, generation), seek (requested, clamped, keyframe, decodedThrough, ms, superseded), clock source switches (`head`→`ts`), corrections > 5 ms and snaps, drops (count per second, not per frame), audio underrun, pad/trim, focus/interruption, renderer failure + retry, live resync/eviction, release. Android logcat filter `SherpaOnnx:video`.

## 14. Performance notes

- No CPU frame copies for preview on either platform; one copy per video packet (file/ring → codec), zero on iOS.
- Exact seek bounded by one GOP of HW decode; scrub decodes one IDR per coalesced request.
- Audio decode ≈ 1 % of a core; audio JNI ≈ 25–50 calls/s.
- MKV: discard contexts stop the video path from reading audio payloads and vice versa.
- Later (measured first, not now): vsync snapping, `AMediaCodec` async mode on API ≥ 28, compact audio index, `AMediaCodec_setOutputSurface` (API 23) surface swap without codec re-create.

## 15. Tests

### 15.1 Host C++

| Executable / area | Must prove |
|---|---|
| `videobuffer_core_host_test` + `preview_controller_test` | Every transition and illegal command; seek coalescing (`superseded`); generation drops stale work; detach/attach restarts at clock time; `ended`/`loop`; release idempotent. |
| `preview_controller_test` (live) | All §6.6 rows with a scripted fake `LiveVideoEntry`: clamp both sides, buffering/resume thresholds, `liveEdgeResync`, eviction while paused → oldest keyframe + `positionEvicted`, finish → ended. |
| `preview_sync_test` | Virtual time: fake video renderer + fake audio sink + `AudioClockEstimator`; every rendered frame within ±1 frame of the clock; drops only when late; first frame after seek has pts ≥ target; first audio sample pts == target ±1 sample; pad/trim on late/overlapping audio; mute keeps clock continuous. |
| `AudioClockEstimator` | head → timestamp switch; extrapolation; pause/flush/segment reset; monotonic; slew vs snap thresholds; never ahead of written frames. |
| `FrameScheduler` | render/drop/wait table incl. clock jumps and refresh-rate changes. |
| `pcm_ring_test` | SPSC correctness, wrap, segment pts mapping; TSan. |
| `videobuffer_demux_host_test` + `audio_demux_test` | Audio index vs `ffprobe` expectations (MP4 AAC, MKV Opus); audio via discard context in MKV; open reads no payloads; no-audio file → `audio: null`; unsupported codec → `decodable: false` (run against `-DVIDEOBUFFER_FFMPEG=minimal`). |
| `audio_decode_test` | AAC priming trimmed (sample 0 = first presentation time); seek-trim sample accuracy on a ramp/tone fixture; Opus/MP3 decode counts; flush. |
| Extract | Duration ±1 packet; `mediaStartMs` for edit-list and late-audio fixtures; 16 kHz mono sample count formula; range; cancel → `VIDEO_CANCELLED`; temp-file sweep. |
| Live audio | Ring eviction keeps audio aligned to video ring start; spool v2 round trip with interleaved tracks; v1 segments still readable; recovery with audio records; `LiveIngest` forwards audio with pacing. |
| Sanitizers | ASan/UBSan and TSan presets cover the new core files. |

### 15.2 macOS host (Apple-only, like `videobuffer_vt_host_test`)

`sb_host_test.mm`: `AVSampleBufferDisplayLayer` + `AVSampleBufferAudioRenderer` + synchronizer on macOS with the A/V fixture — layer status never `failed`, float32 LPCM format accepted, synchronizer time advances and stops with rate 0, flush + re-enqueue after seek. Proves the iOS renderer code paths without a device.

### 15.3 Fixtures (extend `test/fixtures/videobuffer/generate.sh`)

`av_h264_aac.mp4` (5 s, GOP 30, 48 kHz stereo AAC, sync clapper: white frame + 1 kHz beep each second), `av_h264_opus.mkv`, `av_aac_editlist.mp4` (priming + edit list), `av_audio_late.mp4` (audio starts +500 ms), `av_h264_ac3.mp4` (unsupported in shipped FFmpeg). Total stays < 2 MB.

### 15.4 JS (Jest)

Option validation/normalisation; branded ids; event parsing and type narrowing (unknown types dropped); `addListener` filtering by `playerId`; hook lifecycle (create, source change → release old, unmount, StrictMode double-mount); seek result mapping; `@ts-expect-error` type tests for the public API.

### 15.5 Device (later, by the user)

A/V offset with the clapper fixture (logcat `avOffsetMs` + recording), scrub latency, exact-seek ms per GOP size, OCR + preview concurrently on one buffer, background/foreground, Bluetooth route change, phone-call interruption, live ingest preview at the edge, low-RAM device, emulator → explicit `VIDEO_DECODER_UNAVAILABLE`.

## 16. Phases

Each phase ends green on host tests + lefthook (lint, types, commitlint); one commit series per phase.

0. **Prep** — Android `VideoRegistry::SetEventSink` → `RCTDeviceEventEmitter` (fixes missing `SherpaOnnxVideoEvent` on Android); `DecoderPool` classes (`cpu`/`display`) + `configureVideoBuffer`; tests.
1. **Audio track (offline)** — `AudioTrackInfo`, `AudioTimeline`, demux selection + index (MP4 pread, MKV discard context), `VideoBufferInfo.audio` through JNI/ObjC/TS; fixtures; tests.
2. **Audio decode + export** — `FfmpegAudioDecoder`, `VideoAudioExtractor`, `createOfflineAudioBufferFromVideo` on both platforms; tests; docs section. First pipeline value: STT on video audio aligned with OCR `ptsMs`.
3. **Preview core (C++)** — `PlaybackController`, clocks + `AudioClockEstimator`, `FrameScheduler`, `PcmRing`, `VideoFeeder`/`AudioFeeder`, `PreviewPlayer`/`PreviewRegistry`, fakes; host tests incl. TSan.
4. **Android** — `MediaCodecSurfaceRenderer`, `JniAudioTrackRenderer` + `VideoPreviewAudioTrack.kt`, `VideoPreviewView` (SurfaceView/TextureView) + manager, JNI + module methods, coordinator focus fan-out, lifecycle; compile-verified for all ABIs.
5. **iOS** — `SampleBufferVideoRenderer`, `SampleBufferAudioRenderer`, `SynchronizerClock`, `VideoPreviewView` + manager, category methods, session/interruption/lifecycle; macOS host test; compile-verified device + simulator.
6. **TS + docs** — `src/videopreview` (player, hooks, view, types), Jest, `package.json` export + tsconfig paths, `docs/videopreview.md` (public), `docs/internal/videopreview-internal.md`, `docs/disable-ffmpeg.md` rows, README index. → Offline A/V preview and live video preview are device-testable after this phase (example screen in a separate step).
7. **Live audio** — writer API, ring + spool v2, `LiveIngest` audio, live preview with audio, `createLiveAudioBufferFromLiveVideo` tap worker; tests.
8. **Later / optional** (each its own decision) — `audio: { source: 'audioBuffer' }`; playback rate ≠ 1 (iOS: synchronizer rate + `audioTimePitchAlgorithm`; Android: time-stretch, e.g. Sonic (Apache-2.0) — license check first); vsync snapping; seekbar thumbnail strip via `KeyframeThumbCache`; Fabric codegen view.

## 17. Open points for review

1. D6: `AudioTrack` instead of Oboe — OK? (Oboe would only be worth it with minSdk ≥ 27.)
2. D9/D10: export-first for the pipeline; `audioBuffer` as preview source only in phase 8 — OK, or needed earlier?
3. D11: budget defaults `cpu = 1, display = 1` — or `cpu = 2, display = 1` (3 HW sessions on capable devices)?
4. D12: rate fixed at 1.0 in v1 — OK?
5. D15: `SurfaceView` default on Android — OK?
6. D17: default `audio` with unsupported codec → video-only with explicit status/event (vs. hard error by default)?
7. Phase order: live audio (7) after the TS phase (6), so device testing of offline A/V starts earlier — OK?
