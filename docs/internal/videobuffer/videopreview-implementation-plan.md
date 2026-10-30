# VideoPreview — implementation plan (incl. audio)

Branch: `feat/add-videopreview-komponent` (based on `feat/videobuffer`). Status: **decisions confirmed 2026-10-29, not implemented yet**. The example-app screen is a separate later step and not part of this branch's commits.

Prerequisite reading: [videobuffer-implementation-plan.md](videobuffer-implementation-plan.md) (§10 is the behaviour contract this plan implements), [videobuffer-internal.md](videobuffer-internal.md).

## 0. Requirements this plan answers

1. A React component that previews the content of a `VideoBuffer` (offline and live) on Android and iOS.
2. Controls: play, pause, resume, seek forward / backward (absolute and relative), frame step, scrubbing, jump to live edge.
3. **Audio in v1**, in sync with video, and a way to bring the audio track of a video into the SDK's `AudioBuffer` pipeline (STT, enhancement, …).
4. Self-built player in C++ (no RN player library), so performance work stays in our hands.
5. OCR (CPU decode) and preview **may** run at the same time; neither may silently break the other.
6. Strict TypeScript API; free to deviate from older view patterns where a better shape exists.
7. When audio cannot be played, video still plays **and** the developer gets an explicit, typed signal to react to (hint modal today, external audio source in the future).
8. Same rules as VideoBuffer: HW-only video decode (no silent SW fallback), FFmpeg LGPL-only (no `--enable-gpl` / `--enable-nonfree` / `--enable-version3`), debug-first logging.

## 1. Decisions (confirmed 2026-10-29)

| # | Topic | Decision | Reason |
|---|---|---|---|
| D1 | Player engine | Own C++ player on top of `VideoPacketReader`; platform code only renders and tells time | Live ring/spool and eviction semantics do not fit any URI/container-based player |
| D2 | Video render, Android | NDK `AMediaCodec` configured with the view's `ANativeWindow` (surface mode); frames timed by us via `AMediaCodec_releaseOutputBufferAtTime` | Zero-copy, HW, no CPU frames; same HW codec catalog as the OCR decoder |
| D3 | Video render, iOS | `AVSampleBufferDisplayLayer` (iOS 15–16) / its `sampleBufferRenderer` (`AVSampleBufferVideoRenderer`, iOS 17+) fed AVCC `CMSampleBuffer`s; VideoToolbox decodes inside | Zero-copy, HW, timebase built in; no own `VTDecompressionSession` for preview |
| D4 | Audio storage | VideoBuffer keeps the **encoded** audio track (index for offline, packets in ring/spool for live) next to the video track | ~1 MB/min (AAC 128k) instead of 4–23 MB/min PCM; same timeline, seek, eviction |
| D5 | Audio decode | FFmpeg SW decoders already in the prebuilts (`aac, mp3, opus, vorbis, flac, pcm_*`), shared C++ for both platforms | Already shipped, LGPL; AAC stereo decode ≈ 1 % of one core |
| D6 | Preview audio output, Android | `android.media.AudioTrack` (PCM float), created in Kotlin, driven from the C++ audio thread via JNI with a preallocated direct `ByteBuffer` | `getTimestamp` works on API 19+; Oboe/AAudio lack timestamps and device selection on API 24–26 (§2.4) |
| D7 | Preview audio output, iOS | `AVSampleBufferAudioRenderer` + `AVSampleBufferRenderSynchronizer` (shared with the video renderer), LPCM float32 interleaved | One audio-mastered timebase drives audio and video |
| D8 | Master clock | Audio while an audio track plays (also muted: volume 0, sink keeps running); monotonic clock otherwise; seamless hand-over if audio fails mid-play | Standard A/V sync; mute/unmute and audio failure never jump |
| D9 | AudioBuffer integration | **Export**: `createOfflineAudioBufferFromVideo` (v1, phase 2) and `createLiveAudioBufferFromLiveVideo` (phase 7). Preview audio does not go through an AudioBuffer | Pipeline buffers are mono / 16 kHz analysis PCM; preview needs stereo at source rate, fast start, seek inside compressed data (§2.2) |
| D10 | AudioBuffer as preview audio source | **Future feature**, fully specified in §17.1; the v1 API reserves the shape so it is non-breaking | Confirmed: document now, build later |
| D11 | Decoder budget | `DecoderPool` classes `cpu` = 1 (OCR, export, image bridge, thumbs) and `display` = 1 (preview); total HW = 2 as before; configurable; exhausted → explicit error | OCR + preview concurrently by default; deterministic failure otherwise |
| D12 | Playback rate | v1: fixed `1.0`. Other rates are a future feature (§17.2) | Keeps v1 sync simple and correct |
| D13 | Reverse | No reverse playback (HW decoders are forward-only). "Zurückspulen" = relative seek back / scrub / step back | Explicit in docs |
| D14 | TS shape | Player object (lifetime independent of the view) + thin `<VideoPreviewView player={…} />`; new subpath `react-native-sherpa-onnx/videopreview` | Like `expo-video`'s player/view split; no prop/command races; `videobuffer` stays UI-free |
| D15 | Native view, Android | Default `SurfaceView`; prop `androidViewType: 'textureView'` for overlays, animations, rounded corners | SurfaceView is the efficient HW-composited path |
| D16 | Native component kind | Legacy `ViewManager` + `requireNativeComponent` like `OfflineImageBufferFrameView` (RN interop on new arch). Codegen Fabric component later, hidden behind the same TS component | Matches repo (`codegenConfig.type: "modules"`); control path is the TurboModule anyway |
| D17 | Audio not playable (no track / unsupported codec / decode or output failure) | Video keeps playing; `audio` status in every snapshot; typed `audioUnavailable` event **and** `onAudioUnavailable` create option (no listener race); hard error only with `audio: { source: 'track', required: true }` (§9) | Developer can react (modal, later external audio) while playback works |
| D18 | Phase order | Offline A/V preview + live video preview device-testable after phase 6; live audio in phase 7 | Earlier device feedback |

## 2. Research summary

### 2.1 Off-the-shelf players (rejected)

| Candidate | Why not |
|---|---|
| `react-native-video` (ExoPlayer / AVPlayer) | Needs a URI/container. Custom `DataSource` plugins exist on Android, but AVPlayer has no packet-level feed; live ring eviction, `seekClamped`/`positionEvicted`, spool-vs-ring reads cannot be expressed. Two engines with different behaviour. |
| `expo-video` | Same URI model. The **API shape** (player object + view) is adopted (D14). |
| ExoPlayer/Media3 with a custom `MediaSource` (Android only) | No iOS equivalent; duplicates our demux/timeline; Java-side buffer management. |
| FFmpeg-based players (ffplay-style, IJKPlayer, mpv/libmpv) | Video decode would be FFmpeg SW (violates HW-only) or extra hwaccel builds; GPL-sensitive parts, large binaries. |
| VLC (libVLC) | LGPL but huge, own demux/decode stack, no packet feed from our buffers. |

Adopted building blocks: NDK `AMediaCodec`, `AudioTrack`, `AVSampleBufferDisplayLayer`/`AVSampleBufferVideoRenderer`, `AVSampleBufferAudioRenderer`, `AVSampleBufferRenderSynchronizer`, and the FFmpeg already shipped (`libavformat`, `libavcodec` audio decoders, `libswresample`).

### 2.2 Where audio lives

| | A. No audio in VideoBuffer; separate AudioBuffer at ingest | **B. Encoded audio track in VideoBuffer; export on demand (chosen)** | C. Decoded PCM AudioBuffer inside VideoBuffer |
|---|---|---|---|
| Memory | 16 kHz mono 3.8 MB/min (poor preview) or 48 kHz stereo 23 MB/min | ~1 MB/min; PCM only when exported, in the consumer's format | Same as A, always |
| Startup | Full decode at create | Nothing decoded at create (like video) | Full decode at create |
| Sync / seek | Two timelines to keep aligned; eviction mirrored | One timeline, one seek, one eviction | PCM eviction ≠ GOP eviction |
| Pipeline fit | Direct | Export returns normal `OfflineAudioBufferRef` / `LiveAudioBufferRef` + `mediaStartMs` | Direct but forces mono/16k or a second copy |
| Preview quality | Mono / downsampled unless second copy | Source rate and channels | Same as A |

Cross-modal bonus of B: STT segment times + `mediaStartMs` and OCR `ptsMs` share the video timeline.

Works already today: `createOfflineAudioBufferFromFile(sameMp4)` decodes an MP4/MKV audio track through the existing FFmpeg path — without media start offset (edit lists, late audio) and not for live buffers, hence the new export.

### 2.3 Audio decode

Prebuilts (`third_party/ffmpeg_prebuilt/build_ffmpeg*.sh`) enable `aac, mp3, vorbis, flac, opus, pcm_*` decoders, `mov, matroska, …` demuxers and `swresample` → **zero configure changes**. Not available (stays so): `ac3`, `eac3`, `dts`, `alac` decoders → handled by D17. HW audio decode (MediaCodec / AudioToolbox) rejected: no gain for a ~1 %-CPU task, two extra paths, AAC-only.

### 2.4 Android audio output

| Option | Timestamp on API 24–26 | Device selection API 24–26 | Verdict |
|---|---|---|---|
| Oboe (AAudio on 27+, OpenSL ES below) | OpenSL ES: `getTimestamp`, `getFramesRead/Written` → `ErrorUnimplemented` (Oboe FullGuide, Known issues) | OpenSL ES ignores `setDeviceId` | Rejected (would only make sense with minSdk ≥ 27) |
| AAudio direct (dlopen) | Not below 26; 26 has the RefBase crash Oboe avoids | — | Rejected |
| **`AudioTrack`** | `getTimestamp(AudioTimestamp)` since API 19 + `getPlaybackHeadPosition` | `setPreferredDevice` (API 23) via `PaAudioSessionCoordinator.applyPreferredDevice(track)` | **Chosen**; same backend as `PcmPlayer`; ExoPlayer's `AudioTrackPositionTracker` uses the same approach |

JNI cost: one `write(ByteBuffer, size, WRITE_BLOCKING)` per ~20–40 ms chunk, 25–50 calls/s.

### 2.5 iOS

The synchronizer's timebase defaults to the clock of an added `AVSampleBufferAudioRenderer`; without one it is the host clock (D8 falls out for free). `setRate:time:` drives play/pause/seek. LPCM buffers need correct, advancing PTS. Both renderer classes exist on macOS 10.13+ → macOS host test (§16.2).

Pitfalls designed for: video renderer `status == Failed` after background / media-server reset → flush + re-feed from keyframe at current position; audio renderer auto-flush on route change (`AVSampleBufferAudioRendererWasFlushedAutomaticallyNotification`, `…FlushTimeKey`) → re-feed audio from flush time. iOS 17 deprecates enqueueing on the display layer directly → `@available(iOS 17)` uses `layer.sampleBufferRenderer` (selection by OS version, logged, both paths HW).

## 3. Architecture

```
TS  src/videopreview/*   createVideoPreviewPlayer, hooks, <VideoPreviewView>, strict types, events
TS  src/videobuffer/*    + VideoBufferInfo.audio, createOfflineAudioBufferFromVideo, configureVideoBuffer, (phase 7) live tap
     │ TurboModule (NativeSherpaOnnx.ts)  +  view managers (playerId prop only)
Android Kotlin VideoPreviewService/View ─ JNI ─┐      iOS ObjC++ SherpaOnnx+VideoPreview.mm / VideoPreviewView
                                               ▼            ▼
C++ core android/src/main/cpp/video/
   OfflineVideoEntry / LiveVideoEntry ── video track + audio track (encoded)
   audio/   AudioTimeline, AudioPacketReader, FfmpegAudioDecoder, VideoAudioExtractor
   preview/ PreviewRegistry ── PreviewPlayer
                                 ├─ PlaybackController   (pure state machine → effects)
                                 ├─ VideoFeeder ── VideoPacketReader ── IVideoRenderer
                                 │                     ├─ android/MediaCodecSurfaceRenderer
                                 │                     └─ ios/SampleBufferVideoRenderer
                                 ├─ AudioFeeder ── AudioPacketReader ── FfmpegAudioDecoder ── PcmRing ── IAudioRenderer
                                 │                     ├─ android/JniAudioTrackRenderer
                                 │                     └─ ios/SampleBufferAudioRenderer
                                 └─ IPlaybackClock (android: AudioTrackClock | MonotonicClock; ios: SynchronizerClock)
```

### 3.1 Source layout (new / changed)

```
android/src/main/cpp/video/
  VideoTypes.h                       + AudioCodec, AudioTrackInfo, AudioPacketEntry, VideoBufferInfo.audio,
                                       new error codes (§12)
  audio/AudioTimeline.{h,cpp}
  audio/AudioPacketReader.{h,cpp}
  audio/FfmpegAudioDecoder.{h,cpp}   (#if HAVE_FFMPEG; stub → VIDEO_FFMPEG_DISABLED)
  audio/VideoAudioExtractor.{h,cpp}
  demux/FfmpegDemuxer.{h,cpp}        + audio selection, audio index, MKV audio discard-context
  live/AudioPacketRing.{h,cpp}       new (time-evicted relative to video ring)
  live/PacketSpool.{h,cpp}           v2 (audio header block, track bits)
  live/LiveVideoEntry.{h,cpp}        + audio writer API
  live/LiveIngest.{h,cpp}            + audio forwarding
  decode/DecoderPool.{h,cpp}         + DecoderClass budgets, DecoderSlot RAII
  preview/PreviewTypes.h             states, inputs, effects, events, options (C++ mirror of TS)
  preview/PlaybackController.{h,cpp}
  preview/PlaybackClock.{h,cpp}      IPlaybackClock, MonotonicClock, AudioClockEstimator
  preview/FrameScheduler.{h,cpp}
  preview/PcmRing.h
  preview/Renderers.h                IVideoRenderer, IAudioRenderer
  preview/VideoFeeder.{h,cpp}
  preview/AudioFeeder.{h,cpp}
  preview/PreviewPlayer.{h,cpp}
  preview/PreviewRegistry.{h,cpp}
  platform/android/MediaCodecSurfaceRenderer.{h,cpp}
  platform/android/JniAudioTrackRenderer.{h,cpp}
android/src/main/cpp/jni/video/sherpa-onnx-videopreview-jni.cpp
android/src/main/java/com/sherpaonnx/video/preview/
  VideoPreviewNative.kt  VideoPreviewService.kt  VideoPreviewAudioTrack.kt
  VideoPreviewView.kt    VideoPreviewViewManager.kt  VideoPreviewTextureViewManager.kt
ios/videobuffer/preview/
  SherpaOnnx+VideoPreview.mm  SampleBufferVideoRenderer.{h,mm}  SampleBufferAudioRenderer.{h,mm}
  SynchronizerClock.{h,mm}    VideoPreviewView.{h,mm}           VideoPreviewViewManager.mm
src/videopreview/{index.ts, types.ts, player.ts, events.ts, validate.ts, hooks.ts, VideoPreviewView.tsx,
                  __tests__/…}
test/cpp/videobuffer/{audio_demux_test.cpp, audio_decode_test.cpp, audio_extract_test.cpp,
                      live_audio_test.cpp, preview_controller_test.cpp, preview_live_test.cpp,
                      preview_sync_test.cpp, clock_test.cpp, frame_scheduler_test.cpp,
                      pcm_ring_test.cpp, sb_host_test.mm}
```

Build wiring: new C++ files join the existing `video/**` glob (Android CMake, podspec); `platform/android/**` and `jni/**` stay excluded from the pod. iOS adds `AVFoundation` (already linked by PCM player) to the pod frameworks if missing. Host CMake: preview sources into `videobuffer_core_host_test` (no FFmpeg; fakes), audio decode/extract into `videobuffer_demux_host_test` (libav), `sb_host_test` Apple-only like `videobuffer_vt_host_test`.

## 4. Audio track in the VideoBuffer core

### 4.1 Types

```cpp
enum class AudioCodec : uint32_t { Aac = 1, Mp3 = 2, Opus = 3, Vorbis = 4, Flac = 5, PcmS16le = 6,
                                   PcmF32le = 7, Unsupported = 255 };

struct AudioTrackInfo {
  AudioCodec codec = AudioCodec::Unsupported;
  std::string codecName;            // avcodec_get_name(); also set for Unsupported ("ac3")
  int sampleRate = 0;
  int channels = 0;
  uint64_t channelLayoutMask = 0;   // AVChannelLayout.u.mask (native order) or 0 = default for channels
  int frameSize = 0;                // samples per packet if constant (AAC 1024), else 0
  int64_t initialPaddingSamples = 0;// codecpar->initial_padding (encoder priming)
  Rational timeBase;                // stream time base
  std::vector<uint8_t> extradata;   // AudioSpecificConfig / OpusHead / Vorbis setup headers
  bool decodable = false;           // decoder present in this FFmpeg build
};

struct AudioPacketEntry {
  int64_t ptsUs = 0;
  int32_t durationUs = 0;
  uint32_t size = 0;
  int64_t fileOffset = -1;          // mov pread; -1 for matroska / live
};

struct VideoBufferInfo { /* existing fields */ 
  std::optional<AudioTrackInfo> audio;  // nullopt = no audio stream
  TimeRange audioRange;                 // {0,0} when no audio
  int64_t audioPacketsWritten = 0;      // live
};
```

`AudioCodec` ↔ `AVCodecID` mapping lives only in `FfmpegAudioDecoder.cpp` / `FfmpegDemuxer.cpp` (the enum is what the spool persists, never raw `AVCodecID` values, which are not ABI-stable across FFmpeg majors).

### 4.2 `AudioTimeline`

```cpp
class AudioTimeline {
 public:
  void Reserve(size_t n);
  void Append(const AudioPacketEntry& e);            // pts must be non-decreasing; else flagged + logged
  int64_t IndexAtOrBefore(int64_t tUs) const;        // -1 if t < start
  const AudioPacketEntry& At(int64_t index) const;
  int64_t size() const;                              // snapshot-consistent for live readers
  int64_t startUs() const; int64_t endUs() const;    // end = last pts + duration
  int64_t firstIndex() const;                        // > 0 after live eviction
  void EvictBefore(int64_t index);                   // live only; logical (index stays absolute)
};
```

Segment-chunked storage (chunks of 4096 entries) like `Timeline`, so live readers never see a reallocation. Memory: 47 packets/s (48 kHz AAC) → 1 h ≈ 170 k entries × 24 B ≈ 4 MB.

### 4.3 Offline demux

1. Video stream selection unchanged. Audio: `av_find_best_stream(ctx, AVMEDIA_TYPE_AUDIO, -1, videoIndex, nullptr, 0)`. Not found → `audio = nullopt` (not an error). Audio-only files still `VIDEO_NO_VIDEO_TRACK`.
2. `decodable = avcodec_find_decoder(codecpar->codec_id) != nullptr`, evaluated at open with the shipped FFmpeg; logged (`video.audio open codec=aac decodable=1 rate=48000 ch=2`).
3. **MP4/MOV:** audio entries from `avformat_index_get_entry` of the audio stream (pts, pos, size); `durationUs` from the next entry; packets read with `FileIo::pread` independently of video. Edit list / `start_time` already applied by the mov demuxer; `initialPaddingSamples` from codecpar.
4. **Matroska/WebM:** Cues usually reference video only. Audio reads use a **second `AVFormatContext`** on the same file (opened lazily on first audio read, not at create) with all non-audio streams `AVDISCARD_ALL`; seek with `av_seek_frame(audioIdx, ts, AVSEEK_FLAG_BACKWARD)` and read forward with `av_read_frame`. The audio timeline in MKV is filled per read window (headers of the packets read), same lazy idea as per-GOP video entries. The existing video context sets the audio stream to `AVDISCARD_ALL` (it currently reads interleaved audio payloads only to drop them).
5. Open still reads no packet payloads (AVIO byte-counter test extended to files with audio).

### 4.4 `AudioPacketReader`

```cpp
class AudioPacketReader {
 public:
  explicit AudioPacketReader(std::shared_ptr<VideoEntry> entry);
  Status SeekTo(int64_t tUs);                        // positions at IndexAtOrBefore(t) − 1 (decoder warm-up)
  Result<EncodedPacket> Next(int timeoutMs);         // live: tail-wait; Finish → EOS; evicted → VIDEO_FRAME_EVICTED
  const AudioTrackInfo& track() const;
  bool eos() const;
};
```

Offline: mov → pread by entry; matroska → audio context. Live: `AudioPacketRing` when resident, else spool, else `VIDEO_FRAME_EVICTED` with `audioRange`.

### 4.5 Live

- Writer API on `LiveVideoEntry`:
  ```cpp
  Status SetAudioConfig(const AudioTrackInfo& info);   // before first audio packet; once
  Status AppendAudioPacket(const EncodedPacket& pkt);  // pts µs; non-blocking like AppendPacket
  ```
  Audio packets before the first video keyframe are dropped (counted). `AppendAudioPacket` after `Finish()` → `VIDEO_BUFFER_INVALID_STATE`.
- **`AudioPacketRing`** (separate from `EncodedPacketRing` because the video ring is presentation-aligned with the video `Timeline`): deque of packets with absolute indices aligned to `AudioTimeline`. After each video eviction the entry calls `audioRing.EvictBefore(videoRingStartUs − 100 ms)`. Byte budget: `ringMaxBytes` is shared — the video ring evicts when `videoBytes + audioBytes > ringMaxBytes` (audio adds ~1–2 % at typical bitrates).
- Both rings are mutated under the existing entry lock (ordering guarantee for spool enqueue, see VideoBuffer plan §8 "Concurrency").
- `LiveIngest` forwards the selected audio stream (`LiveIngestOptions.includeAudio = true` default; TS `IngestFileToLiveOptions.includeAudio`), same pacing clock as video in `realtime`.
- Info: `audioRange`, `audioPacketsWritten`; no new event (the `packetsAppended` event stays video-driven).

### 4.6 Spool `.vbsp` v2

File header (little-endian):

```
u32 magic 'VBSP'   u32 version = 2
--- video block (unchanged from v1) ---
u32 codec  u32 width  u32 height  ... u32 configLen  u8[configLen] config
--- new in v2 ---
u32 audioPresent (0|1)
if audioPresent:
  u32 audioCodec (AudioCodec enum)   u32 sampleRate   u32 channels   u64 channelLayoutMask
  i32 frameSize   i64 initialPaddingSamples   i32 timeBaseNum   i32 timeBaseDen
  u32 extradataLen   u8[extradataLen] extradata
```

Records unchanged: `[magic u32][len u32][pts i64][dts i64][flags u32][crc32 u32][payload]`; `flags` bits 8–15 = track index (0 video, 1 audio); bits 0–2 keep `Key/NonRef/Discontinuity`. Readers accept v1 (video-only) and v2. Segment rotation still at video keyframes; audio records interleave in write order. Recovery: unchanged record scan; truncation to the last complete video GOP also drops audio records after that point. `PacketSpool` gets `audioOffsets_` (file offset per absolute audio index) next to `offsets_`.

## 5. Audio decode and pipeline export

### 5.1 `FfmpegAudioDecoder`

```cpp
struct PcmChunk { int64_t ptsUs; int frames; int channels; int sampleRate; float* data; /* interleaved, pooled */ };

class FfmpegAudioDecoder {
 public:
  Status Configure(const AudioTrackInfo& info, int maxOutChannels = 2);
  Status Submit(const EncodedPacket& pkt);           // avcodec_send_packet
  bool Receive(PcmChunk* out);                       // avcodec_receive_frame → swr (if needed) → pooled buffer
  void Flush();                                      // avcodec_flush_buffers; reset priming state
  void ReturnChunk(PcmChunk*);                       // pool
};
```

- Output always float32 interleaved at **source rate**; `swr` only for planar→packed and > 2 channels → stereo downmix.
- Priming: `AV_PKT_DATA_SKIP_SAMPLES` side data and `initialPaddingSamples` honoured, so output sample 0 corresponds exactly to the track's first presentation time (edit-list aware). After `Flush()` priming is not re-applied (decoder state, not stream start).
- Chunk pts = packet pts + (skipped samples / rate). A pts gap > 1 packet duration is reported by the consumer (feeder pads silence, §6.5).

### 5.2 `createOfflineAudioBufferFromVideo` (phase 2)

```ts
function createOfflineAudioBufferFromVideo(
  video: OfflineVideoBufferIdSource,               // offline or finished live
  options?: {
    targetSampleRateHz?: number;                    // omit → 16000 (SDK default), 0 → keep source, > 0 → exact
    rangeMs?: { startMs: number; endMs: number };   // video-timeline range; default whole track
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

Native flow: `VideoAudioExtractor::Run(entry, range, targetRate, cancelFlag, progressFn, outPath)` → `AudioPacketReader.SeekTo(range.start)` → decode → trim to range (sample accurate) → `swr` to target rate + mono → stream into `vid_aud_<uuid>.f32` (raw float32, swept as `vid_` orphan) → returns `{ numSamples, sampleRate, mediaStartUs }`. Platform bridge builds the AudioBuffer with the **existing** builders of `createOfflineAudioBufferFromFile`:

- Android: `PipelineAudioRegistry.createOfflineFromMmapFile(path, numSamples, rate, 1)` when `numSamples × 4 ≥ MmapThresholdPolicy.thresholdBytes(FILE_ORIGIN)`, else heap copy + delete (`createOfflineFromFloatArray`) — same code shape as `SherpaOnnxModule` decode-to-mmap path.
- iOS: the equivalent offline-entry builder in `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm`.

Progress events reuse the decode-progress event channel with an `operationId`; cancellation uses the existing cancel-flag pattern (`nativeAllocCancelFlag`/`nativeFreeCancelFlag` on Android).

Errors: `VIDEO_NO_AUDIO_TRACK`, `VIDEO_AUDIO_CODEC_UNSUPPORTED` (message carries `codecName`), `VIDEO_BUFFER_INVALID_STATE` (recording live), `VIDEO_CANCELLED`, `VIDEO_AUDIO_DECODE_FAILED`, `VIDEO_SPOOL_IO`. No HW video decoder involved → no decoder-budget interaction; can run concurrently with OCR and preview.

### 5.3 `createLiveAudioBufferFromLiveVideo` (phase 7)

```ts
function createLiveAudioBufferFromLiveVideo(
  live: LiveVideoBufferIdSource,
  options?: { targetSampleRateHz?: number; windowSeconds?: number; startAt?: 'oldest' | 'liveEdge' }
): Promise<{ audio: LiveAudioBufferRef; mediaStartMs: number; stop(): Promise<void> }>;
```

Native tap worker: `AudioPacketReader` (tail mode) → decoder → resample/mono → `LiveEntry.appendSamples` with a `LiveAudioPipelineWriter` origin (existing append-event machinery). Video `Finish()` → reader EOS → `finalizeLiveAudioBuffer`. Registered as a `StreamingPipelineWorker` so streaming STT consumes it like mic input. Eviction overtaking the tap → gap filled with silence + `discontinuity` log (STT must not see time compression).

## 6. Preview core (C++)

### 6.1 Interfaces

```cpp
// preview/Renderers.h
struct VideoRenderStats { int64_t rendered = 0, dropped = 0; double avOffsetMsMean = 0; };

class IVideoRenderer {
 public:
  virtual ~IVideoRenderer() = default;
  virtual Status Configure(const VideoTrackInfo& track) = 0;         // HW check here
  /** Feed one packet. displayFlag=false → decode but never show (preroll before seek target). */
  virtual Status Submit(const EncodedPacket& pkt, bool displayFlag, uint64_t gen) = 0;
  virtual bool ReadyForMore() const = 0;
  virtual void Flush(uint64_t gen) = 0;                              // drop queued + decoded frames
  virtual void SignalEos(uint64_t gen) = 0;
  virtual VideoRenderStats stats() const = 0;
  virtual void Close() = 0;
  // callbacks into the player (set before Configure)
  std::function<void(uint64_t gen, int64_t ptsUs)> onFirstFrameShown;
  std::function<void(uint64_t gen, int64_t ptsUs)> onFrameShown;     // throttled use only (stepFrame, seek)
  std::function<void(uint64_t gen)> onEos;
  std::function<void(Status)> onFailed;
};

class IAudioRenderer {
 public:
  virtual ~IAudioRenderer() = default;
  virtual Status Open(int sampleRate, int channels) = 0;
  virtual void Start() = 0; virtual void Pause() = 0;
  virtual void Flush(uint64_t gen) = 0;
  virtual void SetVolume(float v) = 0;                               // mute = 0, sink keeps running
  virtual int64_t queuedFrames() const = 0;
  virtual void Close() = 0;
  std::function<void(Status)> onFailed;                              // → AudioFailed (D17)
};

// preview/PlaybackClock.h
class IPlaybackClock {
 public:
  virtual ~IPlaybackClock() = default;
  virtual int64_t NowMediaUs() = 0;                        // non-decreasing while rate > 0
  virtual void SetRate(double rate, int64_t atMediaUs) = 0;// 0 = paused; v1 only 0 or 1
  virtual bool audioMastered() const = 0;
};
```

Platform renderers own their threads (Android) or dispatch queues (iOS); feeders run on those threads, pulled by readiness.

### 6.2 Threads, ownership, locking

| Platform | Thread / queue | Work |
|---|---|---|
| both | `vprev-ctl-<id>` (Android thread / iOS serial queue) | command queue, `PlaybackController::Handle`, executes effects, emits events |
| Android | `vprev-video-<id>` | `VideoFeeder` → codec input (Annex-B in place) → codec output → `FrameScheduler` → release/drop |
| Android | `vprev-audio-<id>` | `AudioFeeder` (reader → decoder → trim/pad) → `PcmRing` → JNI `AudioTrack.write` (blocking); polls `getTimestamp` every 200 ms |
| iOS | video renderer `requestMediaDataWhenReady` queue | `VideoFeeder` → `CMSampleBuffer` → enqueue |
| iOS | audio renderer `requestMediaDataWhenReady` queue | `AudioFeeder` → LPCM `CMSampleBuffer` → enqueue |

Rules:
- Only `ctl` mutates controller state. Media threads report via `PostInput(input)` (lock-free MPSC queue → `ctl`).
- Cancellation is by **generation** (`std::atomic<uint64_t>`): `FlushAll` bumps it; feeders/renderers compare before every submit/render and drop stale work. No mutex is held across a codec call or a JNI call.
- `PreviewPlayer` holds `shared_ptr<VideoEntry>`; `releaseVideoBuffer` while a player exists is safe: the entry outlives its registry slot and playback continues until the player is released (documented; same rule as frame leases). New players on that id fail with `VIDEO_BUFFER_NOT_FOUND`.
- Surface detach (Android `surfaceDestroyed`) is a **synchronous** call into the video thread: it flushes, stops the codec, releases the `ANativeWindow`, then returns.
- JS commands never block the JS thread: TurboModule → enqueue on `ctl` → promise resolved by the effect that completes the command (§6.4).

### 6.3 `PlaybackController` — state machine

States: `idle`, `preparing`, `ready`, `playing`, `paused`, `seeking{resumeAfter}`, `buffering{resumeAfter}`, `ended`, `error`, `released`.

| From | Input | To | Effects |
|---|---|---|---|
| idle | `Prepare` (on create) | preparing | open readers, configure audio (D17 evaluation), `RequestDecoder(display)` when a surface is attached |
| preparing | `Prepared` + first frame shown (or no surface yet) | ready | emit `firstFrameRendered` (if shown), resolve create |
| ready / paused | `Play` | playing | session acquire, `ClockSetRate(1, pos)` after preroll (§6.4), audio `Start` |
| playing | `Pause` | paused | `ClockSetRate(0, now)`, audio `Pause`; atLiveEdge=false |
| playing / paused / ready / ended | `Seek(t, mode)` | seeking{resumeAfter = was playing} | `ClockSetRate(0)`, `FlushAll(++gen)`, `StartFeed(t', mode, gen)` (t' = clamped, §6.7) |
| seeking | `Seek(t2)` | seeking (same resumeAfter) | previous promise → `superseded`; `FlushAll(++gen)`, `StartFeed(t2)` |
| seeking | `FirstFrameShown(gen)` (+ audio preroll if resumeAfter) | playing / paused | resolve seek, emit `seekCompleted`, `ClockSetRate(resumeAfter ? 1 : 0, shownPts)` |
| playing | `DataStarved` (live tail / underrun) | buffering{true} | `ClockSetRate(0, now)`, audio `Pause` |
| buffering | `DataAvailable` (≥ 300 ms video ahead) | playing | `ClockSetRate(1, now)`, audio `Start` |
| playing | `VideoEos` ∧ (`AudioEos` ∨ no audio) ∧ drained | ended (or seeking to start if `loop`) | emit `ended` |
| paused | `StepFrame(+1)` | seeking{false} | feed next frame displayFlag=true |
| paused | `StepFrame(−1)` | seeking{false} | exact seek to previous pts |
| any active | `AudioFailed(code)` | unchanged | clock hand-over (§9.3), emit `audioUnavailable` |
| any active | `Evicted(range)` | seeking{resumeAfter} | jump to oldest keyframe, emit `positionEvicted` |
| any active | `SurfaceDetached` | unchanged | stop video feed, `ReleaseDecoder`, `videoAttached=false` |
| any active | `SurfaceAttached` | seeking{resumeAfter = playing} | `RequestDecoder`, `StartFeed(clockNow, exact)` |
| playing | `AppBackground` ∧ pauseOnBackground | paused | as Pause |
| any | `RendererFailed` (first) | seeking{resumeAfter} | re-feed from keyframe at current position (one retry) |
| any | `RendererFailed` (second within 5 s) / fatal | error | emit `error`, reject pending promises, release decoder |
| any except released | `Release` | released | stop all, release decoder + session; all later commands → `VIDEO_PREVIEW_RELEASED` |

Illegal combinations (e.g. `StepFrame` while playing, `SeekToLiveEdge` on offline, any command in `error` except `Release`) → `VIDEO_PREVIEW_INVALID_STATE`, state unchanged. `Play` in `ended` = `Seek(start)` + resumeAfter. The controller is a pure function `Handle(state, input, nowMediaUs) → (state', effects[])`; `PreviewPlayer` executes effects. This is what the host tests drive.

### 6.4 Start / preroll / promise resolution

- `createVideoPreviewPlayer` resolves when the controller reaches `ready` (or immediately in `preparing` when no view is attached yet — `videoAttached: false` in the snapshot).
- Preroll before the clock starts: first video frame ≥ target decoded and shown (paused image) **and** ≥ 100 ms PCM queued in the audio renderer (if audio plays). Then `ClockSetRate(1, shownPts)`; Android: `AudioTrack.play()` + clock anchor; iOS: `setRate:1 time:shownPts`.
- `play()` resolves when the clock runs; `pause()` when the clock stopped; `seekTo` when the target frame is shown (or `superseded`).
- Without a view: `play()` runs audio + clock; video starts at the clock position when a view attaches.

### 6.5 Clock and A/V sync

- `MonotonicClock`: `anchorMedia + (nowNs − anchorNs) / 1000 × rate`, `CLOCK_MONOTONIC` (Android) / `mach_absolute_time` (host/iOS tests).
- `AudioClockEstimator` (pure math, tested), used by Android `AudioTrackClock`:
  - Segment per flush: `anchorPtsUs`, `anchorFrame` (frames written at segment start), `framesWritten`.
  - Sources: `getTimestamp` (framePosition, nanoTime — same base as `CLOCK_MONOTONIC`) polled every 200 ms from the audio thread; until the first valid timestamp after start/flush: `getPlaybackHeadPosition` (logged `clock.src=head` → `clock.src=ts`).
  - `media(now) = anchorPts + (tsFrame − anchorFrame) / sr × 1e6 + (now − tsNanoTime) / 1000`.
  - Guards: never ahead of `framesWritten`; monotonic while playing; correction slew ≤ 5 ms per update, snap (+ log) when error > 80 ms.
- iOS `SynchronizerClock`: `CMTimebaseGetTime(synchronizer.timebase)`; `SetRate` → `setRate:time:`.
- Audio is written continuously, ring fill target 300 ms (like `PcmPlayer`'s `DEFAULT_MAX_BUFFERED_MS`), `PcmRing` capacity 500 ms.
- **Trim / pad**: after a seek, decoded samples with pts < target are trimmed sample-accurately; when audio starts after the target or a pts gap > 1 packet appears, explicit silence is written so the PCM timeline stays linear (`video.preview.audio pad=…ms`). Overlap (pts going backwards) is trimmed.
- **Android `FrameScheduler::Decide(framePtsUs, clockUs, nowNs, vsyncNs)`**:

  | Condition | Decision |
  |---|---|
  | `clockUs − framePtsUs > max(frameDurUs, 40 ms)` | drop (`releaseOutputBuffer(idx, false)`, `dropped++`) |
  | `framePtsUs − clockUs > 2 × vsync` | wait (hold ≤ 2 output buffers; sleep until due − 2 vsync) |
  | otherwise | `AMediaCodec_releaseOutputBufferAtTime(idx, nowNs + (framePtsUs − clockUs) × 1000)` |

  Vsync period from `Display.getRefreshRate()` at attach and on `DisplayListener.onDisplayChanged`. Preroll frames (`displayFlag=false`) are released without render immediately.
- iOS: frames carry PTS; preroll frames get `kCMSampleAttachmentKey_DoNotDisplay`; the synchronizer presents.
- Stats in the snapshot: `framesRendered`, `framesDropped`, `audioUnderruns`, `avOffsetMs` (rolling mean of `framePts − clock` at render on Android; `0` on iOS where the synchronizer owns presentation, plus `framesDropped` from the renderer).

### 6.6 Seek, scrub, step

| Operation | Algorithm |
|---|---|
| `seekTo(t, 'exact')` (default) | clamp (§6.7) → `FlushAll(++gen)` → video `SeekToKeyframe(t)`, submit forward, frames `< t` with `displayFlag=false`, first frame `≥ t` shown (also when paused) → audio `SeekTo(t)`, decode, trim to `t` → clock anchored at the **shown frame's pts** → resume if `resumeAfter`. |
| `seekTo(t, 'keyframe')` | `KeyframeAtOrBefore(t)`; show it; position = keyframe pts. |
| `seekTo(t, 'closestKeyframe')` | `ClosestKeyframe(t)`; submit only the IDR (+ EOS-less flush of the output); coalesced. Used while dragging; UI sends one `exact` on release. Uses the display decoder, not `KeyframeThumbCache` (no CPU-decoder contention with OCR). |
| `seekBy(Δ, mode)` | `seekTo(clamp(position + Δ), mode)`; position = last shown frame pts while seeking, else clock. |
| `stepFrame(+1)` (paused) | next frame in presentation order (timeline) shown; no audio. If it lies in the current decode run (no flush needed) it is a single decode. |
| `stepFrame(−1)` (paused) | exact seek to the previous frame's pts (one GOP decode-through). |
| Cost bound | exact seek = keyframe + ≤ GOP frames HW-decoded without render (2 s GOP @ 30 fps ≈ 60 frames; HW 1080p ≫ 200 fps → < 300 ms). Logged: `seek req=… clamped=… key=… decodedThrough=… ms=… superseded=…`. |

### 6.7 Live behaviour (VideoBuffer plan §10)

| Case | Behaviour |
|---|---|
| Start on a recording buffer | `live.startAt: 'liveEdge'` (default) → exact seek to `liveEdge − targetLatencyMs` (default 1000); `'oldest'` → `seekableRange.startUs`; `atLiveEdge = (startAt == liveEdge)`. |
| Target inside `seekableRange` | Normal seek (ring fast, spool slow). |
| Target `< seekableRange.startUs` | Clamp to start; result `status: 'clamped'`; event `seekClamped { reason: 'beforeStart' }`. |
| Target `> liveEdge − targetLatencyMs` | Clamp to `liveEdge − targetLatencyMs`; `seekClamped { reason: 'afterLiveEdge' }`. |
| Reader tail-waits | `buffering` (clock 0, audio paused, last frame stays); resume at ≥ 300 ms video ahead of the clock. |
| Following and lag > `maxLatencyMs` (default 3000) | Seek to `liveEdge − targetLatencyMs`; `liveEdgeResync { lagMs, newMs }`. |
| User pauses / seeks back | `atLiveEdge = false`; `seekToLiveEdge()` resumes following. |
| Paused or behind, overtaken by eviction | Reader `VIDEO_FRAME_EVICTED`, or range check on each `packetsAppended` → jump to oldest available keyframe; `positionEvicted { previousMs, newMs }`; play state kept. |
| Buffer finishes | `BufferFinished` → `durationMs` known; EOS → `ended`. Finished with spool = offline behaviour. |
| Audio on live (phase 7) | Audio reader follows the same position; before phase 7 live buffers have no audio track → `audio.status: 'absent'` (+ `audioUnavailable`, §9). |

### 6.8 Packet hand-off performance

- Payload buffers from a per-feeder pool (`EncodedPacket` reuse); no heap allocation per packet in steady state.
- Android: when the AVCC length size is 4 (common), length prefixes are rewritten **in place** to `00 00 00 01` directly inside the codec input buffer (one copy: file/ring → codec buffer). Other sizes go through `BitstreamUtil`.
- iOS: `CMBlockBufferCreateWithMemoryBlock` with a custom block source returning the payload to the pool on free → zero-copy into the renderer.
- Audio: decoder output goes straight into `PcmRing`; Android JNI write uses one preallocated direct `ByteBuffer` per player.

## 7. Android platform

### 7.1 `MediaCodecSurfaceRenderer` (C++)

- Codec by name from the global HW name set (`AMediaCodecDecoder::GlobalHw*Name`, from `VideoCodecCatalog`) → `AMediaCodec_createCodecByName`; no name → `VIDEO_DECODER_UNAVAILABLE` (emulator case, no fallback).
- `AMediaFormat`: mime, size, `csd-0`/`csd-1` from codec config (Annex-B SPS/PPS; HEVC VPS/SPS/PPS in `csd-0`), `rotation-degrees` from `VideoTransform` (honoured in surface mode), `max-input-size` from the largest packet in the index.
- `AMediaCodec_configure(codec, fmt, window, nullptr, 0)`; synchronous mode (minSdk 24): input `dequeueInputBuffer(0)` when `ReadyForMore`, output `dequeueOutputBuffer(info, 5 ms)` → `FrameScheduler`.
- `Flush(gen)`: `AMediaCodec_flush`; decoded frames of old gen released without render.
- Mirror (`mirrorHorizontal`) is applied by the view (`scaleX = −1`), not by the codec.

### 7.2 `VideoPreviewView` (Kotlin) + managers

- `VideoPreviewView : FrameLayout` hosting one child: `SurfaceView` (default manager `SherpaOnnxVideoPreviewView`) or `TextureView` (manager `SherpaOnnxVideoPreviewTextureView`). TS picks the native component by `androidViewType`, so the child type never changes for a mounted view.
- Surface: `SurfaceHolder.Callback.surfaceCreated/Changed/Destroyed` or `SurfaceTextureListener` → `VideoPreviewNative.nativeAttachSurface(playerId, surface, refreshRateHz)` / `nativeDetachSurface(playerId)` (synchronous, §6.2).
- `playerId` prop change: detach from old player, attach to new. One view per player: attaching a player to a second view detaches the first (logged).
- Layout: `resizeMode` (`contain`/`cover`/`stretch`) from `displayWidth/Height` and sample aspect ratio, computed in `onLayout` — SurfaceView child sized and centred (AspectRatioFrameLayout pattern, `clipChildren` for cover); TextureView via `setTransform(Matrix)`. No geometry in JS.
- Display refresh: `DisplayManager.DisplayListener` → `nativeSetRefreshRate`.

### 7.3 `VideoPreviewAudioTrack` (Kotlin, called from C++ via JNI)

```kotlin
internal class VideoPreviewAudioTrack(playerId: String, sampleRate: Int, channels: Int) {
  fun open(): Boolean                                  // AudioTrack(PCM_FLOAT, USAGE_MEDIA, CONTENT_TYPE_MOVIE),
                                                       // buffer = 2 × getMinBufferSize; coordinator intent + applyPreferredDevice
  fun write(buf: java.nio.ByteBuffer, bytes: Int): Int // WRITE_BLOCKING
  fun play(); fun pause(); fun flush()
  fun timestamp(out: LongArray): Boolean               // out[0] = framePosition, out[1] = nanoTime
  fun headPosition(): Long
  fun setVolume(v: Float)
  fun release()                                        // unregisterTrack + releaseIntent("vprev:<id>")
}
```

- Coordinator: `acquireIntent(Intent("vprev:<id>", needsInput = false, needsOutput = true))` on play with audio; `releaseIntent` on pause / ended / release (other apps' audio may resume; reacquired on the next play).
- Focus: the coordinator's focus listener is log-only today → add `addFocusListener((change: Int) -> Unit)` fan-out. `LOSS`/`LOSS_TRANSIENT` → `AudioInterrupted(focusLoss)` → controller pauses + `audioInterrupted` event (playback does **not** resume automatically; dev decides); `LOSS_TRANSIENT_CAN_DUCK` → volume × 0.2 (API < 26; the system ducks on 26+).
- Errors (`open` false, `write` < 0 / `ERROR_DEAD_OBJECT`) → `IAudioRenderer::onFailed` → D17 path.

### 7.4 JNI and services

- `sherpa-onnx-videopreview-jni.cpp` (class `com.sherpaonnx.video.preview.VideoPreviewNative`):
  `nativeCreate(bufferId, optionsJson): String` (playerId or throws coded), `nativePlay/Pause/Release(playerId)`, `nativeSeek(playerId, positionUs, mode, relative, requestId)`, `nativeSeekToLiveEdge(playerId, requestId)`, `nativeStepFrame(playerId, dir, requestId)`, `nativeSetVolume/Muted/Loop`, `nativeSnapshot(playerId): String(json)`, `nativeAttachSurface(playerId, Surface, refreshHz)`, `nativeDetachSurface(playerId)`, `nativeSetRefreshRate`, `nativeAppLifecycle(background: Boolean)`, `nativeAudioInterrupted(playerId, reason)`.
- Async results: commands carry a `requestId`; native emits `{ type: 'commandResult', requestId, ok, result | code, message }` on the event channel; `VideoPreviewService` resolves the stored `Promise` (no blocking of the RN module thread).
- **Event sink fix (phase 0)**: JNI installs `VideoRegistry::SetEventSink` and `PreviewRegistry::SetEventSink` → `VideoBufferService.emit(eventName, json)` → `RCTDeviceEventEmitter` (`SherpaOnnxVideoEvent`, `SherpaOnnxVideoPreviewEvent`). JNIEnv attach per media thread via a cached `JavaVM*`.
- Lifecycle: `LifecycleEventListener.onHostPause/onHostResume` → `nativeAppLifecycle`.
- `SherpaOnnxPackage.kt` registers both view managers.

## 8. iOS platform

- **`VideoPreviewView`**: `UIView`, `+layerClass = AVSampleBufferDisplayLayer`; `videoGravity` from `resizeMode` (`resizeAspect` / `resizeAspectFill` / `resize`); rotation/mirror via `affineTransform` with swapped bounds for 90/270, recomputed in `layoutSubviews`. `playerId` setter attaches/detaches like Android.
- **`SampleBufferVideoRenderer`**: format description via `CMVideoFormatDescriptionCreateFromH264ParameterSets` / `…HEVCParameterSets` from stored config (AVCC length size from config); `VTIsHardwareDecodeSupported(kCMVideoCodecType_H264/HEVC)` at `Configure` (HW-only; else `VIDEO_DECODER_UNAVAILABLE`); target = `layer` (iOS 15–16) or `layer.sampleBufferRenderer` (iOS 17+); enqueue in `requestMediaDataWhenReadyOnQueue`; `flush` on seek (`flushAndRemoveImage` only on release); failure observation (`status`, `AVSampleBufferDisplayLayerFailedToDecodeNotification` / `AVSampleBufferVideoRendererDidFailToDecodeNotification`) → `onFailed`.
- **`SampleBufferAudioRenderer`**: `AudioStreamBasicDescription { kAudioFormatLinearPCM, kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, 32 bit, channels, rate }` → `CMAudioFormatDescriptionCreate`; buffers of 1024–4096 frames, PTS advancing by frames/rate; `volume`, `muted`; `WasFlushedAutomatically` → re-feed from `FlushTimeKey`; `status == Failed` → `onFailed` (D17).
- **`SynchronizerClock`**: one `AVSampleBufferRenderSynchronizer` per player; `addRenderer:` video target and (when audio plays) audio renderer. On audio failure: `removeRenderer:atTime:` for the audio renderer → timebase becomes host clock, continuing at current time (D8 hand-over).
- **Session**: `PaAudioSessionCoordinator acquireIntent:[PaAudioSessionIntent intentWithOwnerId:@"vprev:<id>" needsInput:NO needsOutput:YES]` on play with audio; `releaseIntent:` on pause/ended/release. `AVAudioSessionInterruptionNotification` (began) → `AudioInterrupted(sessionInterruption)` → pause + event.
- **Lifecycle**: `UIApplicationDidEnterBackgroundNotification` / `WillEnterForegroundNotification` → controller; on foreground check renderer status (failed → re-feed).
- **Bridge**: `SherpaOnnx (VideoPreview)` category; TurboModule methods resolve via the same `requestId` mechanism; `@"SherpaOnnxVideoPreviewEvent"` in `supportedEvents`; sink through the existing `gVideoModule`.

## 9. Audio unavailable — handling (D17, confirmed)

### 9.1 Cases

| `reason` | `code` | When | Video |
|---|---|---|---|
| `absent` | `VIDEO_NO_AUDIO_TRACK` | buffer has no audio track (incl. live before phase 7) | plays (monotonic clock) |
| `unsupportedCodec` | `VIDEO_AUDIO_CODEC_UNSUPPORTED` | `decodable == false` (e.g. AC-3) | plays |
| `decodeFailed` | `VIDEO_AUDIO_DECODE_FAILED` | decoder open or repeated decode errors (> 5 consecutive packets) | keeps playing, clock hand-over |
| `outputFailed` | `VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED` | AudioTrack/renderer cannot open or dies (dead object, media-server reset after one reopen attempt) | keeps playing, clock hand-over |
| `disabled` | — (no event) | `audio: { source: 'none' }` | plays; status `off` |

`audioInterrupted` (focus loss / session interruption) is **not** "unavailable": audio is fine, playback pauses; separate event.

### 9.2 Signals to the developer (no race)

1. `createVideoPreviewPlayer` resolves with a player whose **initial snapshot** (`player.initialSnapshot`) already contains `audio` — create-time cases (`absent`, `unsupportedCodec`) are known synchronously after `await`.
2. `options.onAudioUnavailable(event)` is registered in JS **before** the native create call and invoked for create-time and runtime cases (exactly once per occurrence).
3. Event `audioUnavailable` via `player.addListener('audioUnavailable', …)` for runtime cases.
4. `useVideoPreviewStatus(player).audio` for UI binding.

```ts
type VideoPreviewAudioUnavailableEvent = {
  type: 'audioUnavailable';
  reason: 'absent' | 'unsupportedCodec' | 'decodeFailed' | 'outputFailed';
  code: 'VIDEO_NO_AUDIO_TRACK' | 'VIDEO_AUDIO_CODEC_UNSUPPORTED'
      | 'VIDEO_AUDIO_DECODE_FAILED' | 'VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED';
  message: string;
  codec: string | null;          // e.g. 'ac3'
  atMs: number;                  // media position when it happened
  videoContinues: true;          // literal: playback was not stopped
};
```

Strict mode: `audio: { source: 'track', required: true }` turns create-time cases into a rejected `createVideoPreviewPlayer` (`VIDEO_PREVIEW_AUDIO_UNSUPPORTED` with `reason` in the message and a typed `cause`); runtime failures with `required: true` pause the player and emit `error` instead.

Recipe (docs):

```tsx
const player = useVideoPreviewPlayer(video, {
  onAudioUnavailable: (e) => {
    if (e.reason === 'unsupportedCodec') showHint(`Audio format ${e.codec} is not supported — playing without sound.`);
    // future (§17.1): player.setAudioSource({ source: 'audioBuffer', buffer: dubbed });
  },
});
```

### 9.3 Clock hand-over

Runtime audio failure while playing: `ctl` reads the current media time from the audio clock, switches `PreviewPlayer` to a `MonotonicClock` anchored at that time and rate, closes the audio renderer, keeps the video feed untouched. Host test: no frame scheduled with a time jump > 1 frame across the switch.

## 10. Decoder and resource budget (D11, confirmed 1 + 1)

- `DecoderPool` gains `enum class DecoderClass { Cpu, Display }`, independent limits (`cpu = 1`, `display = 1` defaults), and an RAII `DecoderSlot` (`Result<DecoderSlot> AcquireSlot(DecoderClass, ownerId, timeoutMs)`). Existing `Acquire(bufferId)` uses class `Cpu` internally (behaviour unchanged, but default cpu limit becomes 1 — the old shared limit of 2 assumed one of them for preview).
- Public: `configureVideoBuffer({ decoderBudget: { cpu?: number; display?: number } })` (1..4 each, validated).
- Display slot acquired on surface attach + prepare, released on detach / release — not on pause (resume stays instant). Idle close never touches an in-use display slot.
- Busy → `VIDEO_PREVIEW_DECODER_BUSY` (message lists holder player ids); `play()` rejects; video stays detached (`videoAttached: false`); audio-only playback is allowed if the dev calls `play()` anyway — documented.
- OCR + preview on the same buffer: independent readers/decoders, read-only on the entry; safe by `shared_ptr` + generation rules.
- Audio decoders: SW, not budget-limited. Memory per player: no `DecodedFrameCache`/`FrameSlab`; packet pools ≈ 2 × max packet size; `PcmRing` 500 ms (48 kHz stereo float ≈ 190 KB).

## 11. TypeScript API (`react-native-sherpa-onnx/videopreview`)

### 11.1 Types

```ts
export type VideoPreviewPlayerId = string & { readonly __brand: 'VideoPreviewPlayerId' };

export type VideoPreviewAudioOption =
  | { source: 'track'; required?: boolean }            // default { source: 'track', required: false }
  | { source: 'none' };
// Future (§17.1), non-breaking addition:
//  | { source: 'audioBuffer'; buffer: PipelineAudioBufferIdSource; mediaOffsetMs?: number }

export interface VideoPreviewPlayerOptions {
  audio?: VideoPreviewAudioOption;
  startAtMs?: number;                  // offline / finished live; default 0
  live?: {
    startAt?: 'liveEdge' | 'oldest';   // default 'liveEdge'
    targetLatencyMs?: number;          // default 1000, ≥ 0
    maxLatencyMs?: number;             // default 3000, > targetLatencyMs
  };
  volume?: number;                     // [0, 1], default 1
  muted?: boolean;                     // default false
  loop?: boolean;                      // offline / finished live only, default false
  pauseOnBackground?: boolean;         // default true
  progressIntervalMs?: number;         // default 250, [50, 5000]
  onAudioUnavailable?: (event: VideoPreviewAudioUnavailableEvent) => void;
  onError?: (error: VideoPreviewError) => void;   // create errors (hook) and `error` events
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
  | { status: 'playing'; codec: string; sampleRate: number; channels: number }
  | { status: 'muted'; codec: string; sampleRate: number; channels: number }
  | { status: 'off' }
  | { status: 'unavailable'; reason: VideoPreviewAudioUnavailableEvent['reason'];
      code: VideoPreviewAudioUnavailableEvent['code']; codec: string | null }
  | { status: 'interrupted'; reason: 'focusLoss' | 'sessionInterruption' };

export interface VideoPreviewSnapshot {
  playerId: VideoPreviewPlayerId;
  bufferId: string;
  bufferKind: PipelineVideoBufferKind;
  state: VideoPreviewState;
  positionMs: number;
  durationMs: number | null;           // null while a live buffer is recording
  seekableRange: { startMs: number; endMs: number };
  liveEdgeMs: number | null;
  atLiveEdge: boolean;
  playbackRate: 1;                     // literal in v1; widened in §17.2
  videoAttached: boolean;
  audio: VideoPreviewAudioStatus;
  stats: { framesRendered: number; framesDropped: number; audioUnderruns: number; avOffsetMs: number };
}

export type VideoPreviewEvent =
  | { type: 'stateChanged'; state: VideoPreviewState; previousState: VideoPreviewState }
  | { type: 'progress'; positionMs: number; seekableRange: { startMs: number; endMs: number };
      liveEdgeMs: number | null; nativeTimestampMs: number }
  | { type: 'firstFrameRendered'; positionMs: number }
  | { type: 'seekCompleted'; result: VideoPreviewSeekResult; mode: VideoPreviewSeekMode }
  | { type: 'seekClamped'; requestedMs: number; actualMs: number; reason: 'beforeStart' | 'afterLiveEdge' }
  | { type: 'positionEvicted'; previousMs: number; newMs: number }
  | { type: 'liveEdgeResync'; lagMs: number; newMs: number }
  | VideoPreviewAudioUnavailableEvent
  | { type: 'audioInterrupted'; reason: 'focusLoss' | 'sessionInterruption' }
  | { type: 'ended' }
  | { type: 'error'; code: VideoPreviewErrorCode; message: string };

export type VideoPreviewEventType = VideoPreviewEvent['type'];
export type VideoPreviewEventOf<T extends VideoPreviewEventType> = Extract<VideoPreviewEvent, { type: T }>;
```

### 11.2 Player, hooks, view

```ts
export interface VideoPreviewPlayer {
  readonly playerId: VideoPreviewPlayerId;
  readonly bufferId: string;
  readonly initialSnapshot: VideoPreviewSnapshot;
  play(): Promise<void>;                           // start, resume after pause, restart after ended
  pause(): Promise<void>;
  seekTo(positionMs: number, options?: { mode?: VideoPreviewSeekMode }): Promise<VideoPreviewSeekResult>;
  seekBy(deltaMs: number, options?: { mode?: VideoPreviewSeekMode }): Promise<VideoPreviewSeekResult>;
  seekToLiveEdge(): Promise<VideoPreviewSeekResult>;            // offline → VIDEO_PREVIEW_INVALID_STATE
  stepFrame(direction: 1 | -1): Promise<VideoPreviewSeekResult>; // paused only
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setLoop(loop: boolean): Promise<void>;
  getSnapshot(): Promise<VideoPreviewSnapshot>;
  addListener<T extends VideoPreviewEventType>(type: T, listener: (e: VideoPreviewEventOf<T>) => void): () => void;
  release(): Promise<void>;                        // idempotent; afterwards every method rejects VIDEO_PREVIEW_RELEASED
}

export function createVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource,
  options?: VideoPreviewPlayerOptions
): Promise<VideoPreviewPlayer>;

/** Creates on mount / source change, releases on unmount / change; StrictMode-safe (a create that
 *  resolves after unmount is released immediately). null until created or after a create error
 *  (reported through options.onError). */
export function useVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource | null,
  options?: VideoPreviewPlayerOptions
): VideoPreviewPlayer | null;

/** useSyncExternalStore over events. smoothPosition interpolates positionMs per animation frame
 *  while state === 'playing' from the last progress event (positionMs + elapsed since nativeTimestampMs). */
export function useVideoPreviewStatus(
  player: VideoPreviewPlayer | null,
  options?: { smoothPosition?: boolean }
): VideoPreviewSnapshot | null;

export interface VideoPreviewViewProps extends ViewProps {
  player: VideoPreviewPlayer | null;
  resizeMode?: 'contain' | 'cover' | 'stretch';      // default 'contain'
  androidViewType?: 'surfaceView' | 'textureView';   // default 'surfaceView' (ignored on iOS)
}
export function VideoPreviewView(props: VideoPreviewViewProps): React.JSX.Element;
```

Hook error surface: `useVideoPreviewPlayer` returns `null` on create failure and reports it through `options.onError`, so the hook stays a single-value return.

Control mapping: play → `play()`; pause → `pause()`; resume → `play()` (one method, state decides); vorspulen / zurückspulen → `seekBy(±ms)` / `seekTo`; scrubbing → `seekTo(ms, { mode: 'closestKeyframe' })` while dragging + `seekTo(ms)` on release; frame step → `stepFrame(±1)`; live → `seekToLiveEdge()`.

### 11.3 Strictness rules

- Validation in `validate.ts` before any native call: finite numbers, ranges above, `maxLatencyMs > targetLatencyMs`, `live` only meaningful for live buffers (warning in dev if given for offline), `loop` on recording live → `VIDEO_PREVIEW_INVALID_ARGUMENT`.
- Branded `VideoPreviewPlayerId`; `PipelineVideoBufferIdSource` resolved with the existing resolvers.
- Native event payloads are parsed by `events.ts` into the discriminated union (field-by-field checks); unknown/malformed payloads are dropped with a `__DEV__` warning — never cast.
- Errors are `VideoPreviewError extends Error { code: VideoPreviewErrorCode; cause?: unknown }`; `VideoPreviewErrorCode` is a string-literal union + runtime constant object (same pattern as `PipelineAudioErrorCode`).
- No `any` in public types; type tests with `@ts-expect-error` cover misuse (e.g. `stepFrame(2)`, unknown event type, missing `source`).

### 11.4 `videobuffer` subpath additions

- `VideoBufferInfo.audio: VideoAudioTrackInfo | null` with `{ codec: string; decodable: boolean; sampleRate: number; channels: number; startMs: number; durationMs: number }`.
- `createOfflineAudioBufferFromVideo` (§5.2), `createLiveAudioBufferFromLiveVideo` (§5.3, phase 7).
- `configureVideoBuffer({ decoderBudget })`.
- `IngestFileToLiveOptions.includeAudio?: boolean` (phase 7).

## 12. Errors

| Code | Where |
|---|---|
| `VIDEO_PREVIEW_NOT_FOUND` | unknown player id |
| `VIDEO_PREVIEW_RELEASED` | any call after `release()` |
| `VIDEO_PREVIEW_INVALID_STATE` | command not valid in the current state |
| `VIDEO_PREVIEW_INVALID_ARGUMENT` | TS or native validation |
| `VIDEO_PREVIEW_DECODER_BUSY` | display budget exhausted |
| `VIDEO_PREVIEW_RENDER_FAILED` | renderer failed twice within 5 s |
| `VIDEO_PREVIEW_AUDIO_UNSUPPORTED` | create with `required: true` and audio not playable |
| `VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED` | audio output cannot open / died (non-fatal by default) |
| `VIDEO_NO_AUDIO_TRACK` | export / audio status |
| `VIDEO_AUDIO_CODEC_UNSUPPORTED` | export / audio status |
| `VIDEO_AUDIO_DECODE_FAILED` | export / audio status |
| reused | `VIDEO_DECODER_UNAVAILABLE`, `VIDEO_CODEC_UNSUPPORTED`, `VIDEO_FRAME_EVICTED`, `VIDEO_BUFFER_NOT_FOUND`, `VIDEO_BUFFER_INVALID_STATE`, `VIDEO_CANCELLED`, `VIDEO_FFMPEG_DISABLED` |

## 13. Logging (debug-first)

Tags `[SherpaOnnx:video.preview]`, `video.preview.sync`, `video.preview.audio`, `video.audio` (demux/decode/extract). Same runtime gate as VideoBuffer (errors always; info/debug in `__DEV__`). Log at:

- create: buffer id/kind, video codec/size/fps, audio codec/rate/ch/decodable, audio option, decision (`audio=track|absent|unsupported|off`);
- surface attach/detach: view type, size, refresh, sync duration of detach;
- decoder slot acquire/release/busy (class, holders);
- every state transition: `from → to`, input, generation;
- seek: requested, clamped, keyframe, decodedThrough, ms, superseded, mode;
- clock: source switch (`head → ts`, audio → monotonic hand-over), corrections > 5 ms, snaps;
- drops per second (not per frame), audio underruns, pad/trim amounts;
- focus / interruption / route flush; renderer failure + retry;
- live: resync, eviction jump, buffering enter/leave with ahead-ms;
- release (generation, lifetime stats).

Android: `adb logcat | grep 'SherpaOnnx:video'`.

## 14. Performance notes

- No CPU frame copies for preview; one copy per video packet on Android, zero on iOS.
- Exact seek bounded by one GOP of HW decode; scrub decodes one IDR per coalesced request.
- Audio decode ≈ 1 % of a core; 25–50 JNI writes/s.
- MKV discard contexts stop each path from reading the other track's payloads.
- Later, only after measurement: vsync snapping (ExoPlayer `VideoFrameReleaseHelper` style), `AMediaCodec` async mode on API ≥ 28, compact audio index, `AMediaCodec_setOutputSurface` (API 23) surface swap without codec re-create.

## 15. Phases with tasks and acceptance

Each phase ends green on host tests + lefthook (lint, types, commitlint); one commit series per phase (scopes `videobuffer`, `videopreview`).

### Phase 0 — Prep

- Android event sink → `RCTDeviceEventEmitter` (`SherpaOnnxVideoEvent` finally delivered on Android); cached `JavaVM*` attach helper.
- `DecoderPool` classes + `DecoderSlot`; `configureVideoBuffer({ decoderBudget })` (TS, TurboModule, Kotlin, ObjC).
- Coordinator: Android `addFocusListener` fan-out (no behaviour change for existing owners).
- Accept: pool tests (class limits independent, busy error, slot RAII, idle close skips held slots); Jest for `configureVideoBuffer` validation.

### Phase 1 — Audio track (offline)

- Types (§4.1), `AudioTimeline`, demux audio selection + MP4 index + MKV discard context, `AudioPacketReader` (offline), `VideoBufferInfo.audio` through JNI/ObjC/TS.
- Fixtures (§16.3).
- Accept: `audio_demux_test` green against system libav **and** `-DVIDEOBUFFER_FFMPEG=minimal`; open reads no payloads; info shape in Jest.

### Phase 2 — Audio decode + export

- `FfmpegAudioDecoder`, `VideoAudioExtractor`, `createOfflineAudioBufferFromVideo` on both platforms (progress, cancel), docs section in `docs/videobuffer-offline.md` / `docs/videobuffer-streaming.md`.
- Accept: `audio_decode_test`, `audio_extract_test`; ASan; compile-verified Android ABIs + iOS.

### Phase 3 — Preview core (C++)

- `PreviewTypes`, `PlaybackController`, `PlaybackClock` + `AudioClockEstimator`, `FrameScheduler`, `PcmRing`, `VideoFeeder`, `AudioFeeder`, `PreviewPlayer`, `PreviewRegistry`; fake renderers/clock.
- Accept: `preview_controller_test`, `preview_live_test`, `preview_sync_test`, `clock_test`, `frame_scheduler_test`, `pcm_ring_test` green; TSan + ASan clean.

### Phase 4 — Android

- `MediaCodecSurfaceRenderer`, `JniAudioTrackRenderer` + `VideoPreviewAudioTrack.kt`, `VideoPreviewView` + two managers, JNI, `VideoPreviewService` (requestId promises), module methods, lifecycle + focus wiring.
- Accept: all ABIs build; `./gradlew` unit tests; JNI symbol check; no new lint warnings.

### Phase 5 — iOS

- `SampleBufferVideoRenderer` (iOS 15–16 layer / 17+ renderer), `SampleBufferAudioRenderer`, `SynchronizerClock`, `VideoPreviewView` + manager, category methods, session / interruption / lifecycle.
- Accept: `sb_host_test` green on macOS; device + simulator builds.

### Phase 6 — TS + docs

- `src/videopreview` (types, validate, events, player, hooks, view), Jest + type tests, `package.json` export `./videopreview` + tsconfig paths (lib + example), `docs/videopreview.md` (public, incl. §9 recipe), `docs/internal/videobuffer/videopreview-internal.md`, `docs/disable-ffmpeg.md` rows, `docs/README.md` index.
- Accept: Jest green; `yarn typecheck`; docs reviewed. → **Device test possible** (offline A/V, live video-only) via a separate example-screen step.

### Phase 7 — Live audio

- `AudioPacketRing`, writer API, spool v2, `LiveIngest` audio, live `AudioPacketReader`, live preview with audio, `createLiveAudioBufferFromLiveVideo` tap worker.
- Accept: `live_audio_test` (ring alignment, spool v2 round trip, v1 compat, recovery, ingest pacing), preview live sync test with audio, TSan.

## 16. Tests

### 16.1 Host C++ — case lists

- **preview_controller_test**: every row of §6.3; each illegal command per state; seek coalescing (3 seeks → 2 `superseded`, 1 `completed`); generation drops stale `FirstFrameShown`; detach/attach while playing restarts at clock time; `ended` + `play` restarts; `loop`; release idempotent and rejects later commands; renderer failure retry then `error`.
- **preview_live_test** (scripted fake live entry): start at edge with latency; clamp before start / after edge; buffering thresholds; `liveEdgeResync`; eviction while paused → oldest keyframe + `positionEvicted`; finish → `durationMs` + `ended`; `seekToLiveEdge` on offline → invalid state.
- **preview_sync_test** (virtual time, fake renderers + `AudioClockEstimator` over a fake AudioTrack model): frames within ±1 frame of the clock; drops only when late; first frame after seek ≥ target; first audio sample = target ± 1 sample; pad on late audio, trim on overlap; mute keeps clock continuous; audio failure hand-over without jump; no-audio buffer uses monotonic clock.
- **clock_test**: head → ts switch; extrapolation; pause/flush/segment reset; monotonic; slew vs snap; never ahead of written frames.
- **frame_scheduler_test**: decision table incl. clock jumps, 60/90/120 Hz, preroll frames.
- **pcm_ring_test**: SPSC wrap, pts segment mapping, full/empty; TSan stress.
- **audio_demux_test**: MP4 AAC and MKV Opus index vs `expected/*.json`; MKV discard context; no-audio → `null`; AC-3 → `decodable: false` (minimal FFmpeg); payload-free open.
- **audio_decode_test**: priming trimmed (sample 0 = first pts); seek-trim sample accuracy on ramp fixture; Opus/MP3 counts; flush.
- **audio_extract_test**: duration ±1 packet; `mediaStartMs` for edit-list and late-audio fixtures; 16 kHz mono sample-count formula; range; cancel; temp-file sweep.
- **live_audio_test** (phase 7): ring eviction alignment; spool v2 round trip; v1 segment read; recovery with audio records; ingest forwards audio with pacing.

### 16.2 macOS host (Apple-only)

`sb_host_test.mm`: display layer + audio renderer + synchronizer with `av_h264_aac.mp4` — renderer never `failed`, float32 LPCM accepted, synchronizer time advances and stops at rate 0, flush + re-enqueue after seek, audio renderer removal hand-over keeps time continuous.

### 16.3 Fixtures (extend `test/fixtures/videobuffer/generate.sh`)

| File | Content |
|---|---|
| `av_h264_aac.mp4` | 5 s, 640×360, GOP 30, 48 kHz stereo AAC; sync clapper: white frame + 1 kHz 50 ms beep at each full second |
| `av_h264_opus.mkv` | same content, Opus |
| `av_aac_editlist.mp4` | AAC with priming + edit list (non-zero start) |
| `av_audio_late.mp4` | audio starts +500 ms (`-itsoffset`) |
| `av_ramp_aac.mp4` | audio = linear ramp for sample-accurate seek checks |
| `av_h264_ac3.mp4` | AC-3 audio (not decodable with shipped FFmpeg) |

Plus `expected/*.json` from `ffprobe -show_packets -select_streams a`. Total fixtures stay < 2 MB.

### 16.4 JS (Jest)

Option validation and normalisation; branded ids; event parser (each variant + malformed + unknown); `addListener` filtering by `playerId` and unsubscribe; `onAudioUnavailable` fires for create-time case before `await` returns; hook lifecycle (create, source change → old released, unmount, StrictMode double mount); `requestId` promise resolution/rejection mapping; type tests.

### 16.5 Device (later, by the user)

A/V offset with the clapper fixture (logcat `avOffsetMs` + recording), scrub latency, exact-seek ms per GOP size, OCR + preview concurrently on one buffer, background/foreground, Bluetooth route change, phone call, AC-3 file → hint path, live ingest preview at the edge, low-RAM device, emulator → explicit `VIDEO_DECODER_UNAVAILABLE`.

## 17. Future features (documented, not in v1)

### 17.1 AudioBuffer as preview audio source

Use case: play processed audio against the video — denoised (enhancement pipeline output), dubbed (TTS), or replacement audio when the track is unsupported (§9 recipe).

API (non-breaking): `VideoPreviewAudioOption` gains `{ source: 'audioBuffer'; buffer: PipelineAudioBufferIdSource; mediaOffsetMs?: number }` and the player gains `setAudioSource(option): Promise<void>` (switch at runtime = flush audio, keep video, re-anchor clock).

Mapping: AudioBuffer sample `i` plays at video time `mediaOffsetMs + i / rate` (default `mediaOffsetMs` = 0; for buffers from `createOfflineAudioBufferFromVideo` pass its `mediaStartMs`). Before offset / after end → silence. Live AudioBuffer: tail read with the same buffering rules as video.

Native design: `IAudioRenderer` and the clock stay identical; only the **feeder** changes — `AudioBufferFeeder` replaces `AudioFeeder`:
- Android: AudioBuffers are Kotlin `OfflineEntry` / `LiveEntry`. `MmapBacked` entries expose a file path → C++ maps the file read-only directly (zero JNI per chunk); `InMemory` entries → JNI `readSlice` into the direct buffer per 20–40 ms chunk; live → cursor (`createCursorHandle` / `drainCursor`) like `PcmPlayerSession`.
- iOS: equivalent reads from the ObjC registry.
- Mono AudioBuffers are played as mono (renderer opened with 1 channel).

Tests: offset mapping, seek inside/outside buffer, live tail, switch at runtime without video glitch.

### 17.2 Playback rates ≠ 1.0

API: `setPlaybackRate(rate: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2)` (discrete set, widen later), `snapshot.playbackRate: VideoPreviewPlaybackRate`, option `preservePitch` (default true).

- Clock: `IPlaybackClock::SetRate(rate, at)` already in the interface; `MonotonicClock` and `AudioClockEstimator` scale by rate (`media = anchor + Δframes / sr × rate`).
- iOS: `synchronizer.setRate:rate time:`; audio renderer `audioTimePitchAlgorithm = AVAudioTimePitchAlgorithmTimeDomain` (speech) / `Spectral` (music) / `Varispeed` (no pitch preservation).
- Android: `AudioTrack.setPlaybackParams` is avoided (device-dependent quality, interacts with timestamps); instead a time-stretch stage in C++ between decoder and `PcmRing` — candidate Sonic (Apache-2.0, small C library, used by ExoPlayer) — license check and vendoring decision at that time (like libyuv: pinned, `THIRD_PARTY_LICENSES`). Without preserved pitch: resample-only.
- Video: `FrameScheduler` already works in media time; at 2× it must drop when decode throughput < 2 × fps (counted, logged); optional keyframe-only mode for > 2×.
- Tests: clock math per rate, scheduler at 2×, audio frame accounting through time-stretch.

### 17.3 Other later items

- Vsync snapping of release times; `AMediaCodec` async mode on API ≥ 28.
- Seekbar thumbnail strip via `KeyframeThumbCache` (CPU class, low priority vs OCR).
- Codegen Fabric component replacing the interop view managers (same TS component).
- Picture-in-picture / background audio-only mode (`pauseOnBackground: false` already keeps audio; PiP needs platform work).
- Multiple audio tracks (language selection): `AudioTrackInfo[]` + `audioTrackIndex` option.
