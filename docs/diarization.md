# Speaker Diarization

This feature is not yet supported in the React Native SDK.

For **named-speaker** enroll / identify / verify (offline), see [speaker-identification-offline.md](./speaker-identification-offline.md). Diarization will reuse the same speaker-embedding foundation with anonymous cluster indices instead of the SID named-speaker manager.

## Quick Usage

There is no diarization API available yet. This page will be updated once diarization support ships.

## Status

- Planned for future release 1.1.0
- API and configuration are not available yet

Follow the project roadmap or open an issue to track progress.

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

