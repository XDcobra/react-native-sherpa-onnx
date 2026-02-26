# Maven publish helper for FFmpeg Android AAR

Used by **`.github/workflows/build-ffmpeg-android-release.yml`** to publish the built FFmpeg (+ libshine) AAR to GitHub Pages Maven (XDcobra/maven) as `com.xdcobra.sherpa:ffmpeg:<version>`.

**AAR contents:** `jni/arm64-v8a/`, `jni/armeabi-v7a/`, `jni/x86/`, `jni/x86_64/` (`.so` files) and `include/` (FFmpeg headers). Gradle extracts jni into `android/src/main/jniLibs` and include into `android/src/main/cpp/include/ffmpeg`.

**Files:**
- **`publish.env.example`** — Default Maven coordinates (`GROUP_ID`, `ARTIFACT_ID`). Workflow sets `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`.
- **`publish-to-github-pages.sh`** — Clone maven repo, copy AAR + generated POM, update `maven-metadata.xml`, add MD5/SHA1 checksums, push. Run from repo root with required env vars set.

**Optional local use:** Copy `publish.env.example` to `publish.env`, set `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`, then run from repo root:
```bash
./third_party/ffmpeg_prebuilt/publish-maven/publish-to-github-pages.sh
```

The AAR is produced by `../create_ffmpeg_aar.sh` (from the layout built in the workflow: `ffmpeg-android-layout/`).
