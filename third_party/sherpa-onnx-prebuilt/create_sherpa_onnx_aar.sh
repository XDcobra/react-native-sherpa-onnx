#!/usr/bin/env bash
# Create a sherpa-onnx AAR from the prebuilt layout (android/<abi>/lib/*.so, android/java/classes.jar).
# Usage: ./create_sherpa_onnx_aar.sh <prebuilt_dir> <version> [output_path]
# Example: ./create_sherpa_onnx_aar.sh third_party/sherpa-onnx-prebuilt/android 1.12.24
# Output: sherpa-onnx-<version>.aar (modular: POM will declare dependency on com.xdcobra.sherpa:onnxruntime)

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <prebuilt_dir> <version> [output_path]"
  echo "  prebuilt_dir  e.g. third_party/sherpa-onnx-prebuilt/android"
  echo "  version       Maven-style version, e.g. 1.12.24"
  exit 1
fi

PREBUILT_DIR="$1"
VERSION="$2"
OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}.aar}"
ABIS="arm64-v8a armeabi-v7a x86 x86_64"

if [ ! -d "$PREBUILT_DIR" ]; then
  echo "Error: Prebuilt dir not found: $PREBUILT_DIR"
  exit 1
fi

AAR_DIR="sherpa-onnx-aar-staging.$$"
mkdir -p "$AAR_DIR/jni"
mkdir -p "$AAR_DIR/res"

for abi in $ABIS; do
  SRC="$PREBUILT_DIR/$abi/lib"
  DST="$AAR_DIR/jni/$abi"
  if [ -d "$SRC" ]; then
    mkdir -p "$DST"
    cp -v "$SRC"/*.so "$DST/" 2>/dev/null || true
  fi
done

if [ -f "$PREBUILT_DIR/java/classes.jar" ]; then
  cp "$PREBUILT_DIR/java/classes.jar" "$AAR_DIR/classes.jar"
else
  echo "Warning: $PREBUILT_DIR/java/classes.jar not found; AAR will have no Java API."
  touch "$AAR_DIR/classes.jar"
fi

cat > "$AAR_DIR/AndroidManifest.xml" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.xdcobra.sherpa.sherpaonnx">
  <uses-sdk android:minSdkVersion="24" />
</manifest>
EOF

touch "$AAR_DIR/R.txt"

(cd "$AAR_DIR" && zip -r -q "../${OUTPUT_PATH}" .)
rm -rf "$AAR_DIR"
echo "Created $OUTPUT_PATH"
