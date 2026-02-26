#!/usr/bin/env bash
# Publish FFmpeg Android AAR to GitHub Pages Maven (XDcobra/maven).
# Requires: MAVEN_VERSION, AAR_SRC, MAVEN_REPO_PAT in environment.
# Optionally source publish.env.example (or publish.env) for GROUP_ID, ARTIFACT_ID.
# Run from repository root (e.g. in CI after the AAR is built).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

echo "Publishing ${GROUP_ID}:${ARTIFACT_ID}:${MAVEN_VERSION} to https://github.com/XDcobra/maven"

git clone --depth 1 "https://x-access-token:${MAVEN_REPO_PAT}@github.com/XDcobra/maven.git" maven-repo
cd maven-repo
REPO_ROOT="$(pwd)"

mkdir -p "$VERSION_PATH"
cp "../${AAR_SRC}" "$VERSION_PATH/${AAR_NAME}"

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
" "$GROUP_ID" "$ARTIFACT_ID" "$MAVEN_VERSION" "$VERSION_PATH/${POM_NAME}"

cd "$VERSION_PATH"
for f in "$AAR_NAME" "$POM_NAME"; do
  md5sum "$f" | cut -d' ' -f1 > "${f}.md5"
  sha1sum "$f" | cut -d' ' -f1 > "${f}.sha1"
done
cd "$REPO_ROOT"

METADATA_FILE="${REPO_ROOT}/${ARTIFACT_PATH}/maven-metadata.xml"
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
if [ -f "$METADATA_FILE" ]; then
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
" "$METADATA_FILE" "$MAVEN_VERSION" "$TIMESTAMP"
else
  mkdir -p "${REPO_ROOT}/${ARTIFACT_PATH}"
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
" "$GROUP_ID" "$ARTIFACT_ID" "$MAVEN_VERSION" "$TIMESTAMP" "$METADATA_FILE"
fi

cd "${REPO_ROOT}/${ARTIFACT_PATH}"
md5sum maven-metadata.xml | cut -d' ' -f1 > maven-metadata.xml.md5
sha1sum maven-metadata.xml | cut -d' ' -f1 > maven-metadata.xml.sha1
cd "$REPO_ROOT"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add "$GROUP_PATH"
git add "$ARTIFACT_PATH/maven-metadata.xml" "$ARTIFACT_PATH/maven-metadata.xml.md5" "$ARTIFACT_PATH/maven-metadata.xml.sha1" 2>/dev/null || true
if ! git diff --staged --quiet; then
  git commit -m "Maven: add ${ARTIFACT_ID} ${MAVEN_VERSION}"
  git push
fi
cd ..
rm -rf maven-repo
echo "Published ${GROUP_ID}:${ARTIFACT_ID}:${MAVEN_VERSION} to https://xdcobra.github.io/maven/"
