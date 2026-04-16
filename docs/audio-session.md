# Pipeline Audio Session Coordination

Global audio session and route coordination for mic capture + PCM playback.

Import from `react-native-sherpa-onnx/audio`.

## Why this exists

Microphone capture and playback can run at the same time. Instead of configuring route/session per mic/player call, the SDK now uses a central coordinator per platform.

- iOS: coordinates a single process-wide `AVAudioSession`
- Android: coordinates AudioFocus + preferred devices across active `AudioRecord` / `AudioTrack`

This makes behavior deterministic when mic and playback overlap.

## Quick Start

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

## API

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

## Error code quick table

| Code | Meaning |
| --- | --- |
| `AUDIO_SESSION_CONFIG_ERROR` | Session policy/configuration could not be applied |
| `AUDIO_SESSION_ROUTE_ERROR` | Route preference failed (device unavailable or not selectable) |
| `AUDIO_SESSION_STATE_ERROR` | Session state snapshot could not be read |
| `AUDIO_SESSION_INVALID_ARGUMENT` | Invalid route/config argument passed to the session API |