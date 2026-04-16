# Pipeline Audio Session Coordination — Cross-Platform Spec

Status: Target Architecture (Cross-Platform SDK)

Input:
- [ios-audio-session-problem-statement.md](./ios-audio-session-problem-statement.md)

---

## 1. Goal

This document defines the target architecture for a coordinated audio-session and routing layer across iOS and Android. It replaces the earlier iOS-only draft.

Core objectives:

- Deterministic behavior for simultaneous mic capture + PCM playback on both platforms.
- One central coordinator per platform that owns session/routing policy.
- No direct `AVAudioSession` manipulation (iOS) or ad-hoc `AudioAttributes` configuration (Android) in feature code.
- A single, typed public JS/TS API that maps to platform-appropriate native semantics.
- Breaking changes are intentional — the result must be a robust public SDK for unknown consumer use cases.

---

## 2. Current State (IST) — Root Cause Per Platform

### 2.1 iOS

`AVAudioSession` is process-global. Mic and PCM configure it independently:

| File | What it does | Problem |
|------|-------------|---------|
| [ios/audio/bridge/SherpaOnnx+PipelineAudioMic.mm](../../../ios/audio/bridge/SherpaOnnx+PipelineAudioMic.mm) | Sets `PlayAndRecord` + `setActive:YES`; calls `setActive:NO` on stop and error paths; sets `setPreferredInput` | Deactivation kills concurrent PCM playback |
| [ios/pcm/SherpaOnnx+PcmPlayer.mm](../../../ios/pcm/SherpaOnnx+PcmPlayer.mm) | Sets `PlayAndRecord` (when `outputDeviceId` given) or `Playback` (default); sets `setActive:YES`; calls `overrideOutputAudioPort` | Overwrites category set by mic; route override is global but looks per-player |

Consequences:

- Last writer wins on category/mode/activation — non-deterministic.
- `stopMic` deactivates session while PCM is still playing.
- Route set by PCM player creation silently affects mic input path.

### 2.2 Android

Android does **not** have a process-global session category like iOS. `AudioRecord` and `AudioTrack` are independent instances. However:

| File | What it does | Gap |
|------|-------------|-----|
| [android/src/main/java/com/sherpaonnx/audio/pipeline/MicToLiveBufferSink.kt](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/MicToLiveBufferSink.kt) | Creates `AudioRecord` with `VOICE_RECOGNITION`; calls `setPreferredDevice()` per instance | Device preference is per-call, not centralized; no AudioFocus management |
| [android/src/main/java/com/sherpaonnx/pcm/PcmPlayerService.kt](../../../android/src/main/java/com/sherpaonnx/pcm/PcmPlayerService.kt) | Creates `AudioTrack` with `USAGE_MEDIA`/`CONTENT_TYPE_SPEECH`; calls `setPreferredDevice()` per instance | No global route policy; no AudioFocus request/release |
| [android/src/main/java/com/sherpaonnx/pcm/PcmPlayerSession.kt](../../../android/src/main/java/com/sherpaonnx/pcm/PcmPlayerSession.kt) | Manages playback lifecycle (drain, seek, pause/resume) | No coordination with mic lifecycle |

Consequences:

- Per-call `inputDeviceId`/`outputDeviceId` is technically valid on Android (per-instance), but the JS API must be unified across platforms.
- No AudioFocus handling: other apps' audio is not ducked or paused.
- No centralized route state — app cannot query effective routing across active mic + players.

### 2.3 JS API Mismatch

Current signatures suggest per-call device selection:

```ts
startMicToLiveAudioBuffer(id, { inputDeviceId? })   // global effect on iOS, per-instance on Android
createPcmPlayer(id, bufferId, vol, { outputDeviceId? })  // global effect on iOS, per-instance on Android
```

This is semantically misleading on iOS and prevents coordinated routing on both platforms.

---

## 3. Target Architecture (SOLL)

### 3.1 Invariants (both platforms)

1. **Single coordinator** per platform owns all session/routing state. Feature code (mic, PCM) only registers intents.
2. **Owner-based lifecycle**: session deactivation (iOS) and AudioFocus release (Android) happen only when the last owner releases.
3. **Global route policy**: device preference is set once via the public API; the coordinator applies it to all active and future audio paths.
4. **Deterministic reconcile**: same set of active owners + same policy = same native session state.
5. **Snapshot introspection**: app can query the effective session state at any time.

### 3.2 Session Profiles

| Profile | Condition | iOS Category | Android Behavior |
|---------|-----------|-------------|-----------------|
| `inactive` | No active owners | Session deactivated (unless `keepActiveWhenIdle`) | No AudioFocus held |
| `playback` | ≥1 PCM owner, no mic | `AVAudioSessionCategoryPlayback` | AudioFocus `GAIN` with `USAGE_MEDIA` |
| `duplex` | ≥1 mic owner (regardless of PCM) | `AVAudioSessionCategoryPlayAndRecord` | AudioFocus `GAIN` with `USAGE_MEDIA`; mic + track both active |

Rule (deterministic):

```
if any owner.needsInput  → duplex
else if any owner.needsOutput → playback
else → inactive
```

### 3.3 Route Preference Model

Route preference is **global** (not per-owner). The coordinator stores it and applies it:

- **iOS**: `setPreferredInput`, `overrideOutputAudioPort`, Bluetooth options on `setCategory`.
- **Android**: `setPreferredDevice()` on every active and newly created `AudioRecord`/`AudioTrack`.

When preference changes, the coordinator re-applies to all active audio paths.

---

## 4. Platform Architecture

### 4.1 iOS — PaAudioSessionCoordinator

New files:

- `ios/audio/session/PaAudioSessionCoordinator.h`
- `ios/audio/session/PaAudioSessionCoordinator.mm`

**Responsibilities:**

- Process-global singleton, thread-safe via serial dispatch queue.
- Owner registry: map of `ownerId → PaAudioSessionIntent`.
- Global policy storage (`PaAudioSessionPolicy`).
- `reconcile()`: computes target profile from owners + policy; applies only on delta (category, mode, options, active, route).
- System observer: `AVAudioSessionRouteChangeNotification`, `AVAudioSessionInterruptionNotification`, foreground transition → re-reconcile.
- `resetAll()` for module teardown.

**Owner Intent:**

```objc
// PaAudioSessionCoordinator.h
@interface PaAudioSessionIntent : NSObject
@property (nonatomic, copy) NSString *ownerId;   // "mic" or "pcm:<playerId>"
@property (nonatomic, assign) BOOL needsInput;
@property (nonatomic, assign) BOOL needsOutput;
@end
```

**Policy:**

```objc
@interface PaAudioSessionPolicy : NSObject
@property (nonatomic, assign) BOOL keepActiveWhenIdle;           // default NO
@property (nonatomic, assign) BOOL preferBluetoothForDuplex;     // default YES
@property (nonatomic, assign) BOOL defaultToSpeakerWhenDuplex;   // default YES
@property (nonatomic, copy, nullable) NSString *preferredInputDeviceId;
@property (nonatomic, copy, nullable) NSString *preferredOutputDeviceId;
@end
```

**Coordinator public API:**

```objc
@interface PaAudioSessionCoordinator : NSObject
+ (instancetype)shared;

- (void)acquireIntent:(PaAudioSessionIntent *)intent;
- (void)releaseIntent:(NSString *)ownerId;

- (BOOL)configurePolicy:(PaAudioSessionPolicy *)policy error:(NSError **)error;
- (BOOL)setRoutePreferenceInput:(nullable NSString *)inputId
                         output:(nullable NSString *)outputId
                          error:(NSError **)error;
- (void)clearRoutePreference;

- (NSDictionary *)stateSnapshot;   // JSON-serializable for bridge
- (void)resetAll;
@end
```

**Reconcile logic (pseudocode):**

```
func reconcile():
  profile = computeProfile(owners)       // inactive | playback | duplex
  if profile == lastAppliedProfile && policy == lastAppliedPolicy:
    return  // no-op

  switch profile:
    case duplex:
      setCategory(.playAndRecord, mode: .default, options: buildOptions(policy))
      setActive(YES)
      applyRoutePreference(policy)
    case playback:
      setCategory(.playback)
      setActive(YES)
      applyRoutePreference(policy)
    case inactive:
      if !policy.keepActiveWhenIdle:
        setActive(NO, notifyOthers: true)

  lastAppliedProfile = profile
  lastAppliedPolicy = policy
```

### 4.2 Android — PaAudioSessionCoordinator

New file:

- `android/src/main/java/com/sherpaonnx/audio/session/PaAudioSessionCoordinator.kt`

Android does not have a process-global audio session, but the coordinator provides:

1. **Centralized route preference storage** — applied via `setPreferredDevice()` to every active `AudioRecord`/`AudioTrack` and to newly created ones.
2. **Owner registry** — tracks active mic/PCM owners for profile computation and snapshot.
3. **AudioFocus management** — requests focus when first owner registers, abandons when last owner releases.
4. **Device change listener** — `AudioManager.registerAudioDeviceCallback()` to detect connect/disconnect and re-apply preferences.
5. **State snapshot** — mirrors the iOS snapshot shape for cross-platform API consistency.

```kotlin
// PaAudioSessionCoordinator.kt

object PaAudioSessionCoordinator {

  data class Intent(
    val ownerId: String,       // "mic" or "pcm:<playerId>"
    val needsInput: Boolean,
    val needsOutput: Boolean,
  )

  data class Policy(
    val keepActiveWhenIdle: Boolean = false,
    val preferredInputDeviceId: Int? = null,
    val preferredOutputDeviceId: Int? = null,
  )

  // --- Owner management ---
  fun acquireIntent(intent: Intent)
  fun releaseIntent(ownerId: String)

  // --- Policy ---
  fun configurePolicy(policy: Policy)
  fun setRoutePreference(inputDeviceId: Int?, outputDeviceId: Int?)
  fun clearRoutePreference()

  // --- Query ---
  fun stateSnapshot(): Map<String, Any?>  // JSON-serializable

  // --- Lifecycle ---
  fun initialize(context: Context)  // called from TurboModule init
  fun resetAll()

  // --- Internal: called by mic/PCM code ---
  fun applyPreferredDevice(record: AudioRecord)
  fun applyPreferredDevice(track: AudioTrack)
}
```

**AudioFocus handling:**

```kotlin
private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
  .setAudioAttributes(AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build())
  .setOnAudioFocusChangeListener { focusChange ->
    // Handle AUDIOFOCUS_LOSS, AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_GAIN
    // Emit event to JS if needed
  }
  .build()

fun reconcile() {
  val profile = computeProfile(owners)
  when (profile) {
    DUPLEX, PLAYBACK -> {
      if (!holdingFocus) {
        audioManager.requestAudioFocus(focusRequest)
        holdingFocus = true
      }
    }
    INACTIVE -> {
      if (holdingFocus && !policy.keepActiveWhenIdle) {
        audioManager.abandonAudioFocusRequest(focusRequest)
        holdingFocus = false
      }
    }
  }
  reapplyRoutePreferences()
}
```

**Device change callback:**

```kotlin
private val deviceCallback = object : AudioDeviceCallback() {
  override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
    reapplyRoutePreferences()  // preferred device may now be available
  }
  override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
    reapplyRoutePreferences()  // preferred device may have been removed
  }
}
```

**Route preference application:**

The coordinator iterates all active `AudioRecord`/`AudioTrack` instances and calls `setPreferredDevice()`. New instances created by mic/PCM code call `coordinator.applyPreferredDevice(record/track)` immediately after construction.

### 4.3 Platform Comparison

| Aspect | iOS | Android |
|--------|-----|---------|
| Session scope | Process-global `AVAudioSession` | Per-instance `AudioRecord`/`AudioTrack` |
| Category/profile | `setCategory` on coordinator reconcile | Implicit via `AudioAttributes` at track creation |
| Route preference | `setPreferredInput`/`overrideOutputAudioPort` (global) | `setPreferredDevice()` per instance |
| Focus management | Automatic with `setActive` | Explicit `AudioFocusRequest` in coordinator |
| Interruption | `AVAudioSessionInterruptionNotification` | `OnAudioFocusChangeListener` |
| Device change | `AVAudioSessionRouteChangeNotification` | `AudioManager.registerAudioDeviceCallback` |

---

## 5. Implementation Steps

### 5.1 iOS — Coordinator

**Files:**
- `ios/audio/session/PaAudioSessionCoordinator.h` (new)
- `ios/audio/session/PaAudioSessionCoordinator.mm` (new)

**Tasks:**
1. Singleton with serial dispatch queue.
2. Implement `acquireIntent`, `releaseIntent`, `configurePolicy`, `setRoutePreference`, `clearRoutePreference`, `stateSnapshot`, `resetAll`.
3. `reconcile()` — compute profile, apply only on delta.
4. Register observers: `AVAudioSessionRouteChangeNotification`, `AVAudioSessionInterruptionNotification`, `UIApplicationDidBecomeActiveNotification`.
5. Observer handlers call `reconcile()`.

### 5.2 Android — Coordinator

**Files:**
- `android/src/main/java/com/sherpaonnx/audio/session/PaAudioSessionCoordinator.kt` (new)

**Tasks:**
1. Singleton object with thread-safe owner map and policy.
2. Implement `acquireIntent`, `releaseIntent`, `configurePolicy`, `setRoutePreference`, `clearRoutePreference`, `stateSnapshot`, `resetAll`.
3. `reconcile()` — manage AudioFocus acquisition/release, reapply route preferences to all active tracks/records.
4. `initialize(context)` — register `AudioDeviceCallback` via `AudioManager`.
5. `applyPreferredDevice(AudioRecord)` / `applyPreferredDevice(AudioTrack)` — called by feature code after track creation.
6. Track registry: maintain weak references to active `AudioRecord`/`AudioTrack` for route reapplication.

### 5.3 iOS — Mic Bridge Migration

**File:** [ios/audio/bridge/SherpaOnnx+PipelineAudioMic.mm](../../../ios/audio/bridge/SherpaOnnx+PipelineAudioMic.mm)

**Changes:**
1. Remove all direct `AVAudioSession` calls (`setCategory`, `setActive`, `setPreferredInput`).
2. Before AudioQueue start: `[[PaAudioSessionCoordinator shared] acquireIntent:micIntent]` where `micIntent.needsInput = YES`.
3. On AudioQueue error: release mic intent (no direct `setActive:NO`).
4. `stopMicToLiveAudioBuffer`: stop queue, then `releaseIntent:@"mic"`.
5. Remove `inputDeviceId` parameter handling (route is global via coordinator).

### 5.4 iOS — PCM Bridge Migration

**File:** [ios/pcm/SherpaOnnx+PcmPlayer.mm](../../../ios/pcm/SherpaOnnx+PcmPlayer.mm)

**Changes:**
1. Remove all direct `AVAudioSession` calls (`setCategory`, `setActive`, `overrideOutputAudioPort`, `setPreferredInput`).
2. On successful player start: `acquireIntent` with `ownerId = "pcm:<playerId>"`, `needsOutput = YES`.
3. On create error: release intent.
4. `so_destroyPcmPlayer`: `releaseIntent:@"pcm:<playerId>"`.
5. When replacing an existing player ID: release old intent first, then acquire new.
6. Remove `outputDeviceId` parameter handling.

### 5.5 Android — Mic Integration

**File:** [android/src/main/java/com/sherpaonnx/audio/pipeline/MicToLiveBufferSink.kt](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/MicToLiveBufferSink.kt)

**Changes:**
1. After `AudioRecord` construction: call `PaAudioSessionCoordinator.applyPreferredDevice(record)` instead of reading `inputDeviceId` from options.
2. On `start()`: `PaAudioSessionCoordinator.acquireIntent(Intent("mic", needsInput=true, needsOutput=false))`.
3. On `stop()`: `PaAudioSessionCoordinator.releaseIntent("mic")`.
4. Remove `inputDeviceId` parameter from `start()` signature.

### 5.6 Android — PCM Integration

**Files:**
- [android/src/main/java/com/sherpaonnx/pcm/PcmPlayerService.kt](../../../android/src/main/java/com/sherpaonnx/pcm/PcmPlayerService.kt)
- [android/src/main/java/com/sherpaonnx/pcm/PcmPlayerSession.kt](../../../android/src/main/java/com/sherpaonnx/pcm/PcmPlayerSession.kt)

**Changes:**
1. After `AudioTrack` construction: call `PaAudioSessionCoordinator.applyPreferredDevice(track)`.
2. On player creation: `PaAudioSessionCoordinator.acquireIntent(Intent("pcm:<id>", needsInput=false, needsOutput=true))`.
3. On player destruction: `PaAudioSessionCoordinator.releaseIntent("pcm:<id>")`.
4. Remove `outputDeviceId` parameter from create path.

### 5.7 Module Lifecycle — Both Platforms

**iOS** — [ios/SherpaOnnx.mm](../../../ios/SherpaOnnx.mm):
1. Implement `invalidate` (RCTBridgeModule teardown hook).
2. In teardown: destroy all PCM players, stop mic queue, call `[[PaAudioSessionCoordinator shared] resetAll]`.

**Android** — [android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt](../../../android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt):
1. In `initialize()`: call `PaAudioSessionCoordinator.initialize(reactApplicationContext)`.
2. In `invalidate()` (already exists or add): destroy all PCM players, stop mic, call `PaAudioSessionCoordinator.resetAll()`.

### 5.8 TurboModule Bridge — New Methods

**iOS** — Add bridge methods in a new category or in `SherpaOnnx.mm`:
- `configurePipelineAudioSession:` → forwards to coordinator `configurePolicy`
- `setPipelineAudioRoutePreference:` → forwards to coordinator `setRoutePreference`
- `clearPipelineAudioRoutePreference` → forwards to coordinator `clearRoutePreference`
- `getPipelineAudioSessionState` → forwards to coordinator `stateSnapshot`

**Android** — Add overrides in `SherpaOnnxModule.kt`:
- `configurePipelineAudioSession(options, promise)` → `PaAudioSessionCoordinator.configurePolicy(...)`
- `setPipelineAudioRoutePreference(route, promise)` → `PaAudioSessionCoordinator.setRoutePreference(...)`
- `clearPipelineAudioRoutePreference(promise)` → `PaAudioSessionCoordinator.clearRoutePreference()`
- `getPipelineAudioSessionState(promise)` → `PaAudioSessionCoordinator.stateSnapshot()`

---

## 6. Public API (JS/TS)

### 6.1 New Audio Session API

File: [src/audio/types.ts](../../../src/audio/types.ts)

```ts
export interface PipelineAudioRoutePreference {
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export interface PipelineAudioSessionConfig {
  keepActiveWhenIdle?: boolean;
  /** iOS only: allow Bluetooth HFP/A2DP in duplex mode. Default true. */
  preferBluetoothForDuplex?: boolean;
  /** iOS only: default to speaker when duplex. Default true. */
  defaultToSpeakerWhenDuplex?: boolean;
}

export type PipelineAudioProfile = 'inactive' | 'playback' | 'duplex';

export interface PipelineAudioSessionState {
  active: boolean;
  profile: PipelineAudioProfile;
  activeMicOwners: number;
  activePcmOwners: number;
  preferredInputDeviceId?: string;
  preferredOutputDeviceId?: string;
  /** Actually routed input device (may differ from preferred). */
  currentInputDeviceId?: string;
  /** Actually routed output device (may differ from preferred). */
  currentOutputDeviceId?: string;
}
```

### 6.2 TurboModule Spec Additions

File: [src/NativeSherpaOnnx.ts](../../../src/NativeSherpaOnnx.ts)

```ts
configurePipelineAudioSession(config?: {
  keepActiveWhenIdle?: boolean;
  preferBluetoothForDuplex?: boolean;
  defaultToSpeakerWhenDuplex?: boolean;
}): Promise<void>;

setPipelineAudioRoutePreference(route: {
  inputDeviceId?: string;
  outputDeviceId?: string;
}): Promise<void>;

clearPipelineAudioRoutePreference(): Promise<void>;

getPipelineAudioSessionState(): Promise<{
  active: boolean;
  profile: string;
  activeMicOwners: number;
  activePcmOwners: number;
  preferredInputDeviceId?: string;
  preferredOutputDeviceId?: string;
  currentInputDeviceId?: string;
  currentOutputDeviceId?: string;
}>;
```

### 6.3 Breaking Changes to Existing APIs

**`startMicToLiveAudioBuffer`** — remove `inputDeviceId` from options:

```ts
// Before
startMicToLiveAudioBuffer(liveBufferId: string, options?: {
  emitToJs?: boolean;
  inputDeviceId?: string;  // REMOVED
}): Promise<void>;

// After
startMicToLiveAudioBuffer(liveBufferId: string, options?: {
  emitToJs?: boolean;
}): Promise<void>;
```

**`createPcmPlayer`** — remove `outputDeviceId` from options:

```ts
// Before
createPcmPlayer(playerId: string, audioBufferId: string, volume: number, options?: {
  outputDeviceId?: string;  // REMOVED
}): Promise<void>;

// After
createPcmPlayer(playerId: string, audioBufferId: string, volume: number): Promise<void>;
```

File: [src/audiobuffer/types.ts](../../../src/audiobuffer/types.ts)

```ts
// StartMicToLiveOptions: inputDeviceId removed
export interface StartMicToLiveOptions {
  emitToJs?: boolean;
}
```

File: [src/pcm/types.ts](../../../src/pcm/types.ts)

```ts
// PcmPlayerOptions: outputDeviceId removed
export interface PcmPlayerOptions {
  volume?: number;
  onEnded?: (event: PcmPlayerEndedEvent) => void;
}
```

### 6.4 JS Facade Updates

Files:
- [src/audio/index.ts](../../../src/audio/index.ts) — export new session/route functions
- [src/audiobuffer/index.ts](../../../src/audiobuffer/index.ts) — remove `inputDeviceId` from mic start call
- [src/pcm/pcmPlayer.ts](../../../src/pcm/pcmPlayer.ts) — remove `outputDeviceId` from create call

### 6.5 Recommended App Usage Pattern

```ts
import {
  configurePipelineAudioSession,
  setPipelineAudioRoutePreference,
  getPipelineAudioSessionState,
  listAvailableInputDevices,
  listAvailableOutputDevices,
} from 'react-native-sherpa-onnx/audio';

// 1. Configure session policy once at app startup (optional)
await configurePipelineAudioSession({
  keepActiveWhenIdle: false,
  preferBluetoothForDuplex: true,    // iOS
  defaultToSpeakerWhenDuplex: true,  // iOS
});

// 2. Set route preference when user selects a device
const outputs = await listAvailableOutputDevices();
const selected = outputs.find(d => d.kind === 'bluetooth');
if (selected) {
  await setPipelineAudioRoutePreference({ outputDeviceId: selected.id });
}

// 3. Start mic / PCM as usual — no device IDs in these calls
await startMicToLiveAudioBuffer(liveBufferId, { emitToJs: true });
const player = await createPcmPlayer({ volume: 1.0 });

// 4. Query effective state anytime
const state = await getPipelineAudioSessionState();
console.log(state.profile, state.currentOutputDeviceId);
```

---

## 7. Error Handling

### 7.1 Error Codes

| Code | When | Platforms |
|------|------|-----------|
| `AUDIO_SESSION_CONFIG_ERROR` | `configurePipelineAudioSession` fails to apply | iOS (Android: unlikely, resolves silently) |
| `AUDIO_SESSION_ROUTE_ERROR` | Preferred device not found or not available | iOS, Android |
| `AUDIO_SESSION_INVALID_ARGUMENT` | Invalid config/route values | iOS, Android |

### 7.2 Semantics

- **Route preference**: best-effort by default. If the preferred device is unavailable, the system default is used. `getPipelineAudioSessionState()` reports the actually routed device so the app can detect divergence.
- **Mic/PCM start**: rejects only on real session configuration failures (e.g., iOS `setCategory` error, Android `AudioRecord` initialization failure). Route preference failure does not block start.
- **Strict mode**: not in initial scope. Can be added later via `strictRoute: boolean` in `PipelineAudioSessionConfig`.

---

## 8. Test Plan

### 8.1 Cross-Platform Behavioral Tests (Manual)

These tests must pass on both iOS and Android:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Mic start → PCM start → Mic stop → PCM continues | PCM plays uninterrupted |
| 2 | PCM start → Mic start → both active | Both streams stable, no session reset |
| 3 | Rapid toggle: startMic/stopMic + create/destroyPcmPlayer × 50 | No deadlock, no leak, no crash |
| 4 | Set route preference → start mic+PCM → verify `getPipelineAudioSessionState` | Preferred and current device IDs reported correctly |
| 5 | Start mic+PCM → change route preference → audio switches | Route change applies to active streams |
| 6 | RN reload / module teardown | No hanging owners, session returns to inactive |
| 7 | `configurePipelineAudioSession({ keepActiveWhenIdle: true })` → start+stop all | Session stays active after last owner releases |

### 8.2 iOS-Specific Device Matrix

| Device path | Test |
|-------------|------|
| Built-in speaker | Default playback route |
| Built-in receiver | `setPipelineAudioRoutePreference({ outputDeviceId: receiverId })` |
| Bluetooth (HFP) | Duplex mic+PCM via Bluetooth |
| Bluetooth (A2DP) | Playback-only via Bluetooth |
| Wired headphones | Route preference + disconnect mid-stream |
| AirPods (with mic) | Duplex + route change notification |

### 8.3 Android-Specific Device Matrix

| Device path | Test |
|-------------|------|
| Built-in speaker | Default playback route |
| Built-in earpiece | `setPipelineAudioRoutePreference({ outputDeviceId: earpieceId })` |
| Bluetooth (A2DP) | Playback via Bluetooth, verify `setPreferredDevice` |
| Bluetooth (SCO) | Duplex mic+PCM via Bluetooth SCO |
| Wired headset (with mic) | Duplex + unplug mid-stream |
| USB audio | Route preference + connect/disconnect |

### 8.4 JS/TS Contract Tests

1. Type compilation: new session/route types compile without errors.
2. Codegen: TurboModule spec generates correct native signatures on both platforms.
3. Example app screens updated — no `inputDeviceId`/`outputDeviceId` in mic/PCM calls.
4. Smoke test: new API functions callable and return expected shapes.

### 8.5 Regression Focus

- [example/src/screens/pipeline-showcase/PipelineShowcaseScreen.tsx](../../../example/src/screens/pipeline-showcase/PipelineShowcaseScreen.tsx)
- [example/src/screens/stt/STTScreen.tsx](../../../example/src/screens/stt/STTScreen.tsx)
- [example/src/screens/tts/TTSScreen.tsx](../../../example/src/screens/tts/TTSScreen.tsx)

---

## 9. Implementation Order

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **1** | Native coordinators | `PaAudioSessionCoordinator` on iOS (.h/.mm) and Android (.kt). Unit-testable in isolation. |
| **2** | Mic/PCM intent migration | iOS: remove direct `AVAudioSession` calls, use coordinator. Android: remove per-call device params, use coordinator. Both platforms build and run. |
| **3** | JS/TS API + codegen | Add new TurboModule methods. Remove `inputDeviceId`/`outputDeviceId` from existing methods. Run codegen. TS compiles. |
| **4** | TurboModule bridge wiring | Wire new native methods on both platforms. End-to-end calls work. |
| **5** | Module lifecycle | `invalidate` on both platforms calls `coordinator.resetAll()`. |
| **6** | Example app + docs | Update example screens. Update API docs. |
| **7** | Device matrix testing | iOS matrix (§8.2) + Android matrix (§8.3). Fix issues found. |

---

## 10. Definition of Done

1. **No direct session manipulation in feature code**: iOS mic/PCM bridges contain zero `setCategory`/`setActive`/`overrideOutputAudioPort` calls. Android mic/PCM code contains zero `setPreferredDevice` calls (coordinator applies them).
2. **Owner-based lifecycle**: session stays active as long as ≥1 owner is registered. Deactivation (iOS) / focus release (Android) only on last owner release.
3. **Simultaneous mic+PCM stable**: reproducible in example Pipeline Showcase on both platforms.
4. **Global route API works**: `setPipelineAudioRoutePreference` changes effective route on both platforms; `getPipelineAudioSessionState` reports correct state.
5. **Clean teardown**: RN reload / module invalidate releases all owners and resets coordinator.
6. **Builds and codegen clean**: TS types compile, codegen runs, iOS and Android builds succeed.
7. **Device matrix**: all scenarios in §8.2 (iOS) and §8.3 (Android) pass.
