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
  ios-arm64/libpdfium.dylib + Headers/
  ios-arm64_x86_64-simulator/libpdfium.dylib + Headers/
```

Release asset `pdfium-ios.zip` contains that XCFramework. With `SHERPA_ONNX_ENABLE_PDFIUM=1`, `scripts/setup-ios-framework.sh` installs it under `ios/Frameworks/pdfium.xcframework`.

## Fetch / package scripts

```sh
# Download pdfium-binaries (chromium/<version>) and rearrange into android/ layout
./fetch_pdfium_android.sh 8100

# Build AAR for Maven publish
./create_pdfium_aar.sh ./pdfium-android-layout 8100 pdfium-8100.aar

# Assemble a real iOS XCFramework (device + universal simulator) from pdfium-binaries
./create_pdfium_ios_xcframework.sh 8100
```

Upstream source of truth: [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) tags `chromium/<N>` (latest checked: `chromium/8100`). Our tag files use `pdfium-android-v<N>` / `pdfium-ios-v<N>` so Maven/GitHub Release pins stay aligned.

## CI from a feature branch (not yet on main)

New workflow YAMLs are not registered on `main` until merge. Use the established workaround:

1. Push workflows on `feat/add-ocr-support-pdfium-textlayer` (or your branch).
2. Workflows use `on: push` (paths filter) **and** `workflow_dispatch`.
3. Run explicitly:

```sh
gh workflow run build-pdfium-android-release.yml --ref feat/add-ocr-support-pdfium-textlayer
gh workflow run framework-pdfium-ios-framework.yml --ref feat/add-ocr-support-pdfium-textlayer
```

After the first successful push that registers the workflow on that ref, `--ref` dispatch works.

## Pin

- Android tag file: `ANDROID_RELEASE_TAG` (prefix `pdfium-android-v`, e.g. `pdfium-android-v8100`)
- iOS tag file: `IOS_RELEASE_TAG` (prefix `pdfium-ios-v`, e.g. `pdfium-ios-v8100`)
- Upstream fetch uses `chromium/<suffix>` on pdfium-binaries (suffix = `8100` above)
