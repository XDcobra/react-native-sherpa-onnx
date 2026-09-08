# Speaker-embedding sharing — Android verification

SID and diarization both use `SpeakerEmbeddingRunner` under
`android/src/main/cpp/speaker-embedding/`. Acquires with the same
`(model_path, provider, num_threads, debug)` share one ONNX load.

## Manual check (device / emulator)

1. Build and install the example app with the same embedding ONNX available for
   SID and offline diarization.
2. Start logcat filtered on the runner tag:

```bash
adb logcat -s SherpaOnnx:SpeakerEmbedding
```

3. Initialize SID with the embedding model, then run diarization with the **same**
   model path / provider / thread count / debug flag.
4. Expect:

- First acquire: `Acquire cache-miss create model=... dim=N`
- Second acquire: `Acquire cache-hit model=... dim=N`

Host gtests cover registry-key equality/normalization only (no sherpa C-API
on CI). Full Acquire/Compute/Manager sharing is verified on device via the
logcat checks above. A future host job may link a real desktop `libsherpa-onnx-c-api`.
