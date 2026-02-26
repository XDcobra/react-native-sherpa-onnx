#!/bin/bash
# Copy libarchive .c files to ios/patched_libarchive and insert <stdio.h> and <unistd.h>
# after #include "archive_platform.h" so they compile without modifying the submodule.
# Called from SherpaOnnx.podspec during evaluation.
# Requires: libarchive source dir (same as used for HEADER_SEARCH_PATHS: third_party or ios/Downloads/libarchive).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBARCHIVE_SRC="${1:-}"
PATCHED_DIR="$SDK_ROOT/ios/patched_libarchive"

if [ -z "$LIBARCHIVE_SRC" ]; then
  echo "Error: libarchive source dir not set. Usage: $0 <libarchive_source_dir>" >&2
  echo "Use the same path as libarchive_dir in the pod (e.g. third_party/libarchive/libarchive or ios/Downloads/libarchive)." >&2
  exit 1
fi

if [ ! -d "$LIBARCHIVE_SRC" ]; then
  echo "Error: libarchive source dir not found: $LIBARCHIVE_SRC" >&2
  echo "Run ios/scripts/setup-ios-libarchive.sh first or ensure third_party/libarchive is present." >&2
  exit 1
fi

if [ ! -f "$LIBARCHIVE_SRC/archive_platform.h" ]; then
  echo "Error: $LIBARCHIVE_SRC does not look like libarchive (archive_platform.h missing)." >&2
  exit 1
fi

mkdir -p "$PATCHED_DIR"
count=0

# Same exclude as podspec: no test, windows, linux, sunos, freebsd
for f in "$LIBARCHIVE_SRC"/*.c; do
  [ -f "$f" ] || continue
  base=$(basename "$f" .c)
  [[ "$(basename "$f")" =~ ^test\. ]] && continue
  [[ "$base" == *windows* ]] && continue
  [[ "$base" == *linux* ]] && continue
  [[ "$base" == *sunos* ]] && continue
  [[ "$base" == *freebsd* ]] && continue

  dest="$PATCHED_DIR/$(basename "$f")"
  # Insert #include <stdio.h> and #include <unistd.h> after first #include "archive_platform.h"
  inserted=0
  while IFS= read -r line; do
    echo "$line"
    if [ "$inserted" -eq 0 ] && echo "$line" | grep -q '^#include "archive_platform.h"'; then
      echo '#include <stdio.h>'
      echo '#include <unistd.h>'
      inserted=1
    fi
  done < "$f" > "$dest"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "Error: No libarchive .c files were copied to $PATCHED_DIR. Check excludes and source dir." >&2
  exit 1
fi
