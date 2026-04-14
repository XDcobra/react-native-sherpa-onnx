# STT auf Pipeline-AudioBuffer — Zielbild und Umsetzungsplan

Dieses Dokument beschreibt das **Zielbild**, **technische Randbedingungen** und die **Reihenfolge der Arbeit**, um **Offline-STT** und **Alignment** ausschließlich über [`PipelineAudioRegistry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt) / [`audiobuffer`](../../../src/audiobuffer/index.ts) zu betreiben.

---

## Policy: Breaking changes gewollt, kein Legacy

Das SDK ist **noch nicht veröffentlicht**. Es gibt **keine** Rücksicht auf abwärtskompatible IDs, **keine** Übergangsphasen, **keine** Deprecation-Kommentare, **keine** separaten „Migrations“-Hinweise für externe App-Entwickler und **keinen** Fallback auf alte Codepfade.

- **Nur** die neue Pipeline-Logik bleibt.
- Alte Legacy-Logik wird **vollständig und spurlos** entfernt: kein `buf_…`, keine `AudioBufferRegistry`, kein `g_audio_buffers`, keine Legacy-TurboModule-Methoden, keine Re-Exports oder Wrapper unter alten Namen.

API und Verhalten ändern sich hart — das ist **beabsichtigt**.

---

## Zielbild

- **Ein** Registry-Modell, **eine** ID-Semantik (`off_…` / `live_…`), **dieselbe** Auflösung auf Android und iOS.
- `transcribeFromAudioBuffer`, Alignment und alle Buffer-Hilfen lesen **ausschließlich** aus Pipeline-[`OfflineEntry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/OfflineEntry.kt) (bzw. dem iOS-Äquivalent).
- Öffentliche Oberfläche für Pipeline-Buffers: **`audiobuffer`** — **nicht** parallele Legacy-STT-Buffer-APIs. (`pcm-stream` ist nur der PCM-Player-Alias, siehe [`pcm-stream.md`](../../pcm-stream.md).)

---

## Ist-Zustand (nur als Ausgangspunkt für die Löschliste)

| Bereich | Wegmuss (Legacy) | Bleibt / Ziel |
| --- | --- | --- |
| **Android** | [`AudioBufferRegistry`](../../../android/src/main/java/com/sherpaonnx/stt/AudioBufferRegistry.kt), alle `buf_…`-Pfade | [`PipelineAudioRegistry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt) |
| **STT** | [`SherpaOnnxSttHelper`](../../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt): nur `AudioBufferRegistry.get` | Nur `OfflineEntry` / `off_…` |
| **Alignment** | [`SherpaOnnxModule`](../../../android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt): `AudioBufferRegistry` | Dieselbe PCM-Beschaffung wie STT aus Pipeline |
| **iOS** | `g_audio_buffers` und zugehörige Pfade in [`SherpaOnnx+STT.mm`](../../../ios/stt/bridge/SherpaOnnx+STT.mm) | Pipeline wie in [`SherpaOnnx+PipelineAudio.mm`](../../../ios/SherpaOnnx+PipelineAudio.mm) |
| **TS / TurboModule** | `createAudioBufferFromFile`, `getAudioBufferInfo`, `releaseAudioBuffer`, alte Spec-Teile | Nur Pipeline-Methoden in [`NativeSherpaOnnx.ts`](../../../src/NativeSherpaOnnx.ts); JS-Fassaden unter [`audiobuffer`](../../../src/audiobuffer/index.ts); Legacy aus [`stt/index.ts`](../../../src/stt/index.ts) entfernen |

---

## Technische Randbedingungen (von Anfang an, keine Nachbesserungs-„v1“)

### Offline vs. Streaming (Produkt)

- **Offline-STT:** ganze Utterance, ein Durchlauf — Pipeline-**OfflineBuffer** (`off_…`). Nutzungshinweis in **User-Doku**: eher kurze/kleinere Dateien; **gesamte** Wellenform wird ins Offline-Modell geladen (bewusst).
- **Streaming-STT:** chunkweise, große Inhalte — **Online**-API und passendes Modell; siehe [`docs/stt-streaming.md`](../../stt-streaming.md).

Nicht jedes Modell unterstützt Streaming; Offline bleibt nötig, wo nur Offline-Modelle eingesetzt werden.

### sherpa-onnx Offline

Pro [`SherpaOnnxAcceptWaveformOffline`](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/c-api/c-api.h): **höchstens ein** Aufruf pro `OfflineStream` — gesamte Äußerung in diesem Aufruf. In der App wird die **Kotlin-API** von sherpa-onnx genutzt (`OfflineStream.acceptWaveform(...)` o. Ä.); das bildet dieselbe Semantik ab und ändert nichts an der Aussage. Chunkweises Einspeisen auf **demselben** Offline-Stream ist falsch; große Dateien chunkweise im **Produktsinn** ⇒ **Streaming-STT**, nicht Workarounds am Offline-Stream.

### PCM aus `OfflineEntry` — Best Practice, sofort

Implementierung **ohne** bewusst ineffizienten Zwischenschritt und **ohne** „später optimieren“:

- **In-Memory-Offline:** Samples liegen bereits vor — direkt an sherpa-onnx übergeben, **keine** unnötige Kopie (sofern Ownership/Lifetime der nativen API das zulässt; sonst eine dokumentierte, minimale Kopie).
- **File-backed Offline:** **Kein** blindes `readAllSamples()`, das erst in mehreren Schritten die ganze Datei ineffizient puffert. Stattdessen von Anfang an: **ein** klarer Pfad z. B. über `createReader()` / streaming WAV-PCM-Decode **in einen einmal vorbestimmten** `FloatArray` (Länge aus Metadaten), dann **ein** `acceptWaveform`. Ziel: kontrolliertes I/O, vorhersehbare Allokation, keine doppelte vollständige Pufferung derselben Datei.

**Alignment** nutzt **dieselbe** Beschaffungslogik wie STT aus demselben `OfflineEntry` (eine Implementierung, zwei Aufrufer), keine zweite, schlechtere Variante.

### Live-Handles und Offline-STT

`transcribeFromAudioBuffer` nimmt **nur** `off_…` entgegen (nur [`OfflineEntry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/OfflineEntry.kt)) — ein PCM-Auflösepfad, keine Sonderlogik für `live_…` in derselben Methode.

Audio von einem **`live_…`**-Buffer wird vor Offline-STT **immer** über **`createOfflineAudioBufferFromLive`** (Modi `fullIfSpooled` / `windowSnapshot` wie im [Pipeline-Plan](../audio_pipeline_buffers_7605bf7f.plan.md)) in ein **`off_…`** überführt; dort sind Semantik und Speicherprofil explizit. **`live_…` im Zustand `recording`** ist weder für diesen Schritt noch für Offline-STT ohne vorherige Finalisierung/Snapshot-Entscheidung gültig — **harte** native Fehler bei falschem Handle oder Zustand.

---

## Restliche Stolpersteine (technisch, nicht organisatorisch)

1. **iOS-Parität:** STT und Alignment müssen **dieselbe** Pipeline-Auflösung wie Android nutzen; Legacy-Maps entfallen vollständig.
2. **Alignment-Code:** an einer Stelle mit STT auf „Samples aus `OfflineEntry`“ umbauen — ggf. Refaktor, damit nicht zwei divergierende Reader-Pfade existieren.
3. **Codegen / Spec:** Nach Entfernen der Legacy-TurboModule-Methoden Spec + nativen Code + TypeScript **konsistent** neu generieren bzw. anpassen.

---

## Festgelegte Feinentscheidungen

1. **`transcribeFromAudioBuffer` und `live_…`:** Nur **`off_…`**. Live → Offline-STT ausschließlich über **`createOfflineAudioBufferFromLive`** mit dem im [Pipeline-Plan](../audio_pipeline_buffers_7605bf7f.plan.md) beschriebenen Vertrag (`fullIfSpooled` / `windowSnapshot`). So bleibt die Pipeline konsistent und doppelt keine implizite „finished-Live“-Semantik in der Transkriptionsmethode.

2. **File-backed Reader: Chunk-Größe:** Eine **sinnvolle Default-Frames**- bzw. **Byte-Chunk**-Größe festlegen und in Tests verankern. Zusätzlich **öffentlich überschreibbar** (TurboModule-Parameter und durchreichen in [`audiobuffer`](../../../src/audiobuffer/index.ts)), damit Host-Apps bei Bedarf I/O und Latenz feinsteuern können, ohne interne Konstanten zu duplizieren.

---

## Umsetzungsplan (Reihenfolge)

### 1. Gemeinsame native PCM-Beschaffung

- **Android:** Hilfsfunktion oder klarer Pfad im Modul: `bufferId` (`off_…`) → `PipelineAudioRegistry` → `OfflineEntry` → Samples + `sampleRate` nach der Best-Practice-Regel oben (In-Memory vs. file-backed Reader).
- **iOS:** Analog; **Entfernen** von `g_audio_buffers` aus dem STT-/Alignment-Flow sobald ersetzt.

### 2. STT und Alignment umstellen

- [`SherpaOnnxSttHelper`](../../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt) `transcribeFromAudioBuffer`: nur noch Pipeline; **ein** Offline-`acceptWaveform`.
- [`SherpaOnnxModule`](../../../android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt) / Alignment: gleiche PCM-Quelle.

### 3. Legacy und alte Oberfläche vernichten

- Android: `AudioBufferRegistry` und alle Referenzen, Legacy-Buffer-TurboModule-Implementierungen.
- iOS: Legacy-Buffer-Erstellung/-Maps in STT, soweit nur für `buf_…` gedacht.
- [`NativeSherpaOnnx.ts`](../../../src/NativeSherpaOnnx.ts): Legacy-Methoden löschen, Codegen laufen lassen.
- [`stt/index.ts`](../../../src/stt/index.ts): alle Buffer-Legacy-Exporte entfernen; Doku-Beispiele nur noch `off_…` / `audiobuffer`.

### 4. Tests und User-Doku

- Unit-/Integrationstests: In-Memory- und **file-backed** Offline (Reader-Pfad), Fehlerfälle (`recording`, nicht gefunden, leer).
- [`docs/stt-offline.md`](../../stt-offline.md), [`docs/audiobuffer.md`](../../audiobuffer.md) / [`audiobuffer-offline.md`](../../audiobuffer-offline.md): nur neues Modell; Kurz-Hinweis **Offline vs. Streaming** wie oben (kein Migrationskapitel für Altnutzer).

### 5. Optional (separates Epic)

- Native Kopplung **Streaming-STT** an `LiveEntry`-Cursor — außerhalb dieses Offline/Alignment-Puffer-Schwerpunkts.

---

## Erfolgskriterien

- Es existiert **kein** referenzierbarer Codepfad mehr für `buf_…` / `AudioBufferRegistry` / `g_audio_buffers` / Legacy-TurboModule-Buffer.
- Offline-STT und Alignment beziehen PCM **nur** aus Pipeline-`OfflineEntry` mit der vereinbarten **sofortigen** Performance-Strategie (kein „Temporär `readAllSamples()` bis später“).
- Android und iOS verhalten sich für dieselben `off_…`-IDs gleichwertig (Fehlercodes, Erfolg).
- Öffentliche API und Beispiele sprechen **nur** noch die Pipeline-Sprache (`audiobuffer` / `off_…`).

---

## Verweise

- Pipeline-Architektur: [audio_pipeline_buffers_7605bf7f.plan.md](../audio_pipeline_buffers_7605bf7f.plan.md)
- Ältere STT-Pipeline-Notiz: [stt-native-pipeline-spec-implementation-plan.md](../stt-native-pipeline-spec-implementation-plan.md)
- Pipeline-Buffers: [audiobuffer.md](../../audiobuffer.md), [audiobuffer-offline.md](../../audiobuffer-offline.md), [audiobuffer-streaming.md](../../audiobuffer-streaming.md); PCM-Player-Alias: [pcm-stream.md](../../pcm-stream.md)
- STT nur noch über Buffer + Alignment entkoppeln: [stt-pipeline-buffer-only-api-plan.md](./stt-pipeline-buffer-only-api-plan.md)
