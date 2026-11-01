# libvpx Prebuilts (Android + iOS)

Cross-compile [libvpx](https://github.com/webmproject/libvpx) (WebM VP9 encoder) so FFmpeg can `--enable-libvpx` / `--enable-encoder=libvpx-vp9`.

- **Source:** `third_party/libvpx` (submodule). Pinned tag: **`v1.17.0`**.
- **Scope:** VP9 **encoder only** (`--disable-vp8 --disable-vp9-decoder --enable-vp9-encoder`). FFmpeg’s native LGPL `vp9` decoder is compiled separately and does not need libvpx.
- **License:** BSD-3-Clause + WebM `PATENTS` grant. Full text: `THIRD_PARTY_LICENSES/libvpx.txt`.

## Android

```bash
export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/29.0.14206865"
# optional: ABIS=arm64-v8a ANDROID_API=21
cd third_party/libvpx_prebuilt
./build_libvpx.sh
```

Output:

- `android/<abi>/lib/libvpx.a` (static; libvpx does not support shared on `*-android-gcc`)
- `android/<abi>/include/vpx/`
- `android/<abi>/lib/pkgconfig/vpx.pc`

Then build FFmpeg (`third_party/ffmpeg_prebuilt/build_ffmpeg.sh`), which requires this prefix per ABI (same pattern as shine/opus).

## iOS

```bash
cd third_party/libvpx_prebuilt
./build_libvpx_ios.sh
```

Output (static; merged into `FFmpeg.xcframework` by `build_ffmpeg_ios.sh`):

- `ios/iphoneos/arm64/lib/libvpx.a`
- `ios/iphonesimulator/arm64/lib/libvpx.a`
- `ios/iphonesimulator/x86_64/lib/libvpx.a`
- `ios/iphonesimulator/universal/lib/libvpx.a`

libvpx has no `arm64-iphonesimulator-gcc` target; the Apple Silicon simulator slice uses `generic-gnu` with the iOS simulator SDK.

## CI

FFmpeg Android/iOS (and vsw) workflows build libvpx before FFmpeg. Android links `libvpx.a` into `libavcodec.so`; iOS merges `libvpx.a` into `FFmpeg.xcframework`.
