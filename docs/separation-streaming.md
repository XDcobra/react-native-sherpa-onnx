# Streaming source separation

Native sample-level incremental streaming source separation (online decoding) is **not supported** by the underlying `sherpa-onnx` engine.

To separate vocals from accompaniment in a **live pipeline** (e.g. mixed audio from a microphone or a long file ingested into a `LiveAudioBuffer`), use the **live overload** on the **offline** separation engine: mandatory **`continuous_frames`** segmentation turns incoming audio into discrete chunks; each chunk is separated with **offline** Spleeter/UVR weights into **N `LiveAudioBuffer` stems**. That path returns a **`SeparationPipelineHandle`** — the same **pipeline control** surface as other streaming features (`stop`, `flush`, `reset`, `getStatus`, `completed`). See **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)** for how those calls interact with the native worker and buffer finalization.

For implementation details, code examples, configuration, and **pipeline handle** semantics specific to separation:

👉 **[Live overload on offline separation (offline weights, live consumption)](separation-offline.md#live-overload-on-offline-separation-offline-weights-live-consumption)**

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
