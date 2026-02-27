# Sherpa Models (iOS)

Content placed here is copied into the app at build time by the “Copy Sherpa models and test_wavs from sherpa_models” build phase (runs after “Download SherpaOnnx Models”).

## Models

- **`models/` folder**  
  Add one subfolder per model under `sherpa_models/models/` (e.g. `models/my-stt-model/` with all ONNX and token files inside). They are copied to `App.app/models/` and available as asset paths like `models/my-whisper`.

- **For models not loaded by the script**  
  The script `example/scripts/download-models.js` only fetches models listed in `model-download-config.json`. Any other models (custom or not in the config) can be placed here so they are bundled with the app.

In the app, use e.g. `resolveModelPath({ type: 'asset', path: 'models/my-whisper' })` or discover the model via `listAssetModels()`.

## Example test audios

- **`test_wavs/` folder**  
  Place example WAV files here (e.g. `0-en.wav`, `1-en.wav`, `0-zh.wav`) for the STT “Example English 1” etc. They are copied to `App.app/test_wavs/` and resolved as asset paths like `test_wavs/0-en.wav` via `resolveModelPath({ type: 'asset', path: 'test_wavs/0-en.wav' })`.

If the folder is empty, the example app’s sample-audio options will show “Path not found” until you add the WAV files (you can obtain test files from the same source as in `example/scripts/download-models.js` or record your own).

## Layout

```
sherpa_models/
  README.md          (this file)
  models/
    my-whisper/      --> App.app/models/my-whisper
      encoder.onnx
      decoder.onnx
      tokens.txt
  test_wavs/
    0-en.wav         --> App.app/test_wavs/0-en.wav
    1-en.wav
    ...
```
