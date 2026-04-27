# SDK Feature Support Matrix

Stand: Codebasis in `react-native-sherpa-onnx` + `third_party/sherpa-onnx` (Kotlin/C-API).

| Feature | sherpa-onnx: Offline-Config (Kotlin/C-API) | sherpa-onnx: Live/Streaming-Config (Kotlin/C-API) | Unser SDK: Offline-Engine | Unser SDK: Live-Engine (Echt vs. Fake) |
|---|---|---|---|---|
| STT (Speech-to-Text) | Ja | Ja | Ja (`createSTT`) | Ja, **Echt-Streaming** (`createStreamingSTT` / `createLiveSTT`) |
| TTS (Text-to-Speech) | Ja | Nein | Ja (`createTTS`) | Ja, **Fake-Streaming** (Pipeline-Streaming via `createStreamingTTS` + `createIncrementalStreamingTTS`, aber kein natives Online-TTS-Config in sherpa) |
| VAD (Voice Activity Detection) | Nein (kein separates Offline-Config-Modell in sherpa) | Ja (`VadModelConfig`) | Ja (Offline-Run via `createStreamingVAD(...).process()` mit Offline-Audio) | Ja, **Echt-Streaming** (`createStreamingVAD` mit Live-Audio-Pipeline) |
| Speech Enhancement / Denoiser | Ja (`OfflineSpeechDenoiserConfig`) | Ja (`OnlineSpeechDenoiserConfig`) | Ja (`createEnhancement`) | Ja, **Echt-Streaming** (`createStreamingEnhancement`) |
| Alignment (Audio/Text Alignment) | Nein (kein dediziertes sherpa Alignment-Config in Kotlin/C-API) | Nein | Ja (`alignTextToAudio`) | Nein als dedizierte Live-Engine; **Fake-Streaming manuell möglich** (chunk-/segmentweise Orchestrierung) |
| Punctuation | Ja (`OfflinePunctuationConfig`) | Ja (`OnlinePunctuationConfig`) | Nein (derzeit keine öffentliche SDK-Engine) | Nein (derzeit keine öffentliche SDK-Engine) |

## Kurznotizen

- **TTS Live im SDK** ist aktuell pipeline-basiert und wird als Streaming genutzt, obwohl sherpa selbst kein separates Online-TTS-Config wie bei Online-ASR bereitstellt.
- **VAD** ist im SDK als ein Engine-Einstiegspunkt umgesetzt (`createStreamingVAD`), der sowohl Live-Pipeline als auch Offline-Verarbeitung abdecken kann.
- **Alignment** ist im SDK vorhanden, aber nicht als echte Streaming-Engine; laufende/segmentierte Verarbeitung ist nur orchestriert als Fake-Streaming.
- **Punctuation** ist in sherpa vorhanden, aber im aktuellen SDK (dieser Codebasis) noch nicht als eigenes öffentliches Modul/Engine exposed.
