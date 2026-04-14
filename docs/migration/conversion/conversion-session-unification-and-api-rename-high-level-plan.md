# Conversion migration high-level plan (unified sessions + API rename)

## Purpose

This document defines a single migration that is intentionally breaking and removes legacy conversion paths entirely.

Goals:

- replace legacy conversion internals with the new shared session architecture
- eliminate decode/encode duplication across `audiobuffer` and `audio` conversion flows
- rename public conversion APIs to the agreed naming convention
- keep behavior cross-platform aligned (Android + iOS)

This is a high-level implementation plan (not a line-by-line spec).

---

## Scope and decisions

### In scope

- `convertAudioToFormat` -> `saveAudioAsFile` (public API rename, breaking)
- `convertAudioToWav16k` -> `saveAudioAsWav16k` (public API rename, breaking)
- conversion internals switched to session-based pipeline shared with new file-input architecture
- legacy conversion internals removed after cutover
- docs/examples/migration references updated to new API names

### Out of scope

- compatibility aliases
- deprecation period
- preserving old docs wording

---

## Target architecture

Single internal pipeline for buffer -> file conversion:

1. Resolve output destination via existing `FileIOResolver`.
2. Resolve buffer source:
   - offline file-backed -> decode session input
   - offline in-memory -> direct PCM input
   - live finalized + spool -> decode session input
   - live finalized no spool -> direct PCM snapshot input
3. Feed normalized PCM chunks into `AudioEncodeSession`.
4. Emit progress events consistently for conversion.
5. Finalize encoder and return `ResolvedFileRef`.

Result:

- one decode primitive (`AudioDecodeSession`) where decode is needed
- one encode primitive (`AudioEncodeSession`) for all outputs
- no separate legacy conversion stack

---

## Migration phases (single rollout, multiple internal steps)

## Step 1 — Freeze public API rename (breaking contract)

- Rename in `src/audio/index.ts`:
  - `convertAudioToFormat` -> `saveAudioAsFile`
  - `convertAudioToWav16k` -> `saveAudioAsWav16k`
- Update `src/audio/types.ts` comments to use "save" terminology (error codes can remain `CONVERSION_*` unless deliberately renamed).
- Update all imports/usages in `src/`, `example/`, and docs.
- Update `docs/audio-conversion.md` title and all examples/signatures.

Deliverable:

- only new names exist in public TypeScript surface
- no alias exports

## Step 2 — Replace conversion implementation with session pipeline

- Rework native conversion entrypoints to use session architecture end-to-end:
  - JS API -> native bridge (`convertPipelineAudioToDestination` can keep internal name or be renamed later)
  - native path uses `AudioDecodeSession` (when input is file-backed/spool) + `AudioEncodeSession`
  - direct PCM path feeds `AudioEncodeSession` without file re-decode
- Maintain existing format validation and sample-rate semantics.
- Preserve `FileDestination` behavior and SAF/security-scoped handling.

Deliverable:

- conversion behavior unchanged externally (except API name), internals unified

## Step 3 — Remove legacy conversion code completely

- Delete/remove old conversion-only decode/encode pipeline code paths that are superseded.
- Remove dead JNI/ObjC wrappers tied only to removed internals.
- Clean CMake / build entries for removed files.
- Re-run search to confirm no references to removed legacy symbols.

Deliverable:

- single conversion backend in codebase, no parallel legacy path

---

## File-by-file work map

### TypeScript public API

- `src/audio/index.ts`
- `src/audio/types.ts`
- `src/index.tsx` (if re-exports are affected)
- any feature modules importing conversion helpers

### Native bridge

- `src/NativeSherpaOnnx.ts` (method naming/docs consistency)
- `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt`
- `ios/SherpaOnnx+PipelineAudio.mm`

### Native core (Android C++ / iOS shared C++)

- `android/src/main/cpp/jni/audio/AudioDecodeSession.cpp` (+ header)
- encoder session source (new/extracted)
- legacy conversion files currently used by JNI/ObjC conversion path (to remove after cutover)
- `android/src/main/cpp/CMakeLists.txt`

### Docs and examples

- `docs/audio-conversion.md`
- `docs/audiobuffer-offline.md` and `docs/audiobuffer-streaming.md` references
- `docs/fileio.md` integration section references
- all migration/spec docs mentioning old conversion names
- `example/src/**` using old conversion functions

---

## Breaking changes summary

- Removed:
  - `convertAudioToFormat`
  - `convertAudioToWav16k`
- Added:
  - `saveAudioAsFile`
  - `saveAudioAsWav16k`
- No aliases and no deprecation wrappers.

Potential optional follow-up (not required in this migration):

- rename `ConversionErrorCode` -> `AudioSaveErrorCode` for lexical consistency

---

## Open implementation decisions to lock before coding

- Should native bridge method name remain `convertPipelineAudioToDestination` (internal) for now, or be renamed in the same migration for naming purity?
--> Answer: renamed in the same migration for naming purity
- Progress model:
  - add conversion-specific event channel: `audioConversionProgress`
  - do not reuse `fileIOProgress` (reserved for fileio operations)
  - keep `onProgress` in `saveAudioAsFile(...)`, but wire it to `audioConversionProgress`
  - progress payload should be conversion-oriented (operationId + phase + progress fields), not file-copy-oriented
- Error-code vocabulary:
  - keep existing `CONVERSION_*` codes
  - or perform a full rename (larger breaking surface)
--> Answer: perform a full rename (larger breaking surface)
- Destination fallback policy:
  - keep current direct-FD-first + temp-file fallback behavior
--> Answer: keep current direct-FD-first + temp-file fallback behavior

---

## Validation and acceptance criteria

Functional:

- offline and finalized live buffers can be saved to all supported output formats on Android/iOS
- sample-rate constraints and error behavior remain consistent
- `FileDestination` kinds keep existing platform behavior

Architecture:

- conversion uses session-based implementation only
- no duplicate legacy conversion code path remains reachable

API:

- only `saveAudioAsFile` / `saveAudioAsWav16k` appear in public docs and exports
- no remaining references to old names in `src/`, docs, or examples

Observability:

- conversion progress works in the unified path (best-effort where container metadata limits exact totals)

---

## Rollout notes

- This migration should land as one coordinated breaking change branch/PR.
- Recommended commit structure inside that PR:
  1. public API rename + docs/examples updates
  2. native conversion backend unification
  3. legacy code removal + build cleanup + final grep verification

