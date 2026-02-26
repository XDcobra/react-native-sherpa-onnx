#!/usr/bin/env bash
# Check if sherpa-onnx prebuilt libraries were built with Qualcomm QNN (NPU) support.
# Usage: ./check-qnn-support.sh [path-to-libsherpa-onnx-jni.so]
#        ./check-qnn-support.sh [path-to-directory-containing-libs]
# If no argument, checks ./build-android-arm64-v8a/install/lib/ and current dir.

set -e

LIBS_DIR=""
LIB_FILE=""

if [ -n "$1" ]; then
  if [ -d "$1" ]; then
    LIBS_DIR="$1"
  elif [ -f "$1" ]; then
    LIB_FILE="$1"
  else
    echo "Usage: $0 [path-to-libsherpa-onnx-jni.so or path-to-lib-directory]"
    exit 1
  fi
else
  # Default: repo prebuilt output or current dir
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_BUILD="$SCRIPT_DIR/../third_party/sherpa-onnx-prebuilt/android/arm64-v8a/lib"
  if [ -d "$REPO_BUILD" ] && [ -f "$REPO_BUILD/libsherpa-onnx-jni.so" ]; then
    LIBS_DIR="$REPO_BUILD"
  else
    LIBS_DIR="."
  fi
fi

if [ -z "$LIB_FILE" ] && [ -n "$LIBS_DIR" ]; then
  LIB_FILE="$LIBS_DIR/libsherpa-onnx-jni.so"
  if [ ! -f "$LIB_FILE" ]; then
    LIB_FILE="$LIBS_DIR/libsherpa-onnx-c-api.so"
  fi
fi

if [ ! -f "$LIB_FILE" ]; then
  echo "No library found. Tried: $LIB_FILE"
  echo "Usage: $0 [path-to-libsherpa-onnx-jni.so or path-to-lib-directory]"
  exit 1
fi

echo "Checking: $LIB_FILE"
echo ""

# 1) Dynamic dependencies (QNN build MUST link libQnnHtp.so or similar - this is the authoritative check)
echo "=== Dynamic dependencies (readelf -d) ==="
QNN_NEEDED=""
QNN_NEEDED=$(readelf -d "$LIB_FILE" 2>/dev/null | grep -i NEEDED | grep -i qnn) || true
if [ -n "$QNN_NEEDED" ]; then
  echo "$QNN_NEEDED"
  echo "-> QNN library in NEEDED list --> built WITH QNN support (can use NPU at runtime)"
else
  echo "-> No QNN-related library in NEEDED list (no libQnnHtp.so etc.)"
fi
echo ""

# 2) Dynamic symbols (only relevant if NEEDED has QNN; otherwise often just config/error code)
echo "=== Dynamic symbols containing 'qnn' ==="
nm -D "$LIB_FILE" 2>/dev/null | grep -i qnn | head -20 || true
echo ""

# 3) Strings (error messages like 'rebuild with QNN' appear even in non-QNN builds - do not use for verdict)
echo "=== Strings containing 'qnn' (first 10) ==="
strings "$LIB_FILE" 2>/dev/null | grep -i qnn | head -10
echo ""

echo "=== Verdict ==="
if [ -n "$QNN_NEEDED" ]; then
  echo "YES – This library was built WITH QNN support (SHERPA_ONNX_ENABLE_QNN=ON)."
  echo "     It can use Qualcomm NPU when libQnnHtp.so etc. are provided at runtime."
else
  echo "NO – This library was built WITHOUT QNN support (CPU/NNAPI only)."
  echo "     Strings/symbols with 'qnn' are from error messages in the code, not from QNN linkage."
  echo "     To use Qualcomm NPU, rebuild with: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh"
fi
