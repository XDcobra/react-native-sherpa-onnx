#!/usr/bin/env bash
# Update model-license CSV from release asset list and pre-collected tree-cache.
#
# Goal: map each release asset (same names as *-models-expected.csv) to license_type and
# commercial_use hints for app distribution (ads, IAP). Not legal advice.
#
# Behavior:
# - Reads existing CSV if present; preserves rows and manual edits.
# - Merges in all assets from asset-list.txt (release); adds new rows with empty license_type.
# - Skips any asset with detection_source `manual` (hand-maintained row; never overwritten).
# - Skips any asset whose license_type and commercial_use are both set and neither is `unknown`
#   (case-insensitive). Rows with empty or `unknown` license_type and/or empty or `unknown`
#   commercial_use are (re)processed. license_type `exhausted` is never auto-overwritten.
# - Uses tree-cache (from asr/tts/speech-enhancement structure fixtures + new downloads) to see if a LICENSE-like
#   path exists — no full extract unless we need file contents for detection.
# - Downloads the .tar.bz2 only when a license-like path was found and license_type is still empty.
# - Pipeline: try archive (if applicable) --> HF/ModelScope fallbacks for eligible assets. If no license
#   is found after all attempts, license_type is set to exhausted (default keyword; override with
#   LICENSE_EXHAUSTED env). You can set exhausted manually after review.
# - .onnx-only: exhausted (no archive to scan).
# - HF fallback (vits-piper-*.tar.bz2, sherpa-onnx-*.tar.bz2): repo slug = asset basename without .tar.bz2
#   under HF_MODEL_OWNER (default csukuangfj). Try MODEL_CARD (* License: …) then README.md YAML
#   (---\nlicense: …). First successful source wins (HF before ModelScope). Only if HF has no license but
#   README.md links to modelscope.cn/models/…, fetch that /summary HTML and read License from
#   window.__detail_data__ JSON (\"License\":\"…\").
#   license_file = HF repo URL or ModelScope summary URL; detection_source = huggingface_model_card or
#   modelscope_detail_json. Release tarball names must match HF repo names or fetch 404s.
# - QNN binary stream (see --stream-id asr-models-qnn-binary, or QNN in asset name, or qnn-*-license-status.csv):
#   after archive scan + HF fallback still yield nothing, last resort looks up a matching row in
#   asr-models-license-status.csv (default: same directory as --csv). Strip prefix
#   sherpa-onnx-qnn-<soc>-binary-<n>-seconds- from the QNN asset name, then try a few derived filenames
#   (exact, sherpa-onnx-…, and sherpa-onnx-<stem>.tar.bz2 when …-int8.tar.bz2). On match, copy the ASR row’s
#   license fields (not asset_name) onto the QNN asset; on no match --> exhausted like other dead ends.
# - Hugging Face: set HF_TOKEN or HUGGINGFACE_HUB_TOKEN (read token is enough for public repos). Anonymous
#   requests from CI often get HTTP 401; without a token README/MODEL_CARD cannot be fetched.
#
# Note: With `set -u`, ${#empty_assoc[@]} and ${!empty_assoc[@]} can error on some Bash builds;
# we avoid that below.

set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "This script requires Bash version 4+ (for associative arrays)." >&2
  exit 1
fi

ASSET_LIST=""
TREE_CACHE_DIR=""
CSV_FILE=""
STREAM_ID=""
ASR_LICENSE_CSV=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --asset-list) ASSET_LIST="$2"; shift 2 ;;
    --tree-cache-dir) TREE_CACHE_DIR="$2"; shift 2 ;;
    --csv) CSV_FILE="$2"; shift 2 ;;
    --stream-id) STREAM_ID="$2"; shift 2 ;;
    --asr-license-csv) ASR_LICENSE_CSV="$2"; shift 2 ;;
    *) echo "Unknown parameter $1"; exit 1 ;;
  esac
done

if [[ -z "$ASSET_LIST" || -z "$TREE_CACHE_DIR" || -z "$CSV_FILE" ]]; then
  echo "Usage: $0 --asset-list <path> --tree-cache-dir <dir> --csv <path> [--stream-id <id>] [--asr-license-csv <path>]"
  exit 1
fi

if [[ -z "$ASR_LICENSE_CSV" ]]; then
  ASR_LICENSE_CSV="$(cd "$(dirname "$CSV_FILE")" && pwd)/asr-models-license-status.csv"
fi

# Authenticated GitHub downloads (CI: GITHUB_TOKEN; local: GITHUB_TOKEN or GH_TOKEN).
_GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
# Hugging Face raw file fetches (CI: often required to avoid 401 on huggingface.co).
_HF_TOKEN="${HF_TOKEN:-${HUGGINGFACE_HUB_TOKEN:-}}"
# Hugging Face repo slug matches release asset name without .tar.bz2 (e.g. vits-piper-pl_PL-darkman-medium).
HF_MODEL_OWNER="${HF_MODEL_OWNER:-csukuangfj}"
# license_type when all automated sources were tried and none yielded a license (skip on future runs).
LICENSE_EXHAUSTED="${LICENSE_EXHAUSTED:-exhausted}"

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

# Row count for logging (avoid ${#assoc[@]} on empty assoc under set -u on some Bash versions).
existing_csv_rows=0
if [[ -f "$CSV_FILE" ]]; then
  existing_csv_rows=$(($(grep -cve '^[[:space:]]*$' "$CSV_FILE" 2>/dev/null || echo 0)))
  ((existing_csv_rows > 0)) && ((existing_csv_rows--)) # minus header
  ((existing_csv_rows < 0)) && existing_csv_rows=0
fi

echo "=== update_model_license_csv.sh ==="
echo "CSV path: $CSV_FILE"
[[ -n "$STREAM_ID" ]] && echo "Stream id: $STREAM_ID"
echo "ASR license lookup (QNN fallback): $ASR_LICENSE_CSV"
echo "Existing data rows in CSV (excl. header, by line count): $existing_csv_rows"

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

set_exhausted() {
  local name="$1"
  existing_license_type["$name"]="$LICENSE_EXHAUSTED"
  existing_commercial_use["$name"]="unknown"
  existing_confidence["$name"]="high"
  existing_detection_source["$name"]="scan_exhausted"
  existing_license_file["$name"]=""
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

set_hf_model_card() {
  local name="$1"
  local l_type="$2"
  local c_use="$3"
  local conf="$4"
  local page_url="$5"
  local detection_src="${6:-huggingface_model_card}"
  existing_license_type["$name"]="$l_type"
  existing_commercial_use["$name"]="$c_use"
  existing_confidence["$name"]="$conf"
  existing_detection_source["$name"]="$detection_src"
  existing_license_file["$name"]="$page_url"
}

# Prints file body to stdout; returns 0 on HTTP success. Suppresses curl stderr (expected 404 on MODEL_CARD).
fetch_hf_repo_file() {
  local slug="$1"
  local filename="$2"
  local -a _hf_curl=(-sfSL)
  if [[ -n "$_HF_TOKEN" ]]; then
    _hf_curl+=(-H "Authorization: Bearer ${_HF_TOKEN}")
  fi
  _hf_curl+=("https://huggingface.co/${HF_MODEL_OWNER}/${slug}/raw/main/${filename}")
  curl "${_hf_curl[@]}" 2>/dev/null
}

# Extracts the first "* License: value" line (case-insensitive on the label).
parse_model_card_license_field() {
  local card="$1"
  local line lic
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[*][[:space:]]*[Ll]icense:[[:space:]]*(.*) ]]; then
      lic="${BASH_REMATCH[1]}"
      lic="$(echo -n "$lic" | xargs)"
      if [[ -n "$lic" ]]; then
        echo -n "$lic"
        return 0
      fi
    fi
  done <<< "$card"
  return 1
}

# Hugging Face model cards often use YAML front matter: ---\nlicense: apache-2.0\n---
parse_readme_yaml_license_field() {
  local readme="$1"
  local line val in_fm=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == "---" ]]; then
      if [[ "$in_fm" -eq 0 ]]; then
        in_fm=1
      elif [[ "$in_fm" -eq 1 ]]; then
        break
      fi
      continue
    fi
    if [[ "$in_fm" -eq 1 ]] && [[ "$line" =~ ^[Ll]icense:[[:space:]]*(.*) ]]; then
      val="${BASH_REMATCH[1]}"
      val="$(echo -n "$val" | xargs)"
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      if [[ -n "$val" ]]; then
        echo -n "$val"
        return 0
      fi
    fi
  done <<< "$readme"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[Ll]icense:[[:space:]]*(.*) ]]; then
      val="${BASH_REMATCH[1]}"
      val="$(echo -n "$val" | xargs)"
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      if [[ -n "$val" ]]; then
        echo -n "$val"
        return 0
      fi
    fi
  done <<< "$readme"
  return 1
}

# First https://modelscope.cn/models/… URL in text (HF README often links here without YAML license).
extract_first_modelscope_models_url() {
  local readme="$1"
  local url
  url="$(printf '%s\n' "$readme" | grep -oE 'https?://(www\.)?modelscope\.cn/models/[A-Za-z0-9_./%-]+' | head -1)"
  if [[ -z "$url" ]]; then
    url="$(printf '%s\n' "$readme" | grep -oE '(www\.)?modelscope\.cn/models/[A-Za-z0-9_./%-]+' | head -1)"
    if [[ -n "$url" && "$url" != http://* && "$url" != https://* ]]; then
      url="https://${url}"
    fi
  fi
  [[ -n "$url" ]] || return 1
  echo -n "$url"
}

# ModelScope model pages embed JSON in HTML; License field uses escaped quotes: \"License\":\"Apache License 2.0\"
normalize_modelscope_summary_url() {
  local u="$1"
  u="${u%%\?*}"
  u="${u%/}"
  if [[ "$u" != */summary ]]; then
    u="${u}/summary"
  fi
  echo -n "$u"
}

fetch_modelscope_summary_html() {
  local url="$1"
  url="$(normalize_modelscope_summary_url "$url")"
  local -a _ms_curl=(-sfSL -A "Mozilla/5.0 (compatible; react-native-sherpa-onnx-license-update/1.0)")
  _ms_curl+=("$url")
  curl "${_ms_curl[@]}" 2>/dev/null
}

parse_modelscope_license_from_html() {
  local html="$1"
  local lic
  lic="$(printf '%s' "$html" | sed -n 's/.*License\\":\\"\([^\\]*\)\\".*/\1/p' | head -1)"
  lic="$(echo -n "$lic" | xargs)"
  if [[ -n "$lic" ]]; then
    echo -n "$lic"
    return 0
  fi
  lic="$(printf '%s' "$html" | sed -n 's/.*"License":"\([^"]*\)".*/\1/p' | head -1)"
  lic="$(echo -n "$lic" | xargs)"
  if [[ -n "$lic" ]]; then
    echo -n "$lic"
    return 0
  fi
  return 1
}

asset_eligible_for_hf_license_fallback() {
  local asset_name="$1"
  [[ "$asset_name" == vits-piper-*.tar.bz2 || "$asset_name" == sherpa-onnx-*.tar.bz2 ]]
}

# After try_hf_model_card_fallback succeeds, existing_detection_source is set — map to log label.
log_license_fallback_source() {
  local name="$1"
  case "${existing_detection_source["$name"]:-}" in
    modelscope_detail_json)
      echo "ModelScope (via link in Hugging Face README)"
      ;;
    huggingface_model_card)
      echo "Hugging Face (MODEL_CARD or README)"
      ;;
    *)
      echo "online metadata"
      ;;
  esac
}

# Try MODEL_CARD, then README.md YAML; only if still no license, follow modelscope.cn link from README.
try_hf_model_card_fallback() {
  local asset_name="$1"
  local slug page_url card readme raw_lic det l_res c_res conf_res
  local license_ref_url license_ref_src ms_url ms_html ms_raw

  asset_eligible_for_hf_license_fallback "$asset_name" || return 1

  slug="${asset_name%.tar.bz2}"
  page_url="https://huggingface.co/${HF_MODEL_OWNER}/${slug}"
  license_ref_url="$page_url"
  license_ref_src="huggingface_model_card"

  readme=""
  raw_lic=""
  if card="$(fetch_hf_repo_file "$slug" "MODEL_CARD")"; then
    raw_lic="$(parse_model_card_license_field "$card")" || raw_lic=""
  fi
  if [[ -z "$raw_lic" ]]; then
    if readme="$(fetch_hf_repo_file "$slug" "README.md")"; then
      raw_lic="$(parse_readme_yaml_license_field "$readme")" || raw_lic=""
    fi
  fi

  # ModelScope only when HF did not yield a license (README must have been fetched and link MS).
  if [[ -z "$raw_lic" && -n "$readme" ]] && ms_url="$(extract_first_modelscope_models_url "$readme")"; then
    ms_html="$(fetch_modelscope_summary_html "$ms_url")" || ms_html=""
    if [[ -n "$ms_html" ]] && ms_raw="$(parse_modelscope_license_from_html "$ms_html")"; then
      raw_lic="$ms_raw"
      license_ref_url="$(normalize_modelscope_summary_url "$ms_url")"
      license_ref_src="modelscope_detail_json"
    fi
  fi

  [[ -n "$raw_lic" ]] || return 1

  det="$(detect_license "$raw_lic")"
  l_res="$(echo "$det" | cut -d'|' -f1)"
  c_res="$(echo "$det" | cut -d'|' -f2)"
  conf_res="$(echo "$det" | cut -d'|' -f3)"

  if [[ "$l_res" == "unknown" ]]; then
    set_hf_model_card "$asset_name" "$raw_lic" "unknown" "medium" "$license_ref_url" "$license_ref_src"
  else
    set_hf_model_card "$asset_name" "$l_res" "$c_res" "$conf_res" "$license_ref_url" "$license_ref_src"
  fi
  return 0
}

# QNN binary assets: mirror license row from asr-models-license-status.csv (last resort).
qnn_license_fallback_context() {
  [[ "${STREAM_ID:-}" == "asr-models-qnn-binary" ]] && return 0
  [[ "$(basename "$CSV_FILE")" == "qnn-asr-models-license-status.csv" ]] && return 0
  [[ "$1" == *[Qq][Nn][Nn]* ]] && return 0
  return 1
}

strip_qnn_binary_asset_prefix() {
  local n="$1"
  if [[ "$n" =~ ^sherpa-onnx-qnn-[^-]+-binary-[0-9]+-seconds-(.+)$ ]]; then
    echo -n "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# First CSV data row whose first field equals want (after stripping CR); empty if none.
asr_license_csv_row_for_asset_name() {
  local csv="$1"
  local want="$2"
  [[ -f "$csv" ]] || return 1
  awk -F',' -v n="$want" '
    NR == 1 { next }
    {
      key = $1
      sub(/\r$/, "", key)
      if (key == n) { print; exit }
    }
  ' "$csv"
}

# Apply ASR CSV line to QNN asset (same 6 columns as our CSV; keeps QNN asset_name as row key).
apply_asr_license_line_to_qnn_asset() {
  local qnn_asset="$1"
  local line="$2"
  line="${line%$'\r'}"
  local asr_asset license_type commercial_use confidence detection_source license_file remainder
  IFS=',' read -r asr_asset license_type commercial_use confidence detection_source license_file remainder <<< "$line"
  if [[ -n "${remainder:-}" ]]; then
    license_file="${license_file},${remainder}"
  fi
  license_type="${license_type%\"}"; license_type="${license_type#\"}"
  commercial_use="${commercial_use%\"}"; commercial_use="${commercial_use#\"}"
  confidence="${confidence%\"}"; confidence="${confidence#\"}"
  detection_source="${detection_source%\"}"; detection_source="${detection_source#\"}"
  license_file="${license_file%\"}"; license_file="${license_file#\"}"
  existing_license_type["$qnn_asset"]="$license_type"
  existing_commercial_use["$qnn_asset"]="$commercial_use"
  existing_confidence["$qnn_asset"]="$confidence"
  existing_detection_source["$qnn_asset"]="$detection_source"
  existing_license_file["$qnn_asset"]="$license_file"
}

# Set on successful try_qnn_asr_license_fallback (do not capture that function in $(…): subshell drops assoc-array updates).
_QNN_ASR_MIRROR_MATCHED=""

try_qnn_asr_license_fallback() {
  local asset_name="$1"
  local derived cand row matched_asr=""
  local -a cands=()
  local -A tried=()
  _QNN_ASR_MIRROR_MATCHED=""
  qnn_license_fallback_context "$asset_name" || return 1
  derived="$(strip_qnn_binary_asset_prefix "$asset_name")" || return 1
  cands+=("$derived")
  if [[ "$derived" != sherpa-onnx-* ]]; then
    cands+=("sherpa-onnx-${derived}")
  fi
  if [[ "$derived" == *-int8.tar.bz2 ]]; then
    cands+=("sherpa-onnx-${derived%-int8.tar.bz2}.tar.bz2")
  fi
  row=""
  for cand in "${cands[@]}"; do
    [[ -z "$cand" || -n "${tried["$cand"]:-}" ]] && continue
    tried["$cand"]=1
    row="$(asr_license_csv_row_for_asset_name "$ASR_LICENSE_CSV" "$cand")"
    if [[ -n "$row" ]]; then
      matched_asr="$cand"
      break
    fi
  done
  [[ -n "$row" ]] || return 1
  apply_asr_license_line_to_qnn_asset "$asset_name" "$row"
  _QNN_ASR_MIRROR_MATCHED="$matched_asr"
  return 0
}

detect_license() {
  local t="$1"
  t="$(echo "$t" | tr '[:upper:]' '[:lower:]' | tr -s ' \r\n\t' ' ')"

  if [[ "$t" == *"cc0"* || "$t" == *"cc-0"* || "$t" == *"creative commons zero"* || "$t" == *"public domain dedication"* ]]; then echo "cc0|yes|high"
  elif [[ "$t" == *"apache-2.0"* || "$t" == *"apache 2.0"* ]]; then echo "apache-2.0|yes|high"
  elif [[ "$t" == *"apache license 2.0"* ]]; then echo "apache-2.0|yes|high"
  elif [[ "$t" == *"apache license"* && "$t" == *"version 2.0"* ]]; then echo "apache-2.0|yes|high"
  elif [[ "$t" == "mit" || "$t" == *"mit license"* ]]; then echo "mit|yes|high"
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
  l_type_lc="$(echo -n "$l_type" | tr '[:upper:]' '[:lower:]')"
  c_use="${existing_commercial_use["$asset_name"]:-}"
  c_use="$(echo -n "$c_use" | xargs)"
  c_use_lc="$(echo -n "$c_use" | tr '[:upper:]' '[:lower:]')"
  det_src="${existing_detection_source["$asset_name"]:-}"
  det_src="$(echo -n "$det_src" | xargs)"
  det_src_lc="$(echo -n "$det_src" | tr '[:upper:]' '[:lower:]')"
  if [[ "$det_src_lc" == "manual" ]]; then
    echo "  $asset_name — skip (detection_source=manual)"
    continue
  fi
  if [[ "$l_type_lc" == "exhausted" ]]; then
    echo "  $asset_name — skip (license_type=exhausted; clear to re-run automation)"
    continue
  fi
  # Only (re)fill when license_type or commercial_use is empty or explicitly unknown.
  if [[ -n "$l_type" && "$l_type_lc" != "unknown" && -n "$c_use" && "$c_use_lc" != "unknown" ]]; then
    echo "  $asset_name — skip (license_type and commercial_use already set)"
    continue
  fi

  if [[ "$asset_name" == *.onnx ]]; then
    set_exhausted "$asset_name"
    echo "  $asset_name — .onnx bundle --> license_type=$LICENSE_EXHAUSTED (no archive; skipped next run)"
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
    if try_hf_model_card_fallback "$asset_name"; then
      echo "  $asset_name — no license in tree --> filled from $(log_license_fallback_source "$asset_name") (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    if try_qnn_asr_license_fallback "$asset_name"; then
      echo "  $asset_name — no license in tree + HF exhausted --> QNN mirror from asr row (${_QNN_ASR_MIRROR_MATCHED}) (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    set_exhausted "$asset_name"
    echo "  $asset_name — no license in tree + fallbacks exhausted --> license_type=$LICENSE_EXHAUSTED"
    continue
  fi

  echo "  $asset_name — found ${#license_paths[@]} license-like path(s), downloading archive…"
  td="$(mktemp -d -t model-license-XXXXXX)"
  archive_path="${td}/${safe_name}"

  _curl_dl=(-sSL)
  if [[ -n "$_GH_TOKEN" && "$url" == *"github.com"* ]]; then
    _curl_dl+=(-H "Authorization: Bearer ${_GH_TOKEN}" -H "Accept: application/octet-stream")
  fi
  if ! curl "${_curl_dl[@]}" -o "$archive_path" "$url"; then
    rm -rf "$td"
    if try_hf_model_card_fallback "$asset_name"; then
      echo "  $asset_name — download failed --> filled from $(log_license_fallback_source "$asset_name") (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    if try_qnn_asr_license_fallback "$asset_name"; then
      echo "  $asset_name — download failed + HF exhausted --> QNN mirror from asr row (${_QNN_ASR_MIRROR_MATCHED}) (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    set_exhausted "$asset_name"
    echo "  $asset_name — download failed + fallbacks exhausted --> license_type=$LICENSE_EXHAUSTED"
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
      # Avoid bash "ignored null byte" from $(...) and cap size (wrong member / binary).
      out="$(
        tar -xOf "$archive_path" "$c" 2>/dev/null | head -c 524288 | tr -d '\000' || true
      )"
      if [[ -n "$out" ]]; then
        extracted_text="$out"
        used_file="$p"
        break 2
      fi
    done
  done

  if [[ -z "$extracted_text" ]]; then
    rm -rf "$td"
    if try_hf_model_card_fallback "$asset_name"; then
      echo "  $asset_name — could not extract license file --> filled from $(log_license_fallback_source "$asset_name") (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    if try_qnn_asr_license_fallback "$asset_name"; then
      echo "  $asset_name — could not extract license + HF exhausted --> QNN mirror from asr row (${_QNN_ASR_MIRROR_MATCHED}) (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    set_exhausted "$asset_name"
    echo "  $asset_name — could not extract license file + fallbacks exhausted --> license_type=$LICENSE_EXHAUSTED"
    continue
  fi

  det="$(detect_license "$extracted_text")"
  l_res="$(echo "$det" | cut -d'|' -f1)"
  c_res="$(echo "$det" | cut -d'|' -f2)"
  conf_res="$(echo "$det" | cut -d'|' -f3)"

  rm -rf "$td"

  if [[ "$l_res" == "unknown" ]]; then
    if try_hf_model_card_fallback "$asset_name"; then
      echo "  $asset_name — archive license text unknown --> filled from $(log_license_fallback_source "$asset_name") (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    if try_qnn_asr_license_fallback "$asset_name"; then
      echo "  $asset_name — archive text unknown + HF exhausted --> QNN mirror from asr row (${_QNN_ASR_MIRROR_MATCHED}) (license_type=${existing_license_type["$asset_name"]})"
      continue
    fi
    set_exhausted "$asset_name"
    echo "  $asset_name — archive text unclassified + fallbacks exhausted --> license_type=$LICENSE_EXHAUSTED"
    continue
  fi

  set_detected "$asset_name" "$l_res" "$c_res" "$conf_res" "$used_file"
  echo "  $asset_name — detected license_type=$l_res commercial_use=$c_res confidence=$conf_res file=$used_file"
done

echo "--- writing CSV ---"
mkdir -p "$(dirname "$CSV_FILE")"
echo "asset_name,license_type,commercial_use,confidence,detection_source,license_file" > "$CSV_FILE"

declare -A out_seen=()
for name in "${release_assets[@]}"; do
  if [[ -z "${out_seen["$name"]:-}" ]]; then
    echo "${name},${existing_license_type["$name"]:-},${existing_commercial_use["$name"]:-},${existing_confidence["$name"]:-},${existing_detection_source["$name"]:-},${existing_license_file["$name"]:-}" >> "$CSV_FILE"
    out_seen["$name"]=1
  fi
done

declare -a remaining=()
# Empty assoc: ${!existing_asset_name[@]} can trip `set -u` on some Bash builds.
declare -a existing_asset_keys=()
set +u
existing_asset_keys=("${!existing_asset_name[@]}")
set -u
for name in "${existing_asset_keys[@]}"; do
  if [[ -z "${out_seen["$name"]:-}" ]]; then
    remaining+=("$name")
  fi
done

if [[ ${#remaining[@]} -gt 0 ]]; then
  echo "Appending ${#remaining[@]} asset(s) present in CSV but not in current release asset list."
  mapfile -t remaining_sorted < <(printf "%s\n" "${remaining[@]}" | sort)
  for name in "${remaining_sorted[@]}"; do
    echo "${name},${existing_license_type["$name"]:-},${existing_commercial_use["$name"]:-},${existing_confidence["$name"]:-},${existing_detection_source["$name"]:-},${existing_license_file["$name"]:-}" >> "$CSV_FILE"
  done
fi

out_lines=$(wc -l < "$CSV_FILE" | tr -d ' ')
echo "Done. Wrote $CSV_FILE ($out_lines lines including header)."

# Keep Android and iOS bundled copies identical (paths relative to repo root).
# When --csv already points at the Android path, skip copying onto itself (cp errors on same file).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -d "$REPO_ROOT/android" && -d "$REPO_ROOT/ios" && -f "$CSV_FILE" ]]; then
  _bn="$(basename "$CSV_FILE")"
  _android_dir="$REPO_ROOT/android/src/main/assets/model_licenses"
  _ios_dir="$REPO_ROOT/ios/Resources/model_licenses"
  _android_target="$_android_dir/$_bn"
  _ios_target="$_ios_dir/$_bn"
  mkdir -p "$_android_dir" "$_ios_dir"
  same_canonical_path() {
    local a="$1" b="$2"
    local ca cb
    ca="$(cd "$(dirname "$a")" && pwd)/$(basename "$a")"
    cb="$(cd "$(dirname "$b")" && pwd)/$(basename "$b")"
    [[ "$ca" == "$cb" ]]
  }
  if ! same_canonical_path "$CSV_FILE" "$_android_target"; then
    cp "$CSV_FILE" "$_android_target"
  fi
  if ! same_canonical_path "$CSV_FILE" "$_ios_target"; then
    cp "$CSV_FILE" "$_ios_target"
  fi
  echo "Synced $_bn --> android/src/main/assets/model_licenses/ and ios/Resources/model_licenses/"
fi
