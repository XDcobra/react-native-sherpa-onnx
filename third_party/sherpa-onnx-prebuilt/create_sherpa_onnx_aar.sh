#!/usr/bin/env bash
# Create a sherpa-onnx AAR from the prebuilt layout (android/<abi>/lib/*.so,
# android/java/classes.jar or classes-java.jar, optional android/c-api/*.h).
#
# Usage: ./create_sherpa_onnx_aar.sh <prebuilt_dir> <version> [output_path] [mode]
#   mode: native | kotlin | java  (default: native)
#
# Examples:
#   ./create_sherpa_onnx_aar.sh third_party/sherpa-onnx-prebuilt/android 2.0.1-2
#   ./create_sherpa_onnx_aar.sh ... 2.0.1-2 sherpa-onnx-2.0.1-2-kotlin.aar kotlin
#   ./create_sherpa_onnx_aar.sh ... 2.0.1-2 sherpa-onnx-2.0.1-2-java.aar java
#
# Maven layout (from 2.0.1-2):
#   default (no classifier) = native only (jni + c-api + stub classes.jar)
#   classifier kotlin       = fat AAR (natives + Kotlin API)
#   classifier java         = fat AAR (natives + Java Builder API)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <prebuilt_dir> <version> [output_path] [mode]"
  echo "  prebuilt_dir  e.g. third_party/sherpa-onnx-prebuilt/android"
  echo "  version       Maven-style version, e.g. 2.0.1-2"
  echo "  output_path   optional; default depends on mode"
  echo "  mode          native (default) | kotlin | java"
  exit 1
fi

PREBUILT_DIR="$1"
VERSION="$2"
MODE="${4:-native}"

case "$MODE" in
  native)
    OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}.aar}"
    CLASSES_JAR=""
    ;;
  kotlin)
    OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}-kotlin.aar}"
    CLASSES_JAR="$PREBUILT_DIR/java/classes.jar"
    ;;
  java)
    OUTPUT_PATH="${3:-sherpa-onnx-${VERSION}-java.aar}"
    CLASSES_JAR="$PREBUILT_DIR/java/classes-java.jar"
    ;;
  *)
    echo "Error: unknown mode '$MODE' (expected native|kotlin|java)"
    exit 1
    ;;
esac

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
    for bad in libonnxruntime.so libonnxruntime4j_jni.so; do
      if [ -f "$DST/$bad" ]; then
        echo "Error: $bad must not be packaged in sherpa-onnx AAR (use com.xdcobra.sherpa:onnxruntime)."
        exit 1
      fi
    done
  fi
done

if [ "$MODE" = "native" ]; then
  # Valid empty JAR so AAR tooling / AGP accept the archive (no JVM API).
  STUB_DIR="$AAR_DIR/stub-classes"
  mkdir -p "$STUB_DIR"
  (cd "$STUB_DIR" && jar cf "../classes.jar" .)
  rm -rf "$STUB_DIR"
  echo "Native AAR: stub classes.jar (no Kotlin/Java API)"
elif [ -f "$CLASSES_JAR" ] && [ -s "$CLASSES_JAR" ]; then
  cp "$CLASSES_JAR" "$AAR_DIR/classes.jar"
else
  if [ "$MODE" = "java" ]; then
    echo "Error: $CLASSES_JAR not found or empty; Java AAR requires classes-java.jar. Build with --both or --java."
  else
    echo "Error: $CLASSES_JAR not found or empty; Kotlin AAR requires classes.jar. Build with --kotlin or --both and ensure ANDROID_HOME is set."
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

case "$OUTPUT_PATH" in
  /*) OUT_ABS="$OUTPUT_PATH" ;;
  *) OUT_ABS="$(pwd)/$OUTPUT_PATH" ;;
esac
(cd "$AAR_DIR" && zip -r -q "$OUT_ABS" .)
rm -rf "$AAR_DIR"
echo "Created $OUT_ABS (mode=$MODE)"
