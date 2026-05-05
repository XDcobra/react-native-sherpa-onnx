# Sub-Plan 01: Cross-Feature Contract & Validation

## Status
- Phase: **1a (foundation, JS-only)**
- Depends on: nothing — this is the foundation.
- Prerequisite for: sub-02, sub-03, sub-04, sub-05, sub-06.

## Purpose

Define the **shared TypeScript surface** that every feature's live overload reuses:

1. The per-feature `<Feature>LivePipelineOptions` shape (canonical fields, no feature-specific drift).
2. A **single shared validator** for the live-overload entry point (`validateLiveOfflinePipelineOptions`) that owns the `LIVE_OFFLINE_SEGMENTATION_REQUIRED` error code.
3. A typed **error class** for the contract (`LiveOfflinePipelineError`) to give SDK users a stable, programmatic check beyond string matching.

Why this is its own sub-plan: the contract has to be stable **before any feature ships**, otherwise per-feature implementations will drift in error wording, default-policy handling, and field naming.

---

## Design principles

1. **One shared validator per JS layer.** Each feature's `transcribe` / `synthesize` / `punctuate` / `enhance` overload calls **the same** `validateLiveOfflinePipelineOptions(...)`. No per-feature copies.
2. **One error code for the live contract.** `LIVE_OFFLINE_SEGMENTATION_REQUIRED` is reused for missing policy, `mode: 'off'`, `mode: 'manual'`, **and** unsupported evaluator (e.g. enhancement). No feature-specific subcodes.
3. **Typed error, not just message.** Throwing `LiveOfflinePipelineError` (with `.code` and `.feature`) lets SDK users branch programmatically without string matching.
4. **TS narrows the type, runtime guards the JS call site.** `mode?: 'auto'` at the type level means JS users in TS-clean code physically can't pass `'off'`. The runtime validator covers dynamic JS callers and untyped inputs.
5. **No new public buffer types.** The overload reuses `LiveAudioBufferIdSource` / `LiveTextBufferIdSource` exactly as the streaming engines do today.

---

## Files to add

```
src/livePipeline/
  index.ts                    // re-exports
  livePipelineOptions.ts      // <Feature>LivePipelineOptions shapes, base type
  validation.ts               // validateLiveOfflinePipelineOptions(...) + LiveOfflinePipelineError
  __tests__/validation.test.ts
```

Rationale for a dedicated `src/livePipeline/` folder rather than dropping it into `src/segment/`:
- The validator wraps `validateSegmentationConfig` from `src/segment/validation.ts`, but is **distinct** in semantics (it owns its own error code + a stricter contract). Co-locating with `src/segment/` would imply the segmentation module owns the live contract — it doesn't.
- It also makes the import path obvious for feature modules: `import { validateLiveOfflinePipelineOptions } from '../livePipeline'`.

---

## TypeScript shapes

### Base options type

```ts
// src/livePipeline/livePipelineOptions.ts
import type { SegmentationPolicy } from '../segment/engine-types';

/**
 * Mandatory `segmentation` block for the live overload.
 *
 * `mode` is intentionally restricted to `'auto'`; live overloads never run
 * with `mode: 'off'` or `mode: 'manual'` because the entire pipeline is
 * segmentation-driven (the offline decoder is invoked per committed segment).
 */
export interface LiveOfflineSegmentationConfig {
  policy: SegmentationPolicy;
  mode?: 'auto';
}

/**
 * Base shape every `<Feature>LivePipelineOptions` extends.
 * Feature options add their own fields (e.g. `sid` for TTS, `chunkSize` for STT)
 * but **must** keep `segmentation` as a required property.
 */
export interface LiveOfflinePipelineBaseOptions {
  segmentation: LiveOfflineSegmentationConfig;
}
```

Per-feature option shapes are defined in their own sub-plans (sub-03 … sub-06) and **all extend `LiveOfflinePipelineBaseOptions`**:

```ts
// Example (filled in by sub-03):
export interface SttLivePipelineOptions extends LiveOfflinePipelineBaseOptions {
  chunkSize?: number;
  onSegment?: (segment: TextSegment) => void;
}
```

### Error class

```ts
// src/livePipeline/validation.ts
export const LIVE_OFFLINE_SEGMENTATION_REQUIRED =
  'LIVE_OFFLINE_SEGMENTATION_REQUIRED' as const;

export type LiveOfflineErrorCode = typeof LIVE_OFFLINE_SEGMENTATION_REQUIRED;

export class LiveOfflinePipelineError extends Error {
  readonly code: LiveOfflineErrorCode;
  readonly feature: string;

  constructor(feature: string, message: string) {
    super(`${LIVE_OFFLINE_SEGMENTATION_REQUIRED}: ${message}`);
    this.name = 'LiveOfflinePipelineError';
    this.code = LIVE_OFFLINE_SEGMENTATION_REQUIRED;
    this.feature = feature;
  }
}
```

> The constant + `as const` pattern lets users do
> `if (err instanceof LiveOfflinePipelineError && err.code === LIVE_OFFLINE_SEGMENTATION_REQUIRED) { … }`
> with full type narrowing.

### Validator

```ts
// src/livePipeline/validation.ts (continued)
import { validateSegmentationConfig } from '../segment/validation';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { LiveOfflineSegmentationConfig } from './livePipelineOptions';

export interface ValidateLiveOfflinePipelineOptions {
  /** Public-facing feature name used in messages, e.g. 'live offline STT'. */
  featureName: string;
  /** 'speech' for audio inputs (STT, enhancement), 'text' for text inputs (TTS, punctuation). */
  domain: 'text' | 'speech';
  /** Optional whitelist of evaluators (e.g. enhancement: ['continuous_frames']). */
  supportedEvaluators?: string[];
  /** Raw `options.segmentation` from the caller (may be undefined / partial). */
  segmentation: unknown;
}

/**
 * Validates the live overload's mandatory segmentation contract.
 * Throws `LiveOfflinePipelineError` (code `LIVE_OFFLINE_SEGMENTATION_REQUIRED`) on:
 *   - missing `segmentation`
 *   - `mode === 'off'` or `mode === 'manual'`
 *   - missing `policy`
 *   - unsupported evaluator (when `supportedEvaluators` is set)
 *   - any policy validation failure that the segmentation validator would already raise
 */
export function validateLiveOfflinePipelineOptions(
  args: ValidateLiveOfflinePipelineOptions
): { policy: SegmentationPolicy } {
  const { featureName, domain, supportedEvaluators } = args;

  const seg = args.segmentation as
    | Partial<LiveOfflineSegmentationConfig>
    | undefined;

  if (!seg) {
    throw new LiveOfflinePipelineError(
      featureName,
      `${featureName} requires segmentation.policy (mode must not be "off"). ` +
        `Provide a valid policy (e.g. speech_energy_silence, text_synthetic_auto, or continuous_frames for enhancement).`
    );
  }

  // Guard JS callers passing 'off' / 'manual' dynamically (TS already rejects these).
  if (seg.mode != null && seg.mode !== 'auto') {
    throw new LiveOfflinePipelineError(
      featureName,
      `${featureName} live overload requires segmentation.mode === 'auto' (received "${seg.mode}"). ` +
        `For non-segmented batch processing use the offline overload (Off, Off).`
    );
  }

  if (!seg.policy) {
    throw new LiveOfflinePipelineError(
      featureName,
      `${featureName} requires segmentation.policy. ` +
        `Provide a valid policy (e.g. speech_energy_silence, text_synthetic_auto, or continuous_frames for enhancement).`
    );
  }

  // Delegate evaluator/domain/policy-detail validation to the existing helper,
  // routing its failures through the live-overload error code so callers see
  // a single, stable code regardless of which guard tripped.
  try {
    validateSegmentationConfig({
      mode: 'auto',
      policy: seg.policy,
      featureName,
      domain,
      supportsManual: false,
      supportedEvaluators,
      errorPrefix: LIVE_OFFLINE_SEGMENTATION_REQUIRED,
    });
  } catch (err) {
    // validateSegmentationConfig throws plain Error with the chosen prefix;
    // re-wrap as LiveOfflinePipelineError so the public type stays uniform.
    const message =
      err instanceof Error ? err.message : `policy validation failed: ${String(err)}`;
    throw new LiveOfflinePipelineError(
      featureName,
      message.replace(`${LIVE_OFFLINE_SEGMENTATION_REQUIRED}: `, '')
    );
  }

  return { policy: seg.policy };
}
```

### Re-exports

```ts
// src/livePipeline/index.ts
export {
  validateLiveOfflinePipelineOptions,
  LiveOfflinePipelineError,
  LIVE_OFFLINE_SEGMENTATION_REQUIRED,
} from './validation';
export type { LiveOfflineErrorCode } from './validation';
export type {
  LiveOfflinePipelineBaseOptions,
  LiveOfflineSegmentationConfig,
} from './livePipelineOptions';
```

The top-level `src/index.ts` should re-export the **error class** and the **constant** publicly so SDK consumers can `import { LiveOfflinePipelineError, LIVE_OFFLINE_SEGMENTATION_REQUIRED } from 'react-native-sherpa-onnx';`. The validator function itself stays internal — it's an implementation helper for feature modules.

---

## Implementation steps

1. Create `src/livePipeline/` folder.
2. Add `livePipelineOptions.ts` with `LiveOfflinePipelineBaseOptions` and `LiveOfflineSegmentationConfig`.
3. Add `validation.ts` with `LiveOfflinePipelineError`, `LIVE_OFFLINE_SEGMENTATION_REQUIRED` constant, and `validateLiveOfflinePipelineOptions`.
4. Add `index.ts` with the re-exports above.
5. Re-export the error class + constant from `src/index.ts` (public-facing entry point).
6. Add unit tests in `src/livePipeline/__tests__/validation.test.ts` (see test matrix below).

> No native changes are introduced in this sub-plan. Sub-02 onwards build on this surface.

---

## Test matrix (Jest)

`src/livePipeline/__tests__/validation.test.ts` covers:

| # | Input | Expected |
|---|---|---|
| 1 | `segmentation: undefined` | `LiveOfflinePipelineError`, code `LIVE_OFFLINE_SEGMENTATION_REQUIRED`, message contains `requires segmentation.policy`. |
| 2 | `segmentation: { policy: undefined }` | Same as #1. |
| 3 | `segmentation: { mode: 'off', policy: <valid> }` (cast through `as any`) | `LiveOfflinePipelineError`, message contains `mode === 'auto'`. |
| 4 | `segmentation: { mode: 'manual', policy: <valid> }` (cast through `as any`) | Same as #3. |
| 5 | `segmentation: { policy: { evaluator: 'speech_energy_silence' } }`, domain `'speech'` | Returns `{ policy }` unchanged. |
| 6 | `segmentation: { policy: { evaluator: 'text_synthetic_auto' } }`, domain `'text'` | Returns `{ policy }` unchanged. |
| 7 | `segmentation: { policy: { evaluator: 'speech_energy_silence' } }`, domain `'text'` | `LiveOfflinePipelineError`, message mentions text evaluator (delegated to `validateSegmentationConfig`). |
| 8 | `segmentation: { policy: { evaluator: 'speech_energy_silence' } }`, `supportedEvaluators: ['continuous_frames']` | `LiveOfflinePipelineError`, message mentions `continuous_frames`. |
| 9 | `segmentation: { policy: { evaluator: 'speech_vad_model' } }` (no `modelPath`) | `LiveOfflinePipelineError`, message mentions `modelPath`. |
| 10 | `segmentation: { mode: 'auto', policy: <valid> }` | Returns `{ policy }`. |
| 11 | TS-only: declare `const opts: SttLivePipelineOptions = { /* missing segmentation */ }` and assert it does **not** type-check. (Use `tsc --noEmit` snippet test or `expect-type` library.) | TypeScript compile error. |

---

## Acceptance criteria

- `validateLiveOfflinePipelineOptions` is the **only** function any feature uses for live-overload validation.
- All 11 cases in the test matrix pass.
- `LiveOfflinePipelineError` + `LIVE_OFFLINE_SEGMENTATION_REQUIRED` are exported publicly via `src/index.ts`.
- `src/segment/validation.ts` is **not modified** — the live-overload validator wraps it (clean cut, no parameter creep on the segmentation module).

---

## Open questions

### OQ-1.1 — Should `LiveOfflinePipelineError` carry the original cause?

**Question.** When `validateSegmentationConfig` throws (case 7/8/9 in the matrix), should `LiveOfflinePipelineError` set `.cause` to the original error?

**Recommendation: Yes.** Set `cause: err` on the wrapper. Reasoning:

- Modern Node + RN runtimes support `Error.cause` (ES2022).
- Debugging native validator vs. live-overload validator failures is much easier with the chain preserved.
- The public `code` field stays stable (`LIVE_OFFLINE_SEGMENTATION_REQUIRED`); cause is purely diagnostic.

Sketch:

```ts
throw new LiveOfflinePipelineError(featureName, message, { cause: err });
```

with the constructor accepting an `ErrorOptions` second argument and forwarding to `super(message, options)`.

### OQ-1.2 — Should the validator return `{ policy, mode }` or just `{ policy }`?

**Question.** The live overload conceptually only ever runs in `mode: 'auto'`; do we still return `mode` for downstream consumers?

**Recommendation: Return `{ policy }` only.** Reasoning:

- Each feature's worker call is hard-coded to the segmentation-driven path, so `mode` carries no extra information.
- Returning a smaller shape avoids ambiguity ("can I switch mode after validation?" — no).
- If a future feature ever needs to thread `mode` through, it can be added without breaking callers.

### OQ-1.3 — Add `LIVE_OFFLINE_POLICY_NOT_SUPPORTED` as a separate code for enhancement-style restrictions?

**Question.** The design note (§7.6) chose **one** cross-feature error code for the mandatory-policy contract, and the rationale says "users get one stable, searchable code independent of feature." Should evaluator restrictions still reuse `LIVE_OFFLINE_SEGMENTATION_REQUIRED`?

**Recommendation: Yes — keep one code only.** Reasoning:

- Splitting into a second code doubles the documentation surface and burdens users with branching on two codes for a single conceptual failure ("the live overload couldn't accept what you passed").
- The error message template is already explicit (e.g. `"... live enhancement supports only continuous_frames policy; received speech_energy_silence."`); the **message**, not a sub-code, conveys the specific cause.
- Matches the design note's resolved decision in §7.6 / §1.2.

If, post-release, telemetry shows users get tangled by the conflated cases, we can introduce a second sub-code in a minor version. Until then: **one code, rich messages.**
