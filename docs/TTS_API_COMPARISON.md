# TTS API-Vergleich: Kotlin-API, React-Native-Bridge und C-API

Dieses Dokument protokolliert die Analyse der Offline-TTS-Funktionen von sherpa-onnx im Hinblick auf:

1. **Kotlin-API** (sherpa-onnx AAR: `com.k2fsa.sherpa.onnx`): Welche Features, Funktionen und Initialisierungsoptionen für TTS verfügbar sind.
2. **React-Native-JS-Bridge** (dieses Paket): Welche offlinegeeigneten Kotlin-Features noch nicht in der öffentlichen API (tts/index.ts, NativeSherpaOnnx.ts, types.ts) angeboten werden.
3. **C-API** (sherpa-onnx c-api.h / cxx-api.h): Welche Offline-TTS-Funktionen in der C-API existieren, aber nicht in der Kotlin-API abgebildet sind.

Die bestehende Feature-Liste und Nutzer-API sind in [tts.md](./tts.md) beschrieben.

---

## Zusammenfassung: Was können wir ohne C-API ergänzen?

**Prüfung Kotlin-API (Quelle: `sherpa-onnx/kotlin-api/Tts.kt`):**  
Die Datenklasse `OfflineTtsConfig` (Zeilen 82–88) enthält **alle vier** Config-Felder:

```kotlin
data class OfflineTtsConfig(
    var model: OfflineTtsModelConfig = OfflineTtsModelConfig(),
    var ruleFsts: String = "",
    var ruleFars: String = "",
    var maxNumSentences: Int = 1,
    var silenceScale: Float = 0.2f,
)
```

**Konkret über die Kotlin-API hinzufügbar (ohne C-API/JNI):**

| Funktion / Option | Kotlin-API | RN Bridge | Status |
|-------------------|------------|-----------|--------|
| **Init: ruleFsts, ruleFars** | ✅ `OfflineTtsConfig.ruleFsts`, `ruleFars` | ✅ | Implementiert: `TTSInitializeOptions.ruleFsts` / `ruleFars`, Android `buildTtsConfig` + iOS `TtsWrapper::initialize`. |
| **Init: maxNumSentences** | ✅ `OfflineTtsConfig.maxNumSentences` (Default: 1) | ✅ | Implementiert: `TTSInitializeOptions.maxNumSentences`, bei Init durchgereicht. |
| **Init: silenceScale** (Config-Ebene) | ✅ `OfflineTtsConfig.silenceScale` (Default: 0.2f) | ✅ | Implementiert: `TTSInitializeOptions.silenceScale`, bei Init durchgereicht. |

**Nicht ohne C-API hinzufügbar:**

| Funktion | Grund |
|----------|--------|
| **Stream-Progress (0..1)** | Die Kotlin-API liefert im Streaming-Callback nur `(chunk) -> Int`, keinen Progress-Wert. Die C-API hat `SherpaOnnxGeneratedAudioProgressCallback(samples, n, p)`. Für echten Progress müsste Android eine JNI-Schicht auf die C-API nutzen (analog ZipvoiceTtsWrapper). |
| **Zipvoice** | Bereits über C-API gelöst (ZipvoiceTtsWrapper); Kotlin-API enthält kein OfflineTtsZipvoiceModelConfig. |

**Implementierung:**  
Die vier Init-Optionen sind umgesetzt: `src/tts/types.ts` (`TTSInitializeOptions`), `src/tts/index.ts` (Durchreichung an `initializeTts`), `NativeSherpaOnnx.ts` (TurboModule-Spec), Android `SherpaOnnxTtsHelper` (TtsInitState, buildTtsConfig, initializeTts, updateTtsParams) und `SherpaOnnxModule`, iOS `sherpa-onnx-tts-wrapper` (initialize mit rule_fsts/rule_fars/max_num_sentences/silence_scale) und `SherpaOnnx+TTS.mm` (Parameter + Globals für updateTtsParams).

**Kernaussage:** **Init: ruleFsts, ruleFars, maxNumSentences, silenceScale** sind in der Kotlin-API (`Tts.kt` → `OfflineTtsConfig`) vorhanden und in der RN-Bridge (Android + iOS) angeboten. **Stream-Progress** und **Zipvoice** erfordern weiterhin die C-API.

---

## 1. Kotlin-API: TTS-Features, Funktionen und Initialisierungsoptionen

Quelle: Android-Implementierung (`SherpaOnnxTtsHelper.kt`), Kotlin-API-Definition `sherpa-onnx/kotlin-api/Tts.kt` – `com.k2fsa.sherpa.onnx.OfflineTts`, `OfflineTtsConfig`, `OfflineTtsModelConfig`, `GenerationConfig`, `GeneratedAudio`.


| Kategorie                   | Feature / Option                                      | Kotlin-API (Offline)            | Anmerkung                                                                                                       |
| --------------------------- | ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Modelltypen**             | VITS                                                  | ✅ `OfflineTtsVitsModelConfig`   | model, lexicon, tokens, dataDir, noiseScale, noiseScaleW, lengthScale                                           |
|                             | Matcha                                                | ✅ `OfflineTtsMatchaModelConfig` | acousticModel, vocoder, lexicon, tokens, dataDir, noiseScale, lengthScale                                       |
|                             | Kokoro                                                | ✅ `OfflineTtsKokoroModelConfig` | model, voices, tokens, dataDir, lexicon, lengthScale                                                            |
|                             | Kitten                                                | ✅ `OfflineTtsKittenModelConfig` | model, voices, tokens, dataDir, lengthScale                                                                     |
|                             | Pocket                                                | ✅ `OfflineTtsPocketModelConfig` | lmFlow, lmMain, encoder, decoder, textConditioner, vocabJson, tokenScoresJson                                   |
|                             | Zipvoice                                              | ❌ nicht in Kotlin-API           | In diesem Projekt über C-API (`ZipvoiceTtsWrapper`) abgedeckt                                                   |
| **Init-Optionen**           | numThreads                                            | ✅                               | In allen Modellconfigs (OfflineTtsModelConfig)                                                                  |
|                             | debug                                                 | ✅                               | In allen Modellconfigs                                                                                          |
|                             | noiseScale                                            | ✅                               | VITS, Matcha                                                                                                    |
|                             | noiseScaleW                                           | ✅                               | VITS                                                                                                            |
|                             | lengthScale                                           | ✅                               | VITS, Matcha, Kokoro, Kitten                                                                                    |
|                             | ruleFsts / ruleFars                                  | ✅                               | `OfflineTtsConfig` (Tts.kt), Default: ""                                                                        |
|                             | maxNumSentences                                       | ✅                               | `OfflineTtsConfig`, Default: 1 (Callback alle N Sätze)                                                         |
|                             | silenceScale (Config-Ebene)                           | ✅                               | `OfflineTtsConfig`, Default: 0.2f                                                                              |
| **Generierung (einfach)**   | generate(text, sid, speed)                            | ✅                               | Vollpuffer; sid/speed                                                                                           |
| **Generierung (erweitert)** | generateWithConfig(text, config)                      | ✅                               | GenerationConfig: silenceScale, speed, sid, referenceAudio, referenceSampleRate, referenceText, numSteps, extra |
| **Streaming**               | generateWithCallback(text, sid, speed, callback)      | ✅                               | Chunk-Callback ohne Progress                                                                                    |
|                             | generateWithConfigAndCallback(text, config, callback) | ✅                               | Chunk-Callback mit GenerationConfig (z. B. Voice Cloning)                                                       |
| **Rückgabe**                | GeneratedAudio                                        | ✅                               | samples (FloatArray), sampleRate                                                                                |
|                             | GeneratedAudio.save(filePath)                         | ✅                               | WAV-Datei schreiben                                                                                             |
| **Abfragen**                | sampleRate()                                          | ✅                               |                                                                                                                 |
|                             | numSpeakers()                                         | ✅                               |                                                                                                                 |


**GenerationConfig (Kotlin)** – in `parseGenerationConfig()` genutzt:  
`silenceScale`, `speed`, `sid`, `referenceAudio` (FloatArray), `referenceSampleRate`, `referenceText`, `numSteps`, `extra` (Map<String, String>).

---

## 2. Kotlin-API (offline) vs. React-Native-JS-Bridge – Lücken

Welche für Offline-TTS geeigneten Features die Kotlin-API unterstützt, die in der öffentlichen React-Native-API (TurboModule-Spec, tts/index.ts, types.ts) noch **nicht** oder nur teilweise abgebildet sind.


| Feature / Option                                             | Kotlin-API                                                         | RN Bridge (Spec / tts/index)             | Status / Lücke                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Init: modelDir, modelType, numThreads, debug                 | ✅                                                                  | ✅ `initializeTts`                        | Abgedeckt                                                                                                                                                                                                                                                            |
| Init: noiseScale, noiseScaleW, lengthScale                   | ✅                                                                  | ✅ `initializeTts`                        | Abgedeckt                                                                                                                                                                                                                                                            |
| updateTtsParams(noiseScale, noiseScaleW, lengthScale)        | ✅                                                                  | ✅ `updateTtsParams`                      | Abgedeckt                                                                                                                                                                                                                                                            |
| detectTtsModel                                               | ✅ (native Detect)                                                  | ✅ `detectTtsModel`                       | Abgedeckt                                                                                                                                                                                                                                                            |
| generate(text, options)                                      | ✅ generate / generateWithConfig                                    | ✅ `generateTts` + options                | Abgedeckt                                                                                                                                                                                                                                                            |
| generateWithTimestamps                                       | ✅ (geschätzt im Helper)                                            | ✅ `generateTtsWithTimestamps`            | Abgedeckt                                                                                                                                                                                                                                                            |
| generateStream + cancel                                      | ✅ generateWithCallback / WithConfigAndCallback                     | ✅ `generateTtsStream`, `cancelTtsStream` | Abgedeckt                                                                                                                                                                                                                                                            |
| PCM-Player start/write/stop                                  | ✅ (Android AudioTrack)                                             | ✅                                        | Abgedeckt                                                                                                                                                                                                                                                            |
| getSampleRate / getNumSpeakers                               | ✅                                                                  | ✅                                        | Abgedeckt                                                                                                                                                                                                                                                            |
| unloadTts                                                    | ✅                                                                  | ✅                                        | Abgedeckt                                                                                                                                                                                                                                                            |
| save WAV (File / ContentUri)                                 | ✅ GeneratedAudio.save + Helper                                     | ✅                                        | Abgedeckt                                                                                                                                                                                                                                                            |
| saveTextToContentUri / copyContentUriToCache / shareTtsAudio | ✅ (Helper)                                                         | ✅                                        | Abgedeckt                                                                                                                                                                                                                                                            |
| **Stream-Progress (0..1)**                                   | ❌ Kotlin-Callback liefert keine Progress                           | ❌                                        | **Lücke**: C-API hat `SherpaOnnxGeneratedAudioProgressCallback(samples, n, p)`; Kotlin-API nur Chunk-Callback ohne `p`. RN sendet in `ttsStreamChunk` ein `progress`-Feld, wird auf Android aber mit `0f` gefüllt (siehe `emitChunk(chunk, sampleRate, 0f, false)`). |
| **Init: ruleFsts / ruleFars**                                | ✅ `OfflineTtsConfig.ruleFsts`, `ruleFars` (Tts.kt)                 | ❌                                        | In unserem Kotlin-Build (`buildTtsConfig()`) nicht gesetzt. **Lücke** – rein über Kotlin hinzufügbar.                                                                                                 |
| **Init: maxNumSentences / silenceScale**                     | ✅ `OfflineTtsConfig.maxNumSentences`, `silenceScale` (Tts.kt)      | ❌                                        | Werden im RN-Bridge nicht als Init-Parameter angeboten. **Lücke** – rein über Kotlin hinzufügbar.                                                                                                     |
| **Batch-Generierung (mehrere Texte)**                        | ✅ indirekt: `maxNumSentences` steuert, nach wie vielen Sätzen der Callback aufgerufen wird | ❌                                        | C-API/Kotlin ermöglichen Callback pro N Sätze; RN bietet nur Einzeltext. Mit `maxNumSentences` bei Init (Kotlin) kann das Verhalten gesteuert werden; echte Multi-Text-API weiterhin nur über RN-Loop. |


Kurzfassung: Die wesentliche funktionale Lücke für Offline-TTS ist der **echte Fortschrittswert (0..1) im Stream-Callback**; die Kotlin-API liefert ihn nicht, die C-API schon. Die **Init-Optionen** ruleFsts, ruleFars, maxNumSentences und silenceScale sind in der Kotlin-API (`sherpa-onnx/kotlin-api/Tts.kt`, `OfflineTtsConfig`) vorhanden und können ohne C-API in der RN-API angeboten werden.

---

## 3. C-API (offline TTS) vs. Kotlin-API – nur in C-API

Welche Offline-TTS-Funktionen in der C-API (c-api.h / cxx-api.h) existieren, in der Kotlin-API aber **nicht** oder nicht gleichwertig exponiert sind.


| Feature / Funktion                          | C-API                                                                                                                                                                              | Kotlin-API                                                          | Anmerkung                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| OfflineTtsCreate / Destroy                  | ✅                                                                                                                                                                                  | ✅ (OfflineTts)                                                      |                                                                                 |
| SampleRate / NumSpeakers                    | ✅                                                                                                                                                                                  | ✅                                                                   |                                                                                 |
| Generate(text, sid, speed)                  | ✅ `SherpaOnnxOfflineTtsGenerate`                                                                                                                                                   | ✅                                                                   |                                                                                 |
| GenerateWithCallback (Chunk, kein Progress) | ✅ `SherpaOnnxOfflineTtsGenerateWithCallback`                                                                                                                                       | ✅ generateWithCallback                                              |                                                                                 |
| **GenerateWithProgressCallback**            | ✅ `SherpaOnnxOfflineTtsGenerateWithProgressCallback` – Callback `(samples, n, p)` mit Progress `p`                                                                                 | ❌                                                                   | Kotlin-Callbacks liefern keinen Fortschrittswert.                               |
| GenerateWithProgressCallbackWithArg         | ✅ mit `void* arg`                                                                                                                                                                  | ❌                                                                   | Wie oben.                                                                       |
| GenerateWithCallbackWithArg                 | ✅ mit `void* arg`                                                                                                                                                                  | ❌                                                                   | Nur „arg“-Variante fehlt in Kotlin.                                             |
| GenerateWithZipvoice (Voice-Cloning)        | ✅                                                                                                                                                                                  | ❌ (Zipvoice in diesem Projekt per C-API `ZipvoiceTtsWrapper`)       | Kotlin-API hat kein OfflineTtsZipvoiceModelConfig; wir nutzen C-API direkt.     |
| **GenerateWithConfig**                      | ✅ `SherpaOnnxOfflineTtsGenerateWithConfig` + `SherpaOnnxGenerationConfig` (silence_scale, speed, sid, reference_audio, reference_text, num_steps, extra) mit **Progress-Callback** | ✅ GenerationConfig + generateWithConfig (ohne Progress im Callback) | C-API erlaubt Progress beim GenerateWithConfig; Kotlin nur Chunk ohne `p`.      |
| **OfflineTtsConfig**                        | rule_fsts, max_num_sentences, rule_fars, silence_scale                                                                                                                             | ✅ Kotlin `OfflineTtsConfig` (Tts.kt): ruleFsts, ruleFars, maxNumSentences, silenceScale | In unserem RN-Bridge nicht durchgereicht; Kotlin-API hat alle Felder.             |
| SherpaOnnxWriteWave / WriteWaveToBuffer     | ✅                                                                                                                                                                                  | ✅ GeneratedAudio.save (Kotlin) / Helper                             |                                                                                 |
| SherpaOnnxReadWave / ReadWaveFromBinaryData | ✅                                                                                                                                                                                  | Nicht für TTS-Init benötigt; ggf. für Referenz-Audio                | C-API-Hilfen zum Einlesen von WAV.                                              |
| SherpaOnnxDestroyOfflineTtsGeneratedAudio   | ✅                                                                                                                                                                                  | N/A (Kotlin Managed)                                                | Speicherfreigabe auf C-Ebene.                                                   |


Kurzfassung: Die C-API bietet **Progress im Streaming-Callback** (`SherpaOnnxGeneratedAudioProgressCallback` mit `p`) und optionale **Callback-WithArg**-Varianten; die Kotlin-API deckt das nicht ab. Zipvoice ist in der offiziellen Kotlin-API nicht als Modelltyp enthalten und wird bei uns über die C-API (ZipvoiceTtsWrapper) genutzt.

---

## 4. Übersichtstabelle: Feature-Status über alle Schichten


| Feature                                                       | C-API                 | Kotlin-API                   | RN Bridge (JS)       | Hinweis                                    |
| ------------------------------------------------------------- | --------------------- | ---------------------------- | -------------------- | ------------------------------------------ |
| Modelltypen VITS, Matcha, Kokoro, Kitten, Pocket              | ✅                     | ✅                            | ✅ (modelType)        |                                            |
| Zipvoice                                                      | ✅                     | ❌ (C-API-Wrapper im Projekt) | ✅                    | Über ZipvoiceTtsWrapper (JNI/C-API).       |
| Init: numThreads, debug, noiseScale, noiseScaleW, lengthScale | ✅                     | ✅                            | ✅                    |                                            |
| Init: ruleFsts, ruleFars, maxNumSentences, silenceScale       | ✅                     | ✅ (Tts.kt OfflineTtsConfig) | ❌                    | In RN-Init nicht durchgereicht; rein über Kotlin ergänzbar. |
| generate(text, sid, speed)                                    | ✅                     | ✅                            | ✅ generateTts        |                                            |
| generateWithConfig (Voice Cloning, extra)                     | ✅                     | ✅                            | ✅ (options)          |                                            |
| Streaming mit Chunk-Callback                                  | ✅                     | ✅                            | ✅ generateTtsStream  |                                            |
| **Streaming mit Progress (0..1)**                             | ✅                     | ❌                            | ❌ (progress immer 0) | Nur C-API; Kotlin/RN ohne echten Progress. |
| generateWithTimestamps (geschätzt)                            | N/A                   | ✅ (Helper)                   | ✅                    |                                            |
| PCM-Player / Save WAV / ContentUri / Share                    | N/A / ✅ WriteWave     | ✅                            | ✅                    |                                            |
| Batch / max_num_sentences pro Request                         | ✅ (Callback pro Satz) | Nutzung unklar               | ❌                    | C-API-Stil in RN nicht abgebildet.         |


---

## 5. Referenzen

- **Öffentliche TTS-Doku und Feature-Liste:** [tts.md](./tts.md)
- **TurboModule-Spec:** `src/NativeSherpaOnnx.ts`
- **TTS-JS-API und Typen:** `src/tts/index.ts`, `src/tts/types.ts`
- **Kotlin-API (OfflineTtsConfig-Definition):** `sherpa-onnx/sherpa-onnx/kotlin-api/Tts.kt`
- **Android Kotlin TTS:** `android/src/main/java/com/sherpaonnx/SherpaOnnxTtsHelper.kt`, `ZipvoiceTtsWrapper.kt`
- **iOS TTS (C++-Wrapper):** `ios/sherpa-onnx-tts-wrapper.mm`, `ios/SherpaOnnx+TTS.mm`
- **C-API-Header:** `ios/include/sherpa-onnx/c-api/c-api.h`, `cxx-api.h` (TTS: OfflineTts, OfflineTtsConfig, GenerationConfig, GeneratedAudio, Progress-Callbacks)

