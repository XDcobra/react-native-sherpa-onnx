# Streaming TTS

Native sample-level incremental streaming TTS (online decoding) is **not supported** by the underlying `sherpa-onnx` engine.

To use TTS in a **live pipeline** (e.g. synthesizing text as it arrives from a live STT buffer or a network stream), use the **live overload** on the **offline** TTS engine: mandatory **text segmentation** turns the incoming **`LiveTextBuffer`** into discrete chunks; each chunk is synthesized with **offline** weights into a **`LiveAudioBuffer`**. That path returns a **`TtsPipelineHandle`** — the same **pipeline control** surface as other streaming features (`stop`, `flush`, `reset`, `getStatus`, `completed`). See **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)** for how those calls interact with the native worker and buffer finalization.

For implementation details, code examples, configuration, and **pipeline handle** semantics specific to TTS:

👉 **[Live overload on offline TTS (offline weights, live consumption)](tts-offline.md#live-overload-on-offline-tts-offline-weights-live-consumption)**
