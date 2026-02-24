# QNN (Qualcomm NPU) Support

This document describes QNN-specific APIs and behavior in `react-native-sherpa-onnx`. QNN (Qualcomm Neural Network SDK) allows using the Qualcomm NPU (Hexagon) on supported Snapdragon devices for faster inference.

> **Disclaimer — QNN runtime libs not included**  
> This SDK **supports** QNN (sherpa-onnx/ONNX Runtime are built with QNN linking). For **license reasons** we do **not** ship the Qualcomm QNN runtime libraries. If you want QNN/NPU acceleration, you must **obtain and add the QNN runtime libs yourself**. See [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs) and [License and compliance](#license-and-compliance-qnn-sdk) for how to do this in a compliant way.

## Table of contents

- [Quick start: adding QNN runtime libs](#quick-start-adding-qnn-runtime-libs)
- [Overview](#overview)
- [API Reference](#api-reference)
  - [isQnnSupported()](#isqnnsupported)
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
- The SDK exposes **`isQnnSupported()`** so the app can branch UI or config (e.g. show “Use NPU” only when the build has QNN).

## API Reference

### `isQnnSupported()`

```ts
function isQnnSupported(): Promise<boolean>;
```

**Export:** `react-native-sherpa-onnx` (root).

Checks whether the **current build** has QNN support available (i.e. the Qualcomm QNN library can be loaded). This reflects the **native shared libraries** shipped with the app, not whether the device has an NPU.

**Return value:** `Promise<boolean>`

- **`true`** — The QNN library (`libQnnHtp.so`) could be loaded. The sherpa-onnx/ONNX Runtime build is typically a QNN build and can use the QNN execution provider (e.g. `provider: 'qnn'` for STT) on supported devices.
- **`false`** — Either the QNN library is not present (non-QNN build), or the platform is iOS (no QNN), or the check failed.

**Example:**

```ts
import { isQnnSupported } from 'react-native-sherpa-onnx';

const hasQnn = await isQnnSupported();
if (hasQnn) {
  // Optionally use provider: 'qnn' when creating STT
} else {
  // Use CPU or other providers only
}
```

## When does `isQnnSupported()` return what?

| Situation | Result | Notes |
|-----------|--------|--------|
| **Android, QNN runtime libs added** (sherpa-onnx from this SDK is already QNN-built; you added the Qualcomm runtime libs to jniLibs) | `true` | Normal case for a QNN-enabled app. See [Quick start](#quick-start-adding-qnn-runtime-libs). |
| **Android, QNN runtime libs not added** (sherpa-onnx from this SDK is QNN-built, but you have not added the Qualcomm `.so` files) | `false` | Default until you add the QNN libs yourself. |
| **Android, libQnnHtp.so present but sherpa-onnx not built with QNN** | `true` | The function only tests whether the QNN library can be **loaded** (e.g. via `dlopen`). It does **not** verify that sherpa-onnx/ONNX Runtime were actually linked with QNN. In this edge case you may get a false positive. |
| **iOS** | `false` | QNN is Android/Qualcomm only; the iOS implementation always returns `false`. |

**Summary:** `isQnnSupported()` is a **heuristic**: “can we load the QNN library?”

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
