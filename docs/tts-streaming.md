# Streaming TTS

Native sample-level incremental streaming TTS (online decoding) is **not supported** by the underlying `sherpa-onnx` engine.

To use TTS in a live pipeline (e.g., synthesizing text as it arrives from a live STT buffer or a network stream), you must use the **Live Overload** on the offline TTS engine. This approach uses mandatory segmentation to slice the incoming text into discrete segments (sentences or character blocks) and synthesizes them using offline weights.

For implementation details, code examples, and configuration options, please refer to the following section in the offline TTS documentation:

👉 **[Live overload on offline TTS (offline weights, live consumption)](tts-offline.md#live-overload-on-offline-tts-offline-weights-live-consumption)**
