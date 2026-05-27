# Future Work: Dedicated Streaming Export Worker (FFmpeg)

## Context

The current conversion direction is moving toward a pipeline-buffer-first API:

- `convertAudioToFormat(inputBuffer, outputPath, format, options?)`
- `convertAudioToWav16k(inputBuffer, outputPath)`

This works well for **offline / batch** conversion, where the input is finite and stable.

For **live / recording** buffers, a one-shot conversion call is only a snapshot at one point in time. It does not represent a continuously growing stream.

## Problem to solve

If we want real "record while converting" behavior (for example, mic/enhancement output being continuously encoded and written to a file), a simple one-shot `convertAudioToFormat(...)` call is not enough.

Why:

- Conversion APIs are naturally request/response (start -> convert -> finish).
- A live pipeline source keeps receiving samples over time.
- FFmpeg output for long-running sessions needs lifecycle control (start, flush/finalize, stop, error handling), not just a single function call.

Without a dedicated streaming export primitive, users may assume "live conversion" while getting only a point-in-time snapshot.

## Proposed direction

Introduce a dedicated **streaming export worker/session API** for live buffers, separate from offline conversion.

Conceptual pipeline:

`LiveAudioBuffer -> Streaming Export Worker (FFmpeg) -> Output file`

This should follow the same pipeline principles as other live workers:

- native cursor-based draining from `LiveAudioBuffer`
- background worker thread
- explicit lifecycle and status methods

## Open pipeline design decision

Before implementation, we need to decide what the streaming FFmpeg stage should produce as its primary output:

### Option 1: Export-first (write to file)

`LiveAudioBuffer -> Streaming Export Worker (FFmpeg) -> Output file`

- Best for "record while encoding" use cases (MP3/AAC/Opus file output).
- Keeps the worker focused on persistence/export.
- Does not create a downstream audio buffer stage for further pipeline chaining.

### Option 2: Pipeline-first (write to another live buffer)

`LiveAudioBuffer1 -> Streaming Export Worker (FFmpeg) -> LiveAudioBuffer2`

- Keeps the stage fully pipeline-native (buffer in, buffer out).
- Enables downstream chaining after conversion.
- Requires clear semantics about encoded vs decoded payload in `LiveAudioBuffer2`
  (today live audio buffers are float PCM-oriented).

This choice affects API naming, worker internals, and how conversion integrates with
other pipeline stages. It should be resolved before introducing the streaming mode API.

## FFmpeg conversion must be split into 2 modes

### 1) Offline mode (batch)

- Input: `OfflineAudioBuffer` or finalized `LiveAudioBuffer` snapshot.
- Behavior: one-shot conversion.
- API style: `convertAudioToFormat(...)` returns when done.

### 2) Streaming mode (continuous export)

- Input: active `LiveAudioBuffer` in `recording` state.
- Behavior: continuously consume newly appended samples and encode/write while recording is ongoing.
- API style: session/worker handle (`start`, `pause/resume` optional, `stop/finalize`, `getStatus`).

Keeping these modes separate avoids semantic confusion and makes migration safer.

## Potentially affected API surface

### Conversion API (`react-native-sherpa-onnx/audio`)

- `convertAudioToFormat(...)` (batch semantics should remain explicit)
- `convertAudioToWav16k(...)` (batch helper)
- potential new streaming export entrypoint (name TBD), e.g. `startLiveAudioExport(...)`

### Audio buffer API (`react-native-sherpa-onnx/audiobuffer`)

- `createLiveAudioBuffer(...)`
- `appendSamplesToLiveAudioBuffer(...)`
- `appendOfflineToLiveAudioBuffer(...)`
- `finalizeLiveAudioBuffer(...)`
- cursor/read infrastructure used by native workers

### Native bridge / modules

- `NativeSherpaOnnx` spec additions for streaming export session methods
- Android pipeline worker + registry integration
- iOS pipeline worker + lifecycle integration

### Documentation

- `docs/audio-conversion.md` (clearly document batch vs streaming conversion modes)
- migration docs for breaking changes and mode split

## Migration note

For now, keep conversion semantics strict:

- batch conversion for offline/finalized inputs
- reject active live buffers in batch conversion

Then add streaming export as a dedicated API in a follow-up iteration.
