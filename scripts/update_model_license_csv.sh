#!/usr/bin/env bash
# Update model-license CSV from release asset list and pre-collected tree-cache.
#
# Behavior:
# - Keeps existing rows and manual edits.
# - Adds missing asset rows.
# - Auto-fills only when license_type is empty.
# - Uses tree-cache to detect whether an archive likely contains a license file.
# - Downloads/extracts only assets that need license-type detection.

set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "This script requires Bash version 4+ (for associative arrays)." >&2
  exit 1
fi

ASSET_LIST=""
TREE_CACHE_DIR=""
CSV_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --asset-list) ASSET_LIST="$2"; shift 2 ;;
    --tree-cache-dir) TREE_CACHE_DIR="$2"; shift 2 ;;
    --csv) CSV_FILE="$2"; shift 2 ;;
    *) echo "Unknown parameter $1"; exit 1 ;;
  esac
done

if [[ -z "$ASSET_LIST" || -z "$TREE_CACHE_DIR" || -z "$CSV_FILE" ]]; then
  echo "Usage: $0 --asset-list <path> --tree-cache-dir <dir> --csv <path>"
  exit 1
fi

declare -A LICENSE_LIKE_BASENAMES=(
  ["license"]=1 ["license.txt"]=1 ["licence"]=1 ["licence.txt"]=1
  ["copying"]=1 ["copying.txt"]=1 ["notice"]=1 ["notice.txt"]=1
  ["copyright"]=1 ["copyright.txt"]=1 ["model_license"]=1 ["model_license.txt"]=1
  ["license.md"]=1 ["licence.md"]=1 ["copying.md"]=1 ["notice.md"]=1
)

declare -A existing_asset_name
declare -A existing_license_type
declare -A existing_commercial_use
declare -A existing_confidence
declare -A existing_detection_source
declare -A existing_license_file

read_csv() {
  local csv_path="$1"
  if [[ ! -f "$csv_path" ]]; then return; fi
  
  local is_header=1
  while IFS=, read -r asset_name license_type commercial_use confidence detection_source license_file remainder; do
    # Remove carriage returns
    asset_name="${asset_name%$'\r'}"
    license_file="${license_file%$'\r'}"
    if [[ "$is_header" -eq 1 ]]; then
      is_header=0
      continue
    fi
    # strip quotes
    asset_name="${asset_name%\"}"; asset_name="${asset_name#\"}"
    if [[ -z "$asset_name" ]]; then continue; fi
    
    existing_asset_name["$asset_name"]="$asset_name"
    
    license_type="${license_type%\"}"; license_type="${license_type#\"}"
    existing_license_type["$asset_name"]="$license_type"
    
    commercial_use="${commercial_use%\"}"; commercial_use="${commercial_use#\"}"
    existing_commercial_use["$asset_name"]="$commercial_use"
    
    confidence="${confidence%\"}"; confidence="${confidence#\"}"
    existing_confidence["$asset_name"]="$confidence"
    
    detection_source="${detection_source%\"}"; detection_source="${detection_source#\"}"
    existing_detection_source["$asset_name"]="$detection_source"
    
    license_file="${license_file%\"}"; license_file="${license_file#\"}"
    existing_license_file["$asset_name"]="$license_file"
  done < "$csv_path"
}

read_csv "$CSV_FILE"
existing_csv_rows=$((${#existing_asset_name[@]}))
echo "=== update_model_license_csv.sh ==="
echo "CSV path: $CSV_FILE"
echo "Existing rows in CSV (by asset name): $existing_csv_rows"

declare -a release_assets=()
declare -A asset_urls=()

if [[ -f "$ASSET_LIST" ]]; then
  while IFS='|' read -r name url; do
    name="${name%$'\r'}"
    url="${url%$'\r'}"
    # trim spaces
    name="$(echo -n "$name" | xargs)"
    url="$(echo -n "$url" | xargs)"
    if [[ -n "$name" ]]; then
      release_assets+=("$name")
      asset_urls["$name"]="$url"
      if [[ -z "${existing_asset_name["$name"]:-}" ]]; then
        existing_asset_name["$name"]="$name"
        existing_license_type["$name"]=""
        existing_commercial_use["$name"]=""
        existing_confidence["$name"]=""
        existing_detection_source["$name"]=""
        existing_license_file["$name"]=""
      fi
    fi
  done < "$ASSET_LIST"
fi

echo "Asset list file: ${ASSET_LIST:-<none>}"
echo "Tree cache dir: $TREE_CACHE_DIR"
echo "Release assets to consider: ${#release_assets[@]}"
if [[ ${#release_assets[@]} -eq 0 ]]; then
  echo "Note: empty asset list — output CSV will only contain header plus any assets already in CSV but not on release (sorted)."
fi
echo "--- per-asset license pass ---"

get_safe_name() {
  local name="$1"
  name="${name//\//-}"
  name="${name//\\/-}"
  echo "$name"
}

set_missing() {
  local name="$1"
  existing_license_type["$name"]="missing"
  existing_commercial_use["$name"]="unknown"
  existing_confidence["$name"]="high"
  existing_detection_source["$name"]="structure_scan"
  existing_license_file["$name"]=""
}

set_extract_failed() {
  local name="$1"
  local file="$2"
  existing_license_type["$name"]="unknown"
  existing_commercial_use["$name"]="unknown"
  existing_confidence["$name"]="low"
  existing_detection_source["$name"]="archive_extract_failed"
  existing_license_file["$name"]="$file"
}

set_detected() {
  local name="$1"
  local l_type="$2"
  local c_use="$3"
  local conf="$4"
  local file="$5"
  existing_license_type["$name"]="$l_type"
  existing_commercial_use["$name"]="$c_use"
  existing_confidence["$name"]="$conf"
  existing_detection_source["$name"]="archive_license_file"
  existing_license_file["$name"]="$file"
}

detect_license() {
  local t="$1"
  t="$(echo "$t" | tr '[:upper:]' '[:lower:]' | tr -s ' \r\n\t' ' ')"

  if [[ "$t" == *"apache license"* && "$t" == *"version 2.0"* ]]; then echo "apache-2.0|yes|high"
  elif [[ "$t" == *"mit license"* ]]; then echo "mit|yes|high"
  elif [[ "$t" == *"bsd 3-clause"* || ( "$t" == *"redistribution and use in source and binary forms"* && "$t" == *"neither the name"* ) ]]; then echo "bsd-3-clause|yes|medium"
  elif [[ "$t" == *"bsd 2-clause"* ]]; then echo "bsd-2-clause|yes|medium"
  elif [[ "$t" == *"mozilla public license"* && "$t" == *"2.0"* ]]; then echo "mpl-2.0|yes|high"
  elif [[ "$t" == *"isc license"* ]]; then echo "isc|yes|medium"
  elif [[ "$t" == *"the unlicense"* ]]; then echo "unlicense|yes|medium"
  elif [[ "$t" == *"zlib license"* ]]; then echo "zlib|yes|medium"
  elif [[ "$t" == *"gnu affero general public license"* ]]; then echo "agpl-3.0|conditional|high"
  elif [[ "$t" == *"gnu lesser general public license"* ]]; then
    if [[ "$t" == *"version 2.1"* ]]; then echo "lgpl-2.1|conditional|high"
    elif [[ "$t" == *"version 3"* ]]; then echo "lgpl-3.0|conditional|high"
    else echo "lgpl|conditional|medium"; fi
  elif [[ "$t" == *"gnu general public license"* ]]; then
    if [[ "$t" == *"version 3"* ]]; then echo "gpl-3.0|conditional|high"
    elif [[ "$t" == *"version 2"* ]]; then echo "gpl-2.0|conditional|high"
    else echo "gpl|conditional|medium"; fi
  elif [[ "$t" == *"creative commons"* && "$t" == *"noncommercial"* ]]; then
    if [[ "$t" == *"4.0"* ]]; then echo "cc-by-nc-4.0|no|high"
    else echo "cc-by-nc|no|medium"; fi
  elif [[ "$t" == *"creative commons attribution 4.0"* || ( "$t" == *"creative commons"* && "$t" == *"attribution"* && "$t" == *"4.0"* ) ]]; then echo "cc-by-4.0|yes|high"
  elif [[ "$t" == *"non-commercial"* || "$t" == *"non commercial"* ]]; then echo "custom-non-commercial|no|medium"
  elif [[ "$t" == *"research only"* || "$t" == *"for research purposes only"* ]]; then echo "custom-research-only|no|medium"
  else echo "unknown|unknown|low"
  fi
}

for asset_name in "${release_assets[@]}"; do
  url="${asset_urls["$asset_name"]}"
  
  l_type="${existing_license_type["$asset_name"]:-}"
  l_type="$(echo -n "$l_type" | xargs)"
  if [[ -n "$l_type" ]]; then
    echo "  $asset_name — skip (license_type already set: '$l_type')"
    continue
  fi

  if [[ "$asset_name" == *.onnx ]]; then
    set_missing "$asset_name"
    echo "  $asset_name — .onnx bundle → license_type=missing (no archive)"
    continue
  fi

  safe_name="$(get_safe_name "$asset_name")"
  tree_path="${TREE_CACHE_DIR}/${safe_name}.txt"
  
  declare -a license_paths=()
  if [[ -f "$tree_path" ]]; then
    declare -A seen_paths=()
    while IFS= read -r line; do
      s="${line%$'\r'}"
      s="$(echo -n "$s" | xargs)"
      if [[ -z "$s" || "$s" == */ ]]; then continue; fi
      
      base="${s##*/}"
      base_lower="$(echo -n "$base" | tr '[:upper:]' '[:lower:]')"
      
      if [[ -n "${LICENSE_LIKE_BASENAMES["$base_lower"]:-}" ]]; then
        if [[ -z "${seen_paths["$s"]:-}" ]]; then
          license_paths+=("$s")
          seen_paths["$s"]=1
        fi
      elif [[ "$base_lower" == *"license"* || "$base_lower" == *"licence"* ]]; then
        if [[ -z "${seen_paths["$s"]:-}" ]]; then
          license_paths+=("$s")
          seen_paths["$s"]=1
        fi
      fi
    done < "$tree_path"
    unset seen_paths
  fi

  if [[ ${#license_paths[@]} -eq 0 ]]; then
    set_missing "$asset_name"
    echo "  $asset_name — no license-like path in tree listing → license_type=missing"
    continue
  fi

  echo "  $asset_name — found ${#license_paths[@]} license-like path(s), downloading archive…"
  td="$(mktemp -d -t model-license-XXXXXX)"
  archive_path="${td}/${safe_name}"

  if ! curl -sSL -o "$archive_path" "$url"; then
    set_extract_failed "$asset_name" "${license_paths[0]}"
    echo "  $asset_name — download failed → detection_source=archive_extract_failed"
    rm -rf "$td"
    continue
  fi

  extracted_text=""
  used_file="${license_paths[0]}"
  for p in "${license_paths[@]}"; do
    c1="$p"
    c2=""
    c3=""
    if [[ "$p" == ./* ]]; then
      c2="${p:2}"
    else
      c3="./$p"
    fi
    
    for c in "$c1" "$c2" "$c3"; do
      if [[ -z "$c" ]]; then continue; fi
      out="$(tar -xOf "$archive_path" "$c" 2>/dev/null || true)"
      if [[ -n "$out" ]]; then
        extracted_text="$out"
        used_file="$p"
        break 2
      fi
    done
  done

  if [[ -z "$extracted_text" ]]; then
    set_extract_failed "$asset_name" "$used_file"
    echo "  $asset_name — could not extract text from '$used_file' inside archive"
    rm -rf "$td"
    continue
  fi

  det="$(detect_license "$extracted_text")"
  l_res="$(echo "$det" | cut -d'|' -f1)"
  c_res="$(echo "$det" | cut -d'|' -f2)"
  conf_res="$(echo "$det" | cut -d'|' -f3)"
  
  set_detected "$asset_name" "$l_res" "$c_res" "$conf_res" "$used_file"
  echo "  $asset_name — detected license_type=$l_res commercial_use=$c_res confidence=$conf_res file=$used_file"

  rm -rf "$td"
done

echo "--- writing CSV ---"
mkdir -p "$(dirname "$CSV_FILE")"
echo "asset_name,license_type,commercial_use,confidence,detection_source,license_file" > "$CSV_FILE"

declare -A out_seen=()
for name in "${release_assets[@]}"; do
  if [[ -z "${out_seen["$name"]:-}" ]]; then
    echo "${name},${existing_license_type["$name"]},${existing_commercial_use["$name"]},${existing_confidence["$name"]},${existing_detection_source["$name"]},${existing_license_file["$name"]}" >> "$CSV_FILE"
    out_seen["$name"]=1
  fi
done

declare -a remaining=()
for name in "${!existing_asset_name[@]}"; do
  if [[ -z "${out_seen["$name"]:-}" ]]; then
    remaining+=("$name")
  fi
done

if [[ ${#remaining[@]} -gt 0 ]]; then
  echo "Appending ${#remaining[@]} asset(s) present in CSV but not in current release asset list."
  mapfile -t remaining_sorted < <(printf "%s\n" "${remaining[@]}" | sort)
  for name in "${remaining_sorted[@]}"; do
    echo "${name},${existing_license_type["$name"]},${existing_commercial_use["$name"]},${existing_confidence["$name"]},${existing_detection_source["$name"]},${existing_license_file["$name"]}" >> "$CSV_FILE"
  done
fi

out_lines=$(wc -l < "$CSV_FILE" | tr -d ' ')
echo "Done. Wrote $CSV_FILE ($out_lines lines including header)."
