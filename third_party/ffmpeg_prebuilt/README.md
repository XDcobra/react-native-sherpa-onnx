# FFmpeg Prebuilts (Android)

Minimal FFmpeg shared libraries (audio-only) for Android, used by the SDK to convert various audio formats to **WAV 16 kHz mono 16-bit PCM** for sherpa-onnx.

## Layout after build

```
android/
  include/           # Headers (libavcodec, libavformat, libavutil, libswresample)
  arm64-v8a/lib/     # libavcodec.so, libavformat.so, libavutil.so, libswresample.so
  armeabi-v7a/lib/
  x86/lib/
  x86_64/lib/
```

## Building the prebuilts

1. **Initialize the FFmpeg submodule** (if not already done):
   ```bash
   git submodule update --init third_party/ffmpeg
   ```

2. **Set the Android NDK path**:
   - `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT` (e.g. `C:\Users\...\AppData\Local\Android\Sdk\ndk\27.x.x` on Windows).

3. **Run the build**:
  - **Windows (MSYS2 MinGW64 or UCRT64, recommended):**  
    Use MSYS2 and open either the *MSYS2 MinGW 64-bit* or *MSYS2 UCRT64* shell. Do not use PowerShell to run the build scripts; the build requires a POSIX-like shell and the mingw toolchain provided by MSYS2.
    See **[BUILD_MSYS2.md](BUILD_MSYS2.md)** for required environment variables and steps.
    Install required packages in MSYS2 (run inside the MSYS2 shell):
    ```bash
    pacman -Syu --noconfirm
    pacman -S --noconfirm base-devel make yasm diffutils mingw-w64-x86_64-toolchain
    ```
    Then run the build from the MSYS2 shell:
    ```bash
    cd third_party/ffmpeg_prebuilt
    export ANDROID_NDK_ROOT="C:/path/to/your/ndk"
    export ANDROID_API=24
    ./build_ffmpeg_msys2.sh
    ```
   - **Linux / macOS:**
     ```bash
     cd third_party/ffmpeg_prebuilt
     ./build_ffmpeg.sh
     ```

    IMPORTANT: After a successful build you must copy the produced `.so` files into the Android project's `jniLibs` or Gradle may fail to find them during the app build. From the repository root run:
    ```bash
    node third_party/ffmpeg_prebuilt/copy_prebuilts_to_sdk.js
    ```
    This script copies `android/<abi>/lib/*.so` into `android/src/main/jniLibs/<abi>/` so the Android build system can package them.

4. **Commit the `android/` output** (include + per-ABI `lib/*.so`) so that the npm package and CI can link against FFmpeg without building it.

## NPM package

- Only `third_party/ffmpeg_prebuilt` (including `android/`) is shipped in the npm package.
- The FFmpeg **source** (submodule `third_party/ffmpeg`) is not published; it is only used to produce the prebuilts.

## Reference

- Build logic is based on [husen-hn/ffmpeg-android-binary](https://github.com/husen-hn/ffmpeg-android-binary); this variant is minimal (audio decode + swresample only) and uses the in-repo FFmpeg submodule.
