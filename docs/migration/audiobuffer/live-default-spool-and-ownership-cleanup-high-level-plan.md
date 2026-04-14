# LiveAudioBuffer default spool + ownership cleanup (high-level plan)

## Purpose

Make LiveAudioBuffer behavior safer and more consistent by:

- enabling spool persistence by default for live buffers
- preventing silent data loss when ring window overwrites old samples
- cleaning up SDK-created temporary spool files automatically on release
- preserving user-managed spool files when caller explicitly sets a persistence path

This is a high-level migration plan (breaking behavior change allowed).

---

## Current behavior (as-is)

- `createLiveAudioBuffer(...)` does **not** enable spool by default.
- Spool only exists when `persistencePath` is explicitly provided.
- `releasePipelineAudioBuffer(...)` closes spool handles but does not delete spool files.
- Result:
  - ring-overwrite can lose historical samples if no spool
  - cache/tmp spool files can leak unless app cleans them manually

---

## Target behavior (to-be)

1. Every new live buffer has active spool by default.
2. If app does not provide `persistencePath`, SDK creates an auto temp spool path under a dedicated SDK subdirectory.
3. Spool ownership is tracked:
   - `USER_PATH`: caller-provided path, never auto-deleted
   - `AUTO_TEMP`: SDK-generated temp path, auto-deleted on release
4. `createOfflineAudioBufferFromLive('fullIfSpooled')` reliably has full-history source after finalize.
5. App can explicitly clean orphaned auto-temp spools after crash via a dedicated helper/API.

---

## Design decisions

### 1) Default spool policy

- `createLiveAudioBuffer(...)` should internally derive persistence config when missing:
  - location: app cache/tmp directory
  - dedicated subdirectory: `cache/sherpa_live_spool/`
  - filename pattern: `auto_live_spool_<bufferId or uuid>.wav`
  - format default: `wav_pcm_s16le`
- This applies to both Android and iOS.

### 2) Ownership model

Introduce internal spool ownership metadata:

- `SpoolOwnership.USER_PATH`
- `SpoolOwnership.AUTO_TEMP`

Ownership is set at live-buffer creation (or when spool is enabled later).

### 3) Release semantics

On `releasePipelineAudioBuffer(liveId)`:

- always close/finalize spool resources safely
- if ownership is `AUTO_TEMP`, delete spool file
- if ownership is `USER_PATH`, keep file on disk

### 4) Finalize semantics

- `finalizeLiveAudioBuffer(...)` should not delete spool (same as today).
- Finalize only patches header and closes active writer.
- Deletion remains release-time behavior for auto temp files.

### 5) Crash-safe orphan cleanup helper

Add a dedicated helper/API to remove stale SDK-managed spool files only:

- `cleanupAutoTempLiveSpools(options?)`
- only targets SDK-owned directory (`cache/sherpa_live_spool/`)
- never deletes user-provided persistence paths
- safe to call on app startup

---

## API surface impact

Public TypeScript API can remain unchanged:

- no required new parameters
- existing `persistencePath` semantics preserved

Recommended additions:

- explicitly state that spool is on by default unless disabled by future explicit option.
- expose crash-safe cleanup helper for startup housekeeping.

Potential optional future API (not required in this plan):

- `persistence: 'auto' | 'user' | 'none'`
- `cleanupOnRelease?: boolean`

---

## Platform implementation outline

## Android

Files likely touched:

- `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt`
- `android/src/main/java/com/sherpaonnx/audio/pipeline/LiveEntry.kt`
- `android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt`

Key work:

1. Default persistence creation in live-buffer creation path when missing.
   - ensure subdirectory exists: `cache/sherpa_live_spool/`
   - generate deterministic auto filename prefix (`auto_live_spool_...`)
2. Add ownership flag to `LiveEntry`/persistence config.
3. In `LiveEntry.release()`, delete spool file only for `AUTO_TEMP`.
4. Keep current behavior for user-provided path.
5. Add native method backing `cleanupAutoTempLiveSpools`:
   - enumerate only files under `cache/sherpa_live_spool/`
   - best-effort delete all matching files
   - return summary (`deletedCount`, optional `failedCount`)

## iOS

Files likely touched:

- `ios/SherpaOnnx+PipelineAudio.mm`
- `ios/PaLiveEntry.h`

Key work:

1. Default spool path allocation in `createLiveAudioBuffer` when `persistencePath` absent.
   - use dedicated directory under iOS cache/tmp (`.../sherpa_live_spool/`)
2. Add ownership field in `PaLiveEntry`.
3. In `release()`, delete spool only when ownership is `AUTO_TEMP`.
4. Add cleanup method mirroring Android semantics for orphaned auto-temp files.

---

## Behavior matrix

| Case | Spool path source | Ownership | On finalize | On release |
|------|-------------------|-----------|-------------|------------|
| Caller passed `persistencePath` | caller | `USER_PATH` | close/patch | keep file |
| Caller omitted `persistencePath` | SDK `cache/sherpa_live_spool/` path | `AUTO_TEMP` | close/patch | delete file |
| App crashed before release | SDK `cache/sherpa_live_spool/` path | `AUTO_TEMP` | N/A | cleaned by `cleanupAutoTempLiveSpools()` |

---

## Compatibility and migration notes

- Behavior change: live buffers now consume disk by default (cache/tmp).
- Benefit: full-history preservation and better consistency for offline-from-live and player seeking.
- Risk: higher disk usage in long sessions.

Mitigations:

- store in cache/tmp under dedicated SDK subdir (`sherpa_live_spool`)
- enforce release in examples/docs
- provide explicit orphan cleanup helper for app startup
- optional future retention cap/rotation policy

---

## Validation checklist

- [ ] Live buffer without `persistencePath` reports `hasActiveSpool = true`
- [ ] Long recording with ring overflow still fully recoverable via `fullIfSpooled` after finalize
- [ ] Auto temp spool file is deleted on `releasePipelineAudioBuffer`
- [ ] User-provided spool path survives release
- [ ] No spool file leaks on normal and error/cancel paths
- [ ] `cleanupAutoTempLiveSpools()` removes only files in `cache/sherpa_live_spool/`
- [ ] Cleanup helper is idempotent and safe on cold start after crash
- [ ] Android + iOS parity for ownership behavior

---

## Non-goals

- adding a user-facing spool retention API in this step
- changing ring-buffer semantics for streaming workers
- adding historical-spool fallback reads for all live consumers (separate effort)

