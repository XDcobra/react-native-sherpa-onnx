# Cursor-Prompt: Root-README aufräumen („Read before use“, Pipeline, Feature-Übersicht)

Kopiere den **Basis-Prompt** in den Chat und starte die Session.

---

## Basis-Prompt (kopieren)

```text
Arbeite im Repo react-native-sherpa-onnx an der **root README.md** (`README.md`).

**Ziel:** README klarer strukturieren, ohne Marketing-Fluff. Sprache: **Englisch** (wie der Rest der README). Halte dich an `.cursor/rules/sdk-documentation-structure.mdc` (Memory/OOM-Teaser, Links zu `docs/memory-and-models.md` und `docs/segmentation-engine.md` wo passend).

### 1) Neuer Abschnitt „Read before use“

- Füge einen gut sichtbaren Block **nach** der kurzen Produkt-Einleitung (nach dem Absatz über TurboModule / sherpa-onnx) und **vor** `## Installation` ein.
- Überschrift-Vorschlag: **`## Read before use`** (oder **Before you integrate** — wähle eine und nutze sie konsistent in der Table of contents).
- Inhalt (kurz, Stichpunkte, keine Romane):
  - On-Device-Modelle und **native RAM**; Peak-Nutzung; Link **[Memory and models](./docs/memory-and-models.md)**.
  - Viele starke Modelle sind **offline-first / offline-only**; sehr große Offline-Jobs können **OOM** riskieren.
  - **Segmentation engine** als Strategie für **gekapselte Offline-Segmente** / niedrigere Peak-RAM — Link **[Segmentation engine](./docs/segmentation-engine.md)** und ggf. Anker in memory-and-models (Segmentation/OOM-Abschnitt).
  - **`OFFLINE_OOM`:** kurz erwähnen, dass native Fehler diesen Code nutzen und die Meldung auf Streaming (wo verfügbar) und Segmentation-Doku verweist — ohne juristischen oder Marketing-Text.
- **Keine** historischen Hinweise auf entfernte APIs oder „früher gab es X“.

### 2) Example Apps: Video-App entfernen

- Entferne **vollständig** den Eintrag **„Video to Text Comparison App“**: Unterabschnitt, Screenshots, Repo-Link, alle zugehörigen Bilder-Referenzen in diesem Block.
- Aktualisiere die **Table of contents** (kein ToC-Eintrag mehr für Video-App).
- Die **Example App (Audio to Text)** bleibt; prüfe, ob der Fließtext noch konsistent ist.

### 3) „SDK pipeline logic“ überarbeiten

- Ersetze/ergänze den Abschnitt **`## SDK pipeline logic`** so, dass er zur **aktuellen** SDK-Struktur passt (Offline-Batch vs. Live-Pipeline, native Buffer, TurboModule).
- **Segmentation** an sinnvollen Stellen einbauen (nicht nur Marketing):
  - Offline: große Eingaben in **Segmente** teilen, Offline-Engine **pro Segment** — Verweis auf `docs/segmentation-engine.md` und den Memory-Guide.
  - Streaming: wo Segmentierung Engine-gesteuerte Grenzen liefert (kurz, ohne die Feature-Docs zu duplizieren).
- Mermaid-Diagramme **beibehalten oder anpassen**, wenn die alten Pfeile nicht mehr zur Realität passen; lieber ein einfacheres, korrektes Diagramm als ein falsches komplexes.

### 4) „Feature Support“-Tabelle ersetzen durch übersichtlichere Struktur

- Die **eine lange Tabelle** mit ~20 Zeilen soll weg.
- Ersetze sie durch eine **scanbare** Gliederung, z. B.:
  - **Speech & media features** — pro Bereich **STT**, **TTS**, **Enhancement**, **Punctuation**, **VAD**, **Alignment** jeweils **eine Zeile oder ein Satz** mit Links **Offline** · **Streaming** (nur was es wirklich gibt; Alignment nur offline laut Repo).
  - **Pipeline & buffers** — kompakte Liste: offline/live audio & text & segment buffers, audio session, ggf. file I/O — jeweils Doc-Link.
  - **Playback & utilities** — z. B. PCM player, execution providers, model setup, download manager, extraction — kurz gebündelt.
  - **Planned / not yet** — Diarization, Separation o. Ä. in einem kleinen Unterblock (Status wie heute).
- Optional: **sehr kleine** Hilfstabellen (max. 4–6 Zeilen) **pro Untergruppe**, wenn es die Lesbarkeit erhöht — aber **keine** monolithische Super-Tabelle.
- Alle Links gegen **existierende** Dateien unter `docs/` prüfen (keine toten `*.md`-Pfade).
- **Punctuation:** wenn Streaming-Doku existiert, beide Links setzen; sonst nur offline.

### Qualität

- Table of contents und Überschriften-Anchors konsistent halten.
- Keine neuen „wir haben X entfernt“-Sätze für nie veröffentlichte APIs.
- Am Ende: kurze Liste der geänderten README-Abschnitte.

Start.
```

---

## Revision log

| Date | Change |
|------|--------|
| (created) | Initial README rework prompt |
