# Model Download Integration Plan (sherpa-onnx TTS)

This document is a step-by-step implementation plan to add model discovery, download, caching, and initialization to the SDK and wire it into the example app.

## 1) Goals
- Provide a first-class SDK download API for TTS models hosted on GitHub Releases.
- Keep the example app lightweight by downloading models on demand.
- Show only downloaded/cached models on feature screens (tts/stt/etc.).
- Add a dedicated model management screen to download and delete models.
- Support filtering by language, quantization, size tier, and model type (vits, kokoro, etc.).
- Cache downloads locally and reuse them on subsequent launches.

## 2) Constraints and assumptions
- Models are hosted at: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
- Download URL pattern:
	- https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<model_id>.tar.bz2
- The SDK will fetch the model list dynamically via GitHub API and cache it in app storage.
- The SDK already supports loading TTS models from a local file system path.
- The example app will use the SDK API and should not implement its own download logic.

## 3) Data model: registry and metadata

### 3.1 Dynamic registry (GitHub API)
Fetch model assets at runtime from GitHub Releases API and cache the results:
- Release endpoint (tag): https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/tts-models
- The API returns assets with name, size, and download URL.
- Cache response locally (e.g. models-cache.json) with a timestamp.

### 3.2 Model metadata structure
For each asset, derive metadata for filtering:
- id: asset name without extension (matches file name in GitHub release)
- displayName (human readable)
- type: "vits" | "kokoro" | "matcha" | "kitten" | "zipvoice" | "unknown"
- languages: ["en", "de", "zh", ...] (parsed from asset name)
- quantization: "fp16" | "int8" | "int8-quantized" | "unknown"
- sizeTier: "tiny" | "small" | "medium" | "large" | "unknown" (heuristic)
- downloadUrl
- archiveExt: "tar.bz2"
- bytes: number (from GitHub asset size)

### 3.3 Unsupported models handling
- If a model type is unknown/unsupported, do not show it in the dropdown.
- Log it in Logcat with a stable tag (e.g. "SherpaOnnxModelList").

## 4) SDK API design

### 4.1 Public types
Add an SDK module, e.g. src/download/ModelDownloadManager.ts

Interfaces:
- TtsModelMeta
	- id, displayName, type, languages, quantization, sizeTier, downloadUrl, sha256
- DownloadProgress
	- bytesDownloaded, totalBytes, percent
- DownloadResult
	- modelId, localPath

### 4.2 Public functions
- listModelsByCategory(category): Promise<TtsModelMeta[]>
- refreshModelsByCategory(category, options?): Promise<TtsModelMeta[]>
	- options: forceRefresh, cacheTtlMinutes
- getModelsCacheStatusByCategory(category): Promise<{ lastUpdated: string | null, source: "cache" | "remote" }>
- getModelByIdByCategory(category, id): Promise<TtsModelMeta | null>
- listDownloadedModelsByCategory(category): Promise<TtsModelMeta[]>
- isModelDownloadedByCategory(category, id): Promise<boolean>
- getLocalModelPathByCategory(category, id): Promise<string | null>
- downloadModelByCategory(category, id, opts?): Promise<DownloadResult>
	- opts: onProgress, overwrite, signal, maxRetries
- deleteModelByCategory(category, id): Promise<void>
- clearModelCacheByCategory(category): Promise<void>

### 4.3 Events (optional)
- Use an event emitter for progress updates when the UI is open.
- Emit "modelsListUpdated" when cache is refreshed.

## 5) Download pipeline

### 5.1 Storage layout
Use the app's documents directory (per platform):
- Base: <appDocuments>/sherpa-onnx/models/tts/<modelId>/
- Archive: <modelId>.tar.bz2
- Extracted files: model.onnx, tokens.txt, etc.

### 5.2 Download steps
1) Validate model id exists in registry.
2) Ensure cache directory exists.
3) If archive already exists and overwrite=false, skip download.
4) Download archive with progress and resume support if possible.
5) Verify checksum if sha256 available.
6) Extract tar.bz2 to target directory.
7) Validate required files exist (expectedFiles).
8) Mark model as ready (e.g. create .ready file).

### 5.3 Download implementation details
- Use react-native-fs for download to file.
- Use a pure JS tar+bz2 library or native helper.
- For large files, ensure streaming and avoid loading the whole file into memory.
- Prefer GitHub API response for model size, show size in UI.

## 6) Extraction and verification

### 6.1 Extraction
- tar.bz2 extraction should be a utility inside the SDK.
- Must be cross-platform; test on Android and iOS.

### 6.2 Verification
- If sha256 present, verify after download before extraction.
- After extraction, check expected files exist.
- Create a lightweight manifest.json for the cached model to record version and file list.

## 7) Example app integration

### 7.1 UI screens
- Add a Model Management screen and place a download icon next to the settings icon.
- The Model Management screen shows:
	1) Filters: language, quantization, size tier, model type (include "Any")
	2) Available models list (filtered) with size (MB)
	3) Download button with progress
	4) Downloaded/cached models list
	5) Delete action for cached models
- Feature screens (tts/stt/etc.) only list downloaded/cached models.
- If no cached models exist, show an empty state with a shortcut to the Model Management screen.

### 7.2 Workflow
- Model Management screen:
	- On screen open, call refreshModelsByCategory(...).
	- If cache is empty due to API failure, show an error message and a "Reload" button.
	- Use UI filters to populate the available list.
	- On download confirm, call downloadModelByCategory(...).
	- After download success, update the downloaded list and show ready state.
	- On delete, call deleteModelByCategory(...) and refresh lists.
- Feature screens (tts/stt/etc.):
	- On screen open, call listDownloadedModelsByCategory(...) (or cached manifest) and show only local models.
	- On selection, call getLocalModelPathByCategory(...) and initialize the pipeline.
	- If no local models exist, show a prompt to open Model Management.

## 8) Error handling and retries

### 8.1 Error categories
- GitHub API: retry with exponential backoff, then surface cache empty error.
- Network: retry with exponential backoff.
- Storage: warn about disk space and allow user to delete other models.
- Corrupt download: delete archive and re-download.
- Extraction failure: clean folder and show a clear message.

### 8.2 User feedback
- Progress bar with speed and ETA (optional).
- Clear failure reasons and retry button.

## 9) Performance and cache strategy
- Cache the GitHub models list with TTL (e.g. 24 hours).
- Maintain LRU metadata to allow auto-cleanup if space is low.
- Provide a "Manage downloads" screen to delete models.
- Store last-used timestamp in a cache manifest.

## 10) Security and policy
- Use HTTPS for downloads only.
- Clearly disclose model downloads in privacy policy.
- Set "Online content" to Yes in Play Console.

## 11) Implementation steps (ordered)

1) Implement GitHub API fetch for tts-models release assets
2) Add model list cache (JSON + timestamp + TTL)
3) Parse asset names into model metadata (type, language, quantization, sizeTier)
4) Add filtering utilities in the UI ("Any" handled by the app)
5) Implement download + progress (react-native-fs)
6) Implement tar.bz2 extraction helper
7) Add checksum validation and expected file checks (if available)
8) Add cache manifest + ready marker
9) Add model management screen with download/delete and filters
10) Add error + reload UI if model list cache is empty
11) Update feature screens to show only cached models
12) Wire downloaded model path into TTS init
13) Add cleanup UI and LRU strategy (optional)
14) Update privacy policy and Play Console declarations

## 12) Open questions to resolve early
- tar.bz2 extraction: use our own native solution extractTarBz2()
- Checksums: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/checksum.txt
- Fallback model: none yet. Show a disclaimer when no models match a filter combination.
- Cache TTL for GitHub API model list updates.

---

Notes:
- Keep all download logic in the SDK to avoid duplication.
- Ensure the example app uses only the SDK API.
