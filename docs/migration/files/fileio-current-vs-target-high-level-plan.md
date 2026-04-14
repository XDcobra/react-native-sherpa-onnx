# File I/O migration: current vs target state (high-level)

## Purpose

This document summarizes the **current implementation state** and the **target state** for File I/O and audio export destinations.

It is a companion overview to:

- `docs/migration/files/generic-file-io-high-level-plan.md`

That main plan defines the full architecture and decision log. This file is a short alignment document for migration tracking.

---

## Reference baseline

The canonical strategy and open-question decisions are tracked in:

- `docs/migration/files/generic-file-io-high-level-plan.md`

This document only distills:

1. what is implemented today
2. what should be true after migration
3. which gaps remain between both states

---

## Current state (as-is)

### 1) Public API direction has moved forward

- `audio` conversion API already uses destination objects (`FileDestination`) and returns `ResolvedFileRef`.
- `fileio` types already define a unified location model (`fs`, `app`, `contentUri`, `contentTree`, `securityScoped`, `pad`).

### 2) Runtime behavior is mixed by destination kind

- `fs`/`app` destinations are path-based and work as direct file outputs.
- Android stream-style destinations (`contentUri`, `contentTree`) are currently handled via:
  - encode to local temp file
  - copy temp file to destination stream
  - delete temp file

### 3) Platform asymmetry still exists

- Android supports SAF-based stream destinations.
- iOS currently rejects Android-specific kinds (`contentUri`, `contentTree`, `pad`) and primarily supports local path/security-scoped flows.

### 4) Spec vs implementation gap exists

- The generic plan positions direct streaming output as the preferred direction.
- Actual Android conversion for stream destinations still uses temp+copy in the current implementation.

---

## Target state (to-be)

### 1) Single, consistent location model end-to-end

- All relevant APIs accept typed source/destination descriptors.
- Output/result values consistently return canonical `ResolvedFileRef`.

### 2) Performance-first export path

- **Primary path:** direct streaming output (`encoder -> destination stream`) where technically supported.
- **Fallback path:** temp+copy only for explicit non-seekable/format-specific edge cases.
- Fallback usage is transparent to callers and treated as secondary behavior.

### 3) Clear platform contract

- Android: full SAF integration for read/write workflows with explicit permission expectations.
- iOS: explicit support matrix for local/security-scoped flows, with clean unsupported handling for Android-only kinds.

### 4) Security + validation hardening

- `app` paths remain sandboxed to whitelisted base directories.
- Path traversal outside base roots is blocked by resolver validation.
- Error surface uses stable, typed file I/O codes.

---

## Gap summary

Primary migration gap (now closed):

1. Runtime export behavior is aligned with the performance decision:
  - Android `contentUri` / `contentTree` destinations are now direct-stream-first via seekable fd paths
  - temp+copy remains as controlled fallback only for providers that cannot supply a seekable fd

Secondary alignment gaps:

2. Keep docs in sync with real runtime behavior during transition.
3. Finalize platform notes and permission guidance in user-facing docs.
4. Validate result/error consistency across all destination kinds.

---

## Rollout guidance (high-level)

1. **Document reality clearly** while migration is in progress.
2. ✅ **Implement direct-stream-first path** for Android stream destinations.
3. ✅ **Retain fallback safety** only where required by encoder/container constraints.
4. ✅ **Update docs to final semantics** after runtime behavior is fully aligned.

---

## Success criteria

- ✅ Runtime behavior matches the strategic direction in `generic-file-io-high-level-plan.md`.
- ✅ Stream destinations are direct-first in normal cases.
- ✅ Temp+copy is no longer the default stream export behavior.
- ✅ Public docs describe the same behavior the code executes.

