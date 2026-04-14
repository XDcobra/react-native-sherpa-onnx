# STT native pipeline - konkreter Spec- und Implementation-Plan

Status: Draft fuer 1.0.0 (breaking)

Input-Dokumente:
- [stt-native-pipeline-research.md](./stt-native-pipeline-research.md)
- [tts-generated-audio-native-sink-migration.md](./tts-generated-audio-native-sink-migration.md)

## Ziel
Dieses Dokument macht den Schritt von Prinzipien zu konkreter Umsetzung:
- konkrete TurboModule-Signaturen
- pipeline-first Stage-Vertrag fuer STT + Alignment + Enhancement
- verbindliche Fehlercode-Spezifikation
- Slice-Parameter-Vertrag
- detaillierter Testplan ueber 1-2 Core-Tests hinaus

## 1) IST-Analyse gegen aktuellen Code

## 1.1 JS/TurboModule heute
- [src/NativeSherpaOnnx.ts](../../src/NativeSherpaOnnx.ts): `transcribeFile` und `transcribeSamples` liefern volle Nutzlast (text, tokens, timestamps, durations, lang, emotion, event).
- [src/stt/index.ts](../../src/stt/index.ts): `createSTT()` mappt 1:1 auf volle Result-Objekte.
- [src/stt/streaming.ts](../../src/stt/streaming.ts): `getSttStreamResult` nutzt weiterhin token-/timestamp-Arrays pro Poll.

Konsequenz:
- Output ist nicht by-reference fuer grosse Ergebnisse.
- Input ist bei `transcribeSamples` weiterhin O(n) ueber die Bridge (`number[]`).

## 1.2 Android heute
- [android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt](../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt):
  - `transcribeFile`: liest WAV, decodiert, liefert volles `OfflineRecognizerResult` als `WritableMap`.
  - `transcribeSamples`: `ReadableArray` -> `FloatArray` -> volles Result zurueck.
- [android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxOnlineSttHelper.kt](../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxOnlineSttHelper.kt): Streaming-Result weiterhin als volle Arrays.
- [android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt](../../android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt): expose unveraendert als full payload.

Konsequenz:
- Kein nativer Result-Store mit `resultId`.
- Kein shared audio-buffer registry entrypoint fuer STT.

## 1.3 iOS heute
- [ios/stt/bridge/SherpaOnnx+STT.mm](../../ios/stt/bridge/SherpaOnnx+STT.mm): `transcribeFile`/`transcribeSamples` liefern volles Result sofort.
- [ios/stt/bridge/SherpaOnnx+OnlineSTT.mm](../../ios/stt/bridge/SherpaOnnx+OnlineSTT.mm): Streaming ebenfalls text/tokens/timestamps direkt.
- [ios/stt/native/sherpa-onnx-stt-wrapper.mm](../../ios/stt/native/sherpa-onnx-stt-wrapper.mm): Wrapper ist auf direkte Materialisierung ausgelegt.

Konsequenz:
- Gleicher Skalierungsengpass wie auf Android.

## 1.4 Positiver Stand (bereits erreicht)
- Detect-Architektur fuer STT ist bereits modernisiert (optional modelDir/assetName, detectionSources, derived metadata):
  - [android/src/main/cpp/jni/model_detect/stt/sherpa-onnx-model-detect-stt.cpp](../../android/src/main/cpp/jni/model_detect/stt/sherpa-onnx-model-detect-stt.cpp)
  - [android/src/main/cpp/jni/model_detect/stt/sherpa-onnx-stt-wrapper.cpp](../../android/src/main/cpp/jni/model_detect/stt/sherpa-onnx-stt-wrapper.cpp)
  - [src/types/modelDetect.ts](../../src/types/modelDetect.ts)

## 2) Konkreter Zielvertrag (1.0.0)

## 2.0 Pipeline-first Orchestrierung (verbindlich)
Die oeffentliche API wird als kleine, orthogonale Stage-Operationen aufgebaut.

Nicht einfuehren:
- `transcribeWithAlignment`
- `transcribeWithEnhancement`
- `transcribeWithEnhancementAndAlignment`
- weitere Kombinationsvarianten mit `WithXWithY...`

Verbindliche Richtung:
- Audio ueber `bufferId`
- STT ueber `resultId`
- Alignment ueber `alignmentId` (oder gleichwertiges Handle)

Das ist die feste Kompositionsform vor dem grossen STT-Coding.

## 2.1 Daten- und Lifetime-Modell
- Offline pro `instanceId`:
  - genau ein aktiver STT-Result-Slot
  - Slot hat monotonen `resultId` (int64 auf native Seite, JS als number)
  - jeder erfolgreiche `transcribe*` ersetzt den Slot
- Stale-Semantik:
  - Getter mit altem `resultId` muessen mit `STT_STALE_RESULT` fehlschlagen
- Explizite Freigabe:
  - `releaseSttResult(instanceId)` leert den Slot fruehzeitig (optional, aber Teil des Specs)
- Alignment:
  - Alignment-Ergebnisse werden by-reference ueber `alignmentId` adressiert
  - Getter/Export fuer Alignment laufen ueber `alignmentId`
  - `releaseAlignment(alignmentId)` gibt Alignment-Ressourcen explizit frei

## 2.2 Shared Audio Buffer Registry (Phase 1, offline)
Der Registry-Einstieg ist feature-uebergreifend, aber zunaechst auf offline-PCM fokussiert.

```ts
export type AudioBufferKind = 'offlinePcmBuffer';

export type AudioBufferInfo = {
  bufferId: string;
  kind: AudioBufferKind;
  sampleRate: number;
  channelCount: number;
  numSamples: number;
  durationMs: number;
};

// source -> native buffer (path-first, kein bulk PCM ueber Bridge)
createAudioBufferFromFile(
  sourcePath: string,
  targetSampleRateHz?: number,
  forceMono?: boolean
): Promise<AudioBufferInfo>;

getAudioBufferInfo(bufferId: string): Promise<AudioBufferInfo>;
releaseAudioBuffer(bufferId: string): Promise<void>;
```

Hinweis:
- `createAudioBufferFromFloat32Array` ist bewusst nicht Teil von Phase 1 im TurboModule-Codegen-Vertrag.
- Optionaler Power-User-Weg per JSI kann spaeter ergaenzt werden.

## 2.2.1 Stage-Operationen auf Buffern (ohne Kombinationsmethoden)

```ts
// Enhancement als Pipeline-Stage
enhanceBuffer(
  enhancementInstanceId: string,
  bufferId: string,
  options?: { keepInput?: boolean }
): Promise<AudioBufferInfo>;

// STT als Pipeline-Stage
transcribeFromAudioBuffer(
  instanceId: string,
  bufferId: string,
  options?: {
    sourceTag?: 'raw' | 'enhanced' | 'vad-trimmed' | string;
  }
): Promise<SttTranscribeRef>;
```

Regel:
- Jede Stage nimmt Handle-Eingaben und liefert Handle-Outputs.
- Keine Stage kapselt intern mehrere Features in einer kombinierten API.

## 2.3 Offline STT by-reference Signaturen (Phase 1)

```ts
export type SttTranscribeRef = {
  success: boolean;
  resultId?: number;
  sampleRate?: number;
  textLength?: number;
  tokenCount?: number;
  timestampCount?: number;
  durationCount?: number;
  hasLang?: boolean;
  hasEmotion?: boolean;
  hasEvent?: boolean;
  source?: 'file' | 'buffer' | 'samples';
  error?: string;
};

// Breaking: gibt KEIN volles Recognition-Objekt mehr zurueck
transcribeFile(instanceId: string, filePath: string): Promise<SttTranscribeRef>;

// Escape hatch: Input bleibt teuer, Output aber by-reference
transcribeSamples(
  instanceId: string,
  samples: number[],
  sampleRate: number
): Promise<SttTranscribeRef>;

transcribeFromAudioBuffer(
  instanceId: string,
  bufferId: string,
  options?: {
    sourceTag?: 'raw' | 'enhanced' | 'vad-trimmed' | string;
  }
): Promise<SttTranscribeRef>;

getSttResultText(instanceId: string, resultId: number): Promise<string>;
getSttResultTokens(
  instanceId: string,
  resultId: number,
  start?: number,
  maxCount?: number
): Promise<string[]>;
getSttResultTimestamps(
  instanceId: string,
  resultId: number,
  start?: number,
  maxCount?: number
): Promise<number[]>;
getSttResultDurations(
  instanceId: string,
  resultId: number,
  start?: number,
  maxCount?: number
): Promise<number[]>;
getSttResultLang(instanceId: string, resultId: number): Promise<string>;
getSttResultEmotion(instanceId: string, resultId: number): Promise<string>;
getSttResultEvent(instanceId: string, resultId: number): Promise<string>;

releaseSttResult(instanceId: string): Promise<void>;
```

## 2.3.1 Alignment als eigener Pipeline-Stage

```ts
export type AlignmentRef = {
  success: boolean;
  alignmentId?: number;
  segmentCount?: number;
  tokenCount?: number;
  error?: string;
};

// Primary path: STT-Result + Audio-Buffer
alignSttResult(
  instanceId: string,
  resultId: number,
  bufferId: string,
  options?: {
    alignmentModelId?: string;
    granularity?: 'segment' | 'word' | 'token';
  }
): Promise<AlignmentRef>;

// Optional path fuer externen Text
alignTextToBuffer(
  text: string,
  bufferId: string,
  options?: {
    alignmentModelId?: string;
    granularity?: 'segment' | 'word' | 'token';
  }
): Promise<AlignmentRef>;

getAlignmentSegments(
  alignmentId: number,
  start?: number,
  maxCount?: number
): Promise<Array<{
  text: string;
  startSec: number;
  endSec: number;
}>>;

saveAlignment(
  alignmentId: number,
  targetPath: string,
  format?: 'json' | 'srt' | 'vtt'
): Promise<void>;

releaseAlignment(alignmentId: number): Promise<void>;
```

Stale- und Validierungsregeln:
- `alignSttResult` muss `instanceId`, `resultId` und `bufferId` validieren.
- Wenn `resultId` stale ist: `STT_STALE_RESULT`.
- Wenn `bufferId` freigegeben/unbekannt ist: `STT_BUFFER_NOT_FOUND`.
- Wenn `resultId` und `bufferId` nicht kompatibel sind (z.B. andere sample timeline): `STT_ALIGNMENT_INPUT_MISMATCH`.

## 2.4 Streaming STT Vertrag (Phase 2, final segment by-reference)
Phase 1 behaelt Streaming als leichtgewichtigen Poll/Chunk-Fluss.
Phase 2 fuehrt bei finalisierten Segmenten optional `resultId` ein.

```ts
// text-first, keine grossen Arrays per default
getSttStreamResult(streamId: string): Promise<{
  text: string;
  isFinal: boolean;
  resultId?: number; // nur wenn final und nativ retained
}>;
```

Wenn `resultId` gesetzt ist, werden dieselben Getter (`getSttResult*`) genutzt.

Alignment fuer Streaming:
- Keine `streamingTranscribeWithAlignment` API.
- Finalisierte Streaming-Segmente werden ueber `instanceId + resultId` an dieselben Alignment-Stages angebunden.

## 3) Slice-Parameter-Feinheiten (verbindlich)

Gilt fuer `getSttResultTokens`, `getSttResultTimestamps`, `getSttResultDurations`.

Konstanten:
- `STT_DEFAULT_SLICE_COUNT = 1024`
- `STT_MAX_SLICE_COUNT = 16384`

Regeln:
1. `start` default ist `0`.
2. `maxCount` default ist `STT_DEFAULT_SLICE_COUNT`.
3. `start < 0` -> reject `STT_SLICE_INVALID`.
4. `maxCount <= 0` -> reject `STT_SLICE_INVALID`.
5. `maxCount > STT_MAX_SLICE_COUNT` -> reject `STT_SLICE_TOO_LARGE`.
6. `start >= totalCount` -> `[]` (kein Fehler).
7. Rueckgabe ist stabil, solange `resultId` gueltig ist (immutables Snapshot-Verhalten).

Empfohlene JS-Paginierung:
- solange `chunk.length > 0`: `start += chunk.length`.

## 3.1 Slice-Regeln fuer Alignment-Getter
Gilt fuer `getAlignmentSegments` (und spaetere Alignment-Listengetter).

Konstanten:
- `ALIGNMENT_DEFAULT_SLICE_COUNT = 512`
- `ALIGNMENT_MAX_SLICE_COUNT = 8192`

Regeln:
1. `start` default ist `0`.
2. `maxCount` default ist `ALIGNMENT_DEFAULT_SLICE_COUNT`.
3. `start < 0` -> reject `STT_ALIGNMENT_SLICE_INVALID`.
4. `maxCount <= 0` -> reject `STT_ALIGNMENT_SLICE_INVALID`.
5. `maxCount > ALIGNMENT_MAX_SLICE_COUNT` -> reject `STT_ALIGNMENT_SLICE_TOO_LARGE`.
6. `start >= totalCount` -> `[]`.

## 4) Fehlercode-Spezifikation (vereinheitlicht)

Die folgenden Codes gelten fuer Android und iOS gleich. Bestehende generische Codes (`INIT_ERROR`, `TRANSCRIBE_ERROR`, ...) werden in der STT-Pipeline ersetzt.

| Code | Bedeutung | Recoverable | Beispiel |
|---|---|---|---|
| STT_INVALID_ARGUMENT | Parameter ungueltig | ja | leere instanceId, negative sampleRate |
| STT_INSTANCE_NOT_FOUND | STT engine unbekannt | ja | engine bereits zerstort |
| STT_NOT_INITIALIZED | Engine nicht initialisiert | ja | transcribe vor initialize |
| STT_INIT_FAILED | Initialisierung fehlgeschlagen | ja | Modell unvollstaendig |
| STT_MODEL_DETECTION_FAILED | detect fehlgeschlagen | ja | kein kompatibles Modell |
| STT_MODEL_UNSUPPORTED_HARDWARE | Modell fuer nicht-unterstuetzte HW | nein | RK35xx/Ascend Modell |
| STT_CONFIG_FAILED | setConfig fehlgeschlagen | ja | invalid hotwords/rules |
| STT_TRANSCRIBE_FAILED | Decode fehlgeschlagen | ja | defekte WAV |
| STT_BUFFER_NOT_FOUND | bufferId unbekannt | ja | freigegebener Buffer |
| STT_BUFFER_KIND_MISMATCH | falscher Buffer-Typ fuer Aufruf | ja | streaming attachment fuer offline |
| STT_BUFFER_EMPTY | Buffer enthaelt keine Samples | ja | leeres Input-Audio |
| STT_RESULT_EMPTY | kein retained Ergebnis vorhanden | ja | noch kein transcribe |
| STT_RESULT_NOT_FOUND | resultId ungueltig fuer Instanz | ja | falsche Zuordnung |
| STT_STALE_RESULT | resultId ist veraltet | ja | neuer transcribe hat Slot ersetzt |
| STT_SLICE_INVALID | start/maxCount ungueltig | ja | start < 0 |
| STT_SLICE_TOO_LARGE | maxCount ueber Limit | ja | maxCount > 16384 |
| STT_ALIGNMENT_FAILED | Alignment-Berechnung fehlgeschlagen | ja | native align exception |
| STT_ALIGNMENT_NOT_FOUND | alignmentId ungueltig/freigegeben | ja | Getter nach release |
| STT_ALIGNMENT_INPUT_MISMATCH | resultId und bufferId passen nicht zusammen | ja | falsche Audio-Referenz |
| STT_ALIGNMENT_SLICE_INVALID | start/maxCount ungueltig fuer Alignment | ja | start < 0 |
| STT_ALIGNMENT_SLICE_TOO_LARGE | maxCount ueber Alignment-Limit | ja | maxCount > 8192 |
| STT_STREAM_INSTANCE_NOT_FOUND | Online-Instance fehlt | ja | falsche instanceId |
| STT_STREAM_NOT_FOUND | Stream fehlt | ja | stream bereits released |
| STT_STREAM_DECODE_FAILED | Online decode/poll Fehler | ja | native exception |
| STT_STREAM_FINAL_NOT_AVAILABLE | final resultId noch nicht vorhanden | ja | endpoint noch nicht erreicht |
| STT_INTERNAL_ERROR | unerwarteter nativer Fehler | bedingt | fallback code |

User-Message-Vorlage fuer `STT_STALE_RESULT`:
- "Result <requested> ist nicht mehr verfuegbar; diese STT-Instanz haelt nur das letzte Ergebnis (<current>). Materialisiere Daten vor dem naechsten Transcribe oder nutze eine zweite Instanz."

## 5) Konkrete Implementierungsaufgaben pro Layer

## 5.1 TypeScript Spec und Facade
Dateien:
- [src/NativeSherpaOnnx.ts](../../src/NativeSherpaOnnx.ts)
- [src/stt/types.ts](../../src/stt/types.ts)
- [src/stt/index.ts](../../src/stt/index.ts)
- [src/stt/streaming.ts](../../src/stt/streaming.ts)

Aufgaben:
1. Neue TM-Signaturen fuer buffer registry und result getters einfuehren.
2. `SttRecognitionResult` als sofortige Rueckgabe aus `transcribe*` entfernen.
3. Neues `SttTranscribeRef` oeffentlich machen.
4. Convenience-Helper im JS-Facade:
   - `materializeResult(instanceId, resultId)` (optional Helper, intern ueber diskrete Getter)
   - Slice-Paginator fuer tokens/timestamps/durations.
5. Alignment-Stage-Signaturen aufnehmen (`alignSttResult`, `alignTextToBuffer`, `getAlignmentSegments`, `releaseAlignment`).
6. Streaming-Facade auf text-first + optional `resultId` vorbereiten (Phase 2).
7. Keine Kombinationsmethoden in der TS-Surface einfuehren.

## 5.2 Android (Kotlin-first)
Dateien:
- [android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt](../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt)
- [android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt](../../android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt)
- [android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxOnlineSttHelper.kt](../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxOnlineSttHelper.kt)

Neue interne Komponenten:
- `SttRetainedResult` (data class)
- `SttResultSlot` (per instance: `currentResultId`, `result`)
- `AudioBufferRegistry` (shared map fuer offline PCM buffer handles)

Aufgaben:
1. Nach `rec.getResult(stream)` Ergebnis im Slot speichern statt direkt voll zu marshallen.
2. `transcribe*` nur `SttTranscribeRef` zurueckgeben.
3. Getter `getSttResult*` mit Slice-Regeln implementieren.
4. `releaseSttResult` implementieren.
5. `createAudioBufferFromFile`/`getAudioBufferInfo`/`releaseAudioBuffer` implementieren.
6. Alignment-Stage auf Basis `instanceId + resultId + bufferId` anbinden (`alignmentId`-Store + Getter).
7. Fehlercodes auf neue STT_* Codes umstellen.

## 5.3 iOS
Dateien:
- [ios/stt/bridge/SherpaOnnx+STT.mm](../../ios/stt/bridge/SherpaOnnx+STT.mm)
- [ios/stt/bridge/SherpaOnnx+OnlineSTT.mm](../../ios/stt/bridge/SherpaOnnx+OnlineSTT.mm)
- [ios/stt/sherpa-onnx-stt-wrapper.mm](../../ios/stt/sherpa-onnx-stt-wrapper.mm)

Aufgaben:
1. `SttInstanceState` um Result-Slot erweitern (`currentResultId`, retained result).
2. `transcribeFile`/`transcribeSamples` auf metadata-only Rueckgabe umstellen.
3. `getSttResult*` + Slice-Regeln + stale/error handling.
4. Shared AudioBufferRegistry fuer file->buffer einziehen.
5. Alignment-Stage fuer `instanceId + resultId + bufferId` mit `alignmentId`-Store implementieren.
6. Fehlercodes identisch zu Android halten.

## 5.4 C++/JNI
Dateien:
- [android/src/main/cpp/jni/module/sherpa-onnx-module-jni.cpp](../../android/src/main/cpp/jni/module/sherpa-onnx-module-jni.cpp)

Hinweis:
- Fuer STT runtime bleibt Android Kotlin-zentriert.
- JNI/C++ betreffen STT hier nur fuer detect und ggf. shared registry helper, nicht fuer eine zweite Offline-STT-Runtime.

## 6) Testplan (umfangreich)

## 6.1 C++ Host Tests (bestehende detect-tests erweitern)
Datei:
- [test/cpp/model_detect/model_detect_test.cpp](../../test/cpp/model_detect/model_detect_test.cpp)

Zusatzfaelle:
1. STT name-only mit assetName: metadata (`languages`, `quantization`) gesetzt.
2. STT name-only ohne inferierbaren Typ: klarer Fehler.
3. detectionSources-Reihenfolge fuer explicit vs fallback konsistent.
4. Hardware-spezifischer unsupported case setzt Flag und message.
5. preferInt8-Pfadauswahl deterministisch (int8 zuerst, fallback auf fp).
6. Alignment-Stage-Signatur bleibt von Detect entkoppelt (keine hardcoded Combo-API in Detect-Pfaden).

## 6.2 Android Unit/Integration

1. `transcribeFile` gibt `resultId` + Zaehlerfelder, aber keine Arrays zurueck.
2. `transcribeSamples` dito.
3. `getSttResultText` fuer aktuelles resultId erfolgreich.
4. `getSttResultTokens` slicing: start=0,maxCount=3.
5. slicing ueber Ende -> leeres Array.
6. `start < 0` -> `STT_SLICE_INVALID`.
7. `maxCount <= 0` -> `STT_SLICE_INVALID`.
8. `maxCount > STT_MAX_SLICE_COUNT` -> `STT_SLICE_TOO_LARGE`.
9. stale result nach zweitem transcribe -> `STT_STALE_RESULT`.
10. `releaseSttResult` leert Slot, danach `STT_RESULT_EMPTY`.
11. Hotwords-Fehler mappt auf `STT_CONFIG_FAILED` (plus message).
12. buffer registry: create/get/release happy path.
13. `transcribeFromAudioBuffer` mit invalid buffer -> `STT_BUFFER_NOT_FOUND`.
14. `unloadStt` raeumt slot + buffer references auf.
15. Parallelbetrieb zweier Instanzen: keine resultId-Kollision sichtbar im JS-Vertrag.
16. `alignSttResult` Happy Path mit gueltigem `instanceId + resultId + bufferId` liefert `alignmentId`.
17. `alignSttResult` mit stale result -> `STT_STALE_RESULT`.
18. `alignSttResult` mit falschem Buffer -> `STT_ALIGNMENT_INPUT_MISMATCH`.
19. `getAlignmentSegments` Slice-Regeln inkl. Fehlercodes.
20. `releaseAlignment` invalidiert Getter mit `STT_ALIGNMENT_NOT_FOUND`.

## 6.3 iOS Unit/Integration

1. Gleiche ResultRef-Form wie Android fuer `transcribeFile`.
2. Gleiche stale-Semantik (`STT_STALE_RESULT`).
3. Gleiche slice-validation Codes.
4. `releaseSttResult` Verhalten identisch.
5. `createAudioBufferFromFile` parity mit Android (sampleRate/numSamples/durationMs plausibel).
6. Fehlercode-Paritaet fuer nicht initialisierte Instanz.
7. Lifecycle: unload und erneutes initialize erzeugt frischen resultId-Zyklus.
8. Alignment parity: gleiche Request-/Response-Shapes und Fehlercodes wie Android.
9. `alignTextToBuffer` und `alignSttResult` liefern konsistente `alignmentId`-Semantik.

## 6.4 TypeScript Tests
Dateien:
- [src/__tests__/index.test.tsx](../../src/__tests__/index.test.tsx) (neu sinnvoll befuellen)
- neue stt-spezifische tests unter `src/stt/__tests__/...`

Faelle:
1. `createSTT().transcribeFile()` liefert `SttTranscribeRef`.
2. Facade helper materialisiert diskret (mehrere Getter-Aufrufe).
3. Pagination helper liest vollstaendige Tokens per Slices.
4. Fehler-Mapping `STT_STALE_RESULT` -> klare JS-Exception.
5. Streaming text-first Contract (Phase 2 vorbereitet).
6. Pipeline-Orchestrierungstest ohne Combo-API: createBuffer -> enhanceBuffer -> transcribeFromBuffer -> alignSttResult.
7. Alignment-Getter Pagination und release-Verhalten.

## 6.5 End-to-End und Performance

1. Lange Datei (>= 60 min) transcribeFile: kein riesiges Result-Objekt in einem Promise.
2. Peak JS Heap vor/nach Rework vergleichen.
3. Zeit fuer erstes Ergebnis vs Vollmaterialisierung separat messen.
4. Zwei Instanzen parallel: keine gegenseitige stale-Kollision.
5. Pipeline smoke (File -> Buffer -> STT) ohne JS-PCM-Roundtrip.
6. Pipeline smoke inklusive Alignment-Stage (File -> Buffer -> STT -> Alignment) ohne Kombinationsmethode.

## 7) Rollout in Meilensteinen

## Milestone A (Pipeline-Vertrag + offline by-reference)
- TurboModule Signaturen fuer orthogonale Stages (inkl. Alignment-Stage-Vertrag, keine Combo-API).
- Android/iOS offline ResultSlot + Getter + Codes.
- Done-Kriterium: offline STT arbeitet ohne full payload default, und Alignment ist als separater Stage vertraglich fixiert.

## Milestone B (shared audio buffer registry offline)
- file->buffer + transcribeFromAudioBuffer + lifecycle.
- Done-Kriterium: path-first und buffer-first beide stabil.

## Milestone C (streaming final segment by-reference)
- text-first polling + optional `resultId` fuer finalisierte Segmente.
- Done-Kriterium: keine grossen arrays pro Tick als Default.

## Milestone D (Streaming-final Alignment-Anbindung)
- Finalisierte Streaming-Segmente per `resultId` an `alignSttResult` anbinden.
- Done-Kriterium: keine neue Streaming-Combo-API, sondern Wiederverwendung der Stage-Vertraege.

## 8) Ausdruecklich nicht in 1.0.0 Scope
- Vollstaendige Streaming-History per Handles (kein Ring/LRU).
- Bulk-PCM Codegen-ArrayBuffer Signaturen im TurboModule-Typsystem.
- Legacy-Kompatibilitaets-Wrapper fuer alte STT full-result Rueckgaben.
- Feature-Kombinationsmethoden wie `transcribeWithAlignment` / `transcribeWithEnhancementAndAlignment`.

## 9) Entscheidungsbedarf vor Start
1. ✅ `resultId` als `number` (JS) bleibt, intern `int64_t`/`Long`.
2. ✅ `transcribeSamples(number[])` bleibt als Escape Hatch erhalten, aber metadata-only Output.
3. ✅ `STT_DEFAULT_SLICE_COUNT` = **1024**.
   - Begruendung (Public SDK): guter Default fuer breite Geraeteabdeckung (RAM/GC), kleinere Peak-Transfers pro Call, gute Pagination-Stabilitaet.
   - `2048` kann bei High-End-Geraeten minimal weniger Roundtrips bedeuten, erhoeht aber Risiko fuer groessere Bridge-/Heap-Spikes bei Mid-/Low-End.
4. ✅ `alignmentId`-Lifetime: **eigener Store** (nicht an STT-slot gekoppelt).
5. ✅ `ALIGNMENT_DEFAULT_SLICE_COUNT` = **512**.
   - Begruendung (Public SDK): Alignment-Segmente sind meist strukturreicher pro Eintrag; 512 reduziert Payload-Spitzen und ist als Default robuster.
   - `1024` bleibt als expliziter opt-in ueber `maxCount` moeglich, wenn Client/Use-Case das traegt.

Damit sind die Startentscheidungen getroffen; Umsetzung kann direkt nach Milestones beginnen.

## Appendix A) Konkrete Pipeline-Beispiele (Offline)

### A.1 Offline pipeline mit Enhancement-Stage

```ts
// 1) Engines
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/stt-xyz' },
});
const enhancement = await createSpeechEnhancement({
  modelPath: { type: 'asset', path: 'models/enh-xyz' },
});

// 2) File -> native buffer
const raw = await createAudioBufferFromFile('/abs/path/input.wav', 16000, true);

// 3) Enhancement stage (optional in pipeline)
const enhanced = await enhanceBuffer(enhancement.instanceId, raw.bufferId);

// 4) STT stage by reference
const ref = await transcribeFromAudioBuffer(stt.instanceId, enhanced.bufferId, {
  sourceTag: 'enhanced',
});
if (!ref.success || ref.resultId == null) {
  throw new Error(ref.error ?? 'transcribeFromAudioBuffer failed');
}

// 5) Lazy result getter
const text = await getSttResultText(stt.instanceId, ref.resultId);

// 6) Alignment stage (instanceId + resultId + bufferId)
const alignmentRef = await alignSttResult(
  stt.instanceId,
  ref.resultId,
  enhanced.bufferId,
  { granularity: 'word' }
);
if (!alignmentRef.success || alignmentRef.alignmentId == null) {
  throw new Error(alignmentRef.error ?? 'alignSttResult failed');
}

const segments = await getAlignmentSegments(alignmentRef.alignmentId, 0, 200);
await saveAlignment(alignmentRef.alignmentId, '/abs/path/alignment.srt', 'srt');

// 7) Cleanup
await releaseAlignment(alignmentRef.alignmentId);
await releaseSttResult(stt.instanceId);
await releaseAudioBuffer(raw.bufferId);
await releaseAudioBuffer(enhanced.bufferId);
await stt.destroy();
await enhancement.destroy();
```

### A.2 Offline pipeline ohne Enhancement-Stage

```ts
// 1) Engine
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/stt-xyz' },
});

// 2) File -> native buffer
const raw = await createAudioBufferFromFile('/abs/path/input.wav', 16000, true);

// 3) STT stage direkt auf raw buffer
const ref = await transcribeFromAudioBuffer(stt.instanceId, raw.bufferId, {
  sourceTag: 'raw',
});
if (!ref.success || ref.resultId == null) {
  throw new Error(ref.error ?? 'transcribeFromAudioBuffer failed');
}

// 4) Optional alignment
const alignmentRef = await alignSttResult(
  stt.instanceId,
  ref.resultId,
  raw.bufferId,
  { granularity: 'word' }
);

// 5) Cleanup
if (alignmentRef.success && alignmentRef.alignmentId != null) {
  await releaseAlignment(alignmentRef.alignmentId);
}
await releaseSttResult(stt.instanceId);
await releaseAudioBuffer(raw.bufferId);
await stt.destroy();
```

## Appendix B) Wege ohne Pipeline-Werte (kein `bufferId`-Orchestrieren im App-Code)

Die STT-APIs funktionieren weiterhin auch ohne explizite Pipeline-Orchestrierung im App-Code:

```ts
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/stt-xyz' },
});

// Path-first (intern ggf. trotzdem native bufferisiert)
const byFile = await transcribeFile(stt.instanceId, '/abs/path/input.wav');

// Escape hatch: direkte Samples ueber Bridge (teuer bei grossen Inputs)
const bySamples = await transcribeSamples(stt.instanceId, samples, 16000);

if (byFile.success && byFile.resultId != null) {
  const text = await getSttResultText(stt.instanceId, byFile.resultId);
}

await releaseSttResult(stt.instanceId);
await stt.destroy();
```