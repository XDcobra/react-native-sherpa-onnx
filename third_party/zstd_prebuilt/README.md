# zstd prebuilt for libarchive

Builds [zstd](https://github.com/facebook/zstd) for Android and iOS. Output is used by libarchive (with ENABLE_ZSTD=ON).

- **Android:** `build_zstd.sh` → `android/<abi>/lib/libzstd.so` and `android/<abi>/include/`
- **iOS:** `build_zstd_ios.sh` → `ios/<platform>/<arch>/lib/libzstd.a` and `include/`

Prebuilt artifacts (android/, ios/, build-*) are not committed. Run the scripts after `git submodule update --init third_party/zstd`.
