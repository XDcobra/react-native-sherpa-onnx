# Golden-vector fixtures for diarization parity

Place upstream-generated reference timelines here (JSON):

```json
{
  "audio": "sample.wav",
  "sampleRate": 16000,
  "segments": [
    { "start": 0.12, "end": 1.45, "speaker": 0 }
  ]
}
```

Generate with the upstream `sherpa-onnx-offline-speaker-diarization` binary
against the same pyannote + embedding pair used in CI. Host gtests will load
these when present; until then unit tests cover powerset / clustering / timeline
layers independently.
