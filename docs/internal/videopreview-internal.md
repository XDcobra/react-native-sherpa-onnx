# VideoPreview — internal notes

Public API: [../videopreview.md](../videopreview.md). Implementation plan: [videopreview-implementation-plan.md](videopreview-implementation-plan.md).

## Layout

- C++ core: `android/src/main/cpp/video/preview/` (`PlaybackController`, `PreviewPlayer`, clocks, feeders).
- Android render: `platform/android/MediaCodecSurfaceRenderer`, `JniAudioTrackRenderer`, Kotlin `video/preview/`.
- iOS render: `ios/videobuffer/preview/` (`AVSampleBufferDisplayLayer` / audio renderer + synchronizer).
- TS: `src/videopreview/`.

## Clock

Audio-mastered while a track plays (including muted). Hand-over to `MonotonicClock` on audio failure without a time jump. iOS uses `AVSampleBufferRenderSynchronizer`.

## Live audio

Encoded packets live in `AudioPacketRing` (time-evicted with the video ring) and spool v2. `createLiveAudioBufferFromLiveVideo` starts a tap worker into a live AudioBuffer.
