# Audio visualization (`react-native-sherpa-onnx/visualization`)

## Introduction

Import from `react-native-sherpa-onnx/visualization`. This page documents both visualization outputs:

- `levels`: one global spectrum (2D preview/thumbnail)
- `frames`: timeline spectrum series (animation/scrub/3D)

Input can be one of:

- `FileSource` (file picker / history)
- Offline audio buffer reference or id (`off_*`)
- Finalized live handle (`live_*`)

## Why this exists

- Keep visualization compute native and avoid sending PCM through JS.
- Keep one API for file/offline/live paths.
- Support both simple static bars and advanced timeline-driven animation.

## Quick start

### Static 2D spectrum (`levels`)

```ts
import { computeAudioVisualizationProfile } from 'react-native-sherpa-onnx/visualization';

const profile = await computeAudioVisualizationProfile(
  { kind: 'file', source: { kind: 'fs', path: '/tmp/audio.wav' } },
  {
    barCount: 96,
    minHz: 60,
    timeAggregate: 'max_hold',
  }
);

console.log(profile.levels.length, profile.frameCount); // 96, 0
```

### Timeline spectrum (`frames`)

```ts
import { computeAudioVisualizationProfile } from 'react-native-sherpa-onnx/visualization';

const profile = await computeAudioVisualizationProfile(
  { kind: 'offline', buffer: resultBufferRef },
  {
    barCount: 96,
    includeTimeline: true,
    frameDurationMs: 500,
  }
);

console.log(profile.frameCount, profile.frameDurationMs, profile.frames?.length);
```

## API reference

### `computeAudioVisualizationProfile(input, options?)`

```ts
export function computeAudioVisualizationProfile(
  input: AudioVisualizationInput,
  options?: AudioVisualizationOptions
): Promise<AudioVisualizationProfile>;
```

Parameters:

- `input`: `AudioVisualizationInput`
  - `FileSource`
  - `{ kind: 'file', source: FileSource }`
  - `{ kind: 'offline', buffer: PipelineAudioBufferIdSource }`
  - `{ kind: 'live', handle: LiveAudioBufferHandleFinished }`
- `options`: `AudioVisualizationOptions`
  - `kind?: 'spectrum_bars'` (default: `spectrum_bars`)
  - `barCount?: number` (default `96`, range `8..512`)
  - `minHz?: number` (default `60`, minimum `10`)
  - `maxHz?: number` (default auto, Nyquist-safe)
  - `timeAggregate?: 'max_hold' | 'mean'` (applies to global `levels`)
  - `includeTimeline?: boolean`
  - `frameCount?: number`
  - `frameDurationMs?: number`
  - `maxAnalysisDurationMs?: number`

Returns:

- `AudioVisualizationProfile`
  - `kind: 'spectrum_bars'`
  - `sampleRate`
  - `durationMs`
  - `barCount`
  - `levels: number[]` (always present, length = `barCount`)
  - `frameCount: number` (`0` when timeline is disabled)
  - `frameDurationMs: number` (`0` when timeline is disabled)
  - `frames?: Float32Array` (present when timeline is enabled)

## `levels` vs `frames`

- `levels`: one spectrum over the whole analyzed audio using `timeAggregate` (`max_hold` or `mean`).
- `frames`: row-major timeline tensor for animation/scrub/3D.
  - Index formula: `frames[t * barCount + b]`
  - Values are normalized to `0..1`

## Timeline resolution rules

| Input | Result |
| --- | --- |
| No timeline flags | `frameCount=0`, no `frames` |
| `includeTimeline: true` only | `frameDurationMs=500`, `frameCount=ceil(durationMs/500)` |
| Only `frameCount` | `frameDurationMs=durationMs/frameCount` |
| Only `frameDurationMs` | `frameCount=ceil(durationMs/frameDurationMs)` |
| Both set | `frameCount` wins; `frameDurationMs` derived from duration |

## Transport model (TurboModule + JSI)

Compute stays async in TurboModule; large timeline payload is transferred via JSI `ArrayBuffer`.

1. TurboModule computes native profile.
2. Promise resolves with metadata, `levels`, and an internal transfer id.
3. Wrapper calls JSI `takeVisualizationFrames(transferId)`.
4. Wrapper attaches `frames: Float32Array` to the returned profile.

This avoids serializing large `frames` arrays through bridge numbers/`NSNumber` boxing.

## Native algorithm

- STFT with `fftSize=2048`, `hopSize=1024`, Hann window.
- Local shared C++ radix-2 FFT implementation.
- Log-spaced bar mapping from `minHz` to `maxHz`.
- `levels`: aggregate over full analyzed range using `timeAggregate`.
- `frames`: per-timeline-bucket `max_hold` aggregation.
- Per-row normalization (`levels` and each timeline frame): linear power → dB, then map between the 8th and 92nd percentile of that row (~40 dB span), then gamma (~1.65) for display contrast. Avoids clipping loud audio to all `1.0`.
- When `includeTimeline` is enabled, `levels` are derived from the normalized timeline frames (`mean` or `max_hold` across time per bar, per `timeAggregate`), not a separate whole-file max-hold that can flatten low-frequency bars.

## Input-path behavior

- `offline`: reads chunks from `OfflineEntry` (mmap-friendly).
- `file`: decodes in streaming callbacks; no offline buffer registration required.
- `live`: reads finalized live data from spool/ring according to live buffer state.

## Limits

- `frameCount`: `8..512`
- `frameDurationMs`: `50..10000`
- `frameCount * barCount <= 131072` (otherwise `AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE`)
- `maxAnalysisDurationMs` can cap analysis to first `N` ms

## Types and constants

```ts
import { computeAudioVisualizationProfile } from 'react-native-sherpa-onnx/visualization';

import type {
  AudioVisualizationInput,
  AudioVisualizationKind,
  AudioVisualizationOptions,
  AudioVisualizationProfile,
  AudioVisualizationTimeAggregate,
} from 'react-native-sherpa-onnx/visualization';
```

## Error codes

| Code | Meaning |
| --- | --- |
| `AUDIO_VISUALIZATION_INVALID_INPUT` | Input shape or handle/source is invalid. |
| `AUDIO_VISUALIZATION_INVALID_OPTIONS` | Options are invalid (kind/ranges/finiteness). |
| `AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE` | Timeline payload exceeds max allowed size. |
| `AUDIO_BUFFER_NOT_FOUND` | Offline/live buffer id not found. |
| `AUDIO_INVALID_STATE` | Live buffer is not finalized. |
| `BUFFER_INVALIDATED` | Live buffer id invalidated after transfer/disposal. |
| `VISUALIZATION_INTERNAL_ERROR` | Native processing failed unexpectedly. |

Other `AUDIO_*`, `DECODE_*`, and file-resolution errors may still surface from dependent paths.

## Use case examples

<details>
<summary>Static bars for file-picker preview</summary>

```ts
const profile = await computeAudioVisualizationProfile(
  {
    kind: 'file',
    source: {
      kind: 'contentUri',
      uri: pickedUri,
      displayName: pickedName,
    },
  },
  {
    barCount: 72,
    minHz: 80,
    timeAggregate: 'mean',
  }
);
```

</details>

<details>
<summary>Animation frame index from playback position</summary>

```ts
const profile = await computeAudioVisualizationProfile(input, {
  includeTimeline: true,
  frameDurationMs: 250,
  barCount: 96,
});

const frameAt = (positionMs: number) => {
  if (!profile.frames || profile.frameCount <= 0) return null;
  const index = Math.max(
    0,
    Math.min(profile.frameCount - 1, Math.floor(positionMs / profile.frameDurationMs))
  );
  const offset = index * profile.barCount;
  return profile.frames.subarray(offset, offset + profile.barCount);
};
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK last-activity ring buffer (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) - Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
