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
   - **Windows (PowerShell):**  
     MSYS2 must be in your PATH. Install build tools and a C11-capable host compiler in the MSYS2 shell:
     `pacman -S --noconfirm make yasm diffutils mingw-w64-x86_64-gcc`
     Then run:
     ```powershell
     cd third_party\ffmpeg_prebuilt
     .\build_ffmpeg.ps1
     ```
     The script builds FFmpeg entirely in PowerShell (calls bash only for configure/make; does not use build_ffmpeg.sh).
   - **Linux / macOS:**
     ```bash
     cd third_party/ffmpeg_prebuilt
     ./build_ffmpeg.sh
     ```

4. **Commit the `android/` output** (include + per-ABI `lib/*.so`) so that the npm package and CI can link against FFmpeg without building it.

## NPM package

- Only `third_party/ffmpeg_prebuilt` (including `android/`) is shipped in the npm package.
- The FFmpeg **source** (submodule `third_party/ffmpeg`) is not published; it is only used to produce the prebuilts.

## Reference

- Build logic is based on [husen-hn/ffmpeg-android-binary](https://github.com/husen-hn/ffmpeg-android-binary); this variant is minimal (audio decode + swresample only) and uses the in-repo FFmpeg submodule.
