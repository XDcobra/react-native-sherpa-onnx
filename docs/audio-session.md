# Pipeline Audio Session Coordination

## Introduction

Global audio session and route coordination for mic capture + PCM playback.

Import from `react-native-sherpa-onnx/audio`.

## Why this exists

Microphone capture and playback can run at the same time. Instead of configuring route/session per mic/player call, the SDK now uses a central coordinator per platform.

- iOS: coordinates a single process-wide `AVAudioSession`
- Android: coordinates AudioFocus + preferred devices across active `AudioRecord` / `AudioTrack`

This makes behavior deterministic when mic and playback overlap.

## Quick start

```ts
import {
  configurePipelineAudioSession,
  setPipelineAudioRoutePreference,
  getPipelineAudioSessionState,
  clearPipelineAudioRoutePreference,
  listAvailableInputDevices,
  listAvailableOutputDevices,
} from 'react-native-sherpa-onnx/audio';

// Optional startup policy
await configurePipelineAudioSession({ keepActiveWhenIdle: false });

const [inputs, outputs] = await Promise.all([
  listAvailableInputDevices(),
  listAvailableOutputDevices(),
]);

const preferredInput = inputs.find((d) => d.canSelect && d.kind === 'built_in_mic');
const preferredOutput = outputs.find((d) => d.canSelect && d.kind === 'bluetooth');

// Optional global route preference
await setPipelineAudioRoutePreference({
  inputDeviceId: preferredInput?.id ?? null,
  outputDeviceId: preferredOutput?.id ?? null,
});

// Start mic / player normally (no per-call device ids)
// ...

const state = await getPipelineAudioSessionState();
console.log(state.profile, state.currentOutputDeviceId);

// Reset to system defaults
await clearPipelineAudioRoutePreference();
```

## API reference

### `configurePipelineAudioSession(config)`

```ts
function configurePipelineAudioSession(config: {
  keepActiveWhenIdle?: boolean;
}): Promise<void>;
```

- `keepActiveWhenIdle` (default `false`):
  - iOS: keep `AVAudioSession` active when no owners are active
  - Android: keep AudioFocus when no owners are active

### `setPipelineAudioRoutePreference(route)`

```ts
function setPipelineAudioRoutePreference(route: {
  inputDeviceId?: string | null;
  outputDeviceId?: string | null;
}): Promise<void>;
```

Applies globally to all active and future mic/player sessions.

### `listAvailableInputDevices()`

```ts
function listAvailableInputDevices(): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    selected: boolean;
    default: boolean;
    canSelect: boolean;
  }>
>;
```

Lists selectable input devices for `inputDeviceId`.

### `listAvailableOutputDevices()`

```ts
function listAvailableOutputDevices(): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    selected: boolean;
    default: boolean;
    canSelect: boolean;
  }>
>;
```

Lists selectable output devices for `outputDeviceId`.

### `clearPipelineAudioRoutePreference()`

```ts
function clearPipelineAudioRoutePreference(): Promise<void>;
```

Clears global preference and returns routing to system defaults.

### `getPipelineAudioSessionState()`

```ts
function getPipelineAudioSessionState(): Promise<{
  active: boolean;
  profile: 'inactive' | 'playback' | 'duplex';
  activeMicOwners: number;
  activePcmOwners: number;
  preferredInputDeviceId: string | null;
  preferredOutputDeviceId: string | null;
  currentInputDeviceId: string | null;
  currentOutputDeviceId: string | null;
}>;
```

State fields:

- `profile`: computed profile from active owners
- `preferred*`: configured preference
- `current*`: effective routed device (may differ from preferred)

## Types and constants

```ts
import {
  configurePipelineAudioSession, // configure session-level coordinator policy
  setPipelineAudioRoutePreference, // set preferred input/output devices globally
  clearPipelineAudioRoutePreference, // clear preferred device overrides
  getPipelineAudioSessionState, // read current effective session snapshot
  listAvailableInputDevices, // enumerate microphone/input devices
  listAvailableOutputDevices, // enumerate playback/output devices
} from 'react-native-sherpa-onnx/audio';

import type {
  PipelineAudioSessionConfig, // session config shape (keepActiveWhenIdle)
  PipelineAudioRoutePreference, // preferred input/output device ids
  PipelineAudioSessionState, // current profile/owner/device snapshot
  PipelineAudioDeviceInfo, // device descriptor returned by list APIs
} from 'react-native-sherpa-onnx/audio';
```

## Error codes

| Code | Meaning |
| --- | --- |
| `AUDIO_SESSION_CONFIG_ERROR` | Session policy/configuration could not be applied |
| `AUDIO_SESSION_ROUTE_ERROR` | Route preference failed (device unavailable or not selectable) |
| `AUDIO_SESSION_STATE_ERROR` | Session state snapshot could not be read |
| `AUDIO_SESSION_INVALID_ARGUMENT` | Invalid route/config argument passed to the session API |

Other `AUDIO_*` errors may still surface from dependent mic/playback operations outside this coordinator API.

## Use case examples

<details>
<summary>Prefer Bluetooth output while keeping built-in mic as input</summary>

```ts
const [inputs, outputs] = await Promise.all([
  listAvailableInputDevices(),
  listAvailableOutputDevices(),
]);

const input = inputs.find((d) => d.kind === 'built_in_mic' && d.canSelect);
const output = outputs.find((d) => d.kind === 'bluetooth' && d.canSelect);

await setPipelineAudioRoutePreference({
  inputDeviceId: input?.id ?? null,
  outputDeviceId: output?.id ?? null,
});
```

</details>

<details>
<summary>Reset coordinator preferences after a temporary recording session</summary>

```ts
await configurePipelineAudioSession({ keepActiveWhenIdle: false });
// ... run recording + playback workflow ...
await clearPipelineAudioRoutePreference();
const state = await getPipelineAudioSessionState();
console.log(state.preferredInputDeviceId, state.preferredOutputDeviceId);
```

</details>