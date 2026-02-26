#!/bin/bash
# Download libarchive iOS sources from GitHub Releases and extract to ios/Downloads/libarchive.
# Always downloads (no skip when prebuilts exist). Call from Podfile pre_install so that
# ios/Downloads/libarchive exists before the podspec is evaluated (required when using the SDK from npm).
#
# Usage: run from repo root or from Podfile pre_install, e.g.:
#   system("bash", "#{sdk_path}/ios/scripts/setup-ios-libarchive.sh")
# Or: ./ios/scripts/setup-ios-libarchive.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SDK root = parent of ios/
SDK_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOWNLOADS_DIR="$SDK_ROOT/ios/Downloads"
LIBARCHIVE_DIR="$DOWNLOADS_DIR/libarchive"
TAG_FILE="$SDK_ROOT/third_party/libarchive_prebuilt/IOS_RELEASE_TAG"

# Resolve release tag: env LIBARCHIVE_IOS_RELEASE_TAG, or IOS_RELEASE_TAG file (single source of truth; committed and included in npm package).
RELEASE_TAG="${LIBARCHIVE_IOS_RELEASE_TAG:-}"
if [ -z "$RELEASE_TAG" ] && [ -f "$TAG_FILE" ]; then
  RELEASE_TAG=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
fi
if [ -z "$RELEASE_TAG" ]; then
  echo "Error: IOS_RELEASE_TAG not found at $TAG_FILE. Reinstall the package or run from repo." >&2
  exit 1
fi

AUTH_ARGS=()
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_ARGS+=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

echo "Downloading libarchive iOS sources from release $RELEASE_TAG..."

release_json=$(curl -s "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases/tags/$RELEASE_TAG" 2>/dev/null || true)
if [ -z "$release_json" ] || ! echo "$release_json" | grep -q '"assets"'; then
  echo "Error: Could not fetch release $RELEASE_TAG or no assets (rate limit?)." >&2
  exit 1
fi

download_url=""
if command -v jq &>/dev/null; then
  download_url=$(echo "$release_json" | jq -r '.assets[] | select(.name == "libarchive-ios-sources.zip") | .browser_download_url' | head -1)
else
  download_url=$(echo "$release_json" | grep -o '"browser_download_url": "[^"]*libarchive-ios-sources.zip[^"]*"' | head -1 | sed 's/.*: "//;s/"$//')
fi
if [ -z "$download_url" ]; then
  echo "Error: Asset libarchive-ios-sources.zip not found in release $RELEASE_TAG" >&2
  exit 1
fi

mkdir -p "$DOWNLOADS_DIR"
zip_path="$DOWNLOADS_DIR/libarchive-ios-sources.zip"
if ! curl -L -f "${AUTH_ARGS[@]}" -o "$zip_path" "$download_url"; then
  rm -f "$zip_path"
  exit 1
fi
if ! file "$zip_path" 2>/dev/null | grep -q "Zip archive"; then
  echo "Error: Downloaded file is not a valid zip" >&2
  rm -f "$zip_path"
  exit 1
fi

rm -rf "$LIBARCHIVE_DIR"
mkdir -p "$LIBARCHIVE_DIR"
unzip -q -o "$zip_path" -d "$LIBARCHIVE_DIR"
rm -f "$zip_path"

echo "Libarchive iOS sources extracted to $LIBARCHIVE_DIR"
