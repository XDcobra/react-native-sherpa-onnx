# QNN (Qualcomm NPU) Support

This document describes QNN-specific APIs and behavior in `react-native-sherpa-onnx`. QNN (Qualcomm Neural Network SDK) allows using the Qualcomm NPU (Hexagon) on supported Snapdragon devices for faster inference.

> **Disclaimer — QNN runtime libs not included**  
> This SDK **supports** QNN (sherpa-onnx/ONNX Runtime are built with QNN linking). For **license reasons** we do **not** ship the Qualcomm QNN runtime libraries. If you want QNN/NPU acceleration, you must **obtain and add the QNN runtime libs yourself**. See [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs) and [License and compliance](#license-and-compliance-qnn-sdk) for how to do this in a compliant way.

## Table of contents

- [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs)
- [Overview](#overview)
- [API Reference](#api-reference)
  - [getQnnSupport()](#getqnnsupport)
  - [isQnnSupported()](#isqnnsupported)
  - [getAvailableProviders()](#getavailableproviders)
- [When does `isQnnSupported()` return what?](#when-does-isqnnsupported-return-what)
- [License and compliance (QNN SDK)](#license-and-compliance-qnn-sdk)
- [Related documentation](#related-documentation)

## Quick start: adding QNN runtime libs

To enable QNN in your app (so that `isQnnSupported()` returns `true` and you can use `provider: 'qnn'` for STT):

1. **Download the Qualcomm AI Runtime** (accept the license):  
   [Qualcomm AI Runtime Community](https://softwarecenter.qualcomm.com/catalog/item/Qualcomm_AI_Runtime_Community)

2. **Copy the QNN runtime libraries** (e.g. `libQnnHtp.so`, `libQnnHtpV*Stub.so`, `libQnnSystem.so` — see [Run executables on your phone](https://k2-fsa.github.io/sherpa/onnx/qnn/run-executables-on-your-phone-binary.html) for the exact needed libraries) into your app’s native libs per ABI. In the end, the path `android/src/main/jniLibs/arm64-v8a` should look like this:
```
(py312) localhost:android/src/main/jniLibs/arm64-v8a user$ ls -lh
total 329768
-rw-r--r--@ 1 user  staff    15M 20 Nov 17:05 libonnxruntime.so
-rw-r--r--@ 1 user  staff   6.1M 20 Nov 13:32 libQnnCpu.so
-rw-r--r--@ 1 user  staff   2.4M 21 Nov 22:38 libQnnHtp.so
-rw-r--r--@ 1 user  staff    71M 21 Nov 22:38 libQnnHtpPrepare.so
-rw-r--r--@ 1 user  staff   8.3M 21 Nov 22:38 libQnnHtpV68Skel.so
-rw-r--r--@ 1 user  staff   556K 21 Nov 22:38 libQnnHtpV68Stub.so
-rw-r--r--@ 1 user  staff   9.4M 21 Nov 22:38 libQnnHtpV69Skel.so
-rw-r--r--@ 1 user  staff   556K 21 Nov 22:38 libQnnHtpV69Stub.so
-rw-r--r--@ 1 user  staff   9.4M 21 Nov 22:38 libQnnHtpV73Skel.so
-rw-r--r--@ 1 user  staff   562K 21 Nov 22:38 libQnnHtpV73Stub.so
-rw-r--r--@ 1 user  staff   9.4M 21 Nov 22:38 libQnnHtpV75Skel.so
-rw-r--r--@ 1 user  staff   562K 21 Nov 22:38 libQnnHtpV75Stub.so
-rw-r--r--@ 1 user  staff   9.6M 21 Nov 22:38 libQnnHtpV79Skel.so
-rw-r--r--@ 1 user  staff   562K 21 Nov 22:38 libQnnHtpV79Stub.so
-rw-r--r--@ 1 user  staff    10M 21 Nov 22:38 libQnnHtpV81Skel.so
-rw-r--r--@ 1 user  staff   618K 21 Nov 22:38 libQnnHtpV81Stub.so
-rw-r--r--@ 1 user  staff   2.5M 21 Nov 22:38 libQnnSystem.so
-rw-r--r--@ 1 user  staff   4.6M 21 Nov 22:38 libsherpa-onnx-jni.so
```

3. **Rebuild the app.** After that, `isQnnSupported()` should return `true` on devices where the QNN libs load correctly.

The sherpa-onnx and ONNX Runtime libs used by this SDK (from the GitHub Release) are **already built with QNN**; you only add the Qualcomm runtime libs. Do not remove Qualcomm’s copyright or proprietary notices; see [License and compliance](#license-and-compliance-qnn-sdk).

## Overview

- **Android:** The sherpa-onnx and ONNX Runtime libs provided by this SDK (via the GitHub Release used in `build.gradle`) are **built with QNN**. To actually use QNN at runtime, the app must also ship the **QNN runtime libraries** (e.g. `libQnnHtp.so`). This SDK does not include them for license reasons — you add them yourself (see [Quick start](#quick-start-adding-qnn-runtime-libs)). With the libs in place, the STT engine can use the `qnn` provider on supported devices.
- **iOS:** QNN is not used; `isQnnSupported()` always returns `false`.
- The SDK exposes **`isQnnSupported()`** so the app can branch UI or config (e.g. show “Use NPU” only when the build has QNN), and **`getAvailableProviders()`** to list all ONNX Runtime execution providers (including `QNN` when available) for the current build and device.

## API Reference

### `getQnnSupport()`

```ts
type QnnSupport = { providerCompiled: boolean; canInitQnn: boolean };
function getQnnSupport(): Promise<QnnSupport>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns extended QNN support info:

- **`providerCompiled`** — `true` if the QNN execution provider is in the list from `getAvailableProviders()` (ORT build has QNN linked).
- **`canInitQnn`** — `true` if the QNN HTP backend can be initialized (native `QnnBackend_create` succeeds). Requires the QNN runtime libs to be present and the device to support them.

Use this to show the user why QNN is or isn’t available (e.g. “QNN compiled but not usable on this device” when `providerCompiled && !canInitQnn`).

**Example:**

```ts
import { getQnnSupport } from 'react-native-sherpa-onnx';

const { providerCompiled, canInitQnn } = await getQnnSupport();
if (canInitQnn) {
  // Use provider: 'qnn' for STT
} else if (providerCompiled) {
  // Show "QNN built in but not available on this device"
} else {
  // Use CPU or other providers only
}
```

### `isQnnSupported()`

```ts
function isQnnSupported(): Promise<boolean>;
```

**Export:** `react-native-sherpa-onnx` (root).

Equivalent to `(await getQnnSupport()).canInitQnn`: whether QNN can **actually be used** on this device (provider compiled in and HTP backend initializes). Prefer `getQnnSupport()` when you need to distinguish “compiled but not usable” from “not compiled”.

**Return value:** `Promise<boolean>`

- **`true`** — QNN provider is in the build and the QNN HTP backend initialized successfully; you can use `provider: 'qnn'` for STT.
- **`false`** — Either the build has no QNN provider, or the QNN runtime libs are missing, or the backend failed to initialize (e.g. unsupported device). On iOS always `false`.

**Example:**

```ts
import { isQnnSupported } from 'react-native-sherpa-onnx';

const hasQnn = await isQnnSupported();
if (hasQnn) {
  // Use provider: 'qnn' when creating STT
} else {
  // Use CPU or other providers only
}
```

### `getAvailableProviders()`

```ts
function getAvailableProviders(): Promise<string[]>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns the list of **ONNX Runtime execution providers** available in the current build (e.g. `'CPU'`, `'QNN'`, `'NNAPI'`, `'COREML'`, `'XNNPACK'`). This comes from `OrtEnvironment.getAvailableProviders()` on Android; on iOS it returns the providers supported by the iOS build.

Use this to show the user which backends they can choose (e.g. in settings) or to decide which `provider` to pass when creating an STT recognizer. If the list contains `'QNN'`, the build has QNN linked and — provided the QNN runtime libs are present — you can use `provider: 'qnn'` for STT.

**Return value:** `Promise<string[]>` — Provider names (e.g. `['CPU', 'QNN', 'NNAPI']`).

**Example:**

```ts
import { getAvailableProviders } from 'react-native-sherpa-onnx';

const providers = await getAvailableProviders();
const hasQnn = providers.some(p => p.toUpperCase() === 'QNN');
if (hasQnn) {
  // Offer "Use NPU (QNN)" in UI or use provider: 'qnn' for STT
}
```

## When does `isQnnSupported()` / `getQnnSupport()` return what?

| Situation | `providerCompiled` | `canInitQnn` / `isQnnSupported()` | Notes |
|-----------|--------------------|-----------------------------------|--------|
| **Android, QNN runtime libs added** (sherpa-onnx QNN-built; you added Qualcomm runtime libs to jniLibs; device supports HTP) | `true` | `true` | Normal case. See [Quick start](#quick-start-adding-qnn-runtime-libs). |
| **Android, QNN runtime libs not added** (sherpa-onnx QNN-built, but no Qualcomm `.so` files) | `true` | `false` | Add QNN libs so `QnnBackend_create` can succeed. |
| **Android, build without QNN** (ORT/sherpa-onnx not built with QNN) | `false` | `false` | No QNN in `getAvailableProviders()`. |
| **Android, QNN libs present but device/backend init fails** | `true` | `false` | e.g. unsupported SoC or driver; use CPU. |
| **iOS** | `false` | `false` | QNN is Android/Qualcomm only. |

**Summary:** `isQnnSupported()` is true only when **both** the QNN provider is compiled in and the HTP backend initializes. Use `getQnnSupport()` to show users why QNN is unavailable.

## License and compliance (QNN SDK)

The Qualcomm AI Stack License (see `third_party/onnxruntime_prebuilt/license/license.txt`) allows you to **distribute the QNN runtime libraries only in object code and only as part of your application** — not on a standalone basis (e.g. not in a public SDK/npm package).

**How we stay compliant:**

1. **This SDK:** We do **not** ship QNN `.so` files in the repository or npm package. The SDK uses sherpa-onnx/ORT built with QNN but relies on the **app** to provide the QNN runtime libs.
2. **You (app developer):** Download the [Qualcomm AI Runtime Community](https://softwarecenter.qualcomm.com/catalog/item/Qualcomm_AI_Runtime_Community), accept the license, and copy the required runtime libraries (e.g. `libQnnHtp.so`, `libQnnHtpV75Stub.so`, `libQnnSystem.so`) into your app (e.g. `android/app/src/main/jniLibs/arm64-v8a/`). The license permits distribution of these libraries when they are **incorporated in your software application**.
3. **Notices:** Do not remove Qualcomm’s copyright or proprietary notices. If your app ships with QNN libraries, include the applicable Qualcomm license/notice (e.g. from the SDK) in your app’s legal/credits or documentation.

This “you add QNN libs yourself” approach keeps the SDK compliant (no redistribution of QNN by us) while allowing your app to use NPU acceleration under Qualcomm’s terms.

## Related documentation

- [STT](./stt.md) — `provider` option (e.g. `'cpu'`, `'qnn'`) when creating the recognizer.
- [Model Setup](./MODEL_SETUP.md) — How to use bundled or downloaded models with STT/TTS.
- [Building sherpa-onnx Android prebuilts](../../third_party/sherpa-onnx-prebuilt/README.md) — Building with `--qnn` and `QNN_SDK_ROOT`.
