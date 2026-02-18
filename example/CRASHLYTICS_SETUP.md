# Firebase Crashlytics Setup

This example app includes Firebase Crashlytics for crash and error reporting. To build and run the app, you need to add your Firebase configuration once.

## One-time setup

### 1. Create a Firebase project (if you don’t have one)

1. Open [Firebase Console](https://console.firebase.google.com/).
2. Create a new project or select an existing one.

### 2. Add an Android app and get `google-services.json`

1. In the Firebase project, click **Add app** → **Android**.
2. **Android package name**: use the app’s package name from `android/app/build.gradle` (`namespace` or `applicationId`), e.g. `com.xdcobra.voicelab`.
3. (Optional) Add your debug signing certificate SHA-1/SHA-256 for features that need it (e.g. Auth). Run:
   ```bash
   cd android && ./gradlew signingReport
   ```
   and add the **SHA-1** and **SHA-256** from the `debug` variant to the Firebase Android app settings.
4. Download **google-services.json** and place it here:
   ```
   example/android/app/google-services.json
   ```
   The path is relative to the repo root: `example/android/app/`.

### 3. Install dependencies and rebuild

From the **example** directory:

```bash
yarn install
cd android && ./gradlew clean
cd .. && yarn android
```

After this, Crashlytics will be active. In debug builds, crash reports are enabled via `firebase.json` (`crashlytics_debug_enabled: true`). Reports appear in the Firebase Console after the app is restarted (or the process ends).

## Configuration

- **example/firebase.json** – React Native Firebase options (e.g. debug Crashlytics, NDK, JS exception handler chaining). See [Crashlytics usage](https://rnfirebase.io/crashlytics/usage).
- **Native symbol upload** – Configured in `android/app/build.gradle` for debug and release so native (C++) crashes are symbolicated in the Firebase Console.

## GitHub Actions (CI)

Workflows that build the example Android app require Firebase config so that the Google Services and Crashlytics plugins can run:

- **App - Android Playstore Release** (`.github/workflows/app-android-release.yml`) – release AAB
- **SDK - Build Android example app** (`.github/workflows/sdk-android.yml`) – debug APK

Add a **repository secret** named `GOOGLE_SERVICES_JSON` with the **full file content** of your `google-services.json` (the same file you place in `example/android/app/` locally). In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Paste the entire JSON (one line or multi-line) as the value.

If this secret is missing, those workflows will fail with a clear error asking you to set it.

## Do not commit secrets

Add `google-services.json` to `.gitignore` if it contains sensitive data, or use a dedicated Firebase project for the example app and keep that file out of version control.
