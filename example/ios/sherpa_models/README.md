# Sherpa Models (iOS)

Models placed here are copied into the app at build time and are available under the `models/…` asset path.

## Usage

- **`models/` folder**  
  Add one subfolder per model under `sherpa_models/models/` (e.g. `models/my-stt-model/` with all ONNX and token files inside).

- **Build**  
  An extra build phase copies the contents of `sherpa_models/models/` into the app bundle (`App.app/models/`). It runs after “Download SherpaOnnx Models”.

- **For models not loaded by the script**  
  The script `example/scripts/download-models.js` only fetches models listed in `model-download-config.json`. Any other models (custom or not in the config) can be placed here so they are bundled with the app.

## Example

```
sherpa_models/
  README.md          (this file)
  models/
    my-whisper/      → available in the app as models/my-whisper
      encoder.onnx
      decoder.onnx
      tokens.txt
```

In the app, use e.g. `resolveModelPath({ type: 'asset', path: 'models/my-whisper' })` or discover the model via `listAssetModels()`.
