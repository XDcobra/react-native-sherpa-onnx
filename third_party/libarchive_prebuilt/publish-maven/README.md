# Maven publish helper for libarchive Android AAR

Used by **`.github/workflows/build-libarchive-android-release.yml`** to publish the built libarchive AAR to GitHub Pages Maven (XDcobra/maven) as `com.xdcobra.sherpa:libarchive:<version>`.

**AAR contents:** `jni/arm64-v8a/`, `jni/armeabi-v7a/`, `jni/x86/`, `jni/x86_64/` (libarchive.so) and `include/` (headers).

**Optional local use:** Copy `publish.env.example` to `publish.env`, set `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`, then run from repo root:
```bash
./third_party/libarchive_prebuilt/publish-maven/publish-to-github-pages.sh
```

The AAR is produced by `../create_libarchive_aar.sh` (from the layout built in the workflow: `libarchive-android-layout/`).
