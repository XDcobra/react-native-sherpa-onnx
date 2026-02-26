# libarchive Android prebuilt

Build libarchive for Android (all ABIs) and publish as GitHub Release zip and Maven AAR (`com.xdcobra.sherpa:libarchive`).

- **Build locally:** `./build_libarchive.sh` (requires Android NDK, `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT`). Output: `android/<abi>/lib/libarchive.so` and `android/include/`.
- **Release tag:** Set in `ANDROID_RELEASE_TAG` (e.g. `libarchive-android-v3.8.5`). Used by the GitHub workflow and by consumers for the Maven version and release zip.
- **Copy to SDK:** `node copy_prebuilts_to_sdk.js` copies `.so` and headers into `android/src/main/jniLibs` and `android/src/main/cpp/include/libarchive` for local development.
- **CI:** `.github/workflows/build-libarchive-android-release.yml` builds, creates zip + AAR, creates GitHub Release, and publishes to Maven when `MAVEN_REPO_PAT` is set.

Source: `third_party/libarchive` (submodule). Version 3.8.5.
