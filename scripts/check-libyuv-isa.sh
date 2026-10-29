#!/usr/bin/env bash
# Fail if udot/usdot/smmla appear in object files outside libyuv *_neon64.cc.
# Usage: check-libyuv-isa.sh <object-or-archive> [<more>...]
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <object-or-archive>..." >&2
  exit 2
fi

OBJDUMP="${OBJDUMP:-llvm-objdump}"
if ! command -v "$OBJDUMP" >/dev/null 2>&1; then
  OBJDUMP=objdump
fi

fail=0
for input in "$@"; do
  if [[ ! -f "$input" ]]; then
    echo "missing: $input" >&2
    fail=1
    continue
  fi
  # Archives: dump all members. Objects: dump the file.
  dump="$("$OBJDUMP" -d "$input" 2>/dev/null || true)"
  hits="$(printf '%s\n' "$dump" | grep -E -n '\b(udot|usdot|smmla)\b' || true)"
  if [[ -z "$hits" ]]; then
    continue
  fi
  base="$(basename "$input")"
  case "$base" in
    *neon64*)
      continue
      ;;
  esac
  echo "ERROR: $input contains udot/usdot/smmla outside a *_neon64 object:" >&2
  printf '%s\n' "$hits" | head -20 >&2
  fail=1
done

exit "$fail"
