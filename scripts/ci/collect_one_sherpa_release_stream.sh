#!/usr/bin/env bash
# Fetch one GitHub release from k2-fsa/sherpa-onnx (or --github-repo), refresh tree listings,
# aggregate structure + expected CSV, optionally run update_model_license_csv.sh (in this directory).
# Paths are relative to repository root (--repo-root).
set -euo pipefail

GITHUB_REPO="k2-fsa/sherpa-onnx"
REPO_ROOT=""
RELEASE_TAG=""
STRUCTURE_FILE=""
EXPECTED_CSV=""
TREE_CACHE_DIR=""
LICENSE_CSV=""
STREAM_ID=""

usage() {
  echo "Usage: $0 --repo-root <dir> --release-tag <tag> --structure-file <rel> --expected-csv <rel> \\"
  echo "         --tree-cache-dir <rel> [--github-repo owner/name] [--license-csv <rel>] [--stream-id <id>]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --github-repo) GITHUB_REPO="$2"; shift 2 ;;
    --release-tag) RELEASE_TAG="$2"; shift 2 ;;
    --structure-file) STRUCTURE_FILE="$2"; shift 2 ;;
    --expected-csv) EXPECTED_CSV="$2"; shift 2 ;;
    --tree-cache-dir) TREE_CACHE_DIR="$2"; shift 2 ;;
    --license-csv) LICENSE_CSV="$2"; shift 2 ;;
    --stream-id) STREAM_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

[[ -n "$REPO_ROOT" && -n "$RELEASE_TAG" && -n "$STRUCTURE_FILE" && -n "$EXPECTED_CSV" && -n "$TREE_CACHE_DIR" ]] || usage

REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
cd "$REPO_ROOT"

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_abs_tree="$REPO_ROOT/$TREE_CACHE_DIR"
_abs_structure="$REPO_ROOT/$STRUCTURE_FILE"
_abs_expected="$REPO_ROOT/$EXPECTED_CSV"

WORK="$(mktemp -d -t sherpa-collect-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
ASSET_LIST="$WORK/asset-list.txt"

_GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
_ASSET_LIMIT="${ASSET_LIMIT:-}"

echo "=== collect_one_sherpa_release_stream: tag=$RELEASE_TAG tree-cache=$TREE_CACHE_DIR ==="

API_AUTH=()
if [[ -n "$_GH_TOKEN" ]]; then
  API_AUTH=(-H "Authorization: Bearer ${_GH_TOKEN}" -H "Accept: application/vnd.github+json")
fi

RESP="$(curl -sSL "${API_AUTH[@]}" "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}")"
if echo "$RESP" | jq -e '.assets' >/dev/null 2>&1; then
  LIST="$(echo "$RESP" | jq -r '.assets[] | select(.name | endswith(".tar.bz2") or endswith(".onnx")) | "\(.name)|\(.browser_download_url)"')"
  if [[ -z "$_ASSET_LIMIT" || "$_ASSET_LIMIT" == "0" ]]; then
    printf '%s\n' "$LIST" > "$ASSET_LIST"
    echo "  Asset list: no limit ($(wc -l < "$ASSET_LIST" | tr -d ' ') lines)"
  else
    printf '%s\n' "$LIST" | head -n "$_ASSET_LIMIT" > "$ASSET_LIST"
    echo "  Asset list: limit $_ASSET_LIMIT ($(wc -l < "$ASSET_LIST" | tr -d ' ') lines)"
  fi
else
  echo "::warning::Release ${RELEASE_TAG} not found or has no assets (${GITHUB_REPO})" >&2
  : > "$ASSET_LIST"
fi

mkdir -p "$_abs_tree"

if [[ -f "$_abs_structure" ]]; then
  cur=""
  safe=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^#\ Asset:\ (.+)$ ]]; then
      cur="${BASH_REMATCH[1]}"
      safe="${cur//\//-}"
      safe="${safe//\\/-}"
      : > "${_abs_tree}/${safe}.txt"
    elif [[ -n "$cur" ]]; then
      printf '%s\n' "$line" >> "${_abs_tree}/${safe}.txt"
    fi
  done < "$_abs_structure"
  echo "  Parsed existing structure into ${_abs_tree}"
else
  echo "  No existing structure file; tree-cache will be filled from downloads only"
fi

mkdir -p "$WORK/dl"
while IFS='|' read -r name url; do
  [[ -z "$name" ]] && continue
  name="${name%$'\r'}"
  url="${url%$'\r'}"
  safe="${name//\//-}"
  safe="${safe//\\/-}"
  cache_file="${_abs_tree}/${safe}.txt"
  if [[ -f "$cache_file" ]]; then
    echo "  Skip (cache hit): $name"
    continue
  fi
  echo "  Download: $name"
  dl="$WORK/dl/$safe"
  DL_ARGS=(-sSL)
  if [[ -n "$_GH_TOKEN" && "$url" == *"github.com"* ]]; then
    DL_ARGS+=(-H "Authorization: Bearer ${_GH_TOKEN}" -H "Accept: application/octet-stream")
  fi
  if ! curl "${DL_ARGS[@]}" -o "$dl" "$url"; then
    echo "::warning::Download failed for $name" >&2
    rm -f "$dl"
    continue
  fi
  if [[ "$name" == *.tar.bz2 ]]; then
    if ! tar -tjf "$dl" > "$cache_file" 2>/dev/null; then
      echo "::warning::tar -tjf failed for $name" >&2
      rm -f "$cache_file" "$dl"
      continue
    fi
  elif [[ "$name" == *.onnx ]]; then
    # Two lines so structure fixtures match tarball layout: model dir "." and the file (see model_detect_test).
    base="${name##*/}"
    printf '%s\n' "./" "./${base}" > "$cache_file"
  else
    echo "::warning::Unexpected asset $name" >&2
    rm -f "$dl"
    continue
  fi
  rm -f "$dl"
done < "$ASSET_LIST"

mkdir -p "$(dirname "$_abs_structure")"
: > "$_abs_structure"
while IFS='|' read -r name _; do
  [[ -z "$name" ]] && continue
  name="${name%$'\r'}"
  safe="${name//\//-}"
  safe="${safe//\\/-}"
  cache_file="${_abs_tree}/${safe}.txt"
  [[ -f "$cache_file" ]] || continue
  echo "# Asset: $name" >> "$_abs_structure"
  cat "$cache_file" >> "$_abs_structure"
done < "$ASSET_LIST"
echo "  Wrote aggregated structure ($(wc -l < "$_abs_structure" | tr -d ' ') lines)"

if [[ ! -s "$ASSET_LIST" ]]; then
  echo "  No assets; skipping expected CSV and license update"
  exit 0
fi

mkdir -p "$(dirname "$_abs_expected")"
if [[ ! -f "$_abs_expected" ]]; then
  echo "asset_name,model_type" > "$_abs_expected"
fi
tmp="$(mktemp)"
echo "asset_name,model_type" > "$tmp"
while IFS='|' read -r asset _; do
  [[ -z "$asset" ]] && continue
  asset="${asset%$'\r'}"
  esc="${asset//./\\.}"
  line="$(grep -E "^(\"${esc}\"|${esc})," "$_abs_expected" 2>/dev/null | head -1 || true)"
  if [[ -n "$line" ]]; then
    echo "$line" >> "$tmp"
  else
    echo "${asset}," >> "$tmp"
  fi
done < "$ASSET_LIST"
mv "$tmp" "$_abs_expected"
echo "  Expected CSV rows: $(($(wc -l < "$_abs_expected" | tr -d ' ') - 1)) data (+ header)"

if [[ -n "$LICENSE_CSV" ]]; then
  _abs_license="$REPO_ROOT/$LICENSE_CSV"
  echo "  License CSV: $LICENSE_CSV"
  _lic_args=(
    --asset-list "$ASSET_LIST"
    --tree-cache-dir "$_abs_tree"
    --csv "$_abs_license"
  )
  if [[ -n "$STREAM_ID" ]]; then
    _lic_args+=(--stream-id "$STREAM_ID")
  fi
  bash "$CI_DIR/update_model_license_csv.sh" "${_lic_args[@]}"
fi

echo "=== done: $RELEASE_TAG ==="
