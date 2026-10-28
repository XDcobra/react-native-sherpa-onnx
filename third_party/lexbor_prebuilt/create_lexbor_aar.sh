#!/usr/bin/env bash
# Create a lexbor AAR from the prebuilt layout.
# Layout: <layout_dir>/arm64-v8a/, armeabi-v7a/, x86/, x86_64/ (.so) and include/ (headers).
# Usage: ./create_lexbor_aar.sh <layout_dir> <version> [output_path]
# Example: ./create_lexbor_aar.sh lexbor-android-layout 3.0.0

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <layout_dir> <version> [output_path]"
  echo "  layout_dir  e.g. lexbor-android-layout (has arm64-v8a/, …, include/)"
  echo "  version     Maven-style version, e.g. 3.0.0"
  echo "  output_path optional; default lexbor-<version>.aar"
  exit 1
fi

LAYOUT_DIR="$1"
VERSION="$2"
OUTPUT_PATH="${3:-lexbor-${VERSION}.aar}"
ABIS="arm64-v8a armeabi-v7a x86 x86_64"

if [ ! -d "$LAYOUT_DIR" ]; then
  echo "Error: Layout dir not found: $LAYOUT_DIR"
  exit 1
fi

AAR_DIR="lexbor-aar-staging.$$"
mkdir -p "$AAR_DIR/jni"

for abi in $ABIS; do
  SRC="$LAYOUT_DIR/$abi"
  DST="$AAR_DIR/jni/$abi"
  if [ -d "$SRC" ]; then
    mkdir -p "$DST"
    cp -v "$SRC"/*.so "$DST/" 2>/dev/null || true
  fi
done

if [ -d "$LAYOUT_DIR/include" ]; then
  mkdir -p "$AAR_DIR/include"
  cp -R "$LAYOUT_DIR/include/"* "$AAR_DIR/include/"
fi

cat > "$AAR_DIR/AndroidManifest.xml" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.xdcobra.sherpa.lexbor">
  <uses-sdk android:minSdkVersion="21" />
</manifest>
EOF

touch "$AAR_DIR/R.txt"

(cd "$AAR_DIR" && zip -r -q "../${OUTPUT_PATH}" .)
rm -rf "$AAR_DIR"
echo "Created $OUTPUT_PATH"
