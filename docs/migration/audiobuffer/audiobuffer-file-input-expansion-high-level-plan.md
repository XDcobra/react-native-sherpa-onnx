# AudioBuffer file-input expansion (high-level plan)

## Purpose

This document defines the high-level direction for expanding AudioBuffer creation from files while keeping the pipeline-first model and a simple internal buffer representation.

Core goals:

- support broader input audio formats for offline buffer creation
- keep AudioBuffer internals normalized to WAV/PCM-oriented data for predictable pipeline behavior
- introduce live-buffer creation from file as a streaming ingestion flow (chunk-based), not as a full upfront load
- split rollout into two implementation parts to reduce risk and keep each step testable

This is a strategy document only (no final API signatures or low-level implementation details).

---

## Current state (as-is)

- `createOfflineAudioBufferFromFile(source, targetSampleRateHz?, forceMono?)` exists and uses `FileSource`.
- `convertAudioToFormat(input, output, format, options?)` handles buffer -> file export with `AudioOutputFormat`.
- Live buffers can be created empty and appended with:
  - direct samples
  - offline buffer content (`appendOfflineToLiveAudioBuffer`)
- Live buffers do not currently accept file input directly.

Implication:

- Offline and live capabilities are not fully symmetric from a user perspective.
- Input-format expectations are less explicit than output-format expectations.

---

## Target state (to-be)

1. Offline creation supports explicit input-format guidance (aligned with output-format naming/mental model).
2. Offline creation accepts all relevant file sources already supported by `fileio` (`fs`, `app`, `contentUri`, `securityScoped`, `pad` where platform-supported).
3. Live creation can ingest from file in a streaming/chunked manner so downstream pipeline work can start before full ingestion completes.
4. Internal AudioBuffer data model remains normalized (WAV/PCM-oriented) to keep buffer management and model integration simple.

---

## Rollout in two parts

### Part 1 (first): Offline file input expansion

Scope:

- extend offline file creation with an input format option (e.g. `AudioInputFormat`, conceptually parallel to `AudioOutputFormat`)
- ensure all supported `FileSource` kinds are valid entry points for this flow
- reuse internal decode/conversion paths where possible (avoid duplicate transcoding stacks)
- decode/transcode into normalized offline buffer representation

Why first:

- lower complexity than live streaming ingest
- unlocks immediate user value for non-WAV inputs
- provides reusable decode/normalization building blocks for Part 2

Expected outcome:

- users can create offline buffers from mp3/opus/aac/flac/... via the same API family
- pipeline modules continue consuming consistent buffer semantics

### Part 2 (second): Live buffer creation from file via chunk streaming

Scope:

- add a live creation/ingestion path from file source
- process file input incrementally (decode chunk -> append to live buffer)
- allow pipeline consumers to start reading while ingestion is still running
- optionally finalize live state automatically when source ends

Why second:

- depends on robust decode/format handling from Part 1
- adds state/lifecycle complexity (ingesting, cancel, finalize, error propagation)
- requires stronger event/progress/backpressure decisions

Expected outcome:

- consistent developer experience: both offline and live can be sourced from files
- true streaming-style ingest behavior for large files and realtime-like flows

---

## Open design questions (to resolve before implementation)

### API shape and consistency

- Should offline API keep current function name and add optional input-format options, or add a new explicit function?
- Should input format be required, optional, or default to `auto` detection?
- Should live-from-file be a dedicated constructor (`createLiveAudioBufferFromFile`) or a start-ingest method on existing live buffers?

### Format model

- Should `AudioInputFormat` exactly mirror `AudioOutputFormat`, or include additional values/aliases for demux/decode realities?
- How should container vs codec ambiguity be represented (if at all) at this abstraction level?
- What is the fallback behavior when declared format conflicts with sniffed/container data?

### File source coverage and platform behavior

- For each `FileSource` kind, what are guaranteed supported combinations per platform?
- Which flows require temp files internally vs direct stream decode?
- How are platform-specific permission failures surfaced consistently?

### Live ingestion lifecycle

- What states are exposed for live-from-file ingest (recording, ingesting, finished, failed, cancelled)?
- Is auto-finalize the default at end-of-file?
- How should cancellation behave (retain partial buffer vs fail/rollback)?

### Progress, events, and backpressure

- Do we expose ingest progress events (bytes/time/frames)?
- How do ingest events relate to existing `pipelineLiveAudioChunk` events?
- What is the policy when producer speed exceeds consumer/ring capacity?

### Error semantics

- Which new error codes are needed vs reusing existing conversion/fileio codes?
- How should decode failures be classified (unsupported format vs corrupted media vs permission/read errors)?
- Should partial success be representable for live ingestion?

### Performance and memory constraints

- Chunk size defaults and tuning strategy
- Resampling/downmix placement (per-chunk vs staged)
- Avoiding duplicate buffers/copies in decode -> append path

### Testing and validation

- Required matrix for formats x `FileSource` kinds x platform
- Large-file behavior and cancellation tests
- Regression checks for existing pipeline consumers (STT, alignment, textbuffer integrations)

---

## Non-goals

- introducing raw encoded formats as native in-memory buffer representation
- redesigning pipeline consumer APIs outside file-ingest concerns
- defining final TypeScript/native method signatures in this document

---

## Success criteria

- Part 1 ships with stable offline creation for broad file input formats via `FileSource`
- Part 2 ships with reliable live-from-file chunked ingestion and clear lifecycle semantics
- no ambiguity for developers about when to use offline vs live file-based creation
- internal buffer invariants remain simple and pipeline-compatible

