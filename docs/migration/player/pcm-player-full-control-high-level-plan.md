# PCM Player full-control high-level plan

## Status (April 2026)

Implemented.

- `onEnded` event is wired end-to-end (`pcmPlayerEnded` native event -> JS callback).
- `seekToMs`, `restart`, and `getPlaybackPositionMs` are available in the public `PcmPlayer` API.
- Android and iOS native player backends support seek/restart semantics for offline and live buffers.
- Example TTS playback in the app uses `createPcmPlayer(...)` from pipeline buffers.

Note: `audioFileWebPlayback.ts` and `react-native-audio-api` still exist for non-TTS example screens.

## Purpose

Extend the pipeline PCM player so it can replace file-based playback helpers in the example app and provide full playback controls:

- end-of-playback callback (`onEnded`)
- seeking to a position (offline + live, with clear live constraints)
- restart from beginning

This plan is intentionally high-level and API-focused.

---

## Current state

Today, PCM player provides:

- `createPcmPlayer(audioBuffer, options?)`
- `pause()`
- `resume()`
- `destroy()`

Missing for full-player UX:

- no playback completion signal
- no seek API
- no restart API

Example app still uses `react-native-audio-api` for convenient file playback controls/events.

---

## Target state

PCM player becomes primary playback API for pipeline audio buffers and supports core player controls without external playback libs.

### New capabilities

1. **Completion events**
   - `onEnded` callback from JS, triggered when playback reaches end-of-stream.

2. **Seek**
   - seek by milliseconds (primary) and optional frame-based native helper.
   - supported on offline and live with explicit live semantics.

3. **Restart**
   - restart from beginning in one call.
   - implemented as native primitive (not only JS sugar), to avoid race with pause/resume.

---

## Proposed public API shape

### `createPcmPlayer(audioBuffer, options?)`

Extend options:

- `volume?: number`
- `onEnded?: (event: { playerId: string; bufferId: string }) => void`
- optional future: `onStateChanged`, `onPosition`

### `PcmPlayer` interface

Add:

- `seekToMs(positionMs: number): Promise<void>`
- `restart(): Promise<void>`
- optional helper: `getPlaybackPositionMs(): Promise<number>`

Keep existing:

- `pause()`
- `resume()`
- `destroy()`

---

## Playback semantics (must be fixed before implementation)

## Offline buffer

- `onEnded`: fires exactly once per playback run when EOF reached.
- `seekToMs`:
  - clamp to `[0, durationMs]`
  - `seekToMs(durationMs)` positions at EOF (next `resume` ends immediately)
- `restart`: equivalent to `seekToMs(0)` + playback state reset.

## Live buffer (recording / finished)

- While `recording`:
  - live data window is moving; seek is only valid inside currently available range.
  - if target is outside available range: reject with explicit error code.
- While `finished`:
  - seek semantics match offline across retained data source.
- `onEnded` for live:
  - only fires when buffer is `finished` and playback cursor reaches final EOF.
  - never fires while still recording.

---

## Native architecture updates

### Player session state

Add per-player state fields:

- current read cursor (absolute sample index)
- playback state (`playing`, `paused`, `ended`)
- ended-emitted flag (prevents duplicate end events)

### End detection

- audio render/drain loop checks source availability:
  - offline EOF or finalized live EOF -> transition to ended
  - emit ended event once

### Seek implementation

- convert `positionMs` -> sample index using buffer sample rate
- map sample index to source-specific cursor:
  - offline in-memory/file-backed reader seek
  - live cursor seek with available-range validation
- reset ended flag on successful seek (unless seek lands at EOF)

### Restart implementation

- native op resetting cursor to start-of-available/start-of-buffer
- clear ended flag
- do not force auto-resume unless explicitly required by API contract

---

## Event channel strategy

Use dedicated PCM event channel to avoid mixing with decode/conversion/fileio events.

Suggested events:

- `pcmPlayerEnded` (required)
- optional future:
  - `pcmPlayerStateChanged`
  - `pcmPlayerError`

Payload baseline:

- `playerId`
- `bufferId`
- optional diagnostics (`reason`, `positionMs`)

---

## Error model

Add player-specific error codes (JS + native alignment), for example:

- `PCM_PLAYER_NOT_FOUND`
- `PCM_PLAYER_INVALID_STATE`
- `PCM_PLAYER_SEEK_OUT_OF_RANGE`
- `PCM_PLAYER_BUFFER_NOT_FOUND`
- `PCM_PLAYER_BUFFER_INCOMPATIBLE_STATE`

---

## Implementation phases

### Phase 1 — `onEnded`

- add native ended detection and event emission
- add JS subscription wiring in `createPcmPlayer(..., { onEnded })`
- verify one-shot behavior and no event leak after `destroy()`

### Phase 2 — seek

- add native `seekPcmPlayerToMs(playerId, positionMs)`
- add JS `seekToMs(...)`
- define and enforce live seek boundaries

### Phase 3 — restart

- add native `restartPcmPlayer(playerId)`
- add JS `restart()`
- reset ended state correctly

### Phase 4 — example migration

- migrate TTS example playback helpers to PCM player usage (done)
- `audioFileWebPlayback.ts` and `react-native-audio-api` remain for STT/Enhancement screens

---

## Files likely affected

JS/TS:

- `src/pcm/types.ts`
- `src/pcm/pcmPlayer.ts`
- `src/NativeSherpaOnnx.ts`
- `docs/pcm-player.md`
- example playback call sites (`example/src/screens/**`, utils)

Native:

- Android player bridge + player core in `SherpaOnnxModule` / audio pipeline player classes
- iOS player bridge + AVAudioEngine-backed player implementation

---

## Validation checklist

- [x] Offline playback triggers `onEnded` exactly once
- [x] Live recording playback never triggers `onEnded` before finalize
- [x] Live finalized playback triggers `onEnded` at true EOF
- [x] `seekToMs(0)` works for offline and finalized live
- [x] out-of-range seek on live recording fails with explicit code
- [x] `restart()` works from paused/playing/ended states
- [x] no memory leaks from event subscriptions after `destroy()`
- [ ] example app playback works without `react-native-audio-api` (still pending for STT/Enhancement screens)

---

## Non-goals (for this migration)

- full WebAudio parity (filters, graph nodes, time-stretch)
- playlist/crossfade features
- stereo/multi-channel player redesign

