# Bundled models (Android example app)

Place **model directories** in this folder if you want them **shipped inside the APK** and available to the example app without a network step.

## What to put here

- Use **one folder per model** (the same layout you would get after extracting a Sherpa-ONNX release archive).
- Folder names are typically used as **model IDs** in the app (e.g. `sherpa-onnx-whisper-tiny`).
- Keep only what you need—large models increase APK size and build time.

After adding or changing files under `assets/models/`, rebuild the Android app so Gradle packages the new assets.

## Alternative: download at runtime

You do **not** have to bundle models here. The example app includes a **Download Manager** screen: use it to download the model you want to device storage, then pick that model from the app’s model lists.

Bundled assets and downloaded models are both supported; choose whichever fits your workflow (offline demos vs. smaller APK + on-demand download).
