# Maven publish helper for Sherpa-onnx AAR

Used by **`.github/workflows/build-sherpa-onnx-android-release.yml`** to publish the built sherpa-onnx AAR to GitHub Pages Maven (XDcobra/maven) as `com.xdcobra.sherpa:sherpa-onnx:<version>`.

**Modular / Best Practice:** The published POM declares a dependency on `com.xdcobra.sherpa:onnxruntime`, so consumers get ONNX Runtime transitively (no fat AAR).

**Kotlin + Java:** If `AAR_SRC_JAVA` is set and the file exists, the script also publishes the Java API AAR as `artifactId-version-java.aar` (Maven classifier `java`). The workflow sets both `AAR_SRC` (Kotlin) and `AAR_SRC_JAVA` (Java).

**Files:**
- **`publish.env.example`** — Default Maven coordinates (`GROUP_ID`, `ARTIFACT_ID`). Optional `DEPENDENCY_*` for the onnxruntime dependency. Workflow sets `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`, and `DEPENDENCY_VERSION` (from VERSIONS).
- **`publish-to-github-pages.sh`** — Clone maven repo, copy AAR(s) + generated POM (with optional dependency), update `maven-metadata.xml`, add MD5/SHA1 checksums, push. Optional: set `AAR_SRC_JAVA` to also publish the Java API AAR (classifier `java`). Run from repo root with required env vars set.

**Optional local use:** Copy `publish.env.example` to `publish.env`, set `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`, and optionally `DEPENDENCY_VERSION`, then run from repo root:
```bash
./third_party/sherpa-onnx-prebuilt/publish-maven/publish-to-github-pages.sh
```

The AAR is produced by `../create_sherpa_onnx_aar.sh` (from prebuilt `android/` layout).
