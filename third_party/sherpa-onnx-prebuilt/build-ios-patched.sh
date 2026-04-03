#!/usr/bin/env bash
#
# Do not run this script directly for normal iOS framework builds. Use:
#   third_party/sherpa-onnx-prebuilt/build_sherpa_onnx_ios.sh <GIT_REF>
# (from the repo root). That script applies this file over the sherpa-onnx submodule's build-ios.sh
# when CI/hash checks pass, runs CMake/xcodebuild, merges ONNX Runtime into the xcframework, etc.
#
# Patched replacement for k2-fsa/sherpa-onnx build-ios.sh (kept in-repo so the submodule stays clean).
#
# Why this exists:
# - Upstream build-ios.sh downloads ONNX Runtime 1.17.x as onnxruntime.xcframework-*.tar.bz2 with
#   libs at each slice root (e.g. ios-arm64/onnxruntime.a) and Headers at the xcframework root.
# - Newer ORT releases from csukuangfj/onnxruntime-libs (e.g. 1.24.2) ship onnxruntime-ios-static-
#   xcframework-VERSION.zip: per-slice onnxruntime.framework/onnxruntime, headers inside each framework.
# - sherpa-onnx CMake on Apple looks for libonnxruntime.a in SHERPA_ONNXRUNTIME_LIB_DIR; we add a
#   symlink onnxruntime -> libonnxruntime.a inside each onnxruntime.framework.
# - This script also includes the C++ API archive (libsherpa-onnx-cxx-api.a) in the lipo/libtool
#   steps, matching what third_party/sherpa-onnx-prebuilt/build_sherpa_onnx_ios.sh would inject via sed
#   into vanilla upstream — so CI can skip duplicate sed when this file is already applied.
#
# ONNX Runtime version: set ONNXRUNTIME_VERSION (e.g. in GitHub Actions) or default below.
#
set -e

dir=build-ios
mkdir -p $dir
cd $dir
onnxruntime_version="${ONNXRUNTIME_VERSION:-1.24.2}"
onnxruntime_dir=ios-onnxruntime/$onnxruntime_version
onnxruntime_zip=onnxruntime-ios-static-xcframework-${onnxruntime_version}.zip
onnxruntime_extract_root=onnxruntime-ios-static-xcframework-${onnxruntime_version}

SHERPA_ONNX_GITHUB=github.com

if [ "$SHERPA_ONNX_GITHUB_MIRROW" == true ]; then
    SHERPA_ONNX_GITHUB=hub.nuaa.cf
fi

# ORT 1.24+ static xcframework: per-slice onnxruntime.framework/onnxruntime; CMake wants libonnxruntime.a.
ort_symlink_libonnxruntime_a() {
  local xcf="$1"
  for slice in ios-arm64 ios-arm64_x86_64-simulator; do
    local fw="${xcf}/${slice}/onnxruntime.framework"
    if [ -f "${fw}/onnxruntime" ] && [ ! -e "${fw}/libonnxruntime.a" ]; then
      (cd "${fw}" && ln -sf onnxruntime libonnxruntime.a)
    fi
  done
}

if [ ! -f $onnxruntime_dir/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime ]; then
  mkdir -p $onnxruntime_dir
  pushd $onnxruntime_dir
  wget -c "https://${SHERPA_ONNX_GITHUB}/csukuangfj/onnxruntime-libs/releases/download/v${onnxruntime_version}/${onnxruntime_zip}"
  unzip -oq "${onnxruntime_zip}"
  rm -f "${onnxruntime_zip}"
  mv "${onnxruntime_extract_root}/onnxruntime.xcframework" .
  rm -rf "${onnxruntime_extract_root}"
  ort_symlink_libonnxruntime_a "$PWD/onnxruntime.xcframework"
  cd ..
  ln -sf $onnxruntime_version/onnxruntime.xcframework .
  popd
else
  ort_symlink_libonnxruntime_a "$PWD/$onnxruntime_dir/onnxruntime.xcframework"
fi

# First, for simulator
echo "Building for simulator (x86_64)"

export SHERPA_ONNXRUNTIME_LIB_DIR=$PWD/ios-onnxruntime/onnxruntime.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework
export SHERPA_ONNXRUNTIME_INCLUDE_DIR=$PWD/ios-onnxruntime/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Headers

echo "SHERPA_ONNXRUNTIME_LIB_DIR: $SHERPA_ONNXRUNTIME_LIB_DIR"
echo "SHERPA_ONNXRUNTIME_INCLUDE_DIR $SHERPA_ONNXRUNTIME_INCLUDE_DIR"

# Note: We use -DENABLE_ARC=1 here to fix the linking error:
#
# The symbol _NSLog is not defined
#

cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=SIMULATOR64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/simulator_x86_64

cmake --build build/simulator_x86_64 -j 4 --verbose

echo "Building for simulator (arm64)"

cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=SIMULATORARM64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/simulator_arm64

cmake --build build/simulator_arm64 -j 4 --verbose

echo "Building for arm64"

export SHERPA_ONNXRUNTIME_LIB_DIR=$PWD/ios-onnxruntime/onnxruntime.xcframework/ios-arm64/onnxruntime.framework

cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=OS64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/os64

cmake --build build/os64 -j 4
# Generate headers for sherpa-onnx.xcframework
cmake --build build/os64 --target install

echo "Generate xcframework"

mkdir -p "build/simulator/lib"
for f in libkaldi-native-fbank-core.a libkissfft-float.a libsherpa-onnx-c-api.a libsherpa-onnx-cxx-api.a libsherpa-onnx-core.a \
         libsherpa-onnx-fstfar.a libssentencepiece_core.a \
         libsherpa-onnx-fst.a libsherpa-onnx-kaldifst-core.a libkaldi-decoder-core.a \
         libucd.a libpiper_phonemize.a libespeak-ng.a; do
  lipo -create build/simulator_arm64/lib/${f} \
               build/simulator_x86_64/lib/${f} \
       -output build/simulator/lib/${f}
done

# Merge archive first, because the following xcodebuild create xcframework
# cannot accept multi archive with the same architecture.
libtool -static -o build/simulator/libsherpa-onnx.a \
  build/simulator/lib/libkaldi-native-fbank-core.a \
  build/simulator/lib/libkissfft-float.a \
  build/simulator/lib/libsherpa-onnx-c-api.a \
  build/simulator/lib/libsherpa-onnx-cxx-api.a \
  build/simulator/lib/libsherpa-onnx-core.a  \
  build/simulator/lib/libsherpa-onnx-fstfar.a   \
  build/simulator/lib/libsherpa-onnx-fst.a   \
  build/simulator/lib/libsherpa-onnx-kaldifst-core.a \
  build/simulator/lib/libkaldi-decoder-core.a \
  build/simulator/lib/libucd.a \
  build/simulator/lib/libpiper_phonemize.a \
  build/simulator/lib/libespeak-ng.a \
  build/simulator/lib/libssentencepiece_core.a

libtool -static -o build/os64/libsherpa-onnx.a \
  build/os64/lib/libkaldi-native-fbank-core.a \
  build/os64/lib/libkissfft-float.a \
  build/os64/lib/libsherpa-onnx-c-api.a \
  build/os64/lib/libsherpa-onnx-cxx-api.a \
  build/os64/lib/libsherpa-onnx-core.a \
  build/os64/lib/libsherpa-onnx-fstfar.a   \
  build/os64/lib/libsherpa-onnx-fst.a   \
  build/os64/lib/libsherpa-onnx-kaldifst-core.a \
  build/os64/lib/libkaldi-decoder-core.a \
  build/os64/lib/libucd.a \
  build/os64/lib/libpiper_phonemize.a \
  build/os64/lib/libespeak-ng.a \
  build/os64/lib/libssentencepiece_core.a

rm -rf sherpa-onnx.xcframework

xcodebuild -create-xcframework \
      -library "build/os64/libsherpa-onnx.a" -headers install/include \
      -library "build/simulator/libsherpa-onnx.a" -headers install/include  \
      -output sherpa-onnx.xcframework
