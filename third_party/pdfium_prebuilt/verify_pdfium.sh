#!/usr/bin/env bash
# Check a built PDFium binary against what the SDK needs.
#
#   ./verify_pdfium.sh <libpdfium.dylib | pdfium (Mach-O) | libpdfium.so> [--ios-min X.Y]
#
# 1. Every FPDF* function the SDK calls (android/src/main/cpp/pdf/*.cpp) must be
#    exported. A missing one only shows up at runtime otherwise.
# 2. Mach-O: the minimum OS the binary needs (vtool minos) must be <= --ios-min.
#    App Store Connect rejects a framework whose binary needs a newer OS than its
#    Info.plist states (or than the app supports).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK_ROOT="$(cd "$ROOT/../.." && pwd)"
BINARY="${1:?binary path}"
shift || true
IOS_MIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ios-min) IOS_MIN="${2:?}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ -f "$BINARY" ]] || { echo "ERROR: not found: $BINARY" >&2; exit 1; }

# Highest of two dotted versions.
version_gt() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]; }

IS_MACHO=0
file "$BINARY" | grep -q "Mach-O" && IS_MACHO=1

# --- Symbols ---------------------------------------------------------------------------
NM=""
for candidate in "${PDFIUM_NM:-}" "${PDFIUM_LLVM_BIN:+$PDFIUM_LLVM_BIN/llvm-nm}" "$(command -v llvm-nm || true)" "$(command -v nm || true)"; do
  [[ -n "$candidate" && -x "$candidate" ]] && { NM="$candidate"; break; }
done
[[ -n "$NM" ]] || { echo "ERROR: no nm / llvm-nm found" >&2; exit 1; }

NEEDED="$(grep -ohE 'FPDF[A-Za-z_0-9]*[[:space:]]*\(' "$SDK_ROOT"/android/src/main/cpp/pdf/*.cpp \
  | tr -d ' (' | sort -u)"
[[ -n "$NEEDED" ]] || { echo "ERROR: found no FPDF* calls in the SDK sources" >&2; exit 1; }

if [[ "$IS_MACHO" == "1" ]]; then
  EXPORTED="$("$NM" -gU "$BINARY" | awk 'NF >= 3 { print $NF }' | sed 's/^_//' | sort -u)"
else
  EXPORTED="$("$NM" -D --defined-only "$BINARY" | awk 'NF >= 3 { print $NF }' | sort -u)"
fi

MISSING="$(comm -23 <(printf '%s\n' "$NEEDED") <(printf '%s\n' "$EXPORTED") || true)"
COUNT="$(printf '%s\n' "$NEEDED" | wc -l | tr -d ' ')"
if [[ -n "$MISSING" ]]; then
  echo "ERROR: $BINARY does not export these FPDF functions the SDK calls:" >&2
  printf '  %s\n' $MISSING >&2
  exit 1
fi
echo "OK: all $COUNT FPDF functions used by the SDK are exported ($(basename "$BINARY"))"

# --- Minimum OS (Mach-O) -----------------------------------------------------------------
if [[ "$IS_MACHO" == "1" ]]; then
  MINOS_LIST="$(xcrun vtool -show-build "$BINARY" | awk '$1 == "minos" { print $2 }' | sort -uV)"
  [[ -n "$MINOS_LIST" ]] || { echo "ERROR: vtool reported no minos for $BINARY" >&2; exit 1; }
  MINOS="$(echo "$MINOS_LIST" | tail -1)"
  echo "minos: $MINOS"
  if [[ -n "$IOS_MIN" ]] && version_gt "$MINOS" "$IOS_MIN"; then
    echo "ERROR: $BINARY needs iOS $MINOS, but the minimum must be $IOS_MIN" >&2
    exit 1
  fi
  [[ -n "$IOS_MIN" ]] && echo "OK: minos $MINOS <= $IOS_MIN"
fi
