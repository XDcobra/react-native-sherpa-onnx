# QNN (Qualcomm NPU) Support

This document describes QNN-specific APIs and behavior in `react-native-sherpa-onnx`. QNN (Qualcomm Neural Network SDK) allows using the Qualcomm NPU (Hexagon) on supported Snapdragon devices for faster inference.

> **Disclaimer — QNN runtime libs not included**  
> This SDK **supports** QNN (sherpa-onnx/ONNX Runtime are built with QNN linking). For **license reasons** we do **not** ship the Qualcomm QNN runtime libraries. If you want QNN/NPU acceleration, you must **obtain and add the QNN runtime libs yourself**. See [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs) and [License and compliance](#license-and-compliance-qnn-sdk) for how to do this in a compliant way.

## Table of contents

- [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs)
- [Overview](#overview)
- [Unified format (AccelerationSupport)](#unified-format-accelerationsupport)
- [API Reference](#api-reference)
  - [getQnnSupport()](#getqnnsupport)
  - [getAvailableProviders()](#getavailableproviders)
  - [getNnapiSupport()](#getnnapisupport)
  - [getXnnpackSupport()](#getxnnpacksupport)
  - [getCoreMlSupport()](#getcoremlsupport)
- [When does `getQnnSupport()` return what?](#when-does-getqnnsupport-return-what)
- [When does `getNnapiSupport()` return what?](#when-does-getnnapisupport-return-what)
- [When does `getXnnpackSupport()` return what?](#when-does-getxnnpacksupport-return-what)
- [When does `getCoreMlSupport()` return what?](#when-does-getcoremlsupport-return-what)
- [License and compliance (QNN SDK)](#license-and-compliance-qnn-sdk)
- [Related documentation](#related-documentation)

## Quick start: adding QNN runtime libs

To enable QNN in your app (so that `getQnnSupport().canInit` is `true` and you can use `provider: 'qnn'` for STT):

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

3. **Rebuild the app.** After that, `getQnnSupport().canInit` will be `true` on devices where the QNN libs load correctly.

The sherpa-onnx and ONNX Runtime libs used by this SDK (from the GitHub Release) are **already built with QNN**; you only add the Qualcomm runtime libs. Do not remove Qualcomm’s copyright or proprietary notices; see [License and compliance](#license-and-compliance-qnn-sdk).

## Overview

- **Android:** The sherpa-onnx and ONNX Runtime libs provided by this SDK (via the GitHub Release used in `build.gradle`) are **built with QNN**. To actually use QNN at runtime, the app must also ship the **QNN runtime libraries** (e.g. `libQnnHtp.so`). This SDK does not include them for license reasons — you add them yourself (see [Quick start](#quick-start-adding-qnn-runtime-libs)). With the libs in place, the STT engine can use the `qnn` provider on supported devices.
- **iOS:** QNN is not used; `getQnnSupport().canInit` is always `false`.
- The SDK exposes **`getQnnSupport()`** so the app can branch UI or config (e.g. show “Use NPU” only when `canInit` is true, or explain why QNN is unavailable), and **`getAvailableProviders()`** to list all ONNX Runtime execution providers (including `QNN` when available) for the current build and device.

## Unified format (AccelerationSupport)

All acceleration support getters (`getQnnSupport`, `getNnapiSupport`, `getXnnpackSupport`, `getCoreMlSupport`) return the same shape:

```ts
type AccelerationSupport = {
  providerCompiled: boolean;  // ORT EP built in (Android) / Core ML present (iOS)
  hasAccelerator: boolean;    // NPU/ANE present?
  canInit: boolean;          // Session with EP successful?
};
```

| Backend | providerCompiled | hasAccelerator | canInit |
|--------|------------------|----------------|---------|
| **QNN (Android)** | ORT providers contains QNN | Same as canInit (implicit) | QNN init test |
| **NNAPI (Android)** | ORT providers contains NNAPI | nativeHasNnapiAccelerator() (GPU or ACCELERATOR) | NNAPI session test (optional model) |
| **XNNPACK** | ORT providers contains XNNPACK | `true` when compiled (CPU-optimized) | XNNPACK session test (optional model) |
| **Core ML (iOS)** | `true` (Core ML on iOS 11+) | Apple Neural Engine (MLModel.availableComputeDevices) | ORT session with CoreML EP (stub `false` in this module) |

**Optional `modelBase64` (NNAPI, XNNPACK):** If you omit it, the SDK uses its own small embedded test models to compute `canInit`, so you get a meaningful result without passing anything. Pass `modelBase64` (base64-encoded ONNX bytes) only when you want to test compatibility with a **specific** model (e.g. your real STT encoder).

## API Reference

### `getQnnSupport()`

```ts
function getQnnSupport(): Promise<AccelerationSupport>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns QNN support in unified format: **providerCompiled** (QNN in ORT providers), **hasAccelerator** (= canInit for QNN), **canInit** (HTP backend init succeeds). Use `canInit` to decide if you can use `provider: 'qnn'` for STT.

**Example:**

```ts
import { getQnnSupport } from 'react-native-sherpa-onnx';

const support = await getQnnSupport();
if (support.canInit) {
  // Use provider: 'qnn' for STT
} else if (support.providerCompiled) {
  // Show "QNN built in but not available on this device"
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

### `getNnapiSupport()`

```ts
function getNnapiSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns **NNAPI (Android)** support in unified format. **hasAccelerator** uses the NDK Neural Networks API: `true` if any NNAPI device has type GPU or ACCELERATOR (DSP/NPU). **canInit** is the result of a session test: if you omit `modelBase64`, the SDK uses an embedded test model; pass `modelBase64` to test that exact model’s compatibility with NNAPI. On iOS returns all `false`.

#### Why can `hasAccelerator` be No and `canInit` be Yes?

The two values answer different questions:

- **hasAccelerator** comes from the **Android NDK Neural Networks API**: it checks whether the system reports at least one NNAPI device of type **accelerator** (GPU/DSP/NPU). So it means: “Does the device advertise a dedicated NNAPI accelerator?”
- **canInit** comes from **creating an ONNX Runtime session with the NNAPI execution provider**. That only tests whether the NNAPI EP can create a session; NNAPI can still run that session on **CPU** if no accelerator is available or reported.

So **hasAccelerator: No, canInit: Yes** is normal: the NNAPI EP works and a session was created, but the device does not report a dedicated accelerator via the NDK API (execution may be on CPU through NNAPI). Use **canInit** to decide if you can use `provider: 'nnapi'`; use **hasAccelerator** only to show the user whether a dedicated accelerator is advertised.

### `getXnnpackSupport()`

```ts
function getXnnpackSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns **XNNPACK** support in unified format. **hasAccelerator** is `true` when providerCompiled (CPU-optimized). **canInit**: if you omit `modelBase64`, the SDK uses an embedded test model; pass `modelBase64` to test that exact model’s compatibility with XNNPACK. On iOS returns all `false`.

### `getCoreMlSupport()`

```ts
function getCoreMlSupport(modelBase64?: string): Promise<AccelerationSupport>;
```

**Export:** `react-native-sherpa-onnx` (root).

Returns **Core ML (iOS)** support in unified format. **providerCompiled** is always `true` (Core ML present on iOS 11+). **hasAccelerator** is true when Apple Neural Engine is available (`MLModel.availableComputeDevices` contains `.neuralEngine`, iOS 15+). **canInit** would require an ORT session with CoreML EP and is not implemented in this module (returns `false`). On Android returns all `false`.

## When does `getQnnSupport()` return what?

| Situation | `providerCompiled` | `hasAccelerator` | `canInit` | Notes |
|-----------|--------------------|--------------|--------|
| **Android, QNN runtime libs added** (sherpa-onnx QNN-built; you added Qualcomm runtime libs to jniLibs; device supports HTP) | `true` | `true` | `true` | Normal case. See [Quick start](#quick-start-adding-qnn-runtime-libs). |
| **Android, QNN runtime libs not added** (sherpa-onnx QNN-built, but no Qualcomm `.so` files) | `true` | `false` | `false` | Add QNN libs so `QnnBackend_create` can succeed. |
| **Android, build without QNN** (ORT/sherpa-onnx not built with QNN) | `false` | `false` | `false` | No QNN in `getAvailableProviders()`. |
| **Android, QNN libs present but device/backend init fails** | `true` | `false` | `false` | e.g. unsupported SoC or driver; use CPU. |
| **iOS** | `false` | `false` | `false` | QNN is Android/Qualcomm only. |

**Summary:** `canInit` is true only when **both** the QNN provider is compiled in and the HTP backend initializes. Use `getQnnSupport()` to show users why QNN is unavailable.

## When does `getNnapiSupport()` return what?

| Situation | `providerCompiled` | `hasAccelerator` | `canInit` | Notes |
|-----------|--------------------|------------------|-----------|--------|
| **Android, NNAPI in build, device reports accelerator, session OK** | `true` | `true` | `true` | Use `provider: 'nnapi'` for STT. |
| **Android, NNAPI in build, device does not report accelerator, session OK** | `true` | `false` | `true` | NNAPI works (e.g. on CPU); use `provider: 'nnapi'`. See [hasAccelerator vs canInit](#why-can-hasaccelerator-be-no-and-caninit-be-yes). |
| **Android, NNAPI in build, no accelerator (e.g. emulator), session OK** | `true` | `false` | `true` | Same as above. |
| **Android, NNAPI in build, session fails** | `true` | * | `false` | Model or driver issue. |
| **Android, build without NNAPI** | `false` | `false` | `false` | NNAPI not in ORT build. |
| **iOS** | `false` | `false` | `false` | NNAPI is Android-only. |

**Summary:** `canInit` is `true` when a session with NNAPI EP can be created (embedded test model or passed `modelBase64`). `hasAccelerator` is only whether the NDK reports a dedicated accelerator device; it can be `false` even when `canInit` is `true`.

## When does `getXnnpackSupport()` return what?

| Situation | `providerCompiled` | `hasAccelerator` | `canInit` | Notes |
|-----------|--------------------|------------------|-----------|--------|
| **Build has XNNPACK, model passed and session created with XNNPACK** | `true` | `true` | `true` | Use `provider: 'xnnpack'` for STT. |
| **Build has XNNPACK, no model passed** | `true` | `true` | `false` | Pass `modelBase64` to test session init. |
| **Build without XNNPACK** | `false` | `false` | `false` | XNNPACK not in ORT build. |
| **iOS (stub)** | `false` | `false` | `false` | Stub; could be extended. |

**Summary:** `canInit` is only `true` when you call `getXnnpackSupport(modelBase64)` with a valid ONNX model and the session with XNNPACK is created successfully.

## When does `getCoreMlSupport()` return what?

| Situation | `providerCompiled` | `hasAccelerator` | `canInit` | Notes |
|-----------|--------------------|------------------|-----------|--------|
| **iOS 11+, device with ANE (e.g. A12+), iOS 15+** | `true` | `true` | `false` | ANE available; canInit not implemented in this module. |
| **iOS 11+, device without ANE or simulator** | `true` | `false` | `false` | Core ML still available on CPU/GPU. |
| **Android** | `false` | `false` | `false` | Core ML is iOS-only. |

**Summary:** On iOS, `providerCompiled` is always `true`; `hasAccelerator` reflects Apple Neural Engine (iOS 15+). `canInit` would require ORT session with CoreML EP and is not implemented here.

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
