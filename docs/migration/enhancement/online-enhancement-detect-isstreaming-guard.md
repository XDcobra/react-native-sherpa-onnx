# Online Enhancement Detection: Problem and Solution

## Problem Statement

The current enhancement model flow has two conflicting behaviors:

1. `nativeDetectEnhancementModel` is already used as a pre-check in both:
   - Explicit JS detect flow (`detectEnhancementModel(...)`)
   - Implicit init flow (`initializeEnhancement(...)`, `initializeOnlineEnhancement(...)`)
2. Runtime online denoiser validation inside sherpa-onnx can still hard-exit the process (`SHERPA_ONNX_EXIT(-1)`) for unsupported or malformed model exports.

This creates a gap:

- Detection currently reports model type and paths, but does not fully encode online-streaming compatibility.
- `isStreaming` is currently not derived from a robust online-compatibility guard.
- A user may pass a model that looks like `gtcrn`/`dpdfnet` by naming/path conventions but fails online constraints at runtime.

Result: app-level detection and init can look valid, but online runtime can still terminate the process instead of returning a recoverable error.

## Goal

Provide consistent, early, and safe streaming capability signaling for enhancement models:

- Set `isStreaming` correctly in detection results.
- Reuse online compatibility rules during detection when a real filesystem model is available.
- Keep name-only detection (assetName-only) as heuristic/best-effort.

## Agreed Solution

### 1) Extend enhancement detection semantics

Use two separate concepts in detection result:

- `success`: full validation status (files + compatibility checks)
- `isStreaming`: model capability status (whether the detected model is considered online-streaming-capable)

### 2) Add online-compatibility guard into enhancement detect path

When filesystem-based detection is possible (real file list / resolvable model file):

- Run a safe preflight guard in `nativeDetectEnhancementModel` aligned with online denoiser constraints
  (same logical rules as in `online-speech-denoiser-dpdfnet-impl.h` and related online model assumptions),
  but **without** calling runtime paths that may trigger process exit.
- If guard passes for detected `gtcrn` / `dpdfnet`: `isStreaming = true`.
- If guard fails: `isStreaming = false` and include clear error context in detection output.

### 3) Keep assetName-only detection heuristic

When no filesystem is available and detection runs in name-only mode:

- Infer candidate type from asset/model name (`gtcrn` / `dpdfnet`) as best effort.
- Set `isStreaming` heuristically from inferred type.
- Keep `success = false` if full validation cannot be executed in name-only mode.
- Return explicit note that this is a heuristic result and full validation requires filesystem-backed detection.

### 4) Preserve init-time validation (defense in depth)

Detection becomes stronger, but creation path still validates at init time:

- `initializeOnlineEnhancement(...)` continues to validate before engine use.
- Long term, any fatal `exit` behavior in underlying runtime should be replaced by recoverable error propagation.

## Expected Behavior Matrix

| Detection input | Guard execution | `isStreaming` | `success` |
| --- | --- | --- | --- |
| Filesystem-backed `gtcrn/dpdfnet` + guard pass | Full | `true` | `true` |
| Filesystem-backed `gtcrn/dpdfnet` + guard fail | Full | `false` | `false` |
| Filesystem-backed non-streaming/unknown enhancement | Full | `false` | `false` |
| AssetName-only inferred `gtcrn/dpdfnet` | Heuristic only | `true` (best effort) | `false` |
| AssetName-only unknown | Heuristic only | `false` | `false` |

## Why this approach

- Reuses existing detect-first architecture already used by implicit and explicit flows.
- Avoids app crashes by moving compatibility checks into a safe preflight path.
- Keeps backward-compatible detection UX while making `isStreaming` meaningful.
- Clearly communicates confidence level (validated vs heuristic) to callers.
