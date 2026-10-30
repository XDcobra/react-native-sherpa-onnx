# libyuv prebuilt

Build [libyuv](https://chromium.googlesource.com/libyuv/libyuv) for Android and iOS and publish as GitHub Release zip / Maven AAR / iOS XCFramework.

- **Source:** `third_party/libyuv` (submodule). Pinned commit: **`63e54f7374680a03beb3fb595ea756354dabaffd`** (upstream version label **1976**).
- **Android:** `./build_libyuv_android.sh` (requires Android NDK, `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT`). Output: `android/<abi>/lib/libyuv.so`, `android/jni/<abi>/` (Gradle THIRD_PARTY layout), and `android/include/libyuv/`.
- **iOS:** `./build_libyuv_ios.sh` → `libyuv.xcframework` (static, arm64 device + universal simulator).
- **Release tags:** `ANDROID_RELEASE_TAG` / `IOS_RELEASE_TAG` (e.g. `libyuv-android-v1976-1`). The trailing `-N` is our rebuild counter at the same upstream pin (bump to `-2` for a toolchain/flag rebuild without changing the libyuv commit). Used by GitHub workflows and by consumers for Maven version and release zip.
- **Maven:** published to [GitHub Pages Maven](https://xdcobra.github.io/maven/) as `com.xdcobra.sherpa:libyuv:1976-1` (see [XDcobra/maven](https://github.com/XDcobra/maven)).
- **CI:**
  - `.github/workflows/build-libyuv-android-release.yml` — zip + AAR + GitHub Release + Maven publish
  - `.github/workflows/framework-libyuv-ios-framework.yml` — XCFramework zip + GitHub Release
- **SDK resolution:** Gradle (`prebuilt-download.gradle`) cascade THIRD_PARTY → LOCAL_SDK → MAVEN_AAR → GITHUB_RELEASE. iOS: `scripts/setup-ios-framework.sh` downloads the XCFramework from the iOS release tag.
- **Always-on:** VideoBuffer color convert / scale / rotate links libyuv. There is no disable flag.

Bump version: update submodule pin and reset `*_RELEASE_TAG` to `libyuv-*-v<upstream>-1`, or keep the upstream pin and increment `-N`, then re-run the release workflows.

## ISA and x86

Wrapper CMake is `CMakeLists.txt` in this folder (not upstream's). JPEG/MJPEG and unused SIMD backends are disabled.

- Only `*_neon64.cc` is compiled with `-march=armv8.2-a+dotprod+i8mm`. Runtime dispatch in `cpu_id.cc` is the only path into those kernels. `scripts/check-libyuv-isa.sh` runs on the arm64 objects during the Android prebuild.
- `*_gcc.cc` provides SSE for Android **x86** / **x86_64** (NDK clang). `*_win.cc` is kept because 32-bit x86 SSE for MSVC lives there; on NDK/Apple clang it is a no-op unless `LIBYUV_ENABLE_ROWWIN`.
- Prebuilt ABIs are `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` (Android) and arm64 device + arm64/x86_64 simulator (iOS). The example app does not compile libyuv; emulators load the matching `.so` / XCFramework slice.
