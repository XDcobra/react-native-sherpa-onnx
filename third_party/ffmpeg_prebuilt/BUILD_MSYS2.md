# Building FFmpeg for Android in the MSYS2 MinGW64 console

This script builds the FFmpeg prebuilts directly in the **MSYS2 MinGW64 shell**. You get full `configure` and `make` output in the terminal without going through PowerShell.

## Prerequisites

1. **MSYS2** installed (e.g. under `C:\msys64`).
2. **MinGW64 packages** – in the MSYS2 MinGW64 shell run:
   ```bash
   pacman -S --noconfirm make yasm diffutils mingw-w64-x86_64-gcc
   ```
3. **Optional, for visible configure/make output:** To get line-by-line output, `stdbuf` (from coreutils) can be used. In the **MSYS2 shell** (not MinGW64) run:
   ```bash
   pacman -S --noconfirm coreutils
   ```
   Then `stdbuf` should be available in the MinGW64 shell; the script uses it automatically if present.
4. **Android NDK** installed (e.g. via Android Studio / SDK Manager).

## Environment variables

Set **at least** the following before running the script:

| Variable | Required | Description |
|----------|----------|-------------|
| **`ANDROID_NDK_ROOT`** or **`ANDROID_NDK_HOME`** | Yes | Absolute path to the Android NDK. Either variable is sufficient. |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| **`ANDROID_API`** | `24` | Android API level for the NDK toolchain. |
| **`NPROC`** | Number of CPU cores | Number of parallel make jobs. |

### Examples (in the MSYS2 MinGW64 shell)

Windows path (converted to MSYS2 path inside the script):

```bash
export ANDROID_NDK_ROOT="C:/path/to/Android/Sdk/ndk/27.0.12077973"
```

Or MSYS2 path:

```bash
export ANDROID_NDK_ROOT="/c/path/to/Android/Sdk/ndk/27.0.12077973"
```

Optional – set API level:

```bash
export ANDROID_API=24
```

## Steps

1. **Start MSYS2** and open **“MSYS2 MinGW 64-bit”** (MinGW64 shell).

2. **Set repository path and environment variables**, e.g.:
   ```bash
   cd /c/path/to/react-native-sherpa-onnx-core/third_party/ffmpeg_prebuilt
   export ANDROID_NDK_ROOT="C:/path/to/your/ndk"
   ```

3. **Initialize the FFmpeg submodule** (if not already done):
   ```bash
   cd /c/path/to/react-native-sherpa-onnx-core
   git submodule update --init third_party/ffmpeg
   cd third_party/ffmpeg_prebuilt
   ```

4. **Run the build**:
   ```bash
   ./build_ffmpeg_msys2.sh
   ```

5. After a successful build, the libraries are under:
   `third_party/ffmpeg_prebuilt/android/` (per ABI: `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`).

## Notes

- The script derives repo root and FFmpeg source path from the script directory; run it from `third_party/ffmpeg_prebuilt`.
- **Configure output:** FFmpeg’s `configure` has no option for live progress on the console (only `--quiet` and `--logfile`). The script therefore starts `tail -f ffbuild/config.log` in the background so you see the progress of the checks in the same console. At the end of configure, the usual summary (prefix, compiler, enabled features) is also printed.
- On errors, messages from `configure`/`make` appear directly in the console.
