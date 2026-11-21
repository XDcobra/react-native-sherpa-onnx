#!/usr/bin/env bash
# Publish FFmpeg Android AAR to GitHub Pages Maven (XDcobra/maven).
# Requires: MAVEN_VERSION, AAR_SRC, MAVEN_REPO_PAT in environment.
# Optionally source publish.env.example (or publish.env) for GROUP_ID, ARTIFACT_ID.
# Run from repository root (e.g. in CI after the AAR is built).
#
# Several release jobs publish into the same repository at the same time (e.g.
# ffmpeg and ffmpeg-vsw). Each one only writes its own artifact directory, so a
# rejected push is retried on a fresh clone with the same files re-applied.
# PUBLISH_ATTEMPTS (default 5) bounds the retries.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Caller env (e.g. ARTIFACT_ID=ffmpeg-vsw) wins over the example defaults.
_SAVED_GROUP_ID="${GROUP_ID:-}"
_SAVED_ARTIFACT_ID="${ARTIFACT_ID:-}"
if [ -f "${SCRIPT_DIR}/publish.env" ]; then
  set -a
  # shellcheck source=publish.env
  . "${SCRIPT_DIR}/publish.env"
  set +a
elif [ -f "${SCRIPT_DIR}/publish.env.example" ]; then
  set -a
  # shellcheck source=publish.env.example
  . "${SCRIPT_DIR}/publish.env.example"
  set +a
fi
[ -n "${_SAVED_GROUP_ID}" ] && GROUP_ID="${_SAVED_GROUP_ID}"
[ -n "${_SAVED_ARTIFACT_ID}" ] && ARTIFACT_ID="${_SAVED_ARTIFACT_ID}"

for var in GROUP_ID ARTIFACT_ID MAVEN_VERSION AAR_SRC MAVEN_REPO_PAT; do
  eval "val=\${$var}"
  if [ -z "$val" ]; then
    echo "::error::Missing required env: $var" >&2
    exit 1
  fi
done

GROUP_PATH="${GROUP_ID//.//}"
ARTIFACT_PATH="${GROUP_PATH}/${ARTIFACT_ID}"
VERSION_PATH="${ARTIFACT_PATH}/${MAVEN_VERSION}"
AAR_NAME="${ARTIFACT_ID}-${MAVEN_VERSION}.aar"
POM_NAME="${ARTIFACT_ID}-${MAVEN_VERSION}.pom"
AAR_ABS="$(cd "$(dirname "${AAR_SRC}")" && pwd)/$(basename "${AAR_SRC}")"
WORK_ROOT="$(pwd)"
CLONE_DIR="${WORK_ROOT}/maven-repo"
# MAVEN_REPO_URL: override for tests (e.g. a local bare repository).
REPO_URL="${MAVEN_REPO_URL:-https://x-access-token:${MAVEN_REPO_PAT}@github.com/XDcobra/maven.git}"

echo "Publishing ${GROUP_ID}:${ARTIFACT_ID}:${MAVEN_VERSION} to https://github.com/XDcobra/maven"

# Writes the AAR, POM, checksums and maven-metadata.xml into the clone at $1.
apply_files() {
  local repo_root="$1"
  mkdir -p "${repo_root}/${VERSION_PATH}" || return 1
  cp "${AAR_ABS}" "${repo_root}/${VERSION_PATH}/${AAR_NAME}" || return 1

  python3 -c "
import sys
g, a, v, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
open(path, 'w').write('''<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<project xmlns=\"http://maven.apache.org/POM/4.0.0\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">
  <modelVersion>4.0.0</modelVersion>
  <groupId>''' + g + '''</groupId>
  <artifactId>''' + a + '''</artifactId>
  <version>''' + v + '''</version>
  <packaging>aar</packaging>
  <name>''' + a + '''</name>
  <description>FFmpeg + libshine for Android. Built from react-native-sherpa-onnx. Native libs (jni) and headers (include).</description>
</project>''')
" "$GROUP_ID" "$ARTIFACT_ID" "$MAVEN_VERSION" "${repo_root}/${VERSION_PATH}/${POM_NAME}" || return 1

  local f
  for f in "$AAR_NAME" "$POM_NAME"; do
    (cd "${repo_root}/${VERSION_PATH}" \
      && md5sum "$f" | cut -d' ' -f1 > "${f}.md5" \
      && sha1sum "$f" | cut -d' ' -f1 > "${f}.sha1") || return 1
  done

  local metadata="${repo_root}/${ARTIFACT_PATH}/maven-metadata.xml"
  local timestamp
  timestamp=$(date -u +%Y%m%d%H%M%S)
  if [ -f "$metadata" ]; then
    python3 -c "
import sys, xml.etree.ElementTree as ET
path, new_ver, ts = sys.argv[1], sys.argv[2], sys.argv[3]
tree = ET.parse(path)
root = tree.getroot()
ver = root.find('versioning')
if ver is None:
    ver = ET.SubElement(root, 'versioning')
versions_el = ver.find('versions')
if versions_el is None:
    versions_el = ET.SubElement(ver, 'versions')
existing = {e.text.strip() for e in versions_el.findall('version') if e.text}
if new_ver not in existing:
    v = ET.SubElement(versions_el, 'version')
    v.text = new_ver
for tag in ('latest', 'release'):
    el = ver.find(tag)
    if el is not None:
        el.text = new_ver
last = ver.find('lastUpdated')
if last is not None:
    last.text = ts
else:
    ET.SubElement(ver, 'lastUpdated').text = ts
tree.write(path, encoding='unicode', default_namespace='', method='xml')
" "$metadata" "$MAVEN_VERSION" "$timestamp" || return 1
  else
    mkdir -p "${repo_root}/${ARTIFACT_PATH}" || return 1
    python3 -c "
import sys
g, a, v, ts, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
open(path, 'w').write('''<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<metadata>
  <groupId>''' + g + '''</groupId>
  <artifactId>''' + a + '''</artifactId>
  <versioning>
    <latest>''' + v + '''</latest>
    <release>''' + v + '''</release>
    <versions>
      <version>''' + v + '''</version>
    </versions>
    <lastUpdated>''' + ts + '''</lastUpdated>
  </versioning>
</metadata>
''')
" "$GROUP_ID" "$ARTIFACT_ID" "$MAVEN_VERSION" "$timestamp" "$metadata" || return 1
  fi

  (cd "${repo_root}/${ARTIFACT_PATH}" \
    && md5sum maven-metadata.xml | cut -d' ' -f1 > maven-metadata.xml.md5 \
    && sha1sum maven-metadata.xml | cut -d' ' -f1 > maven-metadata.xml.sha1) || return 1
}

# One attempt on a fresh shallow clone. Exit status: 0 published (or nothing
# to publish), 1 hard error, 2 push rejected (retry).
publish_once() {
  rm -rf "$CLONE_DIR"
  git clone --depth 1 "$REPO_URL" "$CLONE_DIR" || return 2
  apply_files "$CLONE_DIR" || return 1
  (
    cd "$CLONE_DIR" || exit 1
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add "$GROUP_PATH" || exit 1
    git add "$ARTIFACT_PATH/maven-metadata.xml" "$ARTIFACT_PATH/maven-metadata.xml.md5" "$ARTIFACT_PATH/maven-metadata.xml.sha1" 2>/dev/null || true
    if git diff --staged --quiet; then
      echo "Nothing to publish (already up to date)."
      exit 0
    fi
    git commit -m "Maven: add ${ARTIFACT_ID} ${MAVEN_VERSION}" || exit 1
    git push || exit 2
  )
}

max_attempts="${PUBLISH_ATTEMPTS:-5}"
attempt=1
while true; do
  status=0
  publish_once || status=$?
  if [ "$status" -eq 0 ]; then
    break
  fi
  if [ "$status" -eq 1 ]; then
    echo "::error::Preparing ${ARTIFACT_ID} ${MAVEN_VERSION} for Maven failed" >&2
    rm -rf "$CLONE_DIR"
    exit 1
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::Push to XDcobra/maven still rejected after ${attempt} attempts" >&2
    rm -rf "$CLONE_DIR"
    exit 1
  fi
  delay=$((attempt * 10 + RANDOM % 10))
  echo "Push rejected (another publisher pushed first?); retrying on a fresh clone in ${delay}s (attempt $((attempt + 1))/${max_attempts})"
  sleep "$delay"
  attempt=$((attempt + 1))
done
rm -rf "$CLONE_DIR"
echo "Published ${GROUP_ID}:${ARTIFACT_ID}:${MAVEN_VERSION} to https://xdcobra.github.io/maven/"
