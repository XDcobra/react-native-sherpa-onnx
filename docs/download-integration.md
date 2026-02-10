# Model Download Integration Plan (sherpa-onnx TTS)

This document is a step-by-step implementation plan to add model discovery, download, caching, and initialization to the SDK and wire it into the example app.

## 1) Goals
- Provide a first-class SDK download API for TTS models hosted on GitHub Releases.
- Keep the example app lightweight by downloading models on demand.
- Support filtering by language, quantization, size tier, and model type (vits, kokoro, etc.).
- Cache downloads locally and reuse them on subsequent launches.

## 2) Constraints and assumptions
- Models are hosted at: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
- Download URL pattern:
	- https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<model_id>.tar.bz2
- The SDK already supports loading TTS models from a local file system path.
- The example app will use the SDK API and should not implement its own download logic.

## 3) Data model: registry and metadata

### 3.1 Registry file
Create a model registry JSON (generated from docs/tts-models.md) and ship it in the SDK:
- Location: src/models/tts-models.json (or similar)
- Fields per model (example):
	- id: "sherpa-onnx-kokoro-en-XX" (matches file name in GitHub release)
	- displayName
	- type: "vits" | "kokoro" | "matcha" | "kitten" | "zipvoice"
	- languages: ["en", "de", "zh", ...]
	- quantization: "fp16" | "int8" | "int8-quantized" | "unknown"
	- sizeTier: "tiny" | "small" | "medium" | "large" | "unknown"
	- downloadUrl
	- archiveExt: "tar.bz2"
	- expectedFiles (optional): list of required files (model.onnx, tokens.txt, etc.)
	- sha256 (optional, but recommended if available)

### 3.2 Parse or pre-generate registry
- Preferred: generate tts-models.json offline (script) from docs/tts-models.md.
- Keep docs/tts-models.md as the source of truth if you plan to update models.

## 4) SDK API design

### 4.1 Public types
Add an SDK module, e.g. src/download/ModelDownloadManager.ts

Interfaces:
- TtsModelMeta
	- id, displayName, type, languages, quantization, sizeTier, downloadUrl, sha256
- FilterOptions
	- language?: string
	- type?: string
	- quantization?: string
	- sizeTier?: string
- DownloadProgress
	- bytesDownloaded, totalBytes, percent
- DownloadResult
	- modelId, localPath

### 4.2 Public functions
- listTtsModels(): TtsModelMeta[]
- filterTtsModels(options: FilterOptions): TtsModelMeta[]
- getTtsModelById(id: string): TtsModelMeta | null
- isModelDownloaded(id: string): Promise<boolean>
- getLocalModelPath(id: string): Promise<string | null>
- downloadTtsModel(id: string, opts?): Promise<DownloadResult>
	- opts: onProgress, overwrite, signal, maxRetries
- deleteTtsModel(id: string): Promise<void>
- clearModelCache(): Promise<void>

### 4.3 Events (optional)
- Use an event emitter for progress updates when the UI is open.

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
- Add a Model Download screen or section in the TTS settings.
- Steps:
	1) Select language
	2) Select quantization (int8/fp16/auto)
	3) Select size tier (tiny/low/medium/small/etc.)
	4) Select model type (vits/kokoro/etc.)
	5) Show filtered list
	6) Download button with progress

### 7.2 Workflow
- On selection, call SDK filter API to populate dropdown.
- On download confirm, call downloadTtsModel(id).
- After download success, call getLocalModelPath(id) and initialize the TTS pipeline.
- If not downloaded, keep a "Download" call-to-action with size info.

## 8) Error handling and retries

### 8.1 Error categories
- Network: retry with exponential backoff.
- Storage: warn about disk space and allow user to delete other models.
- Corrupt download: delete archive and re-download.
- Extraction failure: clean folder and show a clear message.

### 8.2 User feedback
- Progress bar with speed and ETA (optional).
- Clear failure reasons and retry button.

## 9) Performance and cache strategy
- Maintain LRU metadata to allow auto-cleanup if space is low.
- Provide a "Manage downloads" screen to delete models.
- Store last-used timestamp in a cache manifest.

## 10) Security and policy
- Use HTTPS for downloads only.
- Clearly disclose model downloads in privacy policy.
- Set "Online content" to Yes in Play Console.

## 11) Testing checklist

### 11.1 Unit tests
- Filter logic correctness
- Model registry parsing
- Path resolution and cache manifest

### 11.2 Integration tests
- Successful download of a small model
- Resume after cancel
- Verify extraction and required files
- Initialize TTS using downloaded model path

## 12) Implementation steps (ordered)

1) Create and validate tts-models.json from docs/tts-models.md
2) Add model registry loader in SDK
3) Add filter utilities in SDK
4) Implement download + progress (react-native-fs)
5) Implement tar.bz2 extraction helper
6) Add checksum validation and expected file checks
7) Add cache manifest + ready marker
8) Create example app UI for model selection and download
9) Wire downloaded model path into TTS init
10) Add cleanup UI and LRU strategy (optional)
11) Update privacy policy and Play Console declarations

## 13) Open questions to resolve early
- Which tar.bz2 extraction library is acceptable and tested on Android/iOS?
- Where to host checksums (if GitHub release does not provide)?
- What is the default fallback model when no filter matches?

---

Notes:
- Keep all download logic in the SDK to avoid duplication.
- Ensure the example app uses only the SDK API.
