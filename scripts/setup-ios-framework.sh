#!/bin/bash

# Script to download and manage iOS Frameworks (sherpa-onnx, FFmpeg)
# Can be called manually or by Podfile during pod install
# Usage:
#   ./scripts/setup-ios-framework.sh                    # Downloads/updates both frameworks (auto mode, no interactive)
#   ./scripts/setup-ios-framework.sh 1.12.24             # Downloads specific sherpa-onnx version (ffmpeg from its TAG)
#   ./scripts/setup-ios-framework.sh --force            # Remove local caches and re-download both
#   ./scripts/setup-ios-framework.sh --interactive       # Interactive mode with prompts
# To force re-download during pod install: SHERPA_ONNX_IOS_FORCE_DOWNLOAD=1 pod install

set -e

# Resolve package root: explicit (CI), then pod install, then script dir or PWD.
PROJECT_ROOT=""
if [ -n "${SHERPA_ONNX_PROJECT_ROOT}" ] && [ -d "${SHERPA_ONNX_PROJECT_ROOT}" ]; then
  PROJECT_ROOT="${SHERPA_ONNX_PROJECT_ROOT}"
fi
if [ -z "$PROJECT_ROOT" ] && [ -n "${GITHUB_WORKSPACE}" ] && [ -d "${GITHUB_WORKSPACE}/ios" ]; then
  PROJECT_ROOT="${GITHUB_WORKSPACE}"
fi
if [ -z "$PROJECT_ROOT" ] && [ -n "${PODS_TARGET_SRCROOT}" ] && [ -d "${PODS_TARGET_SRCROOT}" ]; then
  PROJECT_ROOT="${PODS_TARGET_SRCROOT}"
fi
if [ -z "$PROJECT_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  if [ -d "$SCRIPT_DIR/../ios" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi
fi
if [ -z "$PROJECT_ROOT" ] && [ -d "$(pwd)/ios" ]; then
  PROJECT_ROOT="$(pwd)"
fi
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: Could not resolve project root. Run from package root or run 'pod install' from example/ios." >&2
  exit 1
fi
FRAMEWORKS_DIR="$PROJECT_ROOT/ios/Frameworks"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Detect if running in interactive mode (terminal)
INTERACTIVE=false
[ -t 0 ] && INTERACTIVE=true

# Check for explicit flags
FORCE_DOWNLOAD=false
if [ "$1" = "--interactive" ]; then
  INTERACTIVE=true
  shift
fi
if [ "$1" = "--force" ]; then
  FORCE_DOWNLOAD=true
  shift
fi
if [ -n "$SHERPA_ONNX_IOS_FORCE_DOWNLOAD" ] && [ "$SHERPA_ONNX_IOS_FORCE_DOWNLOAD" != "0" ]; then
  FORCE_DOWNLOAD=true
fi

# Only print header if interactive
if [ "$INTERACTIVE" = true ]; then
  echo -e "${BLUE}iOS Framework Setup Script${NC}"
  echo "Project root: $PROJECT_ROOT"
  echo ""
fi

# Create frameworks directory if it doesn't exist
mkdir -p "$FRAMEWORKS_DIR"

# Framework slugs to manage (order: sherpa-onnx first, then ffmpeg)
FRAMEWORK_SLUGS=(sherpa-onnx)

if [ "${SHERPA_ONNX_DISABLE_FFMPEG:-0}" = "0" ] && [ "${SHERPA_ONNX_DISABLE_FFMPEG:-false}" != "true" ]; then
  FRAMEWORK_SLUGS+=(ffmpeg)
else
  [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}SHERPA_ONNX_DISABLE_FFMPEG is set. Skipping FFmpeg framework download.${NC}" >&2
fi

# Set config variables for a given framework slug. Call before using TAG_* XCFRAMEWORK_* etc.
get_framework_config() {
  local slug="$1"
  case "$slug" in
    sherpa-onnx)
      TAG_FILE="$PROJECT_ROOT/third_party/sherpa-onnx-prebuilt/IOS_RELEASE_TAG"
      TAG_PREFIX="framework-v"
      XCFRAMEWORK_NAME="sherpa_onnx.xcframework"
      ZIP_ASSET_NAME="sherpa_onnx.xcframework.zip"
      VERSION_FILE="$FRAMEWORKS_DIR/.framework-version-sherpa-onnx"
      LIB_DEVICE="libsherpa-onnx.a"
      LIB_SIMULATOR="libsherpa-onnx.a"
      HEADER_CHECK="Headers/sherpa-onnx/c-api/cxx-api.h"
      DISPLAY_NAME="SherpaOnnx"
      ;;
    ffmpeg)
      TAG_FILE="$PROJECT_ROOT/third_party/ffmpeg_prebuilt/IOS_RELEASE_TAG"
      TAG_PREFIX="ffmpeg-ios-v"
      XCFRAMEWORK_NAME="FFmpeg.xcframework"
      ZIP_ASSET_NAME="ffmpeg-ios-framework.zip"
      VERSION_FILE="$FRAMEWORKS_DIR/.framework-version-ffmpeg"
      LIB_DEVICE="libffmpeg.a"
      LIB_SIMULATOR="libffmpeg.a"
      HEADER_CHECK="Headers/libavcodec/avcodec.h"
      DISPLAY_NAME="FFmpeg"
      ;;
    *)
      echo "Unknown framework: $slug" >&2
      return 1
      ;;
  esac
}

# Helper: check if a framework path is valid for building (has library + required headers)
# Usage: framework_valid <slug> <fw_root>
framework_valid() {
  local slug="$1"
  local fw_root="$2"
  get_framework_config "$slug" || return 1
  [ -f "$fw_root/ios-arm64/$LIB_DEVICE" ] || return 1
  [ -f "$fw_root/ios-arm64_x86_64-simulator/$LIB_SIMULATOR" ] || return 1
  [ -f "$fw_root/ios-arm64_x86_64-simulator/$HEADER_CHECK" ] || return 1
  return 0
}

# Helper: get installed framework version (from version file or xcframework VERSION.txt)
# Usage: get_installed_version <slug>
# Backward compat: for sherpa-onnx, also checks legacy .framework-version
get_installed_version() {
  local slug="$1"
  get_framework_config "$slug" || return 1
  # Backward compat: sherpa-onnx used to use .framework-version
  if [ "$slug" = "sherpa-onnx" ] && [ -f "$FRAMEWORKS_DIR/.framework-version" ]; then
    cat "$FRAMEWORKS_DIR/.framework-version" 2>/dev/null | tr -d '\r\n'
    return 0
  fi
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE" 2>/dev/null | tr -d '\r\n'
    return 0
  fi
  if [ -f "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME/VERSION.txt" ]; then
    grep -Eo '([0-9]+\.)+[0-9]+' "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME/VERSION.txt" | head -n1 | tr -d '\r\n'
    return 0
  fi
  echo ""
}

# Get desired version from a framework's IOS_RELEASE_TAG file.
# Usage: get_desired_version_from_tag <slug>
# Output: version (e.g. 1.12.28 or 8.0.1) or empty if file/tag missing.
get_desired_version_from_tag() {
  local slug="$1"
  get_framework_config "$slug" || return 1
  if [ ! -f "$TAG_FILE" ]; then
    echo ""
    return 0
  fi
  local tag
  tag=$(grep -v '^#' "$TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
  if [ -z "$tag" ] || [ "${tag#$TAG_PREFIX}" = "$tag" ]; then
    echo ""
    return 0
  fi
  echo "${tag#$TAG_PREFIX}"
}

# When run as Xcode build phase: if all frameworks are present, valid, AND match their IOS_RELEASE_TAG, exit successfully.
need_download() {
  local slug="$1"
  local desired="$2"
  get_framework_config "$slug" || return 1
  local fw_path="$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME"
  if [ ! -d "$fw_path" ]; then
    return 0
  fi
  if ! framework_valid "$slug" "$fw_path"; then
    return 0
  fi
  # Backfill version file from xcframework if missing
  if [ ! -f "$VERSION_FILE" ] && [ -f "$fw_path/VERSION.txt" ]; then
    local ver
    ver=$(grep -Eo '([0-9]+\.)+[0-9]+' "$fw_path/VERSION.txt" | head -n1 || true)
    [ -n "$ver" ] && echo "$ver" > "$VERSION_FILE" 2>/dev/null || true
  fi
  local installed
  installed=$(get_installed_version "$slug")
  if [ -n "$desired" ] && [ -n "$installed" ] && [ "$installed" = "$desired" ]; then
    return 1
  fi
  return 0
}

# Prepare GitHub auth header if GITHUB_TOKEN is provided
AUTH_ARGS=()
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_ARGS+=("-H" "Authorization: Bearer $GITHUB_TOKEN")
fi

# Explicit version on command line overrides sherpa-onnx only (backward compat)
SHERPA_DESIRED_OVERRIDE=""
if [ -n "$1" ] && [[ "$1" =~ ^[0-9]+\.([0-9]+\.)*[0-9]+$ ]]; then
  SHERPA_DESIRED_OVERRIDE="$1"
fi

# Return desired version for a framework slug (from TAG, env, or override). No output = use TAG/env only.
get_desired_version() {
  local slug="$1"
  if [ "$slug" = "sherpa-onnx" ] && [ -n "$SHERPA_DESIRED_OVERRIDE" ]; then
    echo "$SHERPA_DESIRED_OVERRIDE"
    return
  fi
  if [ "$slug" = "sherpa-onnx" ] && [ -n "$SHERPA_ONNX_VERSION" ]; then
    echo "$SHERPA_ONNX_VERSION"
    return
  fi
  get_desired_version_from_tag "$slug"
}

# Check early exit: all frameworks present, valid, and matching their desired version
SKIP_ALL=true
for slug in "${FRAMEWORK_SLUGS[@]}"; do
  desired=$(get_desired_version "$slug")
  if [ -z "$desired" ] && [ "$slug" = "sherpa-onnx" ]; then
    SKIP_ALL=false
    break
  fi
  if [ -n "$desired" ] && need_download "$slug" "$desired"; then
    SKIP_ALL=false
    break
  fi
done

if [ "$FORCE_DOWNLOAD" != true ] && [ "$SKIP_ALL" = true ]; then
  for slug in "${FRAMEWORK_SLUGS[@]}"; do
    get_framework_config "$slug" || exit 1
    desired=$(get_desired_version "$slug")
    if [ -n "$desired" ]; then
      installed=$(get_installed_version "$slug")
      echo "[$DISPLAY_NAME] Framework already present at $FRAMEWORKS_DIR/$XCFRAMEWORK_NAME (v$installed), skipping download." >&2
    fi
  done
  
  # Fix CocoaPods header flattening: delete FFmpeg's time.h so it doesn't shadow system time.h
  if [ -d "$FRAMEWORKS_DIR/FFmpeg.xcframework" ]; then
    find "$FRAMEWORKS_DIR/FFmpeg.xcframework" -name "time.h" -path "*/libavutil/time.h" -delete 2>/dev/null || true
  fi

  exit 0
fi

if [ "$FORCE_DOWNLOAD" != true ]; then
  for slug in "${FRAMEWORK_SLUGS[@]}"; do
    get_framework_config "$slug" || exit 1
    desired=$(get_desired_version "$slug")
    if [ -n "$desired" ] && need_download "$slug" "$desired"; then
      installed=$(get_installed_version "$slug")
      [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}[$DISPLAY_NAME] Installed v${installed} does not match TAG ($desired), will re-download.${NC}" >&2
    fi
  done
fi

# Require desired version for sherpa-onnx (main dependency)
if [ -z "$(get_desired_version sherpa-onnx)" ]; then
  get_framework_config "sherpa-onnx" || true
  echo -e "${RED}Error: IOS_RELEASE_TAG not found at $TAG_FILE or invalid format (expected ${TAG_PREFIX}X.Y.Z). Reinstall the package or run from repo.${NC}" >&2
  exit 1
fi

# Function to get local framework version (for display / compare)
get_local_framework_version() {
  local slug="$1"
  get_framework_config "$slug" || return 1
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE"
    return 0
  fi
  if [ "$slug" = "sherpa-onnx" ] && [ -f "$FRAMEWORKS_DIR/.framework-version" ]; then
    cat "$FRAMEWORKS_DIR/.framework-version"
    return 0
  fi
  if [ -f "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME/VERSION.txt" ]; then
    local ver
    ver=$(grep -Eo '([0-9]+\.)+[0-9]+' "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME/VERSION.txt" | head -n1 || true)
    if [ -n "$ver" ]; then
      echo "$ver" > "$VERSION_FILE" 2>/dev/null || true
      echo "$ver"
      return 0
    fi
  fi
  echo ""
}

# Function to download and extract a framework
# Usage: download_and_extract_framework <slug> <version>
download_and_extract_framework() {
  local slug="$1"
  local version="$2"
  get_framework_config "$slug" || return 1
  local tag="${TAG_PREFIX}${version}"

  echo -e "${YELLOW}[$DISPLAY_NAME] Downloading framework version $version...${NC}" >&2

  local release_json
  release_json=$(curl -s "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases/tags/$tag" 2>/dev/null || echo "")

  if [ -z "$release_json" ]; then
    echo -e "${RED}Error: Could not fetch release information for tag $tag${NC}" >&2
    return 1
  fi

  if ! echo "$release_json" | grep -q '"assets"'; then
    echo -e "${RED}Error: GitHub API response for $tag did not contain assets (possible rate limit).${NC}" >&2
    echo "Response (truncated):" >&2
    echo "$release_json" | head -5 >&2
    return 1
  fi

  local download_url
  if command -v jq &> /dev/null; then
    if echo "$release_json" | jq -e . > /dev/null 2>&1; then
      download_url=$(echo "$release_json" | jq -r --arg name "$ZIP_ASSET_NAME" '.assets[] | select(.name == $name) | .browser_download_url' | head -1)
    else
      echo -e "${RED}Error: Release response is not valid JSON${NC}" >&2
      echo "$release_json" | head -5 >&2
      return 1
    fi
  else
    download_url=$(echo "$release_json" | grep -o '"browser_download_url": "[^"]*' | grep "$ZIP_ASSET_NAME" | head -1 | sed 's/.*: "//' | sed 's/"$//')
  fi

  if [ -z "$download_url" ]; then
    echo -e "${RED}Error: Could not find download URL for $DISPLAY_NAME version $version (asset: $ZIP_ASSET_NAME)${NC}" >&2
    if command -v jq &> /dev/null; then
      echo -e "${RED}Available assets:${NC}" >&2
      echo "$release_json" | jq -r '.assets[].name' | sed 's/^/  - /' >&2 || true
    fi
    return 1
  fi

  echo "Downloading from: $download_url" >&2

  local zip_path="$FRAMEWORKS_DIR/$ZIP_ASSET_NAME"

  if ! curl -L -f "${AUTH_ARGS[@]}" -o "$zip_path" "$download_url" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download framework from $download_url${NC}" >&2
    rm -f "$zip_path"
    return 1
  fi

  if ! file "$zip_path" 2>/dev/null | grep -q "Zip archive"; then
    echo -e "${RED}Error: Downloaded file is not a valid zip archive${NC}" >&2
    rm -f "$zip_path"
    return 1
  fi

  if [ -d "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME" ]; then
    echo -e "${YELLOW}[$DISPLAY_NAME] Removing old framework...${NC}" >&2
    rm -rf "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME"
  fi

  echo -e "${YELLOW}[$DISPLAY_NAME] Extracting framework...${NC}" >&2
  unzip -q -o "$zip_path" -d "$FRAMEWORKS_DIR"

  # Normalize name: sherpa zip may contain sherpa-onnx.xcframework
  if [ "$slug" = "sherpa-onnx" ] && [ -d "$FRAMEWORKS_DIR/sherpa-onnx.xcframework" ] && [ ! -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    mv "$FRAMEWORKS_DIR/sherpa-onnx.xcframework" "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"
  fi

  if [ ! -d "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME" ]; then
    echo -e "${RED}Error: Framework extraction failed ($XCFRAMEWORK_NAME)${NC}" >&2
    ls -la "$FRAMEWORKS_DIR" 2>/dev/null | head -20 >&2 || true
    rm -f "$zip_path"
    return 1
  fi

  if ! framework_valid "$slug" "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME"; then
    echo -e "${RED}Error: Downloaded $DISPLAY_NAME framework is missing required libraries or headers.${NC}" >&2
    echo "Expected e.g. $FRAMEWORKS_DIR/$XCFRAMEWORK_NAME/ios-arm64_x86_64-simulator/$HEADER_CHECK" >&2
    rm -rf "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME"
    rm -f "$zip_path"
    return 1
  fi

  rm -f "$zip_path"
  echo "$version" > "$VERSION_FILE"
  echo -e "${GREEN}[$DISPLAY_NAME] Framework v$version downloaded and extracted successfully${NC}" >&2
  return 0
}

# Force: remove existing frameworks and version files so we always re-download
if [ "$FORCE_DOWNLOAD" = true ]; then
  [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Force download: removing local frameworks and version files${NC}" >&2
  for slug in "${FRAMEWORK_SLUGS[@]}"; do
    get_framework_config "$slug" || exit 1
    rm -rf "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME"
    rm -f "$VERSION_FILE"
  done
  rm -f "$FRAMEWORKS_DIR/.framework-version"
fi

# Main: download each framework that needs updating
for slug in "${FRAMEWORK_SLUGS[@]}"; do
  get_framework_config "$slug" || exit 1
  desired=$(get_desired_version "$slug")
  # Sherpa: always ensure desired version (from TAG or $1). FFmpeg: only if TAG is set.
  if [ -z "$desired" ]; then
    [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}[$DISPLAY_NAME] No IOS_RELEASE_TAG version, skipping.${NC}" >&2
    continue
  fi
  local_ver=$(get_local_framework_version "$slug")
  if [ "$local_ver" = "$desired" ] && [ "$FORCE_DOWNLOAD" != true ]; then
    [ "$INTERACTIVE" = true ] && echo -e "${GREEN}[$DISPLAY_NAME] Framework is already v$local_ver${NC}" >&2
    continue
  fi
  [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}[$DISPLAY_NAME] Downloading v$desired...${NC}" >&2
  download_and_extract_framework "$slug" "$desired" || exit 1
done

if [ "$INTERACTIVE" = true ]; then
  echo "" >&2
  echo -e "${GREEN}Framework setup complete!${NC}" >&2
  for slug in "${FRAMEWORK_SLUGS[@]}"; do
    get_framework_config "$slug" || true
    if [ -d "$FRAMEWORKS_DIR/$XCFRAMEWORK_NAME" ]; then
      echo "  $DISPLAY_NAME: $FRAMEWORKS_DIR/$XCFRAMEWORK_NAME" >&2
    fi
  done
  echo "" >&2
  echo "Next steps:" >&2
  echo "  1. cd example" >&2
  echo "  2. pod install" >&2
  echo "  3. Open ios/SherpaOnnxExample.xcworkspace in Xcode" >&2
fi

# Fix CocoaPods header flattening: delete FFmpeg's time.h so it doesn't shadow system time.h
if [ -d "$FRAMEWORKS_DIR/FFmpeg.xcframework" ]; then
  find "$FRAMEWORKS_DIR/FFmpeg.xcframework" -name "time.h" -path "*/libavutil/time.h" -delete 2>/dev/null || true
fi

exit 0
