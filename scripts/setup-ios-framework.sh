#!/bin/bash

# Script to download and manage iOS Framework
# Can be called manually or by Podfile during pod install
# Usage:
#   ./scripts/setup-ios-framework.sh          # Downloads/updates framework (auto mode, no interactive)
#   ./scripts/setup-ios-framework.sh 1.12.24  # Downloads specific version
#   ./scripts/setup-ios-framework.sh --force  # Remove local cache and re-download (same version from IOS_RELEASE_TAG)
#   ./scripts/setup-ios-framework.sh --interactive  # Interactive mode with prompts
# To force re-download during pod install: SHERPA_ONNX_IOS_FORCE_DOWNLOAD=1 pod install

set -e

# Resolve package root: pod install sets PODS_TARGET_SRCROOT when building the pod; otherwise use script dir or PWD.
PROJECT_ROOT=""
if [ -n "${PODS_TARGET_SRCROOT}" ] && [ -d "${PODS_TARGET_SRCROOT}" ]; then
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
VERSION_FILE="$FRAMEWORKS_DIR/.framework-version"

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

# Helper: check if a framework path is valid for building (has library + required headers for compiler)
framework_valid() {
  local fw_root="$1"
  [ -f "$fw_root/ios-arm64/libsherpa-onnx.a" ] || return 1
  [ -f "$fw_root/ios-arm64_x86_64-simulator/Headers/sherpa-onnx/c-api/cxx-api.h" ] || return 1
  return 0
}

# When run as Xcode build phase (prepare_command): if framework is already present and valid, exit successfully.
# Avoids network/TAG-file dependency during build and prevents "PhaseScriptExecution failed" when nothing is needed.
# We require both the library and the Headers (sherpa-onnx/c-api/cxx-api.h) so an incomplete framework triggers a re-download.
if [ "$FORCE_DOWNLOAD" != true ]; then
  if [ -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ] && framework_valid "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"; then
    echo "[SherpaOnnx] Framework already present at $FRAMEWORKS_DIR/sherpa_onnx.xcframework, skipping download." >&2
    exit 0
  fi
  if [ -d "$FRAMEWORKS_DIR/sherpa-onnx.xcframework" ] && framework_valid "$FRAMEWORKS_DIR/sherpa-onnx.xcframework"; then
    echo "[SherpaOnnx] Framework already present at $FRAMEWORKS_DIR/sherpa-onnx.xcframework, skipping download." >&2
    exit 0
  fi
fi

# Prepare GitHub auth header if GITHUB_TOKEN is provided (helps avoid API rate limits)
AUTH_ARGS=()
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_ARGS+=("-H" "Authorization: Bearer $GITHUB_TOKEN")
fi

# If SHERPA_ONNX_VERSION is set, treat it as the desired framework version
# and do not perform the usual "auto-upgrade to latest" behavior. This helps
# prevent accidental upgrades during CI or automated installs.
if [ -n "$SHERPA_ONNX_VERSION" ]; then
  DESIRED_VERSION="$SHERPA_ONNX_VERSION"
fi
# If no env var was provided, use repo-level IOS_RELEASE_TAG (single source of truth for iOS framework version).
# Format: framework-vX.Y.Z (e.g. framework-v1.12.24). Do not use ANDROID_RELEASE_TAG for iOS.
if [ -z "$DESIRED_VERSION" ]; then
  IOS_TAG_FILE="$PROJECT_ROOT/third_party/sherpa-onnx-prebuilt/IOS_RELEASE_TAG"
  if [ -f "$IOS_TAG_FILE" ]; then
    TAG=$(grep -v '^#' "$IOS_TAG_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r\n')
    if [ -n "$TAG" ] && [ "${TAG#framework-v}" != "$TAG" ]; then
      DESIRED_VERSION="${TAG#framework-v}"
      [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Using iOS framework version from IOS_RELEASE_TAG: $DESIRED_VERSION${NC}" >&2
    fi
  fi
  if [ -z "$DESIRED_VERSION" ]; then
    echo -e "${RED}Error: IOS_RELEASE_TAG not found at $IOS_TAG_FILE. Reinstall the package or run from repo.${NC}" >&2
    exit 1
  fi
fi

# Function to compare semantic versions (e.g., "1.12.23" vs "1.12.24")
compare_versions() {
  local v1=$1
  local v2=$2
  
  # Convert to arrays
  IFS='.' read -ra v1_parts <<< "$v1"
  IFS='.' read -ra v2_parts <<< "$v2"
  
  # Pad arrays to same length
  local max_len=${#v1_parts[@]}
  [ ${#v2_parts[@]} -gt $max_len ] && max_len=${#v2_parts[@]}
  
  # Compare each part
  for ((i=0; i<max_len; i++)); do
    local v1_num=${v1_parts[$i]:-0}
    local v2_num=${v2_parts[$i]:-0}
    
    if [ "$v1_num" -lt "$v2_num" ]; then
      echo "-1"  # v1 < v2
      return 0
    elif [ "$v1_num" -gt "$v2_num" ]; then
      echo "1"   # v1 > v2
      return 0
    fi
  done
  
  echo "0"  # v1 == v2
}

# Function to get latest framework version from GitHub
get_latest_framework_version() {
  echo -e "${YELLOW}Fetching latest framework release from GitHub...${NC}" >&2

  local releases_json=$(curl -s "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases" 2>/dev/null || echo "")

  if [ -z "$releases_json" ]; then
    echo -e "${RED}Error: Could not fetch releases from GitHub API${NC}" >&2
    return 1
  fi

  # Avoid jq errors on rate-limit HTML or plain-text responses
  if ! echo "$releases_json" | grep -q '"tag_name"'; then
    echo -e "${RED}Error: GitHub API response did not contain release data (possible rate limit).${NC}" >&2
    echo "Response (truncated):" >&2
    echo "$releases_json" | head -5 >&2
    return 1
  fi

  local version=""

  if command -v jq &> /dev/null; then
    if echo "$releases_json" | jq -e . > /dev/null 2>&1; then
      version=$(echo "$releases_json" | jq -r '.[] | select(.tag_name | startswith("framework-v")) | .tag_name' | head -1 | sed 's/framework-v//')
    else
      echo -e "${RED}Error: GitHub releases response is not valid JSON${NC}" >&2
      echo "$releases_json" | head -5 >&2
      return 1
    fi
  else
    version=$(echo "$releases_json" | grep -o '"tag_name": "framework-v[0-9.]*' | head -1 | sed 's/.*framework-v//')
  fi

  if [ -z "$version" ]; then
    echo -e "${RED}Error: No framework releases found with tag format 'framework-vX.Y.Z'${NC}" >&2
    return 1
  fi

  echo "$version"
}

# Function to get local framework version
get_local_framework_version() {
  # Prefer explicit version file written by this script
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE"
    return 0
  fi

  # If .framework-version missing, try to read VERSION.txt from the XCFramework
  for f in "sherpa_onnx.xcframework" "sherpa-onnx.xcframework"; do
    if [ -f "$FRAMEWORKS_DIR/$f/VERSION.txt" ]; then
      # Extract first semantic version-like token (e.g. 1.12.24)
      ver=$(grep -Eo '([0-9]+\.)+[0-9]+' "$FRAMEWORKS_DIR/$f/VERSION.txt" | head -n1 || true)
      if [ -n "$ver" ]; then
        # Cache it for future runs
        echo "$ver" > "$VERSION_FILE" 2>/dev/null || true
        echo "$ver"
        return 0
      fi
    fi
  done

  echo ""
}

# Function to download and extract framework
download_and_extract_framework() {
  local version=$1
  local tag="framework-v$version"

  echo -e "${YELLOW}Downloading framework version $version...${NC}" >&2

  # Get download URL from GitHub API
  local release_json=$(curl -s "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases/tags/$tag" 2>/dev/null || echo "")

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

  # Extract download URL using jq if available, otherwise grep/sed
  local download_url
  if command -v jq &> /dev/null; then
    if echo "$release_json" | jq -e . > /dev/null 2>&1; then
      download_url=$(echo "$release_json" | jq -r '.assets[] | select(.name == "sherpa_onnx.xcframework.zip") | .browser_download_url' | head -1)
    else
      echo -e "${RED}Error: Release response is not valid JSON${NC}" >&2
      echo "$release_json" | head -5 >&2
      return 1
    fi
  else
    download_url=$(echo "$release_json" | grep -o '"browser_download_url": "[^"]*' | grep 'xcframework.zip' | head -1 | sed 's/.*: "//' | sed 's/"$//')
  fi

  if [ -z "$download_url" ]; then
    echo -e "${RED}Error: Could not find download URL for version $version${NC}" >&2
    echo -e "${RED}Available assets:${NC}" >&2
    if command -v jq &> /dev/null; then
      echo "$release_json" | jq -r '.assets[].name' | sed 's/^/  - /' >&2 || true
    fi
    return 1
  fi

  echo "Downloading from: $download_url" >&2

  # Download the zip file
  local zip_path="$FRAMEWORKS_DIR/sherpa_onnx.xcframework.zip"

  if ! curl -L -f "${AUTH_ARGS[@]}" -o "$zip_path" "$download_url" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download framework from $download_url${NC}" >&2
    rm -f "$zip_path"
    return 1
  fi

  # Check if zip file is valid
  if ! file "$zip_path" 2>/dev/null | grep -q "Zip archive"; then
    echo -e "${RED}Error: Downloaded file is not a valid zip archive${NC}" >&2
    echo "File type: $(file "$zip_path" 2>/dev/null || echo "unknown")" >&2
    rm -f "$zip_path"
    return 1
  fi

  # Remove old framework if it exists
  if [ -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    echo -e "${YELLOW}Removing old framework...${NC}" >&2
    rm -rf "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"
  fi

  # Extract the zip
  echo -e "${YELLOW}Extracting framework...${NC}" >&2
  unzip -q -o "$zip_path" -d "$FRAMEWORKS_DIR"

  # Normalize name: podspec expects sherpa_onnx.xcframework; zip may contain sherpa-onnx.xcframework
  if [ -d "$FRAMEWORKS_DIR/sherpa-onnx.xcframework" ] && [ ! -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    mv "$FRAMEWORKS_DIR/sherpa-onnx.xcframework" "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"
  fi

  if [ ! -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    echo -e "${RED}Error: Framework extraction failed${NC}" >&2
    echo "Contents of $FRAMEWORKS_DIR:" >&2
    ls -la "$FRAMEWORKS_DIR" 2>/dev/null | head -20 >&2 || true
    rm -f "$zip_path"
    return 1
  fi

  # Verify required headers are present (needed for iOS build: #include "sherpa-onnx/c-api/cxx-api.h")
  if ! framework_valid "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"; then
    echo -e "${RED}Error: Downloaded framework is missing required headers for building.${NC}" >&2
    echo "Expected: $FRAMEWORKS_DIR/sherpa_onnx.xcframework/ios-arm64_x86_64-simulator/Headers/sherpa-onnx/c-api/cxx-api.h" >&2
    echo "Simulator Headers directory:" >&2
    ls -la "$FRAMEWORKS_DIR/sherpa_onnx.xcframework/ios-arm64_x86_64-simulator/Headers" 2>/dev/null || echo "  (missing)" >&2
    if [ -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework/ios-arm64_x86_64-simulator/Headers" ]; then
      echo "sherpa-onnx/c-api under Headers:" >&2
      ls -la "$FRAMEWORKS_DIR/sherpa_onnx.xcframework/ios-arm64_x86_64-simulator/Headers/sherpa-onnx/c-api" 2>/dev/null || echo "  (missing)" >&2
    fi
    rm -rf "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"
    rm -f "$zip_path"
    return 1
  fi

  # Remove zip file
  rm -f "$zip_path"

  # Write version file
  echo "$version" > "$VERSION_FILE"

  echo -e "${GREEN}Framework v$version downloaded and extracted successfully${NC}" >&2
  return 0
}

# Force: remove existing framework and version file so we always re-download
if [ "$FORCE_DOWNLOAD" = true ]; then
  [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Force download: removing local framework and version file${NC}" >&2
  rm -rf "$FRAMEWORKS_DIR/sherpa_onnx.xcframework"
  rm -f "$VERSION_FILE"
fi

# Main logic
if [ -n "$1" ]; then
  # User provided a specific version -> explicit, always honor
  download_and_extract_framework "$1"
else
  # If env var was set, enforce that version and do not auto-upgrade to latest
  if [ -n "$DESIRED_VERSION" ]; then
    [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Using SHERPA_ONNX_VERSION=$DESIRED_VERSION${NC}" >&2
    local_version=$(get_local_framework_version)
    if [ "$local_version" != "$DESIRED_VERSION" ] || [ "$FORCE_DOWNLOAD" = true ]; then
      [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Downloading v$DESIRED_VERSION...${NC}" >&2
      download_and_extract_framework "$DESIRED_VERSION" || exit 1
    else
      [ "$INTERACTIVE" = true ] && echo -e "${GREEN}Framework is already v$local_version${NC}" >&2
    fi
  else
    # DESIRED_VERSION is set above from IOS_RELEASE_TAG (required).
    [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Using pinned version from IOS_RELEASE_TAG.${NC}" >&2
    local_version=$(get_local_framework_version)
    if [ "$local_version" != "$DESIRED_VERSION" ] || [ "$FORCE_DOWNLOAD" = true ]; then
      download_and_extract_framework "$DESIRED_VERSION" || exit 1
    else
      [ "$INTERACTIVE" = true ] && echo -e "${GREEN}Framework is already v$local_version${NC}" >&2
    fi
  fi
fi

if [ "$INTERACTIVE" = true ]; then
  echo "" >&2
  echo -e "${GREEN}Framework setup complete!${NC}" >&2
  echo "Framework location: $FRAMEWORKS_DIR/sherpa_onnx.xcframework" >&2
  echo "" >&2
  echo "Next steps:" >&2
  echo "  1. cd example" >&2
  echo "  2. pod install" >&2
  echo "  3. Open ios/SherpaOnnxExample.xcworkspace in Xcode" >&2
fi
exit 0
