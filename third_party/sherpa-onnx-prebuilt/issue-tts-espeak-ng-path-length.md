# TTS: espeak-ng data_dir path length causes fallback to /usr/share and init failure (iOS)

**Status:** Known limitation / upstream (espeak-ng)  
**Affects:** iOS (and likely other platforms when path is long)  
**Component:** Offline TTS (Vits/Piper) with bundled espeak-ng

---

## Summary

When initializing a Vits/Piper TTS model, if the absolute path passed to espeak-ng as `data_dir` (the `espeak-ng-data` directory) exceeds an internal buffer size, espeak-ng appears to truncate the path or fall back to a default. The process then tries to load files from `/usr/share/espeak-ng-data`, which does not exist on iOS (or in app sandboxes), and initialization fails with:

```text
Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory.
```

The application may then hit timeouts (e.g. `grpc_wait_for_shutdown_with_timeout() timed out`) and the TTS wrapper is destroyed without a successful init.

---

## Environment

- **Platform:** iOS (Simulator and device)
- **SDK:** react-native-sherpa-onnx (native layer uses sherpa-onnx C++ with bundled espeak-ng)
- **Model:** Vits/Piper TTS models that require `espeak-ng-data` (e.g. `vits-piper-de_DE-thorsten-medium-int8`)
- **espeak-ng:** Fetched and built via sherpa-onnx CMake (e.g. `cmake/espeak-ng-for-piper.cmake`); internal path buffer size is fixed (e.g. `N_PATH_HOME` in `src/libespeak-ng/speech.c`)

---

## Steps to reproduce

1. Build an iOS app that uses react-native-sherpa-onnx Offline TTS with a Vits/Piper model.
2. Provide a **long** model root path so that the resolved `espeak-ng-data` path is long (e.g. > 200 characters). For example:
   - Use a **downloaded** model under the app's Documents directory with a deep path, e.g.  
     `.../Documents/sherpa-onnx/models/tts/<modelId>/<modelId>/`  
     (the doubled `<modelId>` is common when the tarball extracts a top-level folder with the same name).
   - Or bundle the model as an asset but under a **nested/long** path so that the final `data_dir` passed to the native layer is still long, e.g.  
     `.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8/vits-piper-de_DE-thorsten-medium-int8/espeak-ng-data`.
3. Call TTS initialization (e.g. `createTTS` / `initializeTts`) with that model path.
4. Observe logs and process outcome.

---

## Expected behavior

- TTS initializes successfully using the provided `espeak-ng-data` directory.
- No attempt to read from `/usr/share/espeak-ng-data`.
- No crash and no timeout; the app receives a successful init result or a clear error from the SDK.

---

## Actual behavior

- Logs show that the SDK correctly detects and passes a non-empty `data_dir` to the native layer, e.g.  
  `TtsWrapper: TTS: vits data_dir=.../espeak-ng-data (empty=0)`.
- Despite that, the next line from the espeak-ng library is:  
  `Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory.`
- Followed by grpc timeout and wrapper teardown; TTS init fails.

So the failure occurs **inside** the espeak-ng library (or the sherpa-onnx code that calls it), not in the SDK's path resolution.

---

## Evidence

**Control test (short path, same app/model):**

- Model bundled as asset under a **short** path:  
  `.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8`  
  (single segment; no doubled `modelId`).
- `data_dir` passed to native:  
  `.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8/espeak-ng-data`  
  (~220 characters).
- **Result:** TTS initializes successfully; no `/usr/share/...` error.

**Failure case (long path, same app/model):**

- Model under a **long** path so that `data_dir` is e.g.  
  `.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8/vits-piper-de_DE-thorsten-medium-int8/espeak-ng-data`  
  (~260+ characters).
- **Result:** Same error as with downloaded models:  
  `Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory`  
  and init failure.

Conclusion: the **only** changed variable is the **length** of the path passed to espeak-ng (and whether it gets truncated in a fixed-size buffer). Source of the model (downloaded vs asset) does not matter; path length does.

---

## Logs (failure case)

```text
[TtsModelDetect] DetectTtsModel: modelDir=.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8 espeak-ng dataDir=.../vits-piper-de_DE-thorsten-medium-int8/vits-piper-de_DE-thorsten-medium-int8/espeak-ng-data (empty=0)
TtsWrapper: TTS: modelDir=.../VoiceLabOfflineTools.app/models/vits-piper-de_DE-thorsten-medium-int8
TtsWrapper: TTS: vits data_dir=.../vits-piper-de_DE-thorsten-medium-int8/espeak-ng-data (empty=0)
TtsWrapper: TTS: Creating OfflineTts instance...
Error processing file '/usr/share/espeak-ng-data/phontab': No such file or directory.
WARNING: All log messages before absl::InitializeLog() is called are written to STDERR
E0000 00:00:... init.cc:232] grpc_wait_for_shutdown_with_timeout() timed out.
TtsWrapper: TtsWrapper destroyed
```

---

## Root cause (hypothesis)

- In espeak-ng, the data path is stored in a fixed-size buffer (`N_PATH_HOME` in `src/libespeak-ng/speech.h` / `speech.c`). On Posix (iOS) the default is `N_PATH_HOME_DEF` 255; paths longer than that are truncated.
- If the caller passes a longer path, it is truncated. The truncated path is invalid, so espeak-ng does not find `phontab` (and possibly other files) and falls back to a default path such as `/usr/share/espeak-ng-data`.
- On iOS (and in app sandboxes), that path does not exist, so initialization fails.

---

## Solution options (for SDK / xcframework suppliers)

When choosing how to fix this in react-native-sherpa-onnx (or when building the sherpa-onnx xcframework), these constraints are often desired:

- Do **not** depend on sherpa-onnx or espeak-ng fixing it upstream first.
- Do **not** modify submodule or third-party source in the repo (no dirty submodules).
- Do **not** require maintaining a fork of sherpa-onnx or espeak-ng.
- Fix it **in one place**, in a **robust** way, given that the xcframework is built and supplied separately.

Evaluation:

| Option | No wait for upstream | No submodule edits | No fork | Clean & robust (single place) |
|--------|----------------------|--------------------|---------|--------------------------------|
| **A. Symlink in SDK (native)** | ✅ | ✅ | ✅ | ✅ |
| **B. Build-time patch (espeak-ng)** | ✅ | ✅* | ✅ | ⚠️ |
| **C. Rely on upstream** | ❌ | ✅ | ✅ | N/A |

\*Patch is applied to the **fetched** espeak-ng copy in the build tree (e.g. `build/_deps/espeak_ng-src/`), not to the sherpa-onnx submodule. The submodule stays clean; only the build pipeline changes.

### Recommended: A. Symlink in SDK (native layer)

**Idea:** In the react-native-sherpa-onnx native code (iOS and Android), immediately before TTS initialization: if the resolved `modelDir` path is longer than a safe threshold (e.g. 200 characters), create a **symlink** in a short directory (e.g. app Caches) that points to the real model directory, and pass the **symlink path** as `modelDir` to `DetectTtsModel` / `OfflineTts::Create`. The native code then resolves `espeak-ng-data` under that short path; the kernel resolves the symlink so the real files are read.

**Why it fits:**

- **No wait for upstream** — Fix is entirely inside this SDK.
- **No submodule edits** — All changes are in react-native-sherpa-onnx (e.g. `ios/`, `android/`); third_party/sherpa-onnx and the xcframework binary stay unchanged.
- **No fork** — No fork of sherpa-onnx or espeak-ng.
- **Clean and robust** — One place (TTS init path on iOS + Android), one rule (path too long → use symlink). Works with any prebuilt xcframework; no custom build steps.

**Implementation outline:**

- **iOS:** In `SherpaOnnx+TTS.mm` or the TTS wrapper, before calling `TtsWrapper::initialize(modelDirStr, ...)`: if `modelDirStr.length() > kMaxPathLengthForEspeak` (e.g. 200), create a symlink at `[CachesDirectory]/sherpa_tts_<shortId>` → real path, then pass the symlink path as `modelDir`. Optionally remove the symlink when the TTS instance is released (or reuse one symlink per process).
- **Android:** Same idea in the TTS init path: if path too long, create a symlink (or copy/link under a short app dir) and pass that path to the native call. Note: symlink support in app storage varies by Android version and partition; document or fall back to "copy to short path" if needed.
- **Threshold:** Use a constant (e.g. 200) so that `data_dir` (modelDir + `/espeak-ng-data`) stays under the effective espeak-ng limit.

No changes to the xcframework build; the same binary works for all apps.

### Alternative: B. Build-time patch when building the xcframework (implemented)

**Idea:** When building the sherpa-onnx xcframework, ensure espeak-ng is compiled with a larger path buffer by passing a compile definition (`N_PATH_HOME=512`) to the espeak-ng target. No change to espeak-ng source; the define overrides the default in `speech.h` (`#ifndef N_PATH_HOME`).

**Implementation in this repo:** The iOS XCFramework is built by `third_party/sherpa-onnx-prebuilt/build_sherpa_onnx_ios.sh`. That script patches sherpa-onnx's `cmake/espeak-ng-for-piper.cmake` inline (adds `target_compile_definitions(espeak-ng PRIVATE N_PATH_HOME=512)` after `add_subdirectory(espeak_ng ...)`), so the espeak-ng library is built with a 512-byte path buffer. The workflow (`.github/workflows/framework-sherpa-onnx-ios-framework.yml`) invokes this build script.

**Why it fits:**

- **No wait for upstream** — You fix the limit in your build.
- **Single, clean patch** — One line added in sherpa-onnx's CMake; no sed on espeak-ng source. The patch applies to the sherpa-onnx tree used for the build (submodule or clone).
- **No fork** — You don't fork espeak-ng; the define is passed at build time.
- **Trade-off** — The patch modifies sherpa-onnx's `cmake/espeak-ng-for-piper.cmake` in the build copy. If that file layout changes, the inline patch in `build_sherpa_onnx_ios.sh` may need updating.

---

## Workarounds (for app developers, before SDK implements a fix)

1. **Keep the effective path short**
   - Prefer a **short** model root so that the final `data_dir` (path to `espeak-ng-data`) is under the effective limit (e.g. avoid deep or doubled directory names).
   - For **bundled** models: place the model so the asset path has a single short segment, e.g. `models/<modelId>/` with no extra nesting.
   - For **downloaded** models: either install to a short base path or use a **symlink**: create a short path (e.g. under Caches or a short-named folder) that points to the real model directory, and pass the symlink path as the model root so that `data_dir` stays short.

2. **Patch espeak-ng at build time**
   - When building sherpa-onnx (and thus espeak-ng), ensure the espeak-ng target is built with `N_PATH_HOME=512` so long paths are not truncated. For a **local** iOS XCFramework build, run `third_party/sherpa-onnx-prebuilt/build_sherpa_onnx_ios.sh <git_ref>` (e.g. `./build_sherpa_onnx_ios.sh v1.12.28`); it patches `cmake/espeak-ng-for-piper.cmake` automatically. If you build from a sherpa-onnx tree directly, apply the same CMake change (add `target_compile_definitions(espeak-ng PRIVATE N_PATH_HOME=512)` after `add_subdirectory(espeak_ng ...)` in `cmake/espeak-ng-for-piper.cmake`) before running `build-ios.sh`.

3. **Upstream**
   - Report or track this with the espeak-ng and/or sherpa-onnx upstream projects (include these steps, logs, and the short-vs-long path comparison) so that a proper fix (e.g. dynamic buffer or larger limit) can be considered.

---

## References

- sherpa-onnx TTS uses espeak-ng for Piper/Vits phonemization; `data_dir` is set from model detection and passed to `espeak_Initialize()` (e.g. in `piper-phonemize-lexicon.cc`).
- espeak-ng is pulled in by sherpa-onnx CMake: `cmake/espeak-ng-for-piper.cmake`.
- Related SDK docs: [Model setup](../../docs/model-setup.md) (troubleshooting table) and [TTS](../../docs/tts.md).
