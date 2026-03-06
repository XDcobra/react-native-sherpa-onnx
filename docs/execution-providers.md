# Execution Providers

Hardware acceleration support for ONNX Runtime: QNN (Qualcomm NPU), NNAPI, XNNPACK (Android), and Core ML (iOS).

**Import path:** `react-native-sherpa-onnx`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [AccelerationSupport](#accelerationsupport)
  - [getQnnSupport()](#getqnnsupportmodelbase64)
  - [getDeviceQnnSoc()](#getdeviceqnnsoc)
  - [getNnapiSupport()](#getnnapisupportmodelbase64)
  - [getXnnpackSupport()](#getxnnpacksupportmodelbase64)
  - [getCoreMlSupport()](#getcoremlsupportmodelbase64)
  - [getAvailableProviders()](#getavailableproviders)
- [Per-Backend Behavior](#per-backend-behavior)
- [QNN Runtime Library Setup](#qnn-runtime-library-setup)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| QNN (Qualcomm NPU) | ✅ | Android only — SM8xxx SoCs (SM8850, SM8750, SM8550, …) |
| NNAPI | ✅ | Android only — `hasAccelerator` ≠ `canInit` (see table) |
| XNNPACK | ✅ | Android only — CPU-optimized |
| Core ML | ✅ | iOS only — Neural Engine + ANE |
| Provider list | ✅ | `getAvailableProviders()` — compiled ONNX Runtime EPs |
| SoC detection | ✅ | `getDeviceQnnSoc()` — Android 12+ |

All `get*Support()` methods return the same `AccelerationSupport` shape. Use `provider` in `createSTT()`/`createTTS()` options to select a backend.

---

## Quick Start

```typescript
import {
  getQnnSupport,
  getNnapiSupport,
  getXnnpackSupport,
  getCoreMlSupport,
  getAvailableProviders,
} from 'react-native-sherpa-onnx';
import { Platform } from 'react-native';

// Pick the best provider for this device
let provider = 'cpu';

if (Platform.OS === 'android') {
  const qnn = await getQnnSupport();
  if (qnn.canInit) {
    provider = 'qnn';
  } else {
    const nnapi = await getNnapiSupport();
    if (nnapi.canInit) provider = 'nnapi';
  }
} else {
  const cml = await getCoreMlSupport();
  if (cml.canInit) provider = 'coreml';
}

// Pass to engine creation
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/my-stt-model' },
  provider,
});
```

---

## API Reference

### `AccelerationSupport`

```ts
export type AccelerationSupport = {
  providerCompiled: boolean;  // ORT execution provider was compiled in
  hasAccelerator: boolean;    // Hardware is present (NPU, ANE, etc.)
  canInit: boolean;           // A test session with this EP succeeded
};
```

All `get*Support()` methods return this shape.

- **`providerCompiled`** — The EP is available in the ONNX Runtime build
- **`hasAccelerator`** — The device has the required hardware
- **`canInit`** — A test session initialized successfully with this EP

The optional `modelBase64` parameter lets you supply a custom test model (base64-encoded ONNX). When omitted, the SDK uses an embedded minimal test model.

---

### `getQnnSupport(modelBase64?)`

```ts
function getQnnSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

QNN (Qualcomm AI Engine Direct). Android only; iOS returns all `false`.

Requires:
- Device with Qualcomm SM8xxx SoC
- QNN runtime libraries in the correct directory (see [QNN Runtime Library Setup](#qnn-runtime-library-setup))
- QNN-compatible model files (`.onnx` compiled for QNN, or QNN context binary)

---

### `getDeviceQnnSoc()`

```ts
function getDeviceQnnSoc(): Promise<{
  soc: string | null;
  isSupported: boolean;
}>;
```

Returns the device SoC identifier (e.g. `"SM8850"`) on Android 12+. `isSupported` is `true` when the SoC is SM8xxx (supported for QNN). iOS and older Android return `{ soc: null, isSupported: false }`.

Use `soc` for display and `isSupported` to auto-select QNN models in the download manager.

---

### `getNnapiSupport(modelBase64?)`

```ts
function getNnapiSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

Android Neural Networks API. iOS returns all `false`.

> **Note:** `hasAccelerator` checks for NNAPI hardware support, but `canInit` may still fail if the model uses unsupported NNAPI ops. Always check `canInit` with your actual model if possible.

---

### `getXnnpackSupport(modelBase64?)`

```ts
function getXnnpackSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

XNNPACK CPU-optimized provider. Android only; iOS returns all `false`.

`hasAccelerator` equals `providerCompiled` (no separate hardware — runs on CPU with optimized kernels).

---

### `getCoreMlSupport(modelBase64?)`

```ts
function getCoreMlSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

Apple Core ML. iOS only; Android returns all `false`.

- `providerCompiled`: always `true` for iOS builds (Core ML on iOS 11+)
- `hasAccelerator`: `true` when Apple Neural Engine is present
- `canInit`: test session succeeded

---

### `getAvailableProviders()`

```ts
function getAvailableProviders(): Promise<string[]>;
```

List all compiled ONNX Runtime execution providers (e.g. `["CPU", "NNAPI", "QNN", "XNNPACK"]`). Requires the ORT Java bridge from the `onnxruntime` AAR on Android.

---

## Per-Backend Behavior

| Backend | Platform | `providerCompiled` | `hasAccelerator` | `canInit` |
| --- | --- | --- | --- | --- |
| **QNN** | Android | QNN EP compiled in ORT | SM8xxx SoC detected | Test session passes |
| **QNN** | iOS | `false` | `false` | `false` |
| **NNAPI** | Android | NNAPI EP compiled | NNAPI hardware present | Test session passes (op-dependent) |
| **NNAPI** | iOS | `false` | `false` | `false` |
| **XNNPACK** | Android | XNNPACK EP compiled | = `providerCompiled` | Test session passes |
| **XNNPACK** | iOS | `false` | `false` | `false` |
| **Core ML** | iOS | `true` (iOS 11+) | Neural Engine present | Test session passes |
| **Core ML** | Android | `false` | `false` | `false` |

---

## QNN Runtime Library Setup

QNN requires Qualcomm's runtime shared libraries at a specific path on device. The SDK looks for them in the app's native library directory.

**Directory listing (typical files):**

```
libQnnHtp.so
libQnnHtpV75Stub.so (or V73, V68 — depends on SoC)
libQnnSystem.so
libQnnHtpPrepare.so
libQnnHtpProfilingReader.so (optional)
```

**Setup approaches:**

1. **Download Manager** — Download the `Qnn` model category which includes the runtime libs:
   ```typescript
   import { ModelCategory, downloadModelByCategory } from 'react-native-sherpa-onnx/download';
   await downloadModelByCategory(ModelCategory.Qnn, 'qnn-libs-sm8xxx');
   ```

2. **Bundle in APK** — Place `.so` files in `android/app/src/main/jniLibs/arm64-v8a/`

3. **Manual extraction** — Extract from the Qualcomm AI Engine Direct SDK

**License compliance:** QNN runtime libraries are subject to Qualcomm's license terms. Ensure your distribution complies with the applicable license.

---

## Detailed Examples

### Automatic provider selection with fallback

```typescript
import { Platform } from 'react-native';
import {
  getQnnSupport,
  getNnapiSupport,
  getXnnpackSupport,
  getCoreMlSupport,
} from 'react-native-sherpa-onnx';

async function selectBestProvider(): Promise<string> {
  if (Platform.OS === 'ios') {
    const cml = await getCoreMlSupport();
    return cml.canInit ? 'coreml' : 'cpu';
  }

  // Android: try QNN → NNAPI → XNNPACK → CPU
  const qnn = await getQnnSupport();
  if (qnn.canInit) return 'qnn';

  const nnapi = await getNnapiSupport();
  if (nnapi.canInit) return 'nnapi';

  const xnn = await getXnnpackSupport();
  if (xnn.canInit) return 'xnnpack';

  return 'cpu';
}
```

### Check QNN SoC and show in UI

```typescript
import { getDeviceQnnSoc, getQnnSupport } from 'react-native-sherpa-onnx';

const { soc, isSupported } = await getDeviceQnnSoc();

if (isSupported) {
  const qnn = await getQnnSupport();
  console.log(`SoC: ${soc}, QNN ready: ${qnn.canInit}`);
  // Show QNN toggle in settings
} else {
  console.log('QNN not supported on this device');
}
```

### List all providers

```typescript
import { getAvailableProviders } from 'react-native-sherpa-onnx';

const providers = await getAvailableProviders();
console.log('Available EPs:', providers);
// e.g. ["CPU", "NNAPI", "QNN", "XNNPACK"]
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| `canInit` false for QNN | Check that QNN runtime `.so` files are in jniLibs and the SoC is SM8xxx |
| `canInit` false for NNAPI | Model may use unsupported ops — test with `modelBase64` of your actual model |
| Provider not in `getAvailableProviders()` | The EP was not compiled into the ORT build; check your `onnxruntime` AAR variant |
| Core ML `canInit` false on Simulator | Neural Engine is not available in Simulator; test on physical device |
| QNN models crash | Re-export the QNN context binary for the exact SoC family; mismatched HTP versions crash |

**Unsupported hardware:**
- RK35xx (Rockchip) — no QNN/NNAPI acceleration
- Ascend NPU — not supported by ONNX Runtime mobile

**Performance tips:**

- QNN provides the best speedup on supported Qualcomm devices (2-4× for large models)
- NNAPI and XNNPACK may not accelerate all ops — the runtime falls back to CPU per-op
- Core ML with Neural Engine gives significant speedup on Apple A12+ and M1+ chips
- Always measure latency with your specific model — `canInit` doesn't guarantee speed improvement

---

## See Also

- [STT](stt.md) — `provider` option in `createSTT()`
- [TTS](tts.md) — `provider` option in `createTTS()`
- [Download Manager](download-manager.md) — QNN model category
- [Model Setup](model-setup.md) — Model discovery and paths
