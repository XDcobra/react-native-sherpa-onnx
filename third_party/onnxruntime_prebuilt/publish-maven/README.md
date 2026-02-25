# Maven publish helper for ONNX Runtime AAR

Used by the **GitHub Actions workflow** (`.github/workflows/build-onnxruntime-android-release.yml`) to publish the built AAR to the GitHub Pages Maven repo (XDcobra/maven). The workflow sets `MAVEN_VERSION`, `AAR_SRC`, and `MAVEN_REPO_PAT`; `GROUP_ID` and `ARTIFACT_ID` come from `publish.env.example`.

**Files:**
- **`publish.env.example`** — Default Maven coordinates (`GROUP_ID`, `ARTIFACT_ID`). Documented there: which env vars the workflow must set (`MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`).
- **`publish-to-github-pages.sh`** — Script that clones the Maven repo, copies AAR + generated POM, updates/creates `maven-metadata.xml`, adds MD5/SHA1 checksums, and pushes. Run from repo root with the required env vars set (or source `publish.env` / `publish.env.example` for defaults).

**Optional local use:** Copy `publish.env.example` to `publish.env`, set `MAVEN_VERSION`, `AAR_SRC`, and `MAVEN_REPO_PAT`, then run from repo root:
```bash
./third_party/onnxruntime_prebuilt/publish-maven/publish-to-github-pages.sh
```

---

For **Gradle-based** publish (build AAR layout + checksums locally), use the ONNX Runtime Gradle wrapper:

```bash
./third_party/onnxruntime/java/gradlew --no-daemon -b publish-maven/build.gradle -c publish-maven/settings.gradle -PaarPath=/path/to/onnxruntime-release.aar -PmavenVersion=1.24.2-qnn2.43.1.260218 publish
```

Output: `build/repo/com/xdcobra/sherpa/onnxruntime/<mavenVersion>/` (aar, pom, checksums).
