# Sub-06-02: Event- & Contract-Parity — Findings & Entscheidungen

## Status

- **Tracking-Dokument** (lebendig bis Phase 7 / Sub-06 Abschluss)
- **Eltern-Plan:** [sub-06-cleanup-contract-parity.md](./sub-06-cleanup-contract-parity.md), Workstream **2) Deferred Parity Items**
- **Fokus:** Restliche Event-/Contract-Differenzen (`onSegment`, Finalize, Payload-Shape, Live/Offline-Reads) — **ohne** optionalen Sync-JSI-Schnellpfad für `setPartial` / `appendPartial` (separat Workstream 2b)

## Zweck

- Befunde aus Ist-Analyse (Doc ↔ Code ↔ Android/iOS) festhalten.
- Pro Punkt eine **bindende oder noch offene Entscheidung** dokumentieren, damit Phase 7 nicht neu diskutiert werden muss.
- Abweichungen von `sub-01` / `sub-03` explizit als **must-fix**, **acceptable deviation** oder **open** klassifizieren.

## Legende

| Klassifikation | Bedeutung |
|----------------|-----------|
| `must-fix` | Vor „release-ready“ Sub-06 klären oder implementieren. |
| `acceptable-deviation` | Bewusst so belassen; nur Doku / Kommentar / Typdoc. |
| `open` | Noch zu verifizieren (Audit, Tests, Native-Pfad). |
| `deferred` | Bewusst verschoben; Details in `docs/future-work/` (kein aktueller Phase‑7‑Blocker). |

**Entscheidungs-Status:** `draft` = Vorschlag zur Freigabe durch Maintainern; nach Review → `accepted` im gleichen Dokument nachpflegen.

---

## Übersicht (Quick Reference)

| ID | Thema | Klassifikation | Entscheidungs-Status |
|----|--------|----------------|----------------------|
| EC-01 | Wire + TS: `liveBufferId` in `pipelineLiveSegmentAppended` / öffentliche Segment-Events | `must-fix` (Major Cut, siehe Entscheidung) | **Code umgesetzt** (2026-05-01) |
| EC-02 | `totalSegments` im Wire `pipelineLiveSegmentAppended` (autoritativ Native) + TS | `must-fix` | `accepted` (Code umgesetzt, siehe unten) |
| EC-03 | Text-Segment-Events: Dedup über `segmentIndex` in TS | `deferred` (siehe [future-work](../../future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md)) | `deferred` |
| EC-04 | `reason` / `source` / `createdAtMs` bei Speech-Segmenten (`pipelineLiveSegmentAppended`) | `must-fix` | **Code umgesetzt** (2026-05-01) |
| EC-05 | `payload`-Shape: Android nur flache JSON-Typen vs. iOS volle Deserialisierung | `must-fix` | **Code umgesetzt** (2026-05-01) |
| EC-06 | Finalize: Audio `manual` vs. `auto` / Plattform-Parität / `reason: 'finalize'` | `must-fix` | `accepted` (Audit + Plan unten; Code offen) |
| EC-07 | Öffentliche Callback-API: Parität Text ↔ Audio (`subscribeLiveTextBufferEvents`) | `must-fix` | `accepted` (Umsetzungsplan unten; Code offen) |
| EC-08 | Wire: `pipelineLiveTextSegment` → `pipelineLiveTextSegmentAppended` (einheitliches `*SegmentAppended`-Muster) | `must-fix` (Major Cut, siehe Entscheidung) | **Code umgesetzt** (2026-05-01) |

---

## EC-01 — Wire + öffentliche Typen: `liveBufferId` → `segmentBufferId` (Major Cut)

### Festgestellt

- Native emittieren `pipelineLiveSegmentAppended` mit Feld **`liveBufferId`**, das semantisch die **Live-Segmentbuffer-ID** ist — der Name kollidiert mit der Erwartung „Live-Audio-Buffer“.
- **`src/audiobuffer/index.ts`** routet Audio-`onSegment` nur über **`sourceAudioBufferId`**; das Wire-Feld `liveBufferId` wird dort **nicht** gelesen.
- **`src/segmentbuffer/index.ts`** liest **`raw.liveBufferId`** für Routing der `onSegmentAppended`-Callbacks und setzt es auf dem öffentlichen **`LiveSegmentBufferSegmentAppendedEvent`** (`eventBase.liveBufferId`).
- **`LiveSegmentBufferErrorEvent`** nutzt ebenfalls **`liveBufferId?`**; der Listener `pipelineLiveSegmentError` parst dasselbe Wire-Muster (aktuell kaum / noch nicht von allen Native-Pfaden emittiert — trotzdem **gleiche Umbenennung** für Konsistenz beim Cut).

**Code-Referenzen (Ist):** Android `SherpaOnnxModule.kt` (`putString("liveBufferId", …)`), iOS `SherpaOnnx+SegmentBuffer.mm` (`body[@"liveBufferId"]`), TS `src/segmentbuffer/index.ts`, `src/segmentbuffer/types.ts`, Test `src/audiobuffer/__tests__/segment-events.test.ts` (Mock-Payload).

### Risiko (vorher)

Verwechslung Segment- vs. Audio-ID; unnötige Kompatibilitätsschichten, wenn das SDK noch nicht released ist.

### Entscheidung (**accepted** — Major Cut, kein Kompat-Layer)

1. **Wire-Event `pipelineLiveSegmentAppended`:** Feld **`liveBufferId` entfernen**. Kanonisches Feld: **`segmentBufferId`** = ID des **Live-Segmentbuffers**. Feld **`sourceAudioBufferId`** bleibt unverändert (zugehörige **Audio**-Pipeline-ID).
2. **Kein** paralleles Ausliefern von Alt-Keys; keine Deprecation-Phase im SDK-Pre-Release.
3. **Öffentliche TS-Typen (`src/segmentbuffer/types.ts`):**
   - `LiveSegmentBufferSegmentAppendedEventBase`: **`liveBufferId` → `segmentBufferId`** (Pflichtfeld `string`).
   - `LiveSegmentBufferErrorEvent`: **`liveBufferId?` → `segmentBufferId?`**.
4. **TS-Implementierung (`src/segmentbuffer/index.ts`):**
   - Listener-Raw-Typ: `segmentBufferId?: string` statt `liveBufferId`; Routing-Key = `segmentBufferId`.
   - `eventBase` / emittiertes `LiveSegmentBufferSegmentAppendedEvent`: Property **`segmentBufferId`**.
   - `pipelineLiveSegmentError`-Listener: `raw.segmentBufferId`; gebautes `LiveSegmentBufferErrorEvent` mit **`segmentBufferId`**.
   - Interne Funktion **`registerLiveSegmentBufferCallbacks`** / Maps: Parameter und Variablen sinnvoll in **`segmentBufferId`** umbenennen (reine Lesbarkeit; Map-Key bleibt die Segment-Buffer-ID).
   - **`createLiveSegmentBuffer`**: nach erfolgreicher Native-Erstellung weiterhin `registerLiveSegmentBufferCallbacks(raw.bufferId, …)` — `raw.bufferId` ist weiterhin die Segment-Buffer-ID (nur die **Event-Payload-Namen** ändern sich).
5. **Native (Pflicht, Parität Android + iOS):**
   - **Android:** In `SherpaOnnxModule.kt` im `emitSegmentAppended`-Payload `liveBufferId` durch **`segmentBufferId`** ersetzen (gleicher Wert wie bisher).
   - **iOS:** In `SherpaOnnx+SegmentBuffer.mm` alle `pipelineLiveSegmentAppended`-Bodies: `liveBufferId` → **`segmentBufferId`**.
   - Sobald Native **`pipelineLiveSegmentError`** mit Buffer-Referenz emittiert: dort ebenfalls **`segmentBufferId`** (kein `liveBufferId`).
6. **Tests:** `src/audiobuffer/__tests__/segment-events.test.ts` — Mock-Event auf **`segmentBufferId`** umstellen. Alle weiteren Jest-Mocks / Fixtures, die `pipelineLiveSegmentAppended` simulieren, gleichziehen. Segmentbuffer-spezifische Tests (falls vorhanden / neu) anpassen.
7. **Doku / Kommentare:** `src/NativeSherpaOnnx.ts` (JSDoc zu `emitSegmentAppendedEvents`), öffentliche Segment-/Buffer-Doku und dieses Tracking-Dokument nach Umsetzung als **erledigt** markieren.

**Abgrenzung:** Andere Events (z. B. `pipelineLiveAudioChunk`, `pipelineLiveTextPartial`) nutzen `liveBufferId` für die **Audio- bzw. Text-Live-Buffer-ID** — das ist **korrekt** und **nicht** Teil von EC-01.

**Klassifikation:** `must-fix` (einmaliger Umbenennungs-Cut).

**Entscheidungs-Status:** `accepted` (2026-04-30)

### Follow-up (Implementierung — Checkliste)

- [x] Android: `SherpaOnnxModule.kt` — Payload-Key `segmentBufferId`.
- [x] iOS: `SherpaOnnx+SegmentBuffer.mm` — Payload-Key `segmentBufferId`.
- [x] TS: `src/segmentbuffer/types.ts` — öffentliche Event-Typen.
- [x] TS: `src/segmentbuffer/index.ts` — Listener + Callback-Registrierung + Error-Event.
- [x] TS: `src/audiobuffer/__tests__/segment-events.test.ts` (+ weitere betroffene Tests).
- [x] Optional: Kotlin-Bridge-Parameter in `SegmentBufferEventBridge` / Lambda von `liveId` zu `segmentBufferId` umbenennen (nur Code-Klarheit, kein Wire).
- [x] User-facing Doku / `NativeSherpaOnnx.ts` Kommentar aktualisieren.
- [x] Repo-weit nach Mock-Payloads mit `liveBufferId` unter `pipelineLiveSegmentAppended` suchen und bereinigen.
- [x] **Example-App:** z. B. `example/src/screens/vad/VADScreen.tsx` — nach Typ-Umbenennung prüfen, ob irgendwo `event.liveBufferId` auf **Segment-Appended**-Events zugegriffen wird (aktuell nur andere Felder); ggf. auf `event.segmentBufferId` umstellen, falls genutzt.

---

## EC-02 — `totalSegments` im Wire `pipelineLiveSegmentAppended` (Major Cut)

### Festgestellt (vorher)

- TS setzte `LiveAudioBufferSegmentEvent.totalSegments` nur als **`segmentIndex + 1`** — bei **Ring/Eviction** (`maxSegments`) nicht gleich der **aktuellen Anzahl** gehaltener Segmente im Live-Segmentbuffer.

### Semantik (Zielbild, verbindlich)

- **`totalSegments`** im Native-Payload `pipelineLiveSegmentAppended`: **Anzahl der Segmente, die nach diesem Commit im Live-Segmentbuffer gehalten werden** (`segments.size` nach Append inkl. ggf. Eviction) — **nicht** „nur“ `segmentIndex + 1` über alle Zeit.
- **`segmentIndex`**: unverändert die logische Index-Vergabe beim Append (wie bisher Native/Kotlin/C++).
- TS nutzt **`totalSegments` aus dem Wire**, falls vorhanden; fehlt das Feld (z. B. veralteter Mock), Fallback **`max(1, segmentIndex + 1)`** ohne zusätzliche User-Doku-Pflicht (Clean Cut: Native liefert das Feld immer).

### Entscheidung (**accepted**)

Native **Android + iOS** erweitern; TS **audiobuffer** + **segmentbuffer** (öffentlicher `LiveSegmentBufferSegmentAppendedEvent`) anpassen. **Kein** interim-Typdoc-Hinweis auf Heuristik (Pre-Release-Cut).

**Klassifikation:** `must-fix`  
**Entscheidungs-Status:** `accepted` (2026-04-30)

### Umsetzung (konkret — Referenz für Audit)

| Schicht | Datei / Ort | Änderung |
|---------|-------------|----------|
| Android | `LiveSegmentEntry.kt` | Nach `synchronized(segmentLock)`-Block: `totalSegmentsInBuffer = segments.size`; `emitSegmentAppended?.invoke(bufferId, appendRecord, segmentIndex, totalSegmentsInBuffer)`. |
| Android | `SegmentBufferEventBridge.kt` | Callback-Typ um Parameter **`totalSegments: Int`** erweitern. |
| Android | `SherpaOnnxModule.kt` | In `emitSegmentAppended`-Lambda: `m.putInt("totalSegments", totalSeg)`. |
| iOS | `SherpaOnnx+SegmentBuffer.mm` | `SegLiveEntry::segmentAppendedEmitter` auf **4 Parameter** (`totalSegments`); `seg_notify_segment_appended` übergibt `static_cast<int>(entry->segments.size())` nach Append; beide Event-Body-Stellen: `body[@"totalSegments"]`. |
| TS | `src/audiobuffer/index.ts` | Roh-Typ um `totalSegments?`; `LiveAudioBufferSegmentEvent.totalSegments` aus **`rawEvent.totalSegments`**, sonst `max(1, segmentIndex + 1)`. |
| TS | `src/segmentbuffer/types.ts` | `LiveSegmentBufferSegmentAppendedEventBase` um **`totalSegments: number`**. |
| TS | `src/segmentbuffer/index.ts` | Roh-Typ + `eventBase.totalSegments` (gleiche Logik wie Audiobuffer-Fallback). |
| Tests | `src/audiobuffer/__tests__/segment-events.test.ts` | Mock-Payload um **`totalSegments`** ergänzen (z. B. `1`). |

### Follow-up (Checkliste)

- [x] Native Android + iOS Payload `totalSegments`.
- [x] TS Audiobuffer + Segmentbuffer-Typen + Segmentbuffer-Listener.
- [x] Betroffene Jest-Mocks angepasst.
- [ ] Weitere Tests/Mocks im Repo bei Bedarf (`rg pipelineLiveSegmentAppended`).

---

## EC-03 — Text: Dedup nach `segmentIndex` im TS-Listener (**deferred**)

**Status:** `deferred` — kein aktueller Arbeitspaket für Sub-06-02 / Phase‑7; Inhalt und Follow-ups nachgeführt unter:

**→ [segmentation-ec-03-live-text-segment-index-dedup-invariant.md](../../future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md)**

(Kurz: `dispatchLiveTextSegmentEvent` filtert nach `segmentIndex`; Klärung braucht Emitter-Audit + ggf. Doku-Invariante — siehe Future-Work-Datei.)

---

## EC-04 — Speech: `reason` / `source` / `createdAtMs` auf `pipelineLiveSegmentAppended`

### Festgestellt

- Native setzen `reason`, `source`, `createdAtMs` auf dem Wire-Payload **nur**, wenn `peekSegmentAnnotation` / `seg_engine_peek_annotation` für die **Segment-ID** etwas findet; sonst fehlen die Keys und TS fällt in **`src/audiobuffer/index.ts`** auf **`toSegmentReason` / `toSegmentSource`** zurück (`unknown` → effektiv `'manual_commit'` bzw. `'manual'`).
- Annotations kommen u. a. aus **`SegmentationEngineRegistry.recordSegmentAnnotation`** (Android) bzw. der iOS-Entsprechung (`seg_engine_*` in `SherpaOnnx+SegmentBuffer.mm`); Worker (STT, Punctuation) setzen Meta mit `__segmentReason` / Quelle — nicht jeder Append-Pfad registriert dieselbe Information vor dem Event.

**Code-Referenzen:** Android `SherpaOnnxModule.kt` (Emit nach `peekSegmentAnnotation`), `SegmentationEngineRegistry.kt` (`recordSegmentAnnotation` / `peekSegmentAnnotation`); iOS `SherpaOnnx+SegmentBuffer.mm` (Event-Body + `seg_engine_peek_annotation`); TS `src/audiobuffer/index.ts` (`toSegmentReason`, `toSegmentSource`, Segment-Listener).

### Risiko

Plattform- oder pfadabhängig **leicht andere** sichtbare `Segment.reason` / `Segment.source` / `createdAtMs`, obwohl der User dieselbe Operation ausführt (Debugging, Telemetrie, Policy-UI).

### Entscheidung (**accepted**)

1. **Contract-Ziel:** Für **jeden** produktionsrelevanten Append-Pfad muss das **Wire-Event** `pipelineLiveSegmentAppended` für Speech-Segmente **`reason`**, **`source`** und **`createdAtMs`** enthalten (native ausgespielt, nicht nur durch TS-Fallback erklärbar).
2. **Semantik:** Werte müssen zu den in **`sub-01`** / Segment-Typen erlaubten **`SegmentReason`** / **`SegmentSource`** passen bzw. von TS **`toSegmentReason` / `toSegmentSource`** akzeptiert werden (keine stillen „magischen“ Abweichungen zwischen Android und iOS).
3. **Tests:** Matrix **Pfad × Plattform** mit festen Erwartungen (siehe Umsetzungstabelle); fehlende Fälle = Bug, kein Nachjustieren der Erwartung ohne Doku-Update.

**Klassifikation:** `must-fix` (öffentlicher Segment-Contract).  
**Entscheidungs-Status:** **Code umgesetzt** (2026-05-01)

### Umsetzung (konkret — noch **nicht** im Code umgesetzt)

Zwei zulässige Varianten (eine wählen und durchziehen; **nicht** mischen ohne Doku):

| Variante | Beschreibung | Wo hängt es |
|----------|--------------|-------------|
| **A — Emit-Defaults (empfohlen, geringer Eingriff)** | In **dem** Code, der das RN-Event `pipelineLiveSegmentAppended` baut: wenn Annotation fehlt, **`reason`**, **`source`**, **`createdAtMs`** trotzdem setzen (z. B. `manual_commit` / `manual` / aktuelle Epoch-ms), **identisch** auf Android und iOS. Bestehende Annotationen überschreiben die Defaults nicht. | Android: Lambda `SegmentBufferEventBridge.emitSegmentAppended` in `SherpaOnnxModule.kt` (nach `peekSegmentAnnotation`). iOS: beide Stellen, die `body` für `pipelineLiveSegmentAppended` füllen (`SherpaOnnx+SegmentBuffer.mm`), analog `if (!peek…)` Defaults. |
| **B — Annotation vor jedem Emit** | Jeder native Pfad, der ein Segment in den Live-Segmentbuffer schreibt, ruft **vor** dem Emit **`recordSegmentAnnotation`** (Android) bzw. die iOS-Annotation-Registry auf, sodass `peek` **nie** leer ist. Defaults entfallen im Emitter. | u. a. `appendLiveSegment` / Engine-Commit / interne Append-Helfer; Android `SegmentationEngineRegistry`; iOS `seg_engine_*` in `SherpaOnnx+SegmentBuffer.mm` + ggf. weitere Call-Sites. |

**Zusätzlich (Variante A oder B):**

| Schicht | Datei / Ort | Konkrete Aufgabe |
|---------|-------------|------------------|
| Audit | Android `SegmentationEngineRegistry.kt` + Engine-/Worker-Aufrufer | Liste aller Pfade, die Segmente erzeugen (`recordSegmentAnnotation`, Commit-Metas mit `__segmentReason`). Abgleich mit iOS (`seg_engine_peek_annotation` / Annotation-Liste im Engine-Struct). |
| Audit | `appendLiveSegment` TurboModule | Manueller JS-Append: stellt sicher, dass Wire-Defaults oder Annotation **vor** Emit greifen. |
| TS | `src/audiobuffer/index.ts` | Optional nach Native-Fix: Listener nur noch **validieren** (z. B. in Tests), dass `rawEvent.reason` / `rawEvent.source` gesetzt sind — **keine** Pflicht, Produktions-Defaults zu duplizieren, wenn Native verbindlich liefert. |
| Typen / Doku | `sub-01-segment-contract.md` oder öffentliche Segment-Doku | Ein Absatz: „`pipelineLiveSegmentAppended` liefert für Speech immer `reason`, `source`, `createdAtMs`“ + Verweis auf erlaubte Enum-Werte. |
| Tests | Neu oder erweitert unter `src/audiobuffer/__tests__/` (und ggf. native/instrumented später) | **Matrix** (mindestens): (1) manueller `appendLiveSegment` / `commitSegment`-Pfad, (2) Segmentation-Engine Auto-Commit (z. B. VAD/Energy, wenn im Repo abgedeckt), (3) Finalize-Flush-Segment mit `reason: 'finalize'`, jeweils **Android + iOS** oder mit gemocktem Wire zwei Plattform-Shapes. Erwartung: nach TS-Mapping identische `segment.reason` / `segment.source` / `createdAtMs`-Logik. |

### Follow-up (Checkliste)

- [x] Variante **A** oder **B** festlegen (Team-Notiz in diesem Dokument ergänzen): **Variante A** wurde gewählt (Fallback auf `manual_commit`/`manual`/`System.currentTimeMillis()` im Event-Emitter).
- [x] Native Android + iOS anpassen (siehe Tabelle).
- [x] Matrix-Tests ergänzen / bestehende Segment-Event-Tests erweitern.
- [x] `sub-01` oder User-Doku: ein Absatz Wire-Contract `pipelineLiveSegmentAppended` (Speech).
- [x] Nach Merge: Checkboxen abhaken und ggf. „Resolved“-Datum in Änderungshistorie.

---

## EC-05 — `payload` in `pipelineLiveSegmentAppended`: Android vs. iOS

### Festgestellt

- Android mappt JSON-Payload-Werte nur für **flache** primitive Typen in ein `WritableMap` (`SherpaOnnxModule.kt`, Emit `pipelineLiveSegmentAppended`).
- iOS nutzt `NSJSONSerialization` und kann **verschachtelte** Strukturen durchreichen (`SherpaOnnx+SegmentBuffer.mm`).

### Risiko

Cross-Platform-Apps sehen **unterschiedliche** `meta.payload`-Formen; verschachtelte Felder erscheinen auf Android **gar nicht** oder nur teilweise.

### Entscheidung (**accepted**)

Android **an iOS angleichen**: **rekursive** Abbildung `JSONObject` / `JSONArray` → React-Native **`WritableMap`** / **`WritableArray`**, auf Basis von **`org.json`** (bereits im Pfad) — **ohne** zusätzliche JSON-Bibliothek im SDK.

**Klassifikation:** `must-fix`  
**Entscheidungs-Status:** `accepted` (konkreter Plan in diesem Abschnitt; **Code noch nicht umgesetzt**)

### Abwägung: rekursive Konvertierung vs. externe JSON-Library

| Option | Kurzbeurteilung |
|--------|------------------|
| **A — Rekursiv mit `org.json.*` (empfohlen)** | Eine **private Hilfsfunktion** `JSONObject`/`JSONArray` → `WritableMap`/`WritableArray` deckt dieselben Fälle ab wie iOS mit `NSJSONSerialization` — typisch **unter ~80 Zeilen**, keine neue Gradle-Dependency, kein zusätzliches ProGuard-Thema. |
| **B — Externe Library (Gson, Moshi, kotlinx-serialization + `JsonElement`)** | Für **nur** „JSON-Baum nach RN-Brückentypen“ meist **Overkill**: geparstes Modell muss **trotzdem** nach `WritableMap`/`WritableArray` gewandert werden; zusätzlich neue `implementation` im SDK, transitive Auflösung in Host-Apps — lohnt eher bei **stack-weiter** JSON-Standardisierung (hier nicht gegeben). |

**Fazit:** Externe Library **vereinfacht die Robustheit kaum**; der Aufwand liegt im **rekursiven RN-Mapping**. **`org.json` + getestete Rekursion** ist die schlankste Variante.

### Umsetzung (konkret — geplant, noch nicht implementiert)

1. **Neue Hilfsfunktion (Kotlin)** — z. B. `android/src/main/java/com/sherpaonnx/segment/pipeline/SegmentPayloadJsonToReact.kt` (Name frei), `internal` / package-private:
   - `fun jsonObjectToWritableMap(obj: JSONObject): WritableMap`
   - Dispatcher für Werte: `JSONObject`, `JSONArray`, `String`, `Boolean`, Zahlen (`Int` / `Long` / `Double` — an iOS-`NSNumber`-Verhalten angleichen: ggf. Ganzzahl-Erkennung vs. `putDouble`).
   - **Rekursion:** verschachteltes Objekt → nested `WritableMap`; Array → `WritableArray` mit rekursiven Einträgen.
   - **`JSON.NULL` / null:** einmalig mit iOS-Fixture festlegen (Schlüssel weglassen vs. explizites Null), in Tests verankern.
   - **Fehler:** unparseable `payloadJson` → bestehendes Verhalten beibehalten (kein Crash des Emitters; `try/catch`, optional leeres `payload` / weglassen).

2. **Call-Site:** `SherpaOnnxModule.kt` — Block `if (!rec.payloadJson.isNullOrEmpty()) { … }` ersetzen: statt flacher `when`-Schleife Aufruf der Hilfsfunktion.

3. **Parität:** iOS-Pfad (`NSJSONSerialization` → `NSDictionary`/`NSArray` in `body[@"payload"]`) mit **demselben JSON-String** als Referenz (manuell oder Kotlin-JVM-Test nur für Konverter, falls ohne Android-Device-Test möglich).

4. **Tests (Minimum):**
   - Fixture: `{ "a": 1, "b": { "c": "x" }, "d": [1, { "e": true }] }` — erwartete Struktur nach JS wie bei iOS.
   - Regression: flaches Payload nur mit Primitiven bleibt gültig.

5. **Öffentliche Doku (optional):** ein Satz, dass `payload` auf Android und iOS **gleichermaßen** verschachteltes JSON abbilden kann.

6. **Nicht-Ziel:** iOS-Logik **nicht** ändern, solange Referenz-Parität stimmt; iOS nur anfassen, wenn das Referenzverhalten fachlich falsch ist.

### Follow-up (Checkliste)

- [x] Kotlin-Hilfsdatei + Integration `SherpaOnnxModule.kt`.
- [x] Tests (verschachtelt + flach).
- [ ] Optional: Satz in User-/Segment-Doku.
- [x] Nach Merge: Checkboxen abhaken und Änderungshistorie mit „Resolved“-Hinweis ergänzen.

---

## EC-06 — Finalize-Semantik: Live-Audio (`manual` vs. `auto`)

### Contract-Soll

Aus `sub-03-buffer-integration.md`:

1. `buffer.finalize()` ruft bei angehängter Engine `engine.flush()`.
2. Offene/uncommitted Audio-Frames werden als letztes Segment committed.
3. Das finale `onSegment` / `pipelineLiveSegmentAppended`-Event ist sichtbar.
4. Final-Segmente müssen eine deterministische Semantik haben, insbesondere **`reason: 'finalize'`**, außer eine Policy ist explizit als Checkpoint-Policy dokumentiert.
5. Android und iOS verhalten sich gleich.

### Audit-Findings (2026-05-01)

| Bereich | Ist-Zustand | Bewertung |
|---------|-------------|-----------|
| TS `manual` | `src/audiobuffer/index.ts` ruft vor `finalizeLiveAudioBuffer` `commitFinalizeSegmentIfNeeded()` **nur** für `segmentation.mode === 'manual'`. Es appendet den offenen Bereich in ein `LiveSegmentBuffer` und setzt danach per JS `annotateSpeechSegment(... reason: 'finalize', source: 'manual')`. | Final-Segment wird grundsätzlich erzeugt. **Risiko:** Native `appendLiveSegment` kann das Event bereits emittieren, bevor die JS-Annotation gesetzt ist. Dann sieht der User im Event möglicherweise Default `manual_commit` statt `finalize`. |
| Android `auto` | `LiveEntry.finalize_()` ruft `SegmentationEngineRegistry.onBufferFinalized(bufferId)`. Dort wird `engine.flush()` ausgeführt und danach detached. `SpeechEnergySegmentationEngine.flush()` appendet Rest-Samples mit `reason: 'finalize'`; `SpeechVadModelSegmentationEngine.flush()` verarbeitet Pending-VAD-Samples und appendet offene Speech mit `reason: 'finalize'`. | Final-Segment wird erzeugt, wenn offene Samples/Speech existieren. **Risiko:** Annotation wird in `appendSegment()` der Engine **nach** `LiveSegmentEntry.appendSegment()` gesetzt; das Segment-Appended-Event wird aber im SegmentBuffer-Append-Pfad bereits emittiert. Ergebnis: Wire kann `reason/source/createdAtMs` verpassen. |
| iOS `auto` | `PaLiveEntry::finalize_()` ruft `seg_engine_on_buffer_finalized(bufferId)`. Dort wird `seg_engine_flush_audio()` ausgeführt und danach detached. Energy/VAD-Fade-out existiert analog zu Android. | Grundsätzlich Plattform-Parität zum Android-Auto-Pfad. **Gleiches Risiko:** `seg_record_annotation_for_engine(...)` passiert nach `seg_live_append_segment(...)`; das Event kann vorher ohne Annotation emittiert werden. |
| `continuous_frames` | Android und iOS verwenden im Flush für `continuous_frames` aktuell `reason: 'policy_checkpoint'` statt `finalize`. | Plattform-paritätisch, aber gegen das generische Sub-03-Wording unscharf. Entscheidung nötig: entweder als explizite Policy-Ausnahme dokumentieren oder auf `finalize` umstellen. |

### Entscheidung (**accepted**)

1. **Finalize-Flush bleibt nativ für `auto`.** TS soll nicht zusätzlich versuchen, `auto`-Segments zu erzeugen; Native ist die Quelle für Engine-Zustand und offene Samples.
2. **`manual` bleibt TS-orchestriert**, weil dort keine SegmentationEngine attached sein muss; aber `reason: 'finalize'` darf nicht race-abhängig über eine nachträgliche JS-Annotation kommen.
3. **Event-Wire muss finalen Grund direkt enthalten:** Das Segment-Appended-Event muss bei Finalize-Segmenten **beim Emit** bereits `reason`, `source`, `createdAtMs` tragen. Das ist eng mit EC-04 verbunden; EC-06 konkretisiert die Finalize-Matrix.
4. **`continuous_frames` wird explizit entschieden:** Bevor Code geändert wird, festlegen:
   - Option A: `continuous_frames` Final-Rest bleibt `policy_checkpoint` und wird als Policy-Ausnahme dokumentiert.
   - Option B: Final-Rest wird auf `reason: 'finalize'` umgestellt, Checkpoints während laufendem Recording bleiben `policy_checkpoint`.

**Klassifikation:** `must-fix`  
**Entscheidungs-Status:** `accepted` (Audit abgeschlossen, Umsetzung offen)

### Umsetzung (konkret — geplant, noch nicht implementiert)

| Schicht | Datei / Ort | Konkrete Aufgabe |
|---------|-------------|------------------|
| TS manual | `src/audiobuffer/index.ts` (`commitFinalizeSegmentIfNeeded`) | Finalize-Annotation nicht erst **nach** dem Native-Append wirksam machen. Ziel: Event enthält deterministisch `reason: 'finalize'`, `source: 'manual'`, `createdAtMs`. Mögliche Umsetzung: Append-API/Payload/Meta so erweitern, dass Native beim Emit schon die Finalize-Metadaten hat, oder Event-Emit für diesen Pfad nach Annotation absichern. |
| Android auto | `SegmentationEngineRegistry.kt` + `LiveSegmentEntry.kt` / `SherpaOnnxModule.kt` | Engine-Annotation für Finalize-Segmente muss **vor** dem `pipelineLiveSegmentAppended`-Emit verfügbar sein. Sauberste Richtung: Append-Pfad akzeptiert Commit-Metadaten (`reason/source/createdAtMs`) oder Engine appendet über eine Helper-Funktion, die Record + Annotation atomar vor Event-Emit zusammenführt. |
| iOS auto | `SherpaOnnx+SegmentBuffer.mm` (`seg_append_speech_segment`, `seg_live_append_segment`, `seg_engine_flush_audio`) | Gleiche Reihenfolge wie Android: Annotation/Finalize-Meta vor Event-Emit. Keine Plattform-Sonderlogik. |
| Policy-Ausnahme | Android/iOS `continuous_frames` Flush | Entscheidung A/B treffen. Wenn A: Dokumentieren, dass Final-Rest bei `continuous_frames` ein letzter `policy_checkpoint` ist. Wenn B: Android+iOS auf `finalize` für Flush-Rest umstellen. |
| Tests | `src/audiobuffer/__tests__/segment-events.test.ts` + ggf. neue Segment/Engine-Fixtures | Matrix ergänzen: `manual + finalize`, `auto speech_energy_silence + finalize`, `auto speech_vad_model + finalize`, optional `continuous_frames`. Erwartung: finaler Event enthält erwartetes `reason`, `source`, `createdAtMs`, `totalSegments`, keine Doppel-Segmente. |
| Doku | `sub-03-buffer-integration.md` oder User-/Segment-Doku | Finalize-Kontrakt ergänzen: `manual` TS-orchestriert, `auto` native Engine-Flush; Event-Metadaten sind beim Emit vollständig. `continuous_frames`-Entscheidung dokumentieren. |

### Follow-up (Checkliste)

- [ ] Entscheidung für `continuous_frames`: Option A (`policy_checkpoint` dokumentieren) oder Option B (`finalize` bei Flush-Rest).
- [ ] EC-04/EC-06 gemeinsam implementieren: Annotation/Meta vor Event-Emit, Android + iOS.
- [ ] Manual-Finalize-Pfad so absichern, dass `reason: 'finalize'` nicht race-abhängig ist.
- [ ] Testmatrix ergänzen: manual / auto-energy / auto-vad / continuous_frames.
- [ ] Doku-Kontrakt für Finalize aktualisieren.
- [ ] Nach Merge: Checkboxen abhaken und Änderungshistorie mit „Resolved“-Hinweis ergänzen.

---

## EC-07 — Öffentliche Callback-API: Text ↔ Audio (Parität + `subscribeLiveTextBufferEvents`)

### Festgestellt (Ist)

- **Gemeinsam (bereits symmetrisch):** Sowohl **`createLiveTextBuffer`** als auch **`createEmptyLiveAudioBuffer`** akzeptieren **optionale Callbacks** in den Create-Optionen und liefern auf dem Ref eine Funktion **`unsubscribeEvents`**, die die bei Create registrierten Listener wieder abmeldet (intern nutzt Audio dafür ohnehin **`subscribeLiveAudioBufferEvents`**).
- **Asymmetrie:** **`subscribeLiveAudioBufferEvents(bufferId, callbacks)`** ist **öffentlich** exportiert — ermöglicht **nachträgliches** Subscriben, zweites Modul, Tests, mehrere unabhängige Registrierungen (pro Aufruf ein **`unsubscribe`**-Handle; Callbacks liegen in **Sets** pro Buffer-ID).
- **Live-Text:** Entspricht technisch dem Audio-Muster (**`registerLiveTextCallbacks`** = Set-basierte Registrierung + Rückgabe **`() => void`**), ist aber **nicht** als gleichnamige öffentliche **`subscribe…`**-API exportiert.

### Risiko (vorher)

Kein Laufzeit-Bug, aber **inkonsistente öffentliche Oberfläche**: Nutzerinnen, die nur die Audio-Doku kennen, erwarten auf Text-Seite vergeblich ein **`subscribeLive…`**-Pendant; umgekehrt fehlt die **explizite** Spät-Anbindung für Text.

### Zielbild (Soll)

1. **Primärer, dokumentierter Einstieg (beide Medien):** `create…({ …, onPartial|onFramesAppended, onSegment, onError })` → Ref mit **`unsubscribeEvents`** (ein Handle = alle bei Create übergebenen Callbacks dieses Aufrufs).
2. **Erweitert / explizit (beide Medien):** **`subscribeLiveTextBufferEvents`** spiegelt **`subscribeLiveAudioBufferEvents`** — gleiche Rolle: **nach** Erstellung subscriben, mehrere Listener, gezieltes Abmelden nur eines Bundles über den Rückgabewert von **`subscribe…`**.
3. **Semantik-Parität:** Mehrfach-Aufrufe von **`subscribe…`** pro Buffer-ID sind erlaubt; jedes zurückgegebene **`unsubscribe`** entfernt **nur** die beim jeweiligen Aufruf registrierten Funktionsreferenzen (analog Audio).

### Entscheidung (**accepted**)

- **Keine** dauerhafte „nur-Doku“-Asymmetrie mehr: **`subscribeLiveTextBufferEvents`** als **öffentliche** API ergänzen (Thin-Wrapper um die bestehende **`registerLiveTextCallbacks`**-Logik nach **`resolveLiveTextBufferId`**, analog **`subscribeLiveAudioBufferEvents`**).
- **`createLiveTextBuffer`** bleibt unverändert in der **Rolle** (Create + optionale Callbacks); Implementierung: weiterhin intern **`registerLiveTextCallbacks`** — kein zweites Subsystem, nur **Export + Namens-Spiegel** zu Audio.
- **`subscribeLiveAudioBufferEvents`** bleibt öffentlich (**Flexibilität** beibehalten); kein Entfernen der Audio-API zugunsten „nur Create“.

**Klassifikation:** `must-fix` (öffentliche SDK-Konsistenz vor Sub-06-/Release-Readiness).

**Entscheidungs-Status:** `accepted` (2026-05-01)

### Umsetzung (konkret)

| Schritt | Inhalt |
|---------|--------|
| 1 | **`src/textbuffer/index.ts`:** Neue exportierte Funktion **`subscribeLiveTextBufferEvents(liveBufferId: LiveTextBufferIdSource, callbacks: LiveTextBufferCallbacks): () => void`** — Body: `resolveLiveTextBufferId` + **`registerLiveTextCallbacks(id, callbacks)`** (keine Duplikation der Set-Logik). JSDoc: Parität zu **`subscribeLiveAudioBufferEvents`** (nachträgliches Subscriben, mehrere Listener, Rückgabe = Abmeldung nur dieses Bundles). |
| 2 | **`createLiveTextBuffer`:** unveränderte Semantik; optional im Kommentar vermerken, dass Create-Callbacks denselben Registry-Pfad wie **`subscribeLiveTextBufferEvents`** nutzen. |
| 3 | **Barrel-Export:** Sicherstellen, dass **`subscribeLiveTextBufferEvents`** aus dem Paket-Entry (z. B. **`src/index.ts`** / **`textbuffer`-Re-Exports**) exportiert wird — gleiche Sichtbarkeit wie **`subscribeLiveAudioBufferEvents`**. |
| 4 | **Typen:** **`LiveTextBufferCallbacks`** ist bereits zentral; ggf. **Alias-Typ** `LiveTextBufferEventSubscription` nur anlegen, wenn es der Lesbarkeit dient (optional, nicht zwingend). |
| 5 | **Tests (Jest):** Mindestens: (a) **`subscribeLiveTextBufferEvents`** nach **`createLiveTextBuffer`** ohne Create-Callbacks — Events kommen an; (b) zwei **`subscribe`**-Aufrufe, ein **`unsubscribe`** — nur der betroffene Listener hört auf; (c) Kombination Create-Callbacks + **`subscribe`** — beide empfangen, **`unsubscribeEvents`** auf dem Ref vs. **`subscribe`-Return** getrennt prüfen (analog zu Audio, falls dort Tests existieren — sonst neu für Text als Referenz). |
| 6 | **User-facing Doku / Quickstart:** Einheitliches Kapitel „Live-Buffer-Events“: **Standard = Create + `unsubscribeEvents`**; **Advanced = `subscribeLive…BufferEvents`** für Text **und** Audio. |
| 7 | **Example-App / interne Call-Sites:** Nur anpassen, wenn explizit von der neuen API profitiert (nicht zwingend); Regression = bestehende Create-Pfade unverändert grün. |

### Follow-up (Checkliste)

- [ ] `subscribeLiveTextBufferEvents` in **`src/textbuffer/index.ts`** implementieren + JSDoc.
- [ ] Paket-Exporte prüfen/ergänzen (`src/index.ts` o. Ä.).
- [ ] Jest-Abdeckung (s. Umsetzungstabelle Schritt 5).
- [ ] Öffentliche Buffer-/SDK-Doku: einheitliche **Zwei-Ebenen**-Story (Create vs. Subscribe) für Text **und** Audio.
- [ ] Nach Merge: Checkboxen abhaken; diese Tabelle (EC-07-Zeile) auf „Code umgesetzt“ / ggf. **Resolved**-Datum in der Änderungshistorie.

---

## EC-08 — Event-Namen: Text vs. Segmentbuffer (`*SegmentAppended`)

### Festgestellt

- **Live-Segmentbuffer (Speech/Alignment):** Native emittieren **`pipelineLiveSegmentAppended`** — bereits in EC-01 / EC-02 / EC-04 / EC-05 / EC-06 als Wire-Name verankert.
- **Live-Text-Buffer:** Native emittieren **`pipelineLiveTextSegment`** — gleiche Rolle „Segment committed / an Live-Pipeline angehängt“, aber **abweichender** Event-String und kein gemeinsames Namensmuster mit `…SegmentAppended`.
- **TS:** `src/textbuffer/index.ts` subscribed auf **`pipelineLiveTextSegment`**; `src/segmentbuffer/index.ts` auf **`pipelineLiveSegmentAppended`** — bewusst getrennte Listener-Ketten (unterschiedliche Payloads und Buffer-ID-Semantik).

### Risiko (vorher)

Support/Debug und Doku-Redundanz; vor Release noch ohne externes SDK-Breaking — **Cold/Clean-Cut-Zeitfenster** für eine einmalige Umbenennung.

### Entscheidung (**accepted** — Major Cut, kein Kompat-Layer)

**Einheitliche Namensfamilie:** Alle Native-Events, die ein **abgeschlossenes Live-Segment** melden, sollen den Suffix **`SegmentAppended`** tragen.

1. **`pipelineLiveSegmentAppended` bleibt unverändert** — Kanonischer Wire-Name für den **Live-Segmentbuffer** (Speech/Alignment). Keine Umbenennung dieses Strings (Abhängigkeiten EC-01–06).
2. **`pipelineLiveTextSegment` wird umbenannt in `pipelineLiveTextSegmentAppended`** — gleiches Muster wie oben, Präfix **`pipelineLiveText`** bleibt die eindeutige Domäne (Text-Live-Buffer vs. Audio-Segmentbuffer). **Kein** Zusammenlegen von Text- und Speech-Events unter **einem** gemeinsamen String (Payloads und Routing-Maps in TS bleiben getrennt; Vermeidung von Mehrdeutigkeit und Filter-Heuristiken in einem einzigen Listener).
3. **Kein** paralleles Ausliefern des alten Namens; keine Deprecation-Phase (Pre-Release).

**Klassifikation:** `must-fix` (Major Cut)

**Entscheidungs-Status:** `accepted` (2026-05-01)

### Umsetzung (konkret)

| Bereich | Dateien / Aktion |
|---------|------------------|
| **iOS — Emit** | `ios/textbuffer/bridge/SherpaOnnx+TextBuffer.mm`: `sendEventWithName:@"pipelineLiveTextSegment"` → **`@"pipelineLiveTextSegmentAppended"`** (alle Vorkommen). |
| **iOS — supported events** | `ios/SherpaOnnx.mm`: Array `supportedEvents` — **`pipelineLiveTextSegment`** entfernen, **`pipelineLiveTextSegmentAppended`** eintragen. |
| **Android — Emit** | `android/.../SherpaOnnxModule.kt`: `emit("pipelineLiveTextSegment", …)` → **`emit("pipelineLiveTextSegmentAppended", …)`**. |
| **Android — STT-Helfer** | `android/.../stt/facade/SherpaOnnxOnlineSttHelper.kt`: gleiche String-Änderung. |
| **TS — Listener** | `src/textbuffer/index.ts`: `addListener('pipelineLiveTextSegment', …)` → **`'pipelineLiveTextSegmentAppended'`**; Subscription-Variable/Kommentare konsistent benennen (z. B. `textSegmentSubscription`). |
| **TS — Typdoc / Spec** | `src/NativeSherpaOnnx.ts` und ggf. andere JSDoc-Stellen, die **`pipelineLiveTextSegment`** nennen → neuer Name. |
| **Tests** | `src/textbuffer/__tests__/segment-events.test.ts`: `emitEvent('pipelineLiveTextSegment', …)` → **`pipelineLiveTextSegmentAppended`**. |
| **Doku** | Repo-weit: `rg pipelineLiveTextSegment` — Migration- und Future-Work-Dokumente (z. B. `docs/future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md`), interne Buffer-Doku, Snapshots (`segmentation-engine-core-snapshot.md`), dieses Tracking-Dokument (Tabelle/Querverweise nur falls der alte String noch als „Ist“ stand). |
| **Verifikation** | `rg pipelineLiveTextSegment` muss **0 Treffer** im Produktcode liefern (Doku-Historie optional ausgenommen, wenn bewusst als Archiv — besser: überall aktualisieren). **`yarn tsc --noEmit`**, relevante Jest-Suites (`textbuffer`-Segment-Tests). |

### Follow-up (Checkliste)

- [x] iOS: Text-Buffer-Bridge + `supportedEvents`.
- [x] Android: `SherpaOnnxModule.kt` + `SherpaOnnxOnlineSttHelper.kt` (+ `rg` auf weitere Kotlin/Java-Emitter).
- [x] TS: `textbuffer/index.ts` + Tests + `NativeSherpaOnnx.ts`.
- [x] Doku / Future-Work: alle **`pipelineLiveTextSegment`**-Referenzen auf **`pipelineLiveTextSegmentAppended`**.
- [x] Nach Merge: Checkboxen abhaken; Übersichtstabelle EC-08 auf „Code umgesetzt“ / **Resolved**-Datum in der Änderungshistorie.

---

## Änderungshistorie

| Datum | Notiz |
|-------|--------|
| 2026-04-30 | Erstanlage aus Ist-/Soll-Diskussion Sub-06 WS2 (Event/Contract); alle Entscheidungen zunächst `draft`. |
| 2026-04-30 | **EC-01:** Entscheidung **accepted** — Major Cut: Wire `liveBufferId` in `pipelineLiveSegmentAppended` entfernen, kanonisch `segmentBufferId`; öffentliche TS-Typen + `segmentbuffer`-TS + Tests + Native Android/iOS konsistent (kein Kompat-Layer). Detaillierte Checkliste im EC-01-Abschnitt. |
| 2026-04-30 | **EC-02:** Entscheidung **accepted** + **Umsetzung**: Native `totalSegments` (= `segments.size` nach Commit); TS `audiobuffer` / `segmentbuffer` + Typ `LiveSegmentBufferSegmentAppendedEventBase`; Jest-Mock. Tabelle „Umsetzung“ im EC-02-Abschnitt. |
| 2026-04-30 | **EC-04:** Entscheidung **accepted**; konkreter Umsetzungsplan (Variante A/B, Dateien, Testmatrix, Doku) im EC-04-Abschnitt ergänzt — **ohne** Code-Implementierung in diesem Schritt. |
| 2026-04-30 | **EC-03:** auf **`deferred`** gesetzt; Detailplan und Checkliste nach `docs/future-work/segmentation-ec-03-live-text-segment-index-dedup-invariant.md` verschoben. |
| 2026-04-30 | **EC-05:** Plan vollständig im **EC-05-Abschnitt** (Abwägung + Umsetzung + Checkliste); aus `sub-06-cleanup-contract-parity.md` (ehem. §2c) hierher verlagert, wie EC-02/EC-04. |
| 2026-05-01 | **EC-06:** Audit abgeschlossen; `manual` und `auto` erzeugen grundsätzlich Final-Segmente, aber Event-Metadaten (`reason/source/createdAtMs`) sind wegen Annotation-after-emit nicht zuverlässig. EC-06 auf **`must-fix` / `accepted`** gesetzt, konkrete Umsetzung und Testmatrix im Abschnitt ergänzt. |
| 2026-05-01 | **EC-07:** Frühere **`acceptable-deviation` / `draft`**-Entscheidung verworfen. Stattdessen **`must-fix` / `accepted`**: öffentliche Parität durch **`subscribeLiveTextBufferEvents`** (Thin-Wrapper um bestehende Registry), einheitliche Zwei-Ebenen-Doku (Create + optional Subscribe) für Text und Audio; Umsetzungsplan und Checkliste im EC-07-Abschnitt. |
| 2026-05-01 | **EC-08:** Frühere „keine Umbenennung / Glossar“-Entscheidung verworfen. **`must-fix` / `accepted`**: Cold/Clean Cut — **`pipelineLiveTextSegment` → `pipelineLiveTextSegmentAppended`**; **`pipelineLiveSegmentAppended`** unverändert; Umsetzungsplan und Checkliste im EC-08-Abschnitt. |
| 2026-05-01 | **EC-08 (Umsetzung):** Umbenennung in iOS, Android, TS, Tests und Doku abgeschlossen. `rg` verifiziert (0 Treffer im Produktcode); Jest-Tests `segment-events.test.ts` erfolgreich. |
| 2026-05-01 | **EC-01 (Umsetzung):** Umbenennung von `liveBufferId` zu `segmentBufferId` für `pipelineLiveSegmentAppended` und `pipelineLiveSegmentError` in iOS, Android, TS, Tests und Doku abgeschlossen. |
| 2026-05-01 | **EC-04 (Umsetzung):** Variante A (Emit-Defaults) für Speech-Segmente (`reason`, `source`, `createdAtMs`) in iOS, Android und TS-Tests umgesetzt. |
| 2026-05-01 | **EC-05 (Umsetzung):** Rekursives JSON-Mapping (JSONObject/JSONArray -> WritableMap/WritableArray) für Android implementiert; Parität zu iOS hergestellt; Tests in `segment-events.test.ts` erweitert. |

---

## Nächste Schritte (Phase 7)

1. Maintainer-Review: jedes `draft` → `accepted` oder revidiert.
2. [x] **EC-01:** Implementierung gemäß Checkliste im Abschnitt EC-01 (Native → TS-Typen → `segmentbuffer`-Modul → Tests → Doku); danach die Checkboxen dort abhaken und ggf. „Resolved“-Datum ergänzen.
3. **EC-02:** Umsetzung siehe Abschnitt EC-02 (Code umgesetzt); verbleibende Mocks per `rg pipelineLiveSegmentAppended` prüfen.
4. [x] **EC-04:** Native Wire immer `reason` / `source` / `createdAtMs` (Variante A oder B laut Abschnitt EC-04) + Matrix-Tests + kurzer Doku-Absatz; danach EC-04-Follow-up-Checkboxen abhaken.
5. [x] **EC-05:** Umsetzung gemäß Abschnitt EC-05 (Kotlin-Rekursion + Tests); Checkboxen dort abhaken.
6. **EC-06:** Finalize-Metadaten vor Event-Emit absichern, `continuous_frames`-Entscheidung treffen, Manual/Auto-Testmatrix ergänzen.
7. **EC-07:** `subscribeLiveTextBufferEvents` implementieren, exportieren, Jest + öffentliche Doku (Zwei-Ebenen-Story mit Audio); Checkliste im EC-07-Abschnitt abhaken.
8. [x] **EC-08:** Wire- und TS-Umbenennung **`pipelineLiveTextSegment` → `pipelineLiveTextSegmentAppended`** (Android, iOS, TS, Tests, Doku); `rg pipelineLiveTextSegment` = 0 im Produktcode; Checkliste im EC-08-Abschnitt abhaken.
9. Für jedes übrige `must-fix`: Ticket + Tests + Doku-Anpassung.
10. Nach Umsetzung: diese Datei aktualisieren (Klassifikation, Status, ggf. „Resolved“-Datum).
