# Cursor-Prompt: Example-App README (`example/README.md`)

Kopiere den **Basis-Prompt** in den Chat und führe ihn im Repo **react-native-sherpa-onnx** aus.

---

## Basis-Prompt (kopieren)

```text
Überarbeite **`example/README.md`** im Repo react-native-sherpa-onnx.

**Kontext:** Die Example-App ist gewachsen und deckt fast alle SDK-Features ab (siehe `example/src/screens/home/HomeScreen.tsx`, Konstante `FEATURES`, plus **`Settings`**). Die aktuelle README ist noch das Standard-RN-Boilerplate — sie soll durch eine **echte Example-App-Dokumentation** ersetzt werden.

**Sprache:** **Englisch** (öffentliche README).

### Struktur (Pflicht)

1. **Titel & Einleitung**
   - Kurzer Titel (z. B. „Sherpa ONNX Example App“).
   - **Überblick (1–3 Absätze):** Wofür die App da ist (lokales Ausprobieren von STT/TTS, Pipelines, Buffers, Download-Manager, Alignment, …), Bezug zum Hauptpaket `react-native-sherpa-onnx` (Monorepo-`example/`), ohne Marketing-Floskeln.
   - Optional: Link zur **Root-README** (`../README.md`) und zum **SDK-Doku-Index** (`../docs/README.md` oder relevante Feature-Docs), wo sinnvoll.

2. **Run / Setup (kompakt)**
   - Behalte nur das **Nötigste** zum Bauen: aus `example/`: `yarn install`, `yarn start`, `yarn android` / `yarn ios` (und falls nötig kurz `bundle install` + `pod` für iOS wie heute in der README).
   - Entferne oder stark kürze generische RN-Boilerplate-Abschnitte („Modify your app“, „Congratulations“, „Learn More“-Wall-of-Links), sofern sie nicht für dieses Repo relevant sind.

3. **Feature-Screens — je Screen ein eigenes Kapitel**
   - Orientierung an der **Home-Liste** in `HomeScreen.tsx` (`FEATURES`) **und** dem Screen **Settings** (Zahnrad).
   - Für **jeden** Eintrag (implementiert oder „Coming Soon“) ein **`##`-Kapitel** mit **sprechendem englischen Titel** (z. B. „Speech-to-Text (offline)“, „Download manager showcase“, …).
   - Pro Kapitel:
     - **Screenshots:** Genau **drei** Bilder **nebeneinander** in **einer** Zeile. **Platzhalter:** für alle drei vorerst dieselbe Datei  
       `../docs/images/example_home_screen.png`  
       (relativ zur `example/README.md`). Gleiche Breite pro Bild (z. B. `width="240"` oder ~30 %), damit es auf GitHub lesbar bleibt.
     - **HTML-Layout:** Nutze ein schmales `<table>` mit einer Zeile und drei `<td>`, jeweils ein `<img>`, analog zur Darstellung in der Root-README — oder `<div align="center">` + Tabelle.
     - **Beschreibung unter den Bildern:** Was zeigt der Screen, welche **SDK-APIs/Pipelines** werden dort angetestet, welche **Modelle/Buffer** typischerweise vorkommen, Besonderheiten (Offline vs. Streaming, Live-Buffers, …).  
       Bei **Diarization** / **Separation**: klarstellen, dass der Eintrag in der App vorbereitet ist / „Coming Soon“, ohne historische SDK-Abkündigungen zu erfinden.
   - Reihenfolge der Kapitel: sinnvoll gruppiert oder **wie auf dem Home-Screen** (Download-Manager zuerst ist ok).

4. **Inhaltliche Abgleich**
   - Texte mit den **tatsächlichen** Screen-Zwecken abstimmen (kurz in den jeweiligen `*Screen.tsx` nachlesen, nicht raten).
   - Begriffe mit der **aktuellen SDK-Doku** konsistent halten (kein Verweis auf nicht existierende Doc-Dateien; z. B. nur `tts-streaming.md`, kein separates „incremental“-Dokument).
   - Keine Behauptungen über Features, die der Screen nicht bietet.

5. **Qualität**
   - Keine kaputten relativen Pfade (Screenshots, Links).
   - Am Ende der Session: kurze Liste der angelegten `##`-Kapitel.

Start.
```

---

## Referenz: Screens aus `HomeScreen.tsx` (`FEATURES`)

| Route / Screen | Titel in App (Kurz) |
|----------------|---------------------|
| `DownloadShowcase` | Downloadmanager |
| `STT` | Speech-to-Text |
| `TTS` | Text-to-Speech |
| `STTStreaming` | Speech-to-Text (Streaming) |
| `TTSStreaming` | Text-to-Speech (Streaming) |
| `PipelineShowcase` | Pipeline Showcase |
| `GenerateTimestamp` | Alignment (Subtitles/Timestamps) |
| `Enhancement` | Speech Enhancement |
| `EnhancementStreaming` | Speech Enhancement (Streaming) |
| `VAD` | Voice Activity Detection |
| `Punctuation` | Punctuation |
| `PunctuationStreaming` | Punctuation Streaming |
| `Diarization` | Speaker Diarization (Coming Soon) |
| `Separation` | Source Separation (Coming Soon) |
| *(Navigation)* | **Settings** |

---

## Revision log

| Date | Change |
|------|--------|
| (created) | Initial example README rework prompt |
