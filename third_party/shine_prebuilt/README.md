# libshine Prebuilts (Android)

This folder contains a small MSYS2 build helper to cross-compile `libshine` (MP3 encoder) as shared libraries for Android ABIs so they can be linked into FFmpeg.

Prerequisites
- MSYS2 (MinGW64 or UCRT64) shell
- Android NDK installed and `ANDROID_NDK_ROOT` or `ANDROID_NDK_HOME` set
- The `third_party/shine` submodule initialized (source must be present)

Building
1. Open MSYS2 MinGW64 or UCRT64 shell and install toolchain packages if needed:
```bash
pacman -Syu --noconfirm
pacman -S --noconfirm base-devel make yasm diffutils mingw-w64-x86_64-toolchain
```

2. Run the build script from the repository root (example):
```bash
export ANDROID_NDK_ROOT="C:/path/to/android-ndk"
export ANDROID_API=24
cd third_party/shine_prebuilt
./build_shine_msys2.sh
```

Output
- `third_party/shine_prebuilt/android/<abi>/lib/libshine.so`
- `third_party/shine_prebuilt/android/<abi>/include/...` (headers copied from the `shine` source tree)

After building
- Copy the produced `.so` files into your Android project's `jniLibs` (or use the `third_party/ffmpeg_prebuilt/copy_prebuilts_to_sdk.js` pattern) so Gradle can link them when building FFmpeg.
- Then reconfigure and build FFmpeg with `--extra-cflags`/`--extra-ldflags` pointing at the `include`/`lib` from this build so `--enable-libshine` picks up `libshine`.

Notes
- This script is intentionally minimal: it compiles all `.c` files found in `third_party/shine` and links them into `libshine.so`. If the shine tree has a different layout, adjust the script accordingly.
- The produced `libshine.so` will be ABI-specific and suitable for linking into an FFmpeg cross-build.
