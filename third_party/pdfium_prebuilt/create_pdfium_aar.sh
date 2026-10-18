#!/usr/bin/env bash
# Create a minimal AAR containing jni/<abi>/*.so and include/ headers.
# Usage: ./create_pdfium_aar.sh <layout-dir> <maven-version> <out.aar>
set -euo pipefail
LAYOUT="${1:?layout dir}"
VER="${2:?maven version}"
OUT="${3:?output aar path}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/jni" "$TMP/include"
for abi in arm64-v8a armeabi-v7a x86 x86_64; do
  if [[ -d "$LAYOUT/$abi" ]]; then
    mkdir -p "$TMP/jni/$abi"
    cp "$LAYOUT/$abi"/*.so "$TMP/jni/$abi/" 2>/dev/null || true
  fi
  if [[ -d "$LAYOUT/jni/$abi" ]]; then
    mkdir -p "$TMP/jni/$abi"
    cp "$LAYOUT/jni/$abi"/*.so "$TMP/jni/$abi/" 2>/dev/null || true
  fi
done
if [[ -d "$LAYOUT/include" ]]; then
  cp -R "$LAYOUT/include/." "$TMP/include/"
fi

cat > "$TMP/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.xdcobra.sherpa.pdfium">
</manifest>
EOF

mkdir -p "$TMP/META-INF/com/android/build/gradle"
cat > "$TMP/META-INF/com/android/build/gradle/aar-metadata.properties" <<EOF
aarFormatVersion=1.0
aarMetadataVersion=1.0
minCompileSdk=1
minCompileSdkExtension=0
minAndroidGradlePluginVersion=1.0.0
EOF

OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
(
  cd "$TMP"
  zip -r "$OUT_ABS" AndroidManifest.xml jni include META-INF
)
echo "Wrote $OUT_ABS (version hint: $VER)"
