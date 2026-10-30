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

## Fetch / package scripts

```sh
# Download pdfium-binaries (chromium/<N>, rebuild suffix stripped) and rearrange into android/ layout
./fetch_pdfium_android.sh 8100

# Build AAR for Maven publish (Maven version keeps our -N rebuild counter)
./create_pdfium_aar.sh ./pdfium-android-layout 8100-1 pdfium-8100-1.aar

# Assemble a real iOS XCFramework (device + universal simulator) from pdfium-binaries
./create_pdfium_ios_xcframework.sh 8100
```

Upstream source of truth: [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) tags `chromium/<N>` (latest checked: `chromium/8100`). Our tag files use `pdfium-android-v<N>-X` / `pdfium-ios-v<N>-X`; fetch scripts strip trailing `-X` before hitting `chromium/<N>`.

## CI

Workflows are `workflow_dispatch` only (like libwebp/FFmpeg). Run explicitly:

```sh
gh workflow run build-pdfium-android-release.yml --ref feat/add-ocr-support-pdfium-textlayer
gh workflow run framework-pdfium-ios-framework.yml --ref feat/add-ocr-support-pdfium-textlayer
```

Until the workflow YAML exists on the default branch, `--ref` to a branch that contains the YAML is required.

## Pin

- Android tag file: `ANDROID_RELEASE_TAG` (prefix `pdfium-android-v`, e.g. `pdfium-android-v8100-1`)
- iOS tag file: `IOS_RELEASE_TAG` (prefix `pdfium-ios-v`, e.g. `pdfium-ios-v8100-1`)
- Trailing `-N` is our rebuild counter. Upstream fetch uses `chromium/<chromium>` on pdfium-binaries (chromium = `8100` above, suffix stripped).
