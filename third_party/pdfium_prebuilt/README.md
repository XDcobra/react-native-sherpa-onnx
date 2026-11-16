# PDFium prebuilts (opt-in)

PDFium is **disabled by default** (binary size). Enable at build time:

| Platform | Enable |
|----------|--------|
| Android | `sherpaOnnxEnablePdfium=true` in `gradle.properties` |
| iOS | `SHERPA_ONNX_ENABLE_PDFIUM=1` when installing pods / building |

Without enable, `extractPdfTextLayer` rejects with `ERR_PDF_PDFIUM_DISABLED`.

## Layout (Android)

```
third_party/pdfium_prebuilt/android/
  jni/<abi>/libpdfium.so   # or <abi>/lib/libpdfium.so
  include/fpdfview.h       # + other public PDFium headers
```

Resolution (only when enable is true): THIRD_PARTY → LOCAL_SDK → Maven `com.xdcobra.sherpa:pdfium` → GitHub Release zip `pdfium-android.zip`.

## Layout (iOS)

```
third_party/pdfium_prebuilt/pdfium.xcframework/
  ios-arm64/pdfium.framework/{pdfium, Headers/, Info.plist}
  ios-arm64_x86_64-simulator/pdfium.framework/{pdfium, Headers/, Info.plist}
```

Release asset `pdfium-ios.zip` contains that XCFramework. With `SHERPA_ONNX_ENABLE_PDFIUM=1`, `scripts/setup-ios-framework.sh` installs it under `ios/Frameworks/pdfium.xcframework`.

## Where the binaries come from

The binaries are built in **[XDcobra/pdfium-binaries](https://github.com/XDcobra/pdfium-binaries)**, a fork of [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries). Its workflow *Build for react-native-sherpa-onnx* builds iOS (device arm64, simulator arm64 + x64) and Android (4 ABIs) and publishes them as release `sdk-<N>` (N = PDFium branch `chromium/<N>`), with the asset names of upstream (`pdfium-ios-device-arm64.tgz`, `pdfium-android-arm64.tgz`, ...).

**Why a fork:** upstream builds iOS with `ios_deployment_target = "17.0"`. The SDK supports every iOS that React Native does (15.1 and up) and links PDFium (it is not loaded on demand), so a binary that needs iOS 17 crashes an app at launch on iOS 15 / 16, and App Store Connect rejects the upload (`ITMS-90208`, "bundle pdfium.framework does not support the minimum OS version specified in the Info.plist"). The fork changes only that: the deployment target is an input of the build (default 15.1), and the build fails when the binary needs more. PDFium itself builds fine for older iOS (tested down to 13.0).

The scripts here only download and package; they never build PDFium.

## Scripts

```sh
# Android: download release sdk-<N> of the fork and arrange it into android/ (jni/<abi>, include/)
./fetch_pdfium_android.sh 8152
# Build AAR for Maven publish (Maven version keeps our -N rebuild counter)
./create_pdfium_aar.sh ./pdfium-android-layout 8152-1 pdfium-8152-1.aar

# iOS: download the three slices and assemble pdfium.xcframework (device + universal simulator)
./create_pdfium_ios_xcframework.sh 8152          # IOS_MIN=15.1 by default

# Check any binary: every FPDF function the SDK calls is exported; Mach-O minimum OS <= --ios-min
./verify_pdfium.sh path/to/binary --ios-min 15.1
```

`create_pdfium_ios_xcframework.sh` writes `MinimumOSVersion` into each `Info.plist` **from the binary** (`vtool minos`) and fails when a binary needs more than `IOS_MIN`. Override the download base with `PDFIUM_BINARIES_URL` (default `https://github.com/XDcobra/pdfium-binaries/releases/download`).

## Updating PDFium

1. In the fork: sync with upstream (`Sync fork`), then run the workflow:
   `gh workflow run "Build for react-native-sherpa-onnx" -R XDcobra/pdfium-binaries -f branch=chromium/<N> -f ios_min=15.1`
   (publishes release `sdk-<N>`). PDFium publishes a new branch every week; pdfium-binaries tags the stable ones.
2. Here: set `IOS_RELEASE_TAG` / `ANDROID_RELEASE_TAG` to `pdfium-ios-v<N>-1` / `pdfium-android-v<N>-1`, then run both workflows below.

## CI

Workflows are `workflow_dispatch` only (like libwebp/FFmpeg). Run explicitly:

```sh
gh workflow run build-pdfium-android-release.yml --ref <branch>
gh workflow run framework-pdfium-ios-framework.yml --ref <branch>
```

Until the workflow YAML exists on the default branch, `--ref` to a branch that contains the YAML is required. The iOS workflow fails if a binary needs more than `IOS_MIN` or lacks an FPDF function the SDK calls; the Android workflow checks the functions for every ABI.

## Pin

- Android tag file: `ANDROID_RELEASE_TAG` (prefix `pdfium-android-v`, e.g. `pdfium-android-v8152-1`)
- iOS tag file: `IOS_RELEASE_TAG` (prefix `pdfium-ios-v`, e.g. `pdfium-ios-v8152-1`)
- The number before `-N` is the PDFium branch (`chromium/<N>`, release `sdk-<N>` in the fork). The trailing `-N` is our rebuild counter: raise it when the content changes with the same PDFium version (e.g. other `IOS_MIN`). `scripts/setup-ios-framework.sh` re-downloads on a new tag.
