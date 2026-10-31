# Maven publish helper for lexbor Android AAR

Used by **`.github/workflows/build-lexbor-android-release.yml`** to publish the built lexbor AAR to GitHub Pages Maven ([XDcobra/maven](https://github.com/XDcobra/maven) → https://xdcobra.github.io/maven/) as `com.xdcobra.sherpa:lexbor:<version>` (current: **3.0.0-1**).

**AAR contents:** `jni/arm64-v8a/`, `jni/armeabi-v7a/`, `jni/x86/`, `jni/x86_64/` (`liblexbor.so`) and `include/` (headers).

**Optional local use:** Copy `publish.env.example` to `publish.env`, set `MAVEN_VERSION`, `AAR_SRC`, `MAVEN_REPO_PAT`, then run from repo root:
```bash
./third_party/lexbor_prebuilt/publish-maven/publish-to-github-pages.sh
```

The AAR is produced by `../create_lexbor_aar.sh` (from the layout built in the workflow: `lexbor-android-layout/`).
