#!/bin/bash

# Script to download and manage iOS Framework
# Can be called manually or by Podfile during pod install
# Usage:
#   ./scripts/setup-ios-framework.sh          # Downloads/updates framework (auto mode, no interactive)
#   ./scripts/setup-ios-framework.sh 1.12.23  # Downloads specific version
#   ./scripts/setup-ios-framework.sh --interactive  # Interactive mode with prompts

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
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
if [ "$1" = "--interactive" ]; then
  INTERACTIVE=true
  shift
fi

# Only print header if interactive
if [ "$INTERACTIVE" = true ]; then
  echo -e "${BLUE}iOS Framework Setup Script${NC}"
  echo "Project root: $PROJECT_ROOT"
  echo ""
fi

# Create frameworks directory if it doesn't exist
mkdir -p "$FRAMEWORKS_DIR"

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

  local releases_json=$(curl -s -H "Accept: application/vnd.github+json" "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases" 2>/dev/null || echo "")

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
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE"
  else
    echo ""
  fi
}

# Function to download and extract framework
download_and_extract_framework() {
  local version=$1
  local tag="framework-v$version"

  echo -e "${YELLOW}Downloading framework version $version...${NC}" >&2

  # Get download URL from GitHub API
  local release_json=$(curl -s -H "Accept: application/vnd.github+json" "https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases/tags/$tag" 2>/dev/null || echo "")

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

  if ! curl -L -f -o "$zip_path" "$download_url" 2>/dev/null; then
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

  if [ ! -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    echo -e "${RED}Error: Framework extraction failed${NC}" >&2
    echo "Contents of $FRAMEWORKS_DIR:" >&2
    ls -la "$FRAMEWORKS_DIR" 2>/dev/null | head -20 >&2 || true
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

# Main logic
if [ -n "$1" ]; then
  # User provided a specific version
  download_and_extract_framework "$1"
else
  # Auto mode: check version and download only if needed
  [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Checking framework version...${NC}" >&2
  
  local_version=$(get_local_framework_version)

  if ! latest_version=$(get_latest_framework_version); then
    if [ -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
      echo -e "${YELLOW}Warning: Could not fetch latest framework version, using existing local framework.${NC}" >&2
      exit 0
    fi
    exit 1
  fi

  if [ -z "$latest_version" ]; then
    echo -e "${RED}Error: Could not fetch framework version from GitHub${NC}" >&2
    exit 1
  fi
  
  [ "$INTERACTIVE" = true ] && echo -e "${GREEN}Latest framework version: $latest_version${NC}" >&2
  
  # Check if framework exists
  if [ ! -d "$FRAMEWORKS_DIR/sherpa_onnx.xcframework" ]; then
    [ "$INTERACTIVE" = true ] && echo "Framework not found locally, downloading..." >&2
    download_and_extract_framework "$latest_version" || exit 1
  elif [ -z "$local_version" ]; then
    # Framework exists but no version file
    [ "$INTERACTIVE" = true ] && echo "Framework exists but no version info, updating version file..." >&2
    echo "$latest_version" > "$VERSION_FILE"
  else
    # Compare versions
    local version_cmp=$(compare_versions "$local_version" "$latest_version")
    
    if [ "$version_cmp" = "0" ]; then
      [ "$INTERACTIVE" = true ] && echo -e "${GREEN}Framework is up to date (v$local_version)${NC}" >&2
    elif [ "$version_cmp" = "-1" ]; then
      [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Update available: v$local_version → v$latest_version${NC}" >&2
      if [ "$INTERACTIVE" = true ]; then
        read -p "Do you want to update? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
          download_and_extract_framework "$latest_version" || exit 1
        fi
      else
        # Auto-update in non-interactive mode (e.g., from Podfile)
        download_and_extract_framework "$latest_version" || exit 1
      fi
    else
      [ "$INTERACTIVE" = true ] && echo -e "${YELLOW}Local version (v$local_version) is newer than latest release (v$latest_version)${NC}" >&2
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
