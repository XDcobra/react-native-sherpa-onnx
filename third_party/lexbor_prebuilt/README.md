# lexbor prebuilt

Build [lexbor](https://github.com/lexbor/lexbor) for Android and iOS and publish as GitHub Release zip / Maven AAR / iOS XCFramework.

- **Source:** `third_party/lexbor` (submodule). Pinned version: **v3.0.0**.
- **Android:** `./build_lexbor_android.sh` (requires Android NDK, `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT`). Output: `android/<abi>/lib/liblexbor.so`, `android/jni/<abi>/` (Gradle THIRD_PARTY layout), and `android/include/lexbor/`.
- **iOS:** `./build_lexbor_ios.sh` → `lexbor.xcframework` (static, arm64 device + universal simulator).
- **Release tags:** `ANDROID_RELEASE_TAG` / `IOS_RELEASE_TAG` (e.g. `lexbor-android-v3.0.0-1`). The trailing `-N` is our rebuild counter at the same upstream pin. Used by GitHub workflows and by consumers for Maven version and release zip.
- **Maven:** published to [GitHub Pages Maven](https://xdcobra.github.io/maven/) as `com.xdcobra.sherpa:lexbor:3.0.0-1` (see [XDcobra/maven](https://github.com/XDcobra/maven)).
- **CI:**
  - `.github/workflows/build-lexbor-android-release.yml` — zip + AAR + GitHub Release + Maven publish
  - `.github/workflows/framework-lexbor-ios-framework.yml` — XCFramework zip + GitHub Release
- **SDK resolution:** Gradle (`prebuilt-download.gradle`) cascade THIRD_PARTY → LOCAL_SDK → MAVEN_AAR → GITHUB_RELEASE. iOS: `scripts/setup-ios-framework.sh` downloads the XCFramework from the iOS release tag.
- **Always-on:** Document HTML extract (`extractDocumentText` EPUB XHTML) links lexbor. There is no disable flag.

Bump version: update submodule pin and reset `*_RELEASE_TAG` to `lexbor-*-v<upstream>-1`, or keep the upstream pin and increment `-N`, then re-run the release workflows.
