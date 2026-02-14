# Build minimal FFmpeg (audio-only) for Android on Windows.
# Uses MSYS2 (bash, make) and Android NDK. Does not use build_ffmpeg.sh.

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$FfmpegSrc = Join-Path $RepoRoot "third_party\ffmpeg"
$OutputBase = Join-Path $ScriptDir "android"
$AndroidApi = if ($env:ANDROID_API) { $env:ANDROID_API } else { "24" }

# Resolve NDK path
$NdkPath = $env:ANDROID_NDK_HOME
if (-not $NdkPath) { $NdkPath = $env:ANDROID_NDK_ROOT }
if (-not $NdkPath -and $env:ANDROID_HOME) {
    $NdkDir = Join-Path $env:ANDROID_HOME "ndk"
    if (Test-Path $NdkDir) {
        $Latest = Get-ChildItem $NdkDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($Latest) { $NdkPath = $Latest.FullName }
    }
}
if (-not $NdkPath -or -not (Test-Path $NdkPath)) {
    Write-Error "Android NDK not found. Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT."
    exit 1
}

$Toolchain = Join-Path $NdkPath "toolchains\llvm\prebuilt\windows-x86_64"
if (-not (Test-Path $Toolchain)) {
    Write-Error "NDK toolchain not found at: $Toolchain"
    exit 1
}

# FFmpeg source (submodule)
if (-not (Test-Path (Join-Path $FfmpegSrc "configure"))) {
    Write-Host "Initializing FFmpeg submodule..."
    Set-Location $RepoRoot
    git submodule update --init third_party/ffmpeg
    if (-not (Test-Path (Join-Path $FfmpegSrc "configure"))) {
        Write-Error "FFmpeg source not found at: $FfmpegSrc"
        exit 1
    }
}

# Fix CRLF in configure (submodule may be checked out with CRLF on Windows)
$ConfigurePath = Join-Path $FfmpegSrc "configure"
$bytes = [System.IO.File]::ReadAllBytes($ConfigurePath)
$newBytes = $bytes | Where-Object { $_ -ne 13 }
[System.IO.File]::WriteAllBytes($ConfigurePath, $newBytes)
Write-Host "Normalized configure line endings (CRLF -> LF)."

# MSYS2 path: C:\... -> /c/...
function To-Msys2Path($p) {
    if (-not $p) { return "" }
    $p = $p -replace '\\', '/'
    if ($p -match '^([A-Za-z]):') { $p = "/" + $Matches[1].ToLower() + $p.Substring(2) }
    return $p
}

$NdkMsys = To-Msys2Path $NdkPath
$ToolchainMsys = To-Msys2Path $Toolchain
$FfmpegSrcMsys = To-Msys2Path $FfmpegSrc
$OutputBaseMsys = To-Msys2Path $OutputBase

# Find MSYS2
$Msys2Root = $env:MSYS2_PATH
if (-not $Msys2Root -or -not (Test-Path $Msys2Root)) {
    foreach ($d in @("C:\msys64", "C:\tools\msys64", "C:\tools\msys32")) {
        if (Test-Path $d) { $Msys2Root = $d; break }
    }
}
if (-not $Msys2Root -or -not (Test-Path $Msys2Root)) {
    Write-Error "MSYS2 not found. Set MSYS2_PATH or install to C:\msys64."
    exit 1
}

$Msys2Bash = Join-Path $Msys2Root "usr\bin\bash.exe"
if (-not (Test-Path $Msys2Bash)) {
    Write-Error "MSYS2 bash not found at: $Msys2Bash"
    exit 1
}

$NProc = [System.Environment]::ProcessorCount
if (-not $NProc -or $NProc -lt 1) { $NProc = 4 }

$Msys2RootMsys = To-Msys2Path $Msys2Root

# Bash script: all $VAR that must be expanded by bash must be written as `$VAR (PowerShell escape)
$BuildScriptContent = @"
set -e
# Use MinGW gcc for host (configure) checks so C11 is available; NDK clang is set via --cc/--cxx for target
export MSYS2_ROOT='$Msys2RootMsys'
export PATH="`$MSYS2_ROOT/mingw64/bin:`$PATH"
export ANDROID_NDK_ROOT='$NdkMsys'
OutputBaseMsys='$OutputBaseMsys'
FfmpegSrcMsys='$FfmpegSrcMsys'
TOOLCHAIN="`$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/windows-x86_64"
SYSROOT="`$TOOLCHAIN/sysroot"
API=$AndroidApi
NPROC=$NProc

build_abi() {
    local ABI="`$1" ARCH="`$2" TOOLCHAIN_ARCH="`$3" CPU="`$4"
    local PREFIX="$OutputBaseMsys/`$ABI"
    local CC="`$TOOLCHAIN/bin/`${TOOLCHAIN_ARCH}`${API}-clang"
    local CXX="`$TOOLCHAIN/bin/`${TOOLCHAIN_ARCH}`${API}-clang++"
    mkdir -p "`$PREFIX"
    echo "===== Building FFmpeg for `$ABI ====="
    cd "$FfmpegSrcMsys"
    export CFLAGS="-O3 -fPIC -I`$SYSROOT/usr/include"
    export LDFLAGS="-Wl,-z,max-page-size=16384"
    BUILD_LOG="`$OutputBaseMsys/`$ABI/build.log"
    echo "Running ./configure... (Log: `$BUILD_LOG)"
    ./configure --prefix="`$PREFIX" \
        --enable-shared --disable-static --disable-programs --disable-doc --disable-debug \
        --disable-avdevice --disable-swscale --disable-everything \
        --enable-decoder=aac,mp3,mpeg4aac,vorbis,flac,pcm_s16le,pcm_f32le,pcm_s32le,pcm_u8 \
        --enable-demuxer=mov,mp3,ogg,flac,wav,matroska --enable-muxer=wav --enable-encoder=pcm_s16le \
        --enable-parser=aac,mpegaudio,vorbis,flac --enable-protocol=file --enable-swresample \
        --enable-avcodec --enable-avformat --enable-avutil \
        --host-os=windows-x86_64 --target-os=android --enable-cross-compile \
        --strip="`$TOOLCHAIN/bin/llvm-strip" \
        --arch="`$ARCH" --cpu="`$CPU" \
        --sysroot="`$SYSROOT" --sysinclude="`$SYSROOT/usr/include/" \
        --cc="`$CC" --cxx="`$CXX" 2>&1 | tee "`$BUILD_LOG"
    _cfg_exit="`${PIPESTATUS[0]:-0}"
    if [ "`$_cfg_exit" -ne 0 ]; then exit "`$_cfg_exit"; fi
    make -j"`$NPROC" 2>&1 | tee -a "`$BUILD_LOG"
    _make_exit="`${PIPESTATUS[0]:-0}"
    if [ "`$_make_exit" -ne 0 ]; then exit "`$_make_exit"; fi
    make install 2>&1 | tee -a "`$BUILD_LOG"
    _make_exit="`${PIPESTATUS[0]:-0}"
    if [ "`$_make_exit" -ne 0 ]; then exit "`$_make_exit"; fi
    make distclean 2>/dev/null || make clean 2>/dev/null || true
    echo "Successfully built FFmpeg for `$ABI"
}

build_abi armeabi-v7a  arm    armv7a-linux-androideabi  armv7-a
build_abi arm64-v8a    aarch64 aarch64-linux-android    armv8-a
build_abi x86          i686   i686-linux-android        i686
build_abi x86_64       x86_64 x86_64-linux-android      x86-64

mkdir -p "$OutputBaseMsys/include"
cp -R "$OutputBaseMsys/arm64-v8a/include/"* "$OutputBaseMsys/include/" 2>/dev/null || true
echo ""
echo "Build completed. Output: $OutputBaseMsys"
"@

$BuildScriptPath = Join-Path $env:TEMP "build_ffmpeg_android_$(Get-Random).sh"
$BuildScriptContent = $BuildScriptContent -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText($BuildScriptPath, $BuildScriptContent, [System.Text.UTF8Encoding]::new($false))

$BuildScriptMsys = To-Msys2Path $BuildScriptPath
Write-Host "Note: The configure/make outputs are not shown here. In case of abort or errors: View log in third_party\ffmpeg_prebuilt\android\<ABI>\build.log." -ForegroundColor Gray
Write-Host ""
try {
    & $Msys2Bash -l -c "bash '$BuildScriptMsys'"
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE"
    }
} finally {
    if (Test-Path $BuildScriptPath) { Remove-Item $BuildScriptPath -Force }
}

Write-Host ""
Write-Host "Build completed. Output: $OutputBase"
exit 0
