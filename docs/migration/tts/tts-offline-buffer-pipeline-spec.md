# TTS-Offline Migration auf Audio-/TextBuffer Pipeline

Dieses Dokument definiert den Zielzustand fuer Offline-TTS als Pipeline-API.

Kurzfassung:
- Weg von `GeneratedAudio` + Sink-Generation + feature-fremden TTS-Hilfsfunktionen.
- Hin zu einer klaren Pipeline:
  - Input: `OfflineTextBuffer`
  - Output: `OfflineAudioBuffer`
- Strikte Typisierung auf SDK-Ebene.
- VoiceClone-Referenzaudio kommt aus `OfflineAudioBuffer` statt aus JS-`number[]`.

Hinweis zur Richtung: Obwohl in der Aufgabenbeschreibung ein vertauschtes Beispiel stand, wird hier die fachlich korrekte Gegenrichtung zu STT umgesetzt: **TTS nimmt Text als Input und erzeugt Audio als Output**.

---

## 1) Ist-Zustand Analyse

Aktueller Stand (vereinfacht):

1. JS/API in [src/tts/index.ts](../../../src/tts/index.ts)
- `generateSpeech(text, options?) -> GeneratedAudio`
- `generateSpeechWithTimestamps(...) -> GeneratedAudioWithTimestamps`
- `playFromSink(generation)`
- Modulweite Export-Helfer fuer Persistenz und Sharing (`saveAudioFromGeneration`, `saveAudioFromPCM`).
- Alignment-Reexports aus `tts` (`alignTextToAudio`, `alignTextToTtsSink`, ...).

2. Native Architektur
- Android und iOS halten pro TTS-Instanz einen Batch-Sink (`generation` + PCM).
- `generateTts` schreibt in den Sink; JS liest optional spaeter mit `getTtsSamples`.
- `playTtsFromSink` und `saveTtsAudioFromSink` arbeiten gegen den Sink.

3. Probleme aus SDK-Sicht
- API-Verantwortung vermischt: Synthese + Playback + Persistenz + Subtitle/Alignment in einem Modul.
- Pipeline-Semantik uneinheitlich im Vergleich zu STT-Offline (dort bereits Buffer-first).
- VoiceClone-Referenzaudio wird als rohe Arrays uebergeben (mehr Bridge-Overhead, weniger Typensicherheit).
- Offline-TTS ist nicht strikt auf Offline-Buffer typisiert.

---

## 2) Zielbild

Offline-TTS wird als reine Pipeline-Stage definiert:

- Input: `OfflineTextBuffer` (Textquelle)
- Output: `OfflineAudioBuffer` (Audioziel)

Signatur auf Engine-Ebene:

```ts
synthesize(
  textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
  audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
  options?: TtsSynthesisOptions
): Promise<void>
```

Wesentliche Prinzipien:

1. Keine feature-fremden Offline-TTS-APIs im `tts`-Modul
- Entfernen: Sink-Playback, TTS-Persistenz-/Sharing-Helfer, Subtitle/Alignment-Integration.

2. Strikte Typisierung
- Fuer Offline-TTS nur Offline-Handles/Refs.
- Keine Live-Buffer-Typen in der Offline-Synthese-Signatur.

3. Native Pipeline-Ownership
- Audio bleibt nativ in der Pipeline-Registry.
- Kein Result-Objekt mit großen PCM-Payloads fuer den Standardpfad.

4. Klare Modulgrenzen
- `tts`: nur TTS-spezifische Initialisierung/Konfiguration/Synthese.
- `audiobuffer`: Audio-Lebenszyklus, Save als WAV.
- `alignment`: eigenstaendig, nicht in TTS integriert.

---

## 3) Scope / Nicht-Scope

Im Scope:
- Offline-TTS API-Umbau auf Buffer-Pipeline.
- JS- und Native-Signaturen fuer Offline-TTS.
- VoiceClone-Referenzaudio auf `OfflineAudioBuffer`.
- Entfernen von Offline-TTS-fremden APIs.
- Doku- und Beispielanpassung fuer [docs/tts-offline.md](../../tts-offline.md).

Nicht im Scope:
- Umbau von Streaming-TTS APIs.
- Alignment-Neudesign (separates Zukunftsthema).
- Deprecation-Bridges.

---

## 4) Konkreter API-Vorschlag (TypeScript)

### 4.1 Neue/angepasste Offline-TTS Engine API

Datei: [src/tts/types.ts](../../../src/tts/types.ts)

```ts
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
} from 'react-native-sherpa-onnx/textbuffer';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from 'react-native-sherpa-onnx/audiobuffer';

export interface TtsEngine {
  readonly instanceId: string;

  synthesize(
    textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
    audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
    options?: TtsSynthesisOptions
  ): Promise<void>;

  updateParams(options: TtsUpdateOptions): Promise<{
    success: boolean;
    detectedModels: DetectedModelEntry[];
  }>;

  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;
  destroy(): Promise<void>;
}
```

### 4.2 VoiceClone-Optionen (nur OfflineAudioBuffer)

```ts
export type TtsVoiceCloneZipvoice = {
  kind: 'zipvoice';
  referenceAudio: OfflineAudioBufferRef | OfflineBufferHandle;
  referenceText: string;
};

export type TtsVoiceClonePocket = {
  kind: 'pocket';
  referenceAudio: OfflineAudioBufferRef | OfflineBufferHandle;
  referenceText?: string;
};

export type TtsVoiceClone = TtsVoiceCloneZipvoice | TtsVoiceClonePocket;
```

### 4.3 Entfernte Offline-TTS Typen/Funktionen

Aus `tts` entfernen:
- `GeneratedAudio`
- `GeneratedAudioWithTimestamps`
- `SubtitleMode`, `SubtitleGranularity`, `SubtitleOptions*`
- `PlayFromSinkOptions`, `TtsBatchPlaybackController`
- `SaveAudioTarget*`, `SaveAudioOptions`, `SaveAudioFromPcmInput`
- `saveAudioFromGeneration`, `saveAudioFromPCM`
- `alignTextToAudio`, `alignTextToTtsSink`, `assertAlignmentGranularityForMode` Reexports

### 4.4 Neue TTS-Generierungsoptionen

```ts
export type TtsSynthesisOptions = {
  sid?: number;
  speed?: number;
  silenceScale?: number;
  numSteps?: number;
  extra?: Record<string, string>;
  voiceClone?: TtsVoiceClone;
};
```

Keine Subtitle-/Alignment-Optionen mehr in Offline-TTS.

---

## 5) Pipeline-Erweiterungen

### 5.1 Audiobuffer: leeres Offline-Ausgabeziel

Datei: [src/audiobuffer/index.ts](../../../src/audiobuffer/index.ts)

Neue API:

```ts
createEmptyOfflineAudioBuffer(
  sampleRate: number,
  channelCount?: 1
): Promise<OfflineAudioBufferRef>
```

Verwendung:
- Host erzeugt `audioOut` mit gewuenschter Sample-Rate.
- TTS fuellt dieses Ziel genau einmal.

### 5.2 Textbuffer: expliziter Text-Seed fuer TTS

Datei: [src/textbuffer/index.ts](../../../src/textbuffer/index.ts)

Neue API:

```ts
createOfflineTextBufferFromText(
  text: string,
  options?: {
    lang?: string;
    emotion?: string;
    event?: string;
  }
): Promise<OfflineTextBufferRef>
```

Grund:
- TTS braucht fuer typische App-Flows eine direkte Moeglichkeit, Text in einen Offline-Textbuffer zu bringen (nicht nur STT-Output oder Live-Snapshot).

---

## 6) TurboModule / Native Spec Vorschlag

Datei: [src/NativeSherpaOnnx.ts](../../../src/NativeSherpaOnnx.ts)

### 6.1 Hinzufuegen

```ts
createEmptyOfflineAudioBuffer(
  sampleRate: number,
  channelCount?: number
): Promise<OfflineAudioBufferInfo>;

createOfflineTextBufferFromText(
  text: string,
  options?: Object
): Promise<OfflineTextBufferInfo>;

synthesizeTts(
  instanceId: string,
  textInBufferId: string,
  audioOutBufferId: string,
  options?: Object
): Promise<void>;
```

### 6.2 Entfernen (Offline-TTS-fremd)

- `generateTtsWithTimestamps`
- `getTtsSamples`
- `playTtsFromSink`
- `saveTtsAudioFromSink`
- `saveTtsAudioFromPCM`

`generateTts` wird ersetzt durch `synthesizeTts` (buffer-to-buffer).

---

## 7) Native Umsetzungsvorschlag (Android + iOS parity)

## 7.1 Synthese-Flow

1. `textInBufferId` aufloesen und validieren:
- existiert
- ist offline text buffer
- `text` nicht leer

2. `audioOutBufferId` aufloesen und validieren:
- existiert
- ist offline audio buffer
- ist leer/unpopulated
- deklarierte `sampleRate` == Modell-Output-Rate

3. Synthese in nativen Scratch-Puffer ausfuehren.

4. Ergebnis in `audioOut` committen:
- bevorzugt: adopt/move ohne zusaetzliche Vollkopie,
- alternativ: eine finale Vollkopie (genau einmal) in Registry-Eintrag.

5. Buffer als populated markieren, Promise resolve.

## 7.2 Empty-Buffer-Sizing Strategie (verbindlich)

Empfohlene Strategie (mobile-pragmatisch):
- Intern in Scratch/Grow-Puffer erzeugen.
- Nach Abschluss in `audioOut` eintragen per Move/Adopt (bevorzugt) oder max. eine Kopie.
- Keine dauerhafte doppelte Vollhaltung.

Diese Regel gilt fuer Android und iOS gleich.

## 7.3 Sample-Rate-Mismatch (streng)

Wenn `audioOut.sampleRate !== modelOutputSampleRate`:
- harter Fehler,
- keine automatische Resampling-Heuristik,
- klare Meldung:
  - "audioOut.sampleRate (X) != model sampleRate (Y). Allocate with getTtsSampleRate()."

## 7.4 VoiceClone-Referenzaudio

- `voiceClone.referenceAudio` wird als OfflineAudioBuffer-ID aufgeloest.
- Keine `referenceAudio: number[]` mehr ueber die Bridge.
- Zipvoice: `referenceText` bleibt Pflicht.
- Pocket: Referenzaudio bleibt Pflicht.

## 7.5 Fehlercodes (Vorschlag)

- `TTS_TEXT_BUFFER_NOT_FOUND`
- `TTS_TEXT_BUFFER_KIND_MISMATCH`
- `TTS_TEXT_BUFFER_EMPTY`
- `TTS_AUDIO_OUT_NOT_FOUND`
- `TTS_AUDIO_OUT_KIND_MISMATCH`
- `TTS_AUDIO_OUT_ALREADY_POPULATED`
- `TTS_OUTPUT_SAMPLE_RATE_MISMATCH`
- `TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND`
- `TTS_REFERENCE_AUDIO_BUFFER_KIND_MISMATCH`
- `TTS_GENERATE_ERROR`

---

## 8) Android / iOS Parity-Matrix

| Thema | Android | iOS |
| --- | --- | --- |
| Empty offline audio buffer | `PipelineAudioRegistry.createEmptyOffline(...)` + neuer Entry-Zustand | Entsprechende API in `SherpaOnnx+PipelineAudio.mm` + gleicher Entry-Zustand |
| Text seed buffer | `TextPipelineRegistry.createOfflineFromText(...)` | `SherpaOnnx+TextBuffer.mm` analog |
| TTS synth buffer-to-buffer | `TtsBatchGenerationService` ohne Sink-API, dafuer `synthesizeTts` | `SherpaOnnx+TTSBatch.mm` analog ohne Sink-API |
| VoiceClone reference aus Buffer | Parser liest OfflineAudioBuffer statt `ReadableArray` | Options-Helper liest OfflineAudioBuffer statt `NSArray` |
| Sample-rate strict mismatch | identischer Fehlercode + Message | identischer Fehlercode + Message |
| One-shot populate output | identische Semantik (already populated => error) | identische Semantik |

Parity-Regel: Jede Kotlin-Registry-Aenderung hat ein iOS-Gegenstueck im selben Release-Schritt.

---

## 9) Migrationsplan (Phasen)

### Phase 1: Spec + Native surface
- NativeSherpaOnnx-Signaturen auf Buffer-to-Buffer anpassen.
- Alte Offline-TTS Sink-/Persistenz-/Subtitle-Methoden aus Spec entfernen.

### Phase 2: Buffer prerequisites
- `createEmptyOfflineAudioBuffer` implementieren.
- `createOfflineTextBufferFromText` implementieren.
- Fehlercodes und Typguards fuer Offline-only finalisieren.

### Phase 3: TTS core migration
- `synthesizeTts(instanceId, textInBufferId, audioOutBufferId, options)` implementieren.
- VoiceClone auf OfflineAudioBuffer-Input migrieren.
- Sample-rate strict check implementieren.

### Phase 4: API cleanup (breaking)
- JS `tts` Engine auf `synthesize(...) -> Promise<void>` umstellen.
- `GeneratedAudio`/Sink-basierte APIs entfernen.
- Subtitle/Alignment Integration aus `tts` entfernen.

### Phase 5: Docs + examples
- [docs/tts-offline.md](../../tts-offline.md) komplett auf Pipeline-Flow umstellen.
- Beispiele auf `textbuffer` + `audiobuffer` aktualisieren.
- Hinweise auf alte APIs entfernen.

### Phase 6: Validation
- Android/iOS Parity-Tests.
- Leerer Buffer, doppelte Populate-Versuche, Mismatch-SampleRate, falsche Buffer-Kinds, VoiceClone-Pfade.

---

## 10) Doku-Delta fuer `docs/tts-offline.md`

Die Offline-TTS Doku soll nach Migration folgende Form haben:

1. Quick Start nur mit Buffer-Pipeline
- `createOfflineTextBufferFromText(...)`
- `createEmptyOfflineAudioBuffer(await tts.getSampleRate())`
- `await tts.synthesize(textIn, audioOut, options)`
- optional `saveOfflineAudioBufferToWav(audioOut, path)` aus `audiobuffer`

2. Kein Kapitel mehr zu:
- `GeneratedAudio`
- `getSamples`
- `playFromSink`
- `saveAudioFromGeneration` / `saveAudioFromPCM`
- `generateSpeechWithTimestamps` / Subtitle-Mode
- Alignment-Integration im TTS-Modul

3. API-Reference nur fuer:
- `detectTtsModel`
- `createTTS`
- `tts.synthesize`
- `tts.updateParams`
- `tts.getModelInfo` / `getSampleRate` / `getNumSpeakers`
- `tts.destroy`

---

## 11) Abnahmekriterien

1. Offline-TTS funktioniert ausschliesslich buffer-basiert:
- Text in `OfflineTextBuffer`, Audio in `OfflineAudioBuffer`.

2. Keine Offline-TTS-fremden APIs mehr im `tts`-Package.

3. VoiceClone nutzt `OfflineAudioBuffer` statt Roharrays.

4. Sample-rate mismatch fuehrt immer zu hartem, klaren Fehler.

5. Android/iOS Verhalten und Fehlercodes sind konsistent.

6. [docs/tts-offline.md](../../tts-offline.md) und Beispiele spiegeln den neuen Pipeline-Flow ohne Legacy-Reste.

---

## 12) Referenzen

- [src/tts/index.ts](../../../src/tts/index.ts)
- [src/tts/types.ts](../../../src/tts/types.ts)
- [src/tts/ttsNativeBridge.ts](../../../src/tts/ttsNativeBridge.ts)
- [src/NativeSherpaOnnx.ts](../../../src/NativeSherpaOnnx.ts)
- [android/src/main/java/com/sherpaonnx/tts/service/TtsBatchGenerationService.kt](../../../android/src/main/java/com/sherpaonnx/tts/service/TtsBatchGenerationService.kt)
- [android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt)
- [android/src/main/java/com/sherpaonnx/text/pipeline/TextPipelineRegistry.kt](../../../android/src/main/java/com/sherpaonnx/text/pipeline/TextPipelineRegistry.kt)
- [ios/tts/bridge/SherpaOnnx+TTSBatch.mm](../../../ios/tts/bridge/SherpaOnnx+TTSBatch.mm)
- [ios/audio/bridge/SherpaOnnx+PipelineAudio.mm](../../../ios/audio/bridge/SherpaOnnx+PipelineAudio.mm)
- [ios/textbuffer/bridge/SherpaOnnx+TextBuffer.mm](../../../ios/textbuffer/bridge/SherpaOnnx+TextBuffer.mm)
- [docs/stt-offline.md](../../stt-offline.md)
- [docs/textbuffer.md](../../textbuffer.md)
- [docs/audiobuffer-offline.md](../../audiobuffer-offline.md) · [overview](../../audiobuffer.md)
