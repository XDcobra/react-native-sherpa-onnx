# AudioBuffer JSI / ArrayBuffer — Implementation Spec

> Detailed implementation plan derived from the high-level migration plan
> (`audiobuffer-jsi-external-arraybuffer-migration-plan.md`).
> Status: **READY FOR IMPLEMENTATION — all design decisions resolved.**

---

## Table of Contents

1. [Current Sample Transport Inventory](#1-current-sample-transport-inventory)
2. [Architecture Decision: Companion JSI Module](#2-architecture-decision-companion-jsi-module)
3. [New Public JS API Surface](#3-new-public-js-api-surface)
4. [Phase 1 — iOS Implementation (C++ direct)](#4-phase-1--ios-implementation-c-direct)
5. [Phase 2 — Android Implementation (C++ / JNI)](#5-phase-2--android-implementation-c--jni)
6. [Phase 3 — JS Wrapper & TypeScript API](#6-phase-3--js-wrapper--typescript-api)
7. [Phase 4 — Remove Legacy `number[]` APIs](#7-phase-4--remove-legacy-number-apis)
8. [Phase 5 — Event Path Migration](#8-phase-5--event-path-migration)
9. [Phase 6 — Documentation & Migration Guide](#9-phase-6--documentation--migration-guide)
10. [Copy vs. Zero-Copy Strategy](#10-copy-vs-zero-copy-strategy)
11. [Thread Safety](#11-thread-safety)
12. [Design Decisions (resolved)](#12-design-decisions-resolved)

---

## 1. Current Sample Transport Inventory

### 1.1 JS → Native (write samples)

| Function | Signature (TS) | Codegen Transport | Native Receiver |
|---|---|---|---|
| `createOfflineAudioBufferFromSamples` | `(samples: number[], sampleRate, channelCount?) → Promise<OfflineAudioBufferRef>` | `jsi::Array` → ObjC `NSArray<NSNumber*>` / Kotlin `ReadableArray` | iOS: `NSArray` → `std::vector<float>` → `PaOfflineEntry`; Android: `ReadableArray` → `FloatArray` → `OfflineEntry.InMemory` |
| `appendSamplesToLiveAudioBuffer` | `(liveBufferId, samples: number[], sampleRate) → Promise<void>` | Same as above | iOS: → `PaLiveEntry::appendSamples`; Android: → `LiveEntry.appendSamples` |

### 1.2 Native → JS (read samples)

| Function | Signature (TS) | Codegen Transport | Native Source |
|---|---|---|---|
| `getLiveAudioBufferSamplesSlice` | `(liveBufferId, startFrame, frameCount) → Promise<number[]>` | `NSMutableArray<NSNumber*>` / Kotlin `WritableArray` → `jsi::Array` | iOS: `PaLiveEntry::getSamplesSlice`; Android: `LiveEntry.getSamplesSlice` |
| Event `pipelineLiveAudioChunk` | `{ ..., samples?: number[] }` | `NSDictionary` / Kotlin `WritableMap` → serialized `jsi::Object` | iOS: `for(float s : samples) [arr addObject:@(s)]`; Android: `for(s in samples) arr.pushDouble(s.toDouble())` |

### 1.3 Missing (to be added for consistency)

| Function | Description |
|---|---|
| `getOfflineAudioBufferSamplesSlice` | Read samples slice from offline buffer — analog to `getLiveAudioBufferSamplesSlice` |

### 1.4 Performance Bottlenecks

- **Per-element boxing**: Each `float` ↔ `NSNumber*` / `Double` / `jsi::Value` conversion
- **Codegen `jsi::Array`**: Element-by-element construction/reading through `jsi::Value`
- **Event serialization**: `samples` array in events goes through full RN event serialization
- **Memory**: Large `number[]` arrays allocate in both native and JS heaps simultaneously
- **GC pressure**: Huge JS arrays trigger garbage collection stalls

---

## 2. Architecture Decision: Companion JSI Module

### 2.1 Why Not Convert the Entire TurboModule to C++?

The existing `SherpaOnnxModule` has 50+ methods across STT, TTS, enhancement, audio pipeline, file helpers, etc. Converting everything to a pure C++ TurboModule is impractical.

### 2.2 Chosen Approach: JSI Host Functions via Auto-Install

**Pattern**: Install synchronous JSI host functions into `global.__SherpaOnnxJSI` **automatically during TurboModule initialization**. This is the established pattern used by react-native-mmkv, react-native-worklets-core, vision-camera, etc.

**JSI install happens automatically** in the TurboModule constructor / `init` on both platforms. No explicit `installJSI()` call is required by the SDK consumer. A public `installJSI()` method exists as fallback for rare edge cases where the runtime isn't ready during module init (e.g. custom React Native host configurations).

**Flow**:
```
1. App starts → RN loads SherpaOnnxModule (TurboModule)
2. Module init → native auto-installs global.__SherpaOnnxJSI (if jsi::Runtime available)
3. JS calls global.__SherpaOnnxJSI.getOfflineBufferSamples(bufferId, start, count)
       │
       ▼
     jsi::HostFunction (C++, runs synchronously on JS thread)
       │
       ├─ iOS:  direct C++ access to PaOfflineEntry.samples / PaLiveEntry ring
       │
       └─ Android: JNI → Kotlin PipelineAudioRegistry → FloatArray → memcpy to ArrayBuffer
```

**Key properties**:
- **Synchronous**: No Promise overhead, no async bridge hop
- **ArrayBuffer-native**: JSI creates `jsi::ArrayBuffer` directly — `Float32Array` view in JS
- **Zero-config**: SDK consumer never calls `installJSI()` under normal operation
- **All sample-transport functions are synchronous** — no `Promise` returns

### 2.3 Minimum React Native Version

`jsi::ArrayBuffer` with `MutableBuffer` requires RN ≥ 0.73 (stable JSI). This is a **breaking change**.

**Action**: Set `"react-native": ">=0.73.0"` in `peerDependencies`. No fallback for older versions.

### 2.4 File Layout (new files)

```
ios/
  audiobuffer/
    SherpaOnnxJSI.h          — C++ JSI function declarations + OwnedBuffer
    SherpaOnnxJSI.cpp        — C++ JSI function implementations (iOS, direct PaRegistry access)
    SherpaOnnx+JSI.mm        — ObjC++ install bridge (gets jsi::Runtime, calls installJSIBindings)

android/src/main/cpp/jni/audiobuffer/
  SherpaOnnxJSI.h            — C++ JSI function declarations (same as iOS)
  SherpaOnnxJSI.cpp          — C++ JSI function implementations (Android, JNI→Kotlin)
  SherpaOnnxJSIInstall.cpp   — JNI entry point called from Kotlin to install JSI bindings

src/
  audiobuffer/jsi.ts          — declare global.__SherpaOnnxJSI typings, isJSIAvailable()
```

---

## 3. New Public JS API Surface

### 3.1 Complete TypeScript Signatures

All sample-transport functions are **synchronous** (no `Promise`). They run as JSI host functions directly on the JS thread.

```typescript
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
  LiveAudioBufferRecordingSource,
  LiveAudioBufferIdSource,
} from 'react-native-sherpa-onnx/audiobuffer';

// ── Offline Buffer ──────────────────────────────────────────────

/**
 * Create an offline audio buffer from Float32 PCM samples.
 *
 * Synchronous JSI path: copies samples from the Float32Array's underlying
 * ArrayBuffer into a native PaOfflineEntry / OfflineEntry.InMemory.
 * Returns immediately with buffer metadata and branded handle.
 *
 * @param samples   - Interleaved Float32 PCM samples.
 * @param sampleRate - Sample rate in Hz (e.g. 16000, 44100).
 * @param channelCount - Number of channels (default: 1).
 * @returns Strongly-typed reference with metadata and branded OfflineBufferHandle.
 * @throws If JSI bindings are not installed.
 */
export function createOfflineAudioBufferFromSamples(
  samples: Float32Array,
  sampleRate: number,
  channelCount?: number,
): OfflineAudioBufferRef;

/**
 * Read a contiguous slice of Float32 PCM samples from an offline buffer.
 *
 * Only supports in-memory offline buffers (OfflineEntry.InMemory / PaOfflineEntry).
 * Throws for file-backed entries.
 *
 * @param offlineBufferId - Handle or id of the offline buffer.
 * @param startFrame - Zero-based start frame index.
 * @param frameCount - Number of frames (samples per channel) to read.
 * @returns Float32Array view over a copied ArrayBuffer.
 * @throws BUFFER_NOT_FOUND | BUFFER_NOT_IN_MEMORY | OUT_OF_RANGE
 */
export function getOfflineAudioBufferSamplesSlice(
  offlineBufferId: OfflineBufferHandle | string,
  startFrame: number,
  frameCount: number,
): Float32Array;

// ── Live Buffer ─────────────────────────────────────────────────

/**
 * Append Float32 PCM samples to a live audio buffer.
 *
 * Synchronous JSI path: copies samples from the Float32Array into the native
 * live buffer's ring. Auto-resamples if sampleRate differs from the buffer's rate.
 *
 * @param liveBufferId - Recording-state live buffer handle or id.
 * @param samples - Interleaved Float32 PCM samples.
 * @param sampleRate - Sample rate of the provided samples.
 * @throws BUFFER_NOT_FOUND | BUFFER_NOT_RECORDING
 */
export function appendSamplesToLiveAudioBuffer(
  liveBufferId: LiveAudioBufferRecordingSource,
  samples: Float32Array,
  sampleRate: number,
): void;

/**
 * Read a contiguous slice of Float32 PCM samples from a live buffer's ring.
 *
 * Works on both recording and finished live buffers.
 *
 * @param liveBufferId - Live buffer handle or id.
 * @param startFrame - Zero-based start frame in the ring.
 * @param frameCount - Number of frames to read.
 * @returns Float32Array view over a copied ArrayBuffer.
 * @throws BUFFER_NOT_FOUND
 */
export function getLiveAudioBufferSamplesSlice(
  liveBufferId: LiveAudioBufferIdSource,
  startFrame: number,
  frameCount: number,
): Float32Array;

/**
 * Manually trigger JSI bindings installation.
 *
 * Under normal operation this is never needed — bindings are installed
 * automatically during TurboModule init. Use only as fallback if the runtime
 * was not available during module construction (custom host configurations).
 *
 * @returns true if bindings are (now) installed, false on failure.
 */
export function installJSI(): boolean;
```

### 3.2 Breaking Changes Summary

| Removed / Changed | Replacement | Nature of Change |
|---|---|---|
| `createOfflineAudioBufferFromSamples(samples: number[], ...) → Promise<…>` | `createOfflineAudioBufferFromSamples(samples: Float32Array, ...) → OfflineAudioBufferRef` | `number[]`→`Float32Array`, async→sync |
| `appendSamplesToLiveAudioBuffer(..., samples: number[], ...) → Promise<void>` | `appendSamplesToLiveAudioBuffer(..., samples: Float32Array, ...) → void` | `number[]`→`Float32Array`, async→sync |
| `getLiveAudioBufferSamplesSlice(...) → Promise<number[]>` | `getLiveAudioBufferSamplesSlice(...) → Float32Array` | `Promise<number[]>`→sync `Float32Array` |
| *(does not exist)* | `getOfflineAudioBufferSamplesSlice(...)` | New function |
| Event `samples?: number[]` field | **Removed from events** — pull via `getLiveAudioBufferSamplesSlice()` | Breaking: no more samples in events |
| `emitAppendedSamples` creation option | **Removed** | Breaking: option deleted |
| `peerDependencies["react-native"]` = `"*"` | `">=0.73.0"` | Minimum version enforced |

### 3.3 JSI Global Type Declaration

```typescript
// src/audiobuffer/jsi.ts

declare global {
  var __SherpaOnnxJSI:
    | {
        /**
         * Read a slice of float32 samples from an offline buffer.
         * Returns an ArrayBuffer of raw float32 bytes (length = frameCount * 4).
         * Throws if buffer not found, not in-memory, or out of range.
         */
        getOfflineBufferSamples(
          bufferId: string,
          startFrame: number,
          frameCount: number,
        ): ArrayBuffer;

        /**
         * Create an offline buffer from float32 PCM samples.
         * Takes the Float32Array's .buffer (ArrayBuffer).
         * Returns a JSON string: '{"bufferId":"off_xxx","kind":"offlinePcmBuffer",...}'.
         */
        createOfflineFromSamples(
          samples: ArrayBuffer,
          sampleRate: number,
          channelCount: number,
        ): string;

        /**
         * Read a slice of float32 samples from a live buffer's ring.
         * Returns an ArrayBuffer of raw float32 bytes.
         */
        getLiveBufferSamples(
          bufferId: string,
          startFrame: number,
          frameCount: number,
        ): ArrayBuffer;

        /**
         * Append float32 PCM samples to a live audio buffer.
         * Takes the Float32Array's .buffer (ArrayBuffer).
         */
        appendSamplesToLive(
          liveBufferId: string,
          samples: ArrayBuffer,
          sampleRate: number,
        ): void;
      }
    | undefined;
}

/**
 * Returns true if the JSI bindings are installed and ready.
 * Under normal operation, this is always true after module load.
 */
export function isJSIAvailable(): boolean {
  return globalThis.__SherpaOnnxJSI != null;
}
```

### 3.4 Error Codes

JSI host functions throw `jsi::JSError` (appears as a regular JS `Error` in catch blocks). Errors use structured codes for programmatic handling:

| Code | Thrown By | Meaning |
|---|---|---|
| `JSI_NOT_INSTALLED` | JS wrapper | `global.__SherpaOnnxJSI` is undefined |
| `BUFFER_NOT_FOUND` | All functions | Buffer ID is not registered in native registry |
| `BUFFER_NOT_IN_MEMORY` | `getOfflineBufferSamples` | Offline buffer is file-backed, not in-memory |
| `BUFFER_NOT_RECORDING` | `appendSamplesToLive` | Live buffer is in `finished` state |
| `INVALID_ARGS` | All functions | Wrong argument count or type |

---

## 4. Phase 1 — iOS Implementation (C++ direct)

### 4.1 Auto-Install in Module Init

JSI bindings are installed automatically during `SherpaOnnx` module init. The `RCTCxxBridge` pattern (already used by the onnxruntime module in this project) provides access to `jsi::Runtime`:

```objc
// ios/audiobuffer/SherpaOnnx+JSI.mm

#import "SherpaOnnx.h"
#import <React/RCTBridge+Private.h>
#import <jsi/jsi.h>
#import "SherpaOnnxJSI.h"

@implementation SherpaOnnx (JSI)

/// Called automatically from SherpaOnnx init to install JSI bindings.
- (void)autoInstallJSI {
  RCTCxxBridge *cxxBridge = (RCTCxxBridge *)self.bridge;
  if (!cxxBridge || !cxxBridge.runtime) return;
  auto &runtime = *(facebook::jsi::Runtime *)cxxBridge.runtime;
  sherpa::installJSIBindings(runtime);
}

/// TurboModule fallback: explicit install from JS.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(installJSI) {
  RCTCxxBridge *cxxBridge = (RCTCxxBridge *)self.bridge;
  if (!cxxBridge || !cxxBridge.runtime) return @false;
  auto &runtime = *(facebook::jsi::Runtime *)cxxBridge.runtime;
  sherpa::installJSIBindings(runtime);
  return @true;
}

@end
```

The existing `SherpaOnnx.mm` `init` method calls `[self autoInstallJSI]` after `[super initWithDisabledObservation]`.

### 4.2 `OwnedBuffer` — Shared MutableBuffer Implementation

```cpp
// ios/audiobuffer/SherpaOnnxJSI.h (also duplicated in android/src/main/cpp/jni/audiobuffer/)

#pragma once
#include <jsi/jsi.h>
#include <vector>

namespace sherpa {

/// MutableBuffer backed by a std::vector<uint8_t>.
/// Passed to jsi::ArrayBuffer for ownership transfer.
class OwnedBuffer : public facebook::jsi::MutableBuffer {
public:
  explicit OwnedBuffer(size_t size) : buf_(size) {}
  size_t size() const override { return buf_.size(); }
  uint8_t *data() override { return buf_.data(); }
private:
  std::vector<uint8_t> buf_;
};

/// Install all JSI host functions on global.__SherpaOnnxJSI.
/// Idempotent: calling twice is a no-op (overwrites the same global).
void installJSIBindings(facebook::jsi::Runtime &rt);

} // namespace sherpa
```

### 4.3 JSI Host Functions — iOS (SherpaOnnxJSI.cpp)

```cpp
// ios/audiobuffer/SherpaOnnxJSI.cpp

#include "SherpaOnnxJSI.h"
#include "PaRegistry.h"   // C++ singleton registry
#include <string>
#include <cstring>

using namespace facebook;

namespace sherpa {

// ── getOfflineBufferSamples(bufferId, startFrame, frameCount) → ArrayBuffer ──

static jsi::Value jsiGetOfflineSamplesSlice(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] getOfflineBufferSamples requires 3 arguments");

  auto bufferId = args[0].asString(rt).utf8(rt);
  int startFrame = static_cast<int>(args[1].asNumber());
  int frameCount = static_cast<int>(args[2].asNumber());

  auto *entry = PaRegistry::shared().getOffline(bufferId);
  if (!entry)
    throw jsi::JSError(rt, "[BUFFER_NOT_FOUND] " + bufferId);

  // V1: only in-memory buffers supported
  if (!entry->isInMemory())
    throw jsi::JSError(rt, "[BUFFER_NOT_IN_MEMORY] " + bufferId);

  const auto &samples = entry->samples;
  int totalSamples = static_cast<int>(samples.size());
  int clampedStart = std::max(0, std::min(startFrame, totalSamples));
  int available = std::min(frameCount, totalSamples - clampedStart);

  if (available <= 0) {
    auto buf = std::make_shared<OwnedBuffer>(0);
    return jsi::ArrayBuffer(rt, std::move(buf));
  }

  size_t byteLen = static_cast<size_t>(available) * sizeof(float);
  auto buf = std::make_shared<OwnedBuffer>(byteLen);
  std::memcpy(buf->data(), samples.data() + clampedStart, byteLen);
  return jsi::ArrayBuffer(rt, std::move(buf));
}

// ── createOfflineFromSamples(samplesAB, sampleRate, channelCount) → JSON string ──

static jsi::Value jsiCreateOfflineFromSamples(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] createOfflineFromSamples requires 3 arguments");

  auto ab = args[0].asObject(rt).getArrayBuffer(rt);
  int sampleRate = static_cast<int>(args[1].asNumber());
  int channelCount = static_cast<int>(args[2].asNumber());
  if (channelCount <= 0) channelCount = 1;

  size_t byteLen = ab.size(rt);
  size_t numSamples = byteLen / sizeof(float);

  // Copy from ArrayBuffer into a new vector<float>
  std::vector<float> pcm(numSamples);
  std::memcpy(pcm.data(), ab.data(rt), byteLen);

  // Register in native PaRegistry
  auto info = PaRegistry::shared().createOfflineFromSamples(
      std::move(pcm), sampleRate, channelCount);

  // Return JSON string with OfflineAudioBufferInfo fields
  // (parsed in JS wrapper to produce OfflineAudioBufferRef)
  return jsi::String::createFromUtf8(rt, info.toJSON());
}

// ── getLiveBufferSamples(bufferId, startFrame, frameCount) → ArrayBuffer ──

static jsi::Value jsiGetLiveSamplesSlice(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] getLiveBufferSamples requires 3 arguments");

  auto bufferId = args[0].asString(rt).utf8(rt);
  int startFrame = static_cast<int>(args[1].asNumber());
  int frameCount = static_cast<int>(args[2].asNumber());

  auto *entry = PaRegistry::shared().getLive(bufferId);
  if (!entry)
    throw jsi::JSError(rt, "[BUFFER_NOT_FOUND] " + bufferId);

  // Lock the live entry's mutex (ring may be written by mic/worker threads)
  std::lock_guard<std::mutex> lock(entry->mtx);
  auto slice = entry->getSamplesSlice(startFrame, frameCount);

  if (slice.empty()) {
    auto buf = std::make_shared<OwnedBuffer>(0);
    return jsi::ArrayBuffer(rt, std::move(buf));
  }

  size_t byteLen = slice.size() * sizeof(float);
  auto buf = std::make_shared<OwnedBuffer>(byteLen);
  std::memcpy(buf->data(), slice.data(), byteLen);
  return jsi::ArrayBuffer(rt, std::move(buf));
}

// ── appendSamplesToLive(bufferId, samplesAB, sampleRate) → void ──

static jsi::Value jsiAppendSamplesToLive(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] appendSamplesToLive requires 3 arguments");

  auto bufferId = args[0].asString(rt).utf8(rt);
  auto ab = args[1].asObject(rt).getArrayBuffer(rt);
  int sampleRate = static_cast<int>(args[2].asNumber());

  auto *entry = PaRegistry::shared().getLive(bufferId);
  if (!entry)
    throw jsi::JSError(rt, "[BUFFER_NOT_FOUND] " + bufferId);
  if (entry->state != PaLiveEntry::RECORDING)
    throw jsi::JSError(rt, "[BUFFER_NOT_RECORDING] " + bufferId);

  size_t byteLen = ab.size(rt);
  size_t numSamples = byteLen / sizeof(float);
  const float *data = reinterpret_cast<const float *>(ab.data(rt));

  entry->appendSamples(data, numSamples, sampleRate, "append");
  return jsi::Value::undefined();
}

// ── Install ──

void installJSIBindings(jsi::Runtime &rt) {
  auto jsiObj = jsi::Object(rt);

  jsiObj.setProperty(rt, "getOfflineBufferSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "getOfflineBufferSamples"),
      3, jsiGetOfflineSamplesSlice));

  jsiObj.setProperty(rt, "createOfflineFromSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "createOfflineFromSamples"),
      3, jsiCreateOfflineFromSamples));

  jsiObj.setProperty(rt, "getLiveBufferSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "getLiveBufferSamples"),
      3, jsiGetLiveSamplesSlice));

  jsiObj.setProperty(rt, "appendSamplesToLive",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "appendSamplesToLive"),
      3, jsiAppendSamplesToLive));

  rt.global().setProperty(rt, "__SherpaOnnxJSI", std::move(jsiObj));
}

} // namespace sherpa
```

### 4.4 iOS Registry Refactoring: `PaRegistry`

Currently `PaOfflineEntry` and `PaLiveEntry` are C++ structs stored in `NSMutableDictionary` inside `SherpaOnnx+PipelineAudio.mm`. The JSI functions need direct C++ access.

**Solution**: Introduce a C++ singleton `PaRegistry` that owns all entries by ID. `SherpaOnnx+PipelineAudio.mm` delegates to it. JSI code accesses it directly — no ObjC overhead.

```cpp
// ios/PaRegistry.h

#pragma once
#include "PaLiveEntry.h"   // existing C++ struct
#include <unordered_map>
#include <mutex>
#include <memory>
#include <string>

struct PaOfflineEntryInfo {
  std::string bufferId;
  std::string kind;       // "offlinePcmBuffer"
  std::string state;      // "immutable"
  int sampleRate;
  int channelCount;
  int numSamples;
  double durationMs;

  std::string toJSON() const;
};

class PaRegistry {
public:
  static PaRegistry &shared();

  // ── Offline ──
  PaOfflineEntry *getOffline(const std::string &id);
  PaOfflineEntryInfo createOfflineFromSamples(
      std::vector<float> samples, int sampleRate, int channelCount);
  void removeOffline(const std::string &id);

  // ── Live ──
  PaLiveEntry *getLive(const std::string &id);
  void registerLive(const std::string &id, std::shared_ptr<PaLiveEntry> entry);
  void removeLive(const std::string &id);

  void clear();

private:
  PaRegistry() = default;
  std::mutex mtx_;
  std::unordered_map<std::string, std::unique_ptr<PaOfflineEntry>> offline_;
  std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> live_;
};
```

### 4.5 Files to Create/Modify (iOS)

| File | Action | Purpose |
|---|---|---|
| `ios/audiobuffer/SherpaOnnxJSI.h` | Create | JSI function declarations + `OwnedBuffer` class |
| `ios/audiobuffer/SherpaOnnxJSI.cpp` | Create | JSI function implementations (4 host functions) |
| `ios/audiobuffer/SherpaOnnx+JSI.mm` | Create | ObjC++ auto-install + `installJSI` fallback |
| `ios/PaRegistry.h` | Create | C++ singleton registry header |
| `ios/PaRegistry.cpp` | Create | C++ singleton registry implementation |
| `ios/SherpaOnnx.mm` | Modify | Call `[self autoInstallJSI]` in `init` |
| `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm` | Modify | Delegate to `PaRegistry` for all entry storage |
| `SherpaOnnx.podspec` | Modify | Add new source files |

---

## 5. Phase 2 — Android Implementation (C++ / JNI)

### 5.1 Auto-Install via Kotlin Module Init

The Kotlin module calls a JNI method during `init` to install JSI bindings. The Android `PipelineAudioRegistry` stays in Kotlin — JSI functions call into it via JNI.

```kotlin
// SherpaOnnxModule.kt

init {
  // ... existing library loads ...
  // Auto-install JSI bindings
  try {
    val jsContext = reactApplicationContext
      .catalystInstance
      .javaScriptContextHolder
      .get()
    if (jsContext != 0L) {
      nativeInstallJSI(jsContext, PipelineAudioRegistry)
    }
  } catch (_: Exception) {
    // Runtime not available yet — user can call installJSI() later
  }
}

// Fallback TurboModule method
override fun installJSI(): Boolean {
  return try {
    val jsContext = reactApplicationContext
      .catalystInstance
      .javaScriptContextHolder
      .get()
    if (jsContext == 0L) return false
    nativeInstallJSI(jsContext, PipelineAudioRegistry)
    true
  } catch (_: Exception) {
    false
  }
}

private external fun nativeInstallJSI(jsiRuntimePointer: Long, registry: Any)
```

### 5.2 JNI Install Entry Point

```cpp
// android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSIInstall.cpp

#include <jni.h>
#include <jsi/jsi.h>
#include "SherpaOnnxJSI.h"

extern "C" JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeInstallJSI(
    JNIEnv *env, jobject /* thiz */, jlong runtimePtr, jobject registry)
{
  auto &rt = *reinterpret_cast<facebook::jsi::Runtime *>(runtimePtr);
  // Cache JNI references for later use by JSI host functions
  sherpa::cacheJNIReferences(env, registry);
  sherpa::installJSIBindings(rt);
}
```

### 5.3 Android JSI Host Functions (JNI→Kotlin)

```cpp
// android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSI.cpp

#include "SherpaOnnxJSI.h"
#include <jni.h>
#include <cstring>

using namespace facebook;

namespace sherpa {

// Cached JNI references (set during install)
static JavaVM *g_jvm = nullptr;
static jobject g_registryRef = nullptr;
static jmethodID g_getOfflineSamplesSliceMethod = nullptr;
static jmethodID g_getLiveSamplesSliceMethod = nullptr;
static jmethodID g_createOfflineFromFloatArrayMethod = nullptr;
static jmethodID g_appendSamplesToLiveMethod = nullptr;

static JNIEnv *getJNIEnv() {
  JNIEnv *env = nullptr;
  g_jvm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (!env) g_jvm->AttachCurrentThread(&env, nullptr);
  return env;
}

void cacheJNIReferences(JNIEnv *env, jobject registry) {
  env->GetJavaVM(&g_jvm);
  g_registryRef = env->NewGlobalRef(registry);

  jclass cls = env->GetObjectClass(registry);
  g_getOfflineSamplesSliceMethod = env->GetMethodID(cls,
      "getOfflineSamplesSliceJni",
      "(Ljava/lang/String;II)[F");
  g_getLiveSamplesSliceMethod = env->GetMethodID(cls,
      "getLiveSamplesSliceJni",
      "(Ljava/lang/String;II)[F");
  g_createOfflineFromFloatArrayMethod = env->GetMethodID(cls,
      "createOfflineFromFloatArrayJni",
      "([FII)Ljava/lang/String;");
  g_appendSamplesToLiveMethod = env->GetMethodID(cls,
      "appendSamplesToLiveJni",
      "(Ljava/lang/String;[FI)V");
  env->DeleteLocalRef(cls);
}

// ── getOfflineBufferSamples → ArrayBuffer ──

static jsi::Value jsiGetOfflineSamplesSlice(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] getOfflineBufferSamples requires 3 arguments");

  auto bufferId = args[0].asString(rt).utf8(rt);
  int startFrame = static_cast<int>(args[1].asNumber());
  int frameCount = static_cast<int>(args[2].asNumber());

  JNIEnv *env = getJNIEnv();
  jstring jBufferId = env->NewStringUTF(bufferId.c_str());
  auto jArr = (jfloatArray)env->CallObjectMethod(
      g_registryRef, g_getOfflineSamplesSliceMethod,
      jBufferId, startFrame, frameCount);
  env->DeleteLocalRef(jBufferId);

  if (env->ExceptionCheck()) {
    env->ExceptionDescribe();
    env->ExceptionClear();
    throw jsi::JSError(rt, "[BUFFER_NOT_FOUND] " + bufferId);
  }
  if (!jArr)
    throw jsi::JSError(rt, "[BUFFER_NOT_FOUND] " + bufferId);

  jsize len = env->GetArrayLength(jArr);
  size_t byteLen = static_cast<size_t>(len) * sizeof(float);
  auto buf = std::make_shared<OwnedBuffer>(byteLen);
  env->GetFloatArrayRegion(jArr, 0, len, reinterpret_cast<float *>(buf->data()));
  env->DeleteLocalRef(jArr);

  return jsi::ArrayBuffer(rt, std::move(buf));
}

// ── createOfflineFromSamples → JSON string ──

static jsi::Value jsiCreateOfflineFromSamples(
    jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count)
{
  if (count < 3)
    throw jsi::JSError(rt, "[INVALID_ARGS] createOfflineFromSamples requires 3 arguments");

  auto ab = args[0].asObject(rt).getArrayBuffer(rt);
  int sampleRate = static_cast<int>(args[1].asNumber());
  int channelCount = static_cast<int>(args[2].asNumber());
  if (channelCount <= 0) channelCount = 1;

  size_t byteLen = ab.size(rt);
  jsize numSamples = static_cast<jsize>(byteLen / sizeof(float));

  JNIEnv *env = getJNIEnv();
  jfloatArray jArr = env->NewFloatArray(numSamples);
  env->SetFloatArrayRegion(jArr, 0, numSamples,
      reinterpret_cast<const float *>(ab.data(rt)));

  auto jResult = (jstring)env->CallObjectMethod(
      g_registryRef, g_createOfflineFromFloatArrayMethod,
      jArr, sampleRate, channelCount);
  env->DeleteLocalRef(jArr);

  if (env->ExceptionCheck()) {
    env->ExceptionDescribe();
    env->ExceptionClear();
    throw jsi::JSError(rt, "[INVALID_ARGS] createOfflineFromSamples failed");
  }

  const char *cStr = env->GetStringUTFChars(jResult, nullptr);
  std::string result(cStr);
  env->ReleaseStringUTFChars(jResult, cStr);
  env->DeleteLocalRef(jResult);

  return jsi::String::createFromUtf8(rt, result);
}

// ── getLiveBufferSamples / appendSamplesToLive → same pattern ──
// (analogous to offline, calling g_getLiveSamplesSliceMethod / g_appendSamplesToLiveMethod)

// ── Install (identical to iOS) ──

void installJSIBindings(jsi::Runtime &rt) {
  auto jsiObj = jsi::Object(rt);

  jsiObj.setProperty(rt, "getOfflineBufferSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "getOfflineBufferSamples"),
      3, jsiGetOfflineSamplesSlice));

  jsiObj.setProperty(rt, "createOfflineFromSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "createOfflineFromSamples"),
      3, jsiCreateOfflineFromSamples));

  jsiObj.setProperty(rt, "getLiveBufferSamples",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "getLiveBufferSamples"),
      3, jsiGetLiveSamplesSlice));

  jsiObj.setProperty(rt, "appendSamplesToLive",
    jsi::Function::createFromHostFunction(rt,
      jsi::PropNameID::forAscii(rt, "appendSamplesToLive"),
      3, jsiAppendSamplesToLive));

  rt.global().setProperty(rt, "__SherpaOnnxJSI", std::move(jsiObj));
}

} // namespace sherpa
```

### 5.4 Kotlin JNI Helper Methods

```kotlin
// PipelineAudioRegistry.kt — new methods exposed to C++ via JNI

/**
 * Read a sample slice from an in-memory offline buffer.
 * Called from C++ JSI host function via JNI. Returns FloatArray for bulk memcpy.
 * @throws IllegalArgumentException if buffer not found
 * @throws UnsupportedOperationException if buffer is file-backed
 */
fun getOfflineSamplesSliceJni(bufferId: String, startFrame: Int, frameCount: Int): FloatArray {
  val entry = offlineBuffers[bufferId]
    ?: throw IllegalArgumentException("[BUFFER_NOT_FOUND] $bufferId")
  return when (entry) {
    is OfflineEntry.InMemory -> {
      val end = minOf(startFrame + frameCount, entry.samples.size)
      if (startFrame >= end) FloatArray(0)
      else entry.samples.copyOfRange(startFrame, end)
    }
    else -> throw UnsupportedOperationException("[BUFFER_NOT_IN_MEMORY] $bufferId")
  }
}

/**
 * Read a sample slice from a live buffer ring.
 * Called from C++ JSI host function via JNI.
 */
fun getLiveSamplesSliceJni(bufferId: String, startFrame: Int, frameCount: Int): FloatArray {
  val entry = liveBuffers[bufferId]
    ?: throw IllegalArgumentException("[BUFFER_NOT_FOUND] $bufferId")
  return entry.getSamplesSlice(startFrame, frameCount)
}

/**
 * Create an offline buffer from a FloatArray.
 * Called from C++ JSI host function via JNI.
 * @return JSON string with OfflineAudioBufferInfo fields.
 */
fun createOfflineFromFloatArrayJni(samples: FloatArray, sampleRate: Int, channelCount: Int): String {
  val entry = createOfflineFromSamples(samples, sampleRate, channelCount)
  return entry.toJSON()
}

/**
 * Append float samples to a live buffer.
 * Called from C++ JSI host function via JNI.
 */
fun appendSamplesToLiveJni(bufferId: String, samples: FloatArray, sampleRate: Int) {
  val entry = liveBuffers[bufferId]
    ?: throw IllegalArgumentException("[BUFFER_NOT_FOUND] $bufferId")
  if (entry.state != LiveEntry.State.RECORDING)
    throw IllegalStateException("[BUFFER_NOT_RECORDING] $bufferId")
  entry.appendSamples(samples, sampleRate, source = LIVE_APPEND_SOURCE_APPEND)
}
```

### 5.5 JNI Performance Characteristics

| Operation | Cost |
|---|---|
| `env->GetFloatArrayRegion(arr, 0, N, dst)` | Single memcpy of N×4 bytes |
| Current: iterate `ReadableArray` N times | N × boxing + N × `getDouble()` + N × `jsi::Value` construction |
| **Improvement factor** | ~10–50× for large N (eliminates per-element overhead) |

### 5.6 Files to Create/Modify (Android)

| File | Action | Purpose |
|---|---|---|
| `android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSI.h` | Create | JSI declarations + `OwnedBuffer` + `cacheJNIReferences` |
| `android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSI.cpp` | Create | JSI host function implementations (JNI→Kotlin) |
| `android/src/main/cpp/jni/audiobuffer/SherpaOnnxJSIInstall.cpp` | Create | JNI `nativeInstallJSI` entry point |
| `android/src/main/cpp/CMakeLists.txt` | Modify | Add new source files, include JSI headers path |
| `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt` | Modify | Auto-install in `init`, `installJSI()` fallback, `external fun nativeInstallJSI` |
| `android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt` | Modify | Add `*Jni` methods for JSI access |

---

## 6. Phase 3 — JS Wrapper & TypeScript API

### 6.1 JS Wrapper Implementations (`src/audiobuffer/index.ts`)

All sample-transport functions delegate to `global.__SherpaOnnxJSI` directly. The public functions resolve branded handles to raw string IDs, then call the JSI layer synchronously, and wrap `ArrayBuffer` returns into `Float32Array`.

```typescript
// ── createOfflineAudioBufferFromSamples ──

export function createOfflineAudioBufferFromSamples(
  samples: Float32Array,
  sampleRate: number,
  channelCount?: number,
): OfflineAudioBufferRef {
  const jsi = requireJSI();
  const json = jsi.createOfflineFromSamples(
    samples.buffer,
    sampleRate,
    channelCount ?? 1,
  );
  const info = JSON.parse(json) as OfflineAudioBufferInfo;
  return {
    info,
    bufferId: info.bufferId as OfflineBufferHandle,
  };
}

// ── getOfflineAudioBufferSamplesSlice ──

export function getOfflineAudioBufferSamplesSlice(
  offlineBufferId: OfflineBufferHandle | string,
  startFrame: number,
  frameCount: number,
): Float32Array {
  const jsi = requireJSI();
  const id = resolveOfflineAudioBufferId(offlineBufferId);
  const ab = jsi.getOfflineBufferSamples(id, startFrame, frameCount);
  return new Float32Array(ab);
}

// ── appendSamplesToLiveAudioBuffer ──

export function appendSamplesToLiveAudioBuffer(
  liveBufferId: LiveAudioBufferRecordingSource,
  samples: Float32Array,
  sampleRate: number,
): void {
  const jsi = requireJSI();
  const id = resolveLiveAudioBufferId(liveBufferId);
  jsi.appendSamplesToLive(id, samples.buffer, sampleRate);
}

// ── getLiveAudioBufferSamplesSlice ──

export function getLiveAudioBufferSamplesSlice(
  liveBufferId: LiveAudioBufferIdSource,
  startFrame: number,
  frameCount: number,
): Float32Array {
  const jsi = requireJSI();
  const id = resolveLiveAudioBufferId(liveBufferId);
  const ab = jsi.getLiveBufferSamples(id, startFrame, frameCount);
  return new Float32Array(ab);
}

// ── installJSI (public fallback) ──

export function installJSI(): boolean {
  if (isJSIAvailable()) return true;
  // Call native TurboModule fallback (synchronous)
  return getNative().installJSI() === true;
}

// ── Internal helper ──

function requireJSI(): NonNullable<typeof globalThis.__SherpaOnnxJSI> {
  const jsi = globalThis.__SherpaOnnxJSI;
  if (!jsi) {
    throw new Error(
      '[JSI_NOT_INSTALLED] SherpaOnnx JSI bindings not available. ' +
      'Ensure react-native >= 0.73 and module loaded correctly.',
    );
  }
  return jsi;
}
```

### 6.2 TurboModule Spec Change

```typescript
// src/NativeSherpaOnnx.ts — add to Spec interface:

/**
 * Install JSI bindings for high-performance sample transport.
 * Normally auto-installed during module init. Exposed as fallback.
 * Synchronous (no Promise return).
 */
installJSI(): boolean;
```

Remove from `NativeSherpaOnnx.ts`:
- `createOfflineAudioBufferFromSamples(samples: number[], sampleRate: number, channelCount?: number): Promise<{...}>`
- `appendSamplesToLiveAudioBuffer(liveBufferId: string, samples: number[], sampleRate: number): Promise<void>`
- `getLiveAudioBufferSamplesSlice(liveBufferId: string, startFrame: number, frameCount: number): Promise<number[]>`

### 6.3 Exports from `src/index.ts`

```typescript
// New exports
export {
  getOfflineAudioBufferSamplesSlice,
  installJSI,
  isJSIAvailable,
} from './audiobuffer';

// Changed signatures (same name, different types)
export {
  createOfflineAudioBufferFromSamples,  // now Float32Array, sync
  appendSamplesToLiveAudioBuffer,        // now Float32Array, sync
  getLiveAudioBufferSamplesSlice,        // now Float32Array, sync
} from './audiobuffer';
```

---

## 7. Phase 4 — Remove Legacy `number[]` APIs

All legacy `number[]` sample-transport methods are removed outright. No deprecation period.

### 7.1 TurboModule Spec Removal

Remove from `NativeSherpaOnnx.ts` Spec interface:
- `createOfflineAudioBufferFromSamples(samples: number[], ...)` — replaced by JSI
- `appendSamplesToLiveAudioBuffer(..., samples: number[], ...)` — replaced by JSI
- `getLiveAudioBufferSamplesSlice(...)` — replaced by JSI

### 7.2 Android Native Code Removal

| File | Action |
|---|---|
| `SherpaOnnxModule.kt` | Remove `override fun createOfflineAudioBufferFromSamples(...)`, `override fun appendSamplesToLiveAudioBuffer(...)`, `override fun getLiveAudioBufferSamplesSlice(...)` |
| `PipelineAudioRegistry.kt` | Remove `readableArrayToFloatArray()` helper |

### 7.3 iOS Native Code Removal

| File | Action |
|---|---|
| `SherpaOnnx+PipelineAudio.mm` | Remove `-(void)createOfflineAudioBufferFromSamples:sampleRate:channelCount:resolve:reject:` |
| `SherpaOnnx+PipelineAudio.mm` | Remove `-(void)appendSamplesToLiveAudioBuffer:samples:sampleRate:resolve:reject:` |
| `SherpaOnnx+PipelineAudio.mm` | Remove `-(void)getLiveAudioBufferSamplesSlice:startFrame:frameCount:resolve:reject:` |
| `SherpaOnnx+PipelineAudio.mm` | Remove `NSArray<NSNumber*>` → `std::vector<float>` conversion loops |

### 7.4 Codegen Regeneration

After spec removal, run codegen to regenerate `NativeSherpaOnnxSpec.java` (Android) and `SherpaOnnxSpec-generated.mm` / `SherpaOnnxSpecJSI.h` (iOS). The generated stubs for the removed methods will disappear.

---

## 8. Phase 5 — Event Path Migration

### 8.1 Decision: Remove `samples` from Events Entirely

The `samples?: number[]` field is removed from `pipelineLiveAudioChunk` events. SDK consumers use `getLiveAudioBufferSamplesSlice()` (synchronous JSI) from their event callback to pull samples on demand.

This eliminates:
- Per-element `float→NSNumber*→jsi::Value` / `float→Double→jsi::Value` serialization
- Duplicate memory (samples exist in both native ring and JS heap)
- GC pressure from large JS arrays in rapid event callbacks

### 8.2 TypeScript Type Changes

```typescript
// src/audiobuffer/types.ts — BEFORE:
export interface LiveAudioBufferFramesAppendedEvent {
  liveBufferId: string;
  source: LiveBufferAppendSource;
  sampleRate: number;
  frameCount: number;
  totalSamplesWritten: number;
  samples?: number[];  // ← REMOVE
}

// AFTER:
export interface LiveAudioBufferFramesAppendedEvent {
  liveBufferId: string;
  source: LiveBufferAppendSource;
  sampleRate: number;
  frameCount: number;
  totalSamplesWritten: number;
}
```

```typescript
// src/audiobuffer/types.ts — BEFORE:
export interface CreateLiveAudioBufferOptions {
  sampleRate: number;
  channelCount?: number;
  windowSeconds?: number;
  persistencePath?: string;
  persistenceFormat?: 'wav_pcm_s16le' | 'wav_pcm_float';  // ← REMOVED (always F32 WAV internally)
  emitAppendedEvents?: boolean;
  emitAppendedSamples?: boolean;  // ← REMOVE
  appendEventMinIntervalMs?: number;
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
  onError?: (event: LiveAudioBufferErrorEvent) => void;
}

// AFTER:
export interface CreateLiveAudioBufferOptions {
  sampleRate: number;
  channelCount?: number;
  windowSeconds?: number;
  persistencePath?: string;
  persistenceFormat?: 'wav_pcm_s16le' | 'wav_pcm_float';  // ← REMOVED (always F32 WAV internally)
  emitAppendedEvents?: boolean;
  appendEventMinIntervalMs?: number;
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
  onError?: (event: LiveAudioBufferErrorEvent) => void;
}
```

### 8.3 Native Event Changes

**Android (`LiveEntry.kt`):**
- Remove `pendingSampleChunks` list and merge logic in `buildPendingFramesAppendedEventLocked()`
- Remove `appendEventsIncludeSamples` flag
- `LiveFramesAppendedEvent.samples` field → removed
- Event `WritableMap` no longer includes `"samples"` key

**Android (`SherpaOnnxModule.kt`):**
- Remove the `event.samples?.let { ... arr.pushDouble(...) }` block from `emitPipelineLiveAudioChunk()`

**iOS (`PaLiveEntry`):**
- Remove `appendEventsIncludeSamples` flag
- Remove sample collection in `onFramesAppended` callback
- Event `NSDictionary` no longer includes `@"samples"` key

**iOS (`SherpaOnnx+PipelineAudio.mm`):**
- Remove `if (!samples.empty()) { ... }` block from event emission lambda

### 8.4 TurboModule Spec: `createLiveAudioBuffer`

Remove `emitAppendedSamples` from the options object in `NativeSherpaOnnx.ts`:

```typescript
// BEFORE:
createLiveAudioBuffer(options: {
  sampleRate: number;
  channelCount?: number;
  windowSeconds?: number;
  persistencePath?: string;
  persistenceFormat?: string;  // ← REMOVED (always F32 WAV internally)
  emitAppendedSamples?: boolean;  // ← REMOVE
  // ... rest
}): Promise<{...}>;

// AFTER (emitAppendedSamples removed):
createLiveAudioBuffer(options: {
  sampleRate: number;
  channelCount?: number;
  windowSeconds?: number;
  persistencePath?: string;
  persistenceFormat?: string;  // ← REMOVED (always F32 WAV internally)
  // ... rest
}): Promise<{...}>;
```

### 8.5 Usage Pattern After Migration

```typescript
const buf = await createLiveAudioBuffer({
  sampleRate: 16000,
  emitAppendedEvents: true,
  onFramesAppended: (event) => {
    // Pull samples synchronously via JSI — no bridge overhead
    const samples = getLiveAudioBufferSamplesSlice(
      event.liveBufferId,
      event.totalSamplesWritten - event.frameCount,
      event.frameCount,
    );
    // samples is Float32Array, directly usable
    processAudio(samples);
  },
});
```

---

## 9. Phase 6 — Documentation & Migration Guide

### 9.1 Files to Update

| File | Changes |
|---|---|
| `docs/audiobuffer-offline.md` | `Float32Array` signatures, `getOfflineAudioBufferSamplesSlice` API reference, power-user notice |
| `docs/audiobuffer-streaming.md` | `Float32Array` signatures, event changes (no `samples`), pull-based pattern, power-user notice |
| `docs/audio-conversion.md` | Cross-link to JSI sample transport for power users |

### 9.2 Migration Guide (new doc: `docs/migration/audiobuffer/audiobuffer-jsi-migration-guide.md`)

Structure:
1. **What changed** — `number[]` → `Float32Array`, async → sync, event samples removed
2. **Before / After** code examples for each function
3. **Minimum RN version** — `>=0.73.0`
4. **Event migration** — subscribe → pull pattern with `getLiveAudioBufferSamplesSlice`

### 9.3 Power-User Notice (placed in relevant docs)

```markdown
> **Performance notice**: Direct sample access via `Float32Array` is an
> advanced/power-user feature. For most workflows (TTS → file, STT from mic,
> enhancement → export), prefer the **pipeline-first** approach which keeps all
> audio in native buffers and never crosses the JS bridge with raw samples.
```

---

## 10. Copy vs. Zero-Copy Strategy

### 10.1 Read Path (native → JS)

All read operations produce a **copy**. This is safe, fast, and avoids use-after-free risks.

| Platform | Operation | Strategy | Cost (160K samples / 640KB) |
|---|---|---|---|
| iOS (offline) | memcpy from `PaOfflineEntry.samples` → `OwnedBuffer` | Copy | <0.1ms |
| iOS (live) | lock + memcpy from ring slice → `OwnedBuffer` | Copy | <0.1ms |
| Android (offline) | JNI `GetFloatArrayRegion` → `OwnedBuffer` | Copy | ~0.2ms (incl. JNI hop) |
| Android (live) | JNI `GetFloatArrayRegion` → `OwnedBuffer` | Copy | ~0.2ms (incl. JNI hop) |

Zero-copy (sharing native memory directly with JS via `shared_ptr`) is **not used** for V1:
- **Risk**: JS holds `ArrayBuffer` while native releases the buffer → use-after-free
- **Complexity**: Ref-counting across JS GC / native lifecycle boundaries
- **Not needed**: Copy of 640KB is <0.1ms — negligible vs. current ~15–50ms per-element overhead

### 10.2 Write Path (JS → native)

| Platform | Operation | Strategy |
|---|---|---|
| iOS | Read `ArrayBuffer::data()` → copy to `std::vector<float>` | Copy |
| Android | Read `ArrayBuffer::data()` → `SetFloatArrayRegion` → Kotlin `FloatArray` | Copy |

JS can modify or GC the `Float32Array` after the synchronous call returns. Native always owns its own copy.

### 10.3 Performance Comparison

For 10 seconds of 16kHz mono audio = 160,000 samples = 640KB:

| Path | Current (`number[]`) | New (`ArrayBuffer`) | Speedup |
|---|---|---|---|
| JS → Native write | ~15–50ms (160K `jsi::Value` constructions) | <0.1ms (single memcpy) | **150–500×** |
| Native → JS read | ~15–50ms (160K `NSNumber*` / `Double` boxing) | <0.2ms (memcpy + JNI hop) | **75–250×** |
| Event samples (per callback) | ~1–5ms per chunk (1600 samples) | **0ms** (no samples in event) | ∞ (eliminated) |

---

## 11. Thread Safety

### 11.1 JSI Functions Run on JS Thread

All JSI host functions execute synchronously on the **JS thread**. Single-threaded from JS perspective — no concurrent JSI calls.

However, native audio processing (mic capture, enhancement worker, STT feed) runs on **other threads** and mutates live buffer rings concurrently.

### 11.2 Required Synchronization

**iOS:**

| Buffer Type | Concurrency Risk | Lock Strategy |
|---|---|---|
| `PaOfflineEntry` (InMemory) | Immutable after creation | No lock needed |
| `PaLiveEntry` ring | Mic/worker thread writes concurrently | Use existing `std::mutex mtx` — acquire in JSI read & write paths |
| `PaRegistry` lookup maps | Module init / buffer create/destroy | `PaRegistry::mtx_` |

**Android:**

| Buffer Type | Concurrency Risk | Lock Strategy |
|---|---|---|
| `OfflineEntry.InMemory` | Immutable after creation (`@Volatile`) | No lock needed |
| `LiveEntry` ring | Mic/worker thread writes concurrently | Kotlin `getSamplesSlice` already acquires internal lock |
| `PipelineAudioRegistry` maps | Concurrent access from module + JSI | `ConcurrentHashMap` (existing) |

### 11.3 Latency Budget

Synchronous JSI functions block the JS thread:

| Operation | Expected Latency | Acceptable? |
|---|---|---|
| memcpy 640KB (10s @16kHz) | <0.1ms | Yes |
| JNI round-trip (Android) | ~0.2ms | Yes |
| Mutex acquisition (live buffer read during mic write) | <0.01ms typical | Yes |
| Worst case: 10M samples (10min @16kHz stereo) = 40MB | ~2ms memcpy | Acceptable |

---

## 12. Design Decisions (resolved)

All design questions have been resolved. This section records the decisions for reference.

| # | Question | Decision | Rationale |
|---|---|---|---|
| Q1 | `installJSI()` timing | **Automatic** in module init; public `installJSI()` as fallback | Zero-config for SDK consumers |
| Q2 | Event `samples` field | **Remove entirely** | Consumers pull via `getLiveAudioBufferSamplesSlice()` — eliminates serialization overhead |
| Q3 | Offline file-backed reads | **V1: InMemory only**; throw `BUFFER_NOT_IN_MEMORY` for file-backed | Simplicity; file-backed support added later if needed |
| Q4 | Android registry architecture | **Keep Kotlin**; add JNI getter methods | JNI hop (~0.2ms) negligible vs. current overhead; avoids invasive C++ refactor |
| Q5 | `createOfflineAudioBufferFromSamples` return | **Fully synchronous** | memcpy + registration <1ms for typical sizes |
| Q6 | Minimum RN version | **`react-native >= 0.73.0`** | Stable JSI + `jsi::ArrayBuffer`. Breaking change — no fallback. |
| Q7 | Public API type | **`Float32Array`** | Ergonomic; `new Float32Array(ab)` is a zero-copy view over `ArrayBuffer` |
| Q8 | JSI global name | **`global.__SherpaOnnxJSI`** | Double-underscore = internal. Namespace-scoped. |

---

## Implementation Order Summary

| Phase | Scope | Key Files |
|---|---|---|
| **Phase 1** | iOS: `PaRegistry`, JSI host functions, auto-install | `ios/PaRegistry.{h,cpp}`, `ios/audiobuffer/SherpaOnnxJSI.{h,cpp}`, `ios/audiobuffer/SherpaOnnx+JSI.mm`, `ios/SherpaOnnx.mm` (modify init) |
| **Phase 2** | Android: JNI getters, JSI host functions, auto-install | `android/.../audiobuffer/SherpaOnnxJSI.{h,cpp}`, `SherpaOnnxJSIInstall.cpp`, `PipelineAudioRegistry.kt` (add Jni methods), `SherpaOnnxModule.kt` (modify init) |
| **Phase 3** | JS wrapper, TS types, `jsi.ts`, public API | `src/audiobuffer/jsi.ts`, `src/audiobuffer/index.ts` (rewrite functions), `src/NativeSherpaOnnx.ts` (add `installJSI`, remove 3 legacy methods) |
| **Phase 4** | Remove legacy `number[]` APIs | `SherpaOnnxModule.kt`, `SherpaOnnx+PipelineAudio.mm`, `PipelineAudioRegistry.kt` |
| **Phase 5** | Event migration: remove `samples` + `emitAppendedSamples` | `LiveEntry.kt`, `PaLiveEntry`, `SherpaOnnxModule.kt`, `SherpaOnnx+PipelineAudio.mm`, `types.ts` |
| **Phase 6** | Documentation, migration guide | `docs/audiobuffer-offline.md`, `docs/audiobuffer-streaming.md`, new migration guide |

Each phase is independently testable. Phases 1+2 can run in parallel (platform-independent). Phase 3 requires both platforms. Phases 4+5 are cleanup after Phase 3.
