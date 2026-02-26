#!/usr/bin/env bash
# Create a sherpa-onnx AAR from the prebuilt layout (android/<abi>/lib/*.so, android/java/classes.jar or classes-java.jar, optional android/c-api/*.h).
# Usage: ./create_sherpa_onnx_aar.sh <prebuilt_dir> <version> [output_path] [java]
# Example: ./create_sherpa_onnx_aar.sh third_party/sherpa-onnx-prebuilt/android 1.12.24
#          ./create_sherpa_onnx_aar.sh third_party/sherpa-onnx-prebuilt/android 1.12.24 sherpa-onnx-1.12.24-java.aar java
# Output: sherpa-onnx-<version>.aar (Kotlin API) or sherpa-onnx-<version>-java.aar (Java API if 4th arg = "java")
# Includes C-API headers (c-api/) when present so Maven consumers get libs + headers without GitHub release.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <prebuilt_dir> <version> [output_path] [java]"
  echo "  prebuilt_dir  e.g. third_party/sherpa-onnx-prebuilt/android"
  echo "  version       Maven-style version, e.g. 1.12.24"
  echo "  output_path   optional; default sherpa-onnx-<version>.aar or sherpa-onnx-<version>-java.aar if [java]"
  echo "  java          if set, use classes-java.jar (Builder API) instead of classes.jar (Kotlin API)"
  exit 1
fi

PREBUILT_DIR="$1"
VERSION="$2"
USE_JAVA="${4:-}"
if [ -n "$USE_JAVA" ]; then
  OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}-java.aar}"
  CLASSES_JAR="$PREBUILT_DIR/java/classes-java.jar"
else
  OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}.aar}"
  CLASSES_JAR="$PREBUILT_DIR/java/classes.jar"
fi
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

if [ -f "$CLASSES_JAR" ] && [ -s "$CLASSES_JAR" ]; then
  cp "$CLASSES_JAR" "$AAR_DIR/classes.jar"
else
  if [ -n "$USE_JAVA" ]; then
    echo "Error: $CLASSES_JAR not found or empty; Java AAR requires a valid classes-java.jar. Build with --both or --java."
  else
    echo "Error: $CLASSES_JAR not found or empty; Kotlin AAR requires a valid classes.jar. Build with --kotlin or --both and ensure ANDROID_HOME is set for the Kotlin API build."
  fi
  exit 1
fi

# C-API headers (for native SDK builds; same layout as release zip so Gradle can extract to include/sherpa-onnx/)
if [ -d "$PREBUILT_DIR/c-api" ]; then
  mkdir -p "$AAR_DIR/c-api"
  cp -v "$PREBUILT_DIR/c-api/"*.h "$AAR_DIR/c-api/" 2>/dev/null || true
else
  SHERPA_CAPI="$SCRIPT_DIR/../sherpa-onnx/sherpa-onnx/c-api"
  if [ -d "$SHERPA_CAPI" ]; then
    mkdir -p "$AAR_DIR/c-api"
    cp -v "$SHERPA_CAPI/"*.h "$AAR_DIR/c-api/" 2>/dev/null || true
  fi
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
