# STT: Nur noch AudioBuffer als Eingabe — Umsetzungsplan

## Zielbild (Architektur)

**Ja — die Richtung ist konsistent mit dem Pipeline-Modell:**

- **STT** soll **keine** feature-spezifischen Eingabe-Shortcuts mehr anbieten (kein direkter Dateipfad, kein Rohtext-`number[]` in der STT-API).
- **Einheitliche Oberfläche:** Eingabe für Offline-STT ist ausschließlich ein **`off_…`-Handle** ([`OfflineAudioBuffer`](../../../src/audiobuffer/types.ts) / [`PipelineAudioRegistry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt) auf nativer Seite).
- **Features** (Enhancement, Konvertierung, I/O, …) **füllen oder transformieren** Buffer — sie sind **kein** Teil der STT-Methodensignatur, sondern Schritte **davor** oder **danach** in der Pipeline.

Beispiel-Pipeline (wie von dir skizziert):

```text
Datei → OfflineAudioBuffer₁ → Enhancement → OfflineAudioBuffer₂ → STT → Text
                                                              ↘
                                                        Alignment(Text, OfflineAudioBuffer₂)
```

- **Alignment** nach STT nutzt damit **denselben** PCM wie die Transkription (z. B. `OfflineAudioBuffer₂`) plus den **Text aus STT** — nicht eine an STT gekoppelte Spezial-API.

---

## Migrations-Policy: Breaking ist erlaubt

Umstellung **feature für feature** auf die **AudioBuffer-Pipeline**. Dazwischen ist es **in Ordnung**, wenn integrierte Features **brechen** oder vorübergehend **nicht** unterstützt werden — es wird **nicht** versucht, alte und neue Welt gleichzeitig vollständig zu bedienen.

- Sobald ein Feature (z. B. **Alignment**) auf die Pipeline umgestellt ist, ist es wieder **voll nutzbar** — bis dahin bewusst **hart umbrechen** statt Kompatibilitäts-Brücken.
- **Kein `sourceTag`** mehr an der STT-Transkription (weder TS, noch TurboModule, noch native Übergabe) — Parameter **entfernen**.

---

## Ist-Zustand (kurz)

| Bereich | Aktuell |
| --- | --- |
| **STT-Engine (TS)** [`SttEngine`](../../../src/stt/types.ts) | `transcribeFile`, `transcribeSamples`, `transcribeFromAudioBuffer` |
| **Native** | [`transcribeFile` / `transcribeSamples` / `transcribeFromAudioBuffer`](../../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt) (Android), analog iOS [`SherpaOnnx+STT.mm`](../../../ios/stt/bridge/SherpaOnnx+STT.mm) |
| **STT-Modul „Alignment Stage“** | [`alignSttResult`](../../../src/stt/index.ts), [`alignTextToBuffer`](../../../src/stt/index.ts), dazu Getter/Speichern/Release um `alignmentId` aus dem STT-Kontext |
| **Alignment allgemein** | Eigenes Paket [`react-native-sherpa-onnx/alignment`](../../../src/alignment/index.ts) (`alignTextToAudio`, …) — **getrennte** Produkt-API |

Doppelung: Transkription kann **Datei** oder **Buffer** direkt triggern; Alignment existiert **zweimal** (STT-gebunden vs. Alignment-Modul).

---

## Soll-Zustand

### 1. STT-Eingabe

- **Eine** Methode auf `SttEngine`: **`transcribe(bufferId: OfflineBufferHandle)`** — nur `bufferId`, **ohne** `sourceTag` oder andere Zusatzoptionen.
- **Entfernen:**
  - `transcribeFile` (kein `filePath` in STT)
  - `transcribeSamples`
  - `transcribeFromAudioBuffer` (redundant, sobald nur noch `off_…` erlaubt ist — die neue `transcribe` *ist* die Buffer-Transkription)

**Konsequenz für Aufrufer:**  
Wer bisher `transcribeFile(path)` nutzt: **`createOfflineAudioBufferFromFile(path, …)`** → **`transcribe(bufferId)`**.  
Wer `transcribeSamples` nutzt: **`createOfflineAudioBufferFromSamples`** → **`transcribe`**.

### 2. STT und Alignment entkoppeln

- **Entfernen** der **STT-spezifischen** Alignment-Stufe aus [`src/stt/index.ts`](../../../src/stt/index.ts):  
  `alignSttResult`, `alignTextToBuffer`, sowie die dazugehörigen Exporte/Hilfen (`getAlignmentSegments`, `saveAlignment`, `releaseAlignment`, …), die **nur** diesem Pfad dienen — ohne Rücksicht darauf, ob die allgemeine Alignment-API während der Umstellung noch alle Varianten anbietet.
- **Alignment** später ausschließlich über das **Alignment-Feature** und **Pipeline-Buffers** (z. B. `alignTextToAudio` mit **`off_…`**), sobald das Alignment-Paket migriert ist. **Bis dahin** darf Alignment-End-to-End **kaputt** sein; keine Pflicht, den alten STT-Alignment-Pfad am Leben zu halten.

Damit: **kein** `instanceId` + `resultId` + `bufferId` als Spezialweg in STT; stattdessen **klare Daten**: Text + Audio-Buffer.

### 3. Native / TurboModule

- **Reduktion** der STT-TurboModule-Methoden auf das Minimum: z. B. eine native **`transcribeFromPipelineOfflineBuffer(instanceId, bufferId)`** (intern unverändert sherpa `acceptWaveform` + `decode` aus [`OfflineEntry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/OfflineEntry.kt)).
- **`transcribeFile` / `transcribeSamples` / `transcribeFromAudioBuffer`** sowie **`sourceTag`** an der Transkriptions-Schnittstelle in [`NativeSherpaOnnx.ts`](../../../src/NativeSherpaOnnx.ts) und nativ **entfernen**; **Codegen** neu fahren.
- **Alignment:** Native Einträge, die **nur** den entfallenen STT-Alignment-Pfad bedienen (`alignSttResult`, …), **entfernen**. Was `alignTextToAudio` intern braucht, separat beim Alignment-Migrationsarbeitspaket klären — kein paralleles Alt-API-Feeding nötig.

### 4. Dokumentation & Example

- [`docs/stt-offline.md`](../../stt-offline.md): alle Beispiele **nur** `audiobuffer` + `transcribe(bufferId)`.
- [`example/`](../../../example/): `STTScreen` und andere — Umstellung auf Buffer-Erstellung vor STT.
- Verweise in [`README.md`](../../../README.md) / Streaming-Doku: klare Trennung „Buffer bauen“ vs. „STT aufrufen“.

---

## Phasen (Reihenfolge)

### Phase 1 — Schnittstelle festziehen

- Signatur: **`transcribe(bufferId: OfflineBufferHandle)`** — keine weiteren Parameter.
- Liste der zu löschenden TurboModule-Symbole (inkl. `sourceTag`) + Codegen-Lauf.
- Alignment-Migration (inkl. `AlignAudioInput` → `off_…`) als **eigenes** Arbeitspaket nach STT-Umstellung — darf bis zur Fertigstellung **brechen**.

### Phase 2 — TypeScript öffentliche STT-API

- [`src/stt/types.ts`](../../../src/stt/types.ts): `SttEngine` auf **`transcribe`** umstellen; alte Methoden entfernen.
- [`src/stt/index.ts`](../../../src/stt/index.ts): Engine-Implementierung; STT-Alignment-Block entfernen (siehe Soll 2).
- [`src/NativeSherpaOnnx.ts`](../../../src/NativeSherpaOnnx.ts): Spec bereinigen; **Codegen** neu fahren.

### Phase 3 — Native Android / iOS

- **STT:** eine Transkriptionsfunktion aus `PipelineAudioRegistry` / `OfflineEntry`; Entfernen der direkten Datei- und Sample-Pfade in [`SherpaOnnxSttHelper.kt`](../../../android/src/main/java/com/sherpaonnx/stt/facade/SherpaOnnxSttHelper.kt) und iOS-Äquivalent.
- **Alignment (STT-Pfad):** Aufräumen parallel zu Phase 2/4.

### Phase 4 — Alignment auf Pipeline (eigenes Feature, darf zwischendurch brechen)

- [`alignTextToAudio`](../../../src/alignment/alignTextToAudio.ts) / [`AlignAudioInput`](../../../src/alignment/types.ts) auf **`off_…`** (und ggf. nativ dieselbe Quelle wie STT) umbauen.
- Dokumentieren: empfohlener Weg **STT-Text + gleicher `off_…`** über **`alignment`**.
- Alte Pfade (nur STT-gebunden oder nur Pfad/PCM ohne Pipeline) **ohne** Kompatibilitätslayer entfernen, sobald nicht mehr nötig.

### Phase 5 — Tests, Beispiel-App, Doku

- Unit-/Integration: `transcribe` mit `off_…` (In-Memory + file-backed).
- End-to-End **STT + Alignment** erst wieder als Regression vorsehen, **wenn** Phase 4 erledigt ist; davor ist der Bruch **akzeptiert**.

---

## Hinweise

- **Mehr Boilerplate in Apps:** `transcribeFile`-Einzeiler wird Buffer anlegen + `transcribe` — **beabsichtigt**.
- **Features brechen zwischendurch:** z. B. volle Alignment-Kette erst wieder nach Alignment-Migration testen; kein Zwang zur Zwischen-Kompatibilität.
- **Streaming-STT** (Online): eigene API (`createStreamingSTT`, …); dieser Plan betrifft primär **Offline-STT** und die **Buffer-basierte** Offline-Kette.

---

## Erfolgskriterien

- `SttEngine` exponiert **genau eine** Offline-Transkriptionsmethode: **`transcribe(bufferId)`** — **ohne** `sourceTag`.
- Keine `transcribeFile` / `transcribeSamples` / `transcribeFromAudioBuffer` in öffentlicher STT-API und Spec.
- Keine STT-gebundene Alignment-API mehr; Alignment läuft über **`alignment`** + Buffer + Text aus STT.
- Doku und Example durchgängig im Pipeline-Stil.

---

## Verweise

- Buffer-Pipeline: [stt-audiobuffer-migration.md](./stt-audiobuffer-migration.md)
- Architektur Pipeline-Buffers: [audio_pipeline_buffers_7605bf7f.plan.md](../audio_pipeline_buffers_7605bf7f.plan.md)
