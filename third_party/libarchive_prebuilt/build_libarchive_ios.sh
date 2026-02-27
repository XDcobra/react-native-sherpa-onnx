#!/usr/bin/env bash
# Package libarchive sources for iOS (no compilation).
# Used by build-libarchive-ios-release.yml to create libarchive-ios-sources.zip.
# Requires: libarchive source in ../../third_party/libarchive (submodule).
# Output: libarchive-ios-layout/ with .c and .h files needed to build libarchive on iOS (Darwin).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBARCHIVE_SRC="$REPO_ROOT/third_party/libarchive"
LIBARCHIVE_LIB="$LIBARCHIVE_SRC/libarchive"
OUTPUT_DIR="$SCRIPT_DIR/libarchive-ios-layout"

if [ ! -d "$LIBARCHIVE_LIB" ] || [ ! -f "$LIBARCHIVE_LIB/archive.h" ]; then
    echo "Error: libarchive source not found at $LIBARCHIVE_LIB"
    echo "Run: git submodule update --init third_party/libarchive"
    exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Copy .c files, excluding test and non-Darwin platform files (same logic as podspec).
for f in "$LIBARCHIVE_LIB"/*.c; do
    [ -f "$f" ] || continue
    base=$(basename "$f" .c)
    name=$(basename "$f")
    if [[ "$name" == test.* ]]; then
        continue
    fi
    if [[ "$base" == *windows* ]] || [[ "$base" == *linux* ]] || [[ "$base" == *sunos* ]] || [[ "$base" == *freebsd* ]]; then
        continue
    fi
    cp -v "$f" "$OUTPUT_DIR/"
done

# Copy all headers from libarchive (public and private) so .c files that include
# e.g. archive_write_private.h, archive_cmdline_private.h, archive_xxhash.h resolve.
for h in "$LIBARCHIVE_LIB"/*.h; do
    [ -f "$h" ] && cp -v "$h" "$OUTPUT_DIR/"
done

echo "Done. Output: $OUTPUT_DIR"
echo "  .c files: $(find "$OUTPUT_DIR" -name '*.c' | wc -l)"
echo "  .h files: $(find "$OUTPUT_DIR" -name '*.h' | wc -l)"
