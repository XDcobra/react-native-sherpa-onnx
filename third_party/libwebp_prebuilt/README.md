# libwebp prebuilt

Build [libwebp](https://github.com/webmproject/libwebp) for Android and iOS and publish as GitHub Release zip / Maven AAR (`com.xdcobra.sherpa:libwebp`) / iOS XCFramework.

- **Source:** `third_party/libwebp` (submodule). Pinned version: **v1.5.0**.
- **Android:** `./build_libwebp_android.sh` (requires Android NDK, `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT`). Output: `android/<abi>/lib/libwebp.so`, `android/<abi>/lib/libsharpyuv.so`, `android/jni/<abi>/` (Gradle THIRD_PARTY layout), and `android/include/webp/`.
- **iOS:** `./build_libwebp_ios.sh` → `libwebp.xcframework` (static, arm64 device + universal simulator; sharpyuv merged in).
- **Release tags:** `ANDROID_RELEASE_TAG` / `IOS_RELEASE_TAG` (e.g. `libwebp-android-v1.5.0`). Used by GitHub workflows and by consumers for Maven version and release zip.
- **CI:**
  - `.github/workflows/build-libwebp-android-release.yml` — zip + AAR + GitHub Release + optional Maven publish
  - `.github/workflows/framework-libwebp-ios-framework.yml` — XCFramework zip + GitHub Release
- **SDK resolution:** Gradle (`prebuilt-download.gradle`) cascade THIRD_PARTY → LOCAL_SDK → MAVEN_AAR → GITHUB_RELEASE. iOS: `scripts/setup-ios-framework.sh` downloads the XCFramework from the iOS release tag.

Bump version: update submodule pin + both `*_RELEASE_TAG` files + re-run the release workflows.
