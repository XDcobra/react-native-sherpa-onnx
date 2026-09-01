#!/usr/bin/env bash
# Stage collect outputs and push with pull --rebase retries (avoids race when multiple collects run).
#
# Usage:
#   git_commit_collect_changes.sh --message "commit msg" [--config FILE ...]
#   git_commit_collect_changes.sh --message "commit msg" --manifest scripts/ci/sherpa_model_collect_manifest.json
#
# Env (CI): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME
# Optional: GIT_PUSH_MAX_ATTEMPTS (default 8), GITHUB_SERVER_URL (default https://github.com)
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "This script requires Bash version 4+." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECT_SCRIPT="$SCRIPT_DIR/collect_all_sherpa_model_streams.sh"

COMMIT_MESSAGE=""
MANIFEST=""
declare -a CONFIGS=()

usage() {
  echo "Usage: $0 --message <msg> (--config <file> | --manifest <json>)..." >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    --config)
      CONFIGS+=("${2:-}")
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$COMMIT_MESSAGE" ]]; then
  usage
fi

if [[ -n "$MANIFEST" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required when using --manifest" >&2
    exit 1
  fi
  while IFS= read -r cfg; do
    [[ -n "$cfg" ]] && CONFIGS+=("$cfg")
  done < <(jq -r '.configs[]' "$MANIFEST")
fi

if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  echo "At least one --config or --manifest is required" >&2
  exit 1
fi

cd "$REPO_ROOT"

git config user.name "${GIT_USER_NAME:-github-actions[bot]}"
git config user.email "${GIT_USER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

declare -A staged_paths=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  staged_paths["$f"]=1
done < <(
  for cfg in "${CONFIGS[@]}"; do
    bash "$COLLECT_SCRIPT" --config "$cfg" --print-git-paths
  done | sort -u
)

if [[ ${#staged_paths[@]} -eq 0 ]]; then
  echo "No git paths resolved from collect configs" >&2
  exit 1
fi

for f in "${!staged_paths[@]}"; do
  git add "$f"
done

git status --short

if git diff --staged --quiet; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"

_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
_repo="${GITHUB_REPOSITORY:-}"
_branch="${GITHUB_REF_NAME:-}"
_server="${GITHUB_SERVER_URL:-https://github.com}"
_max_attempts="${GIT_PUSH_MAX_ATTEMPTS:-8}"

if [[ -z "$_token" || -z "$_repo" || -z "$_branch" ]]; then
  echo "Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or GITHUB_REF_NAME for push" >&2
  exit 1
fi

_remote="https://x-access-token:${_token}@${_server#https://}/${_repo}.git"

for ((attempt = 1; attempt <= _max_attempts; attempt++)); do
  echo "git push attempt ${attempt}/${_max_attempts} -> ${_branch}"
  if git push "$_remote" "HEAD:${_branch}"; then
    echo "Push succeeded."
    exit 0
  fi

  if [[ "$attempt" -eq "$_max_attempts" ]]; then
    echo "Push failed after ${_max_attempts} attempts" >&2
    exit 1
  fi

  echo "Push rejected; fetching and rebasing onto origin/${_branch}…"
  git fetch "$_remote" "${_branch}"
  if ! git rebase "FETCH_HEAD"; then
    echo "Rebase failed; aborting." >&2
    git rebase --abort || true
    exit 1
  fi
done
