# E-Dokumente — Umsetzungsplan (einmal, vollständig)

> **Status:** Plan (nicht aus diesem File implementieren, bis der Auftrag kommt)
> **Modul:** `react-native-sherpa-onnx/document` (`src/document/`)
> **Ersetzt:** den Phase-3-Hinweis in [`.cursor/plans/ocr_imagebuffer_plan_184e0b27.plan.md`](../../.cursor/plans/ocr_imagebuffer_plan_184e0b27.plan.md)
> **Vorbild-API:** [`docs/pdf-offline.md`](../pdf-offline.md) — Extract schreibt nie OCR; Bilder sind ein zweiter, expliziter Schritt
> **Android first.** Log-Tag `[SherpaOnnx:doc]`. `__DEV__` / bestehende Native-Debug-Flags.

Ziel ist **Text für TTS und Weiterverarbeitung**, nicht ein Ebook-Reader. Fließtext landet im TextBuffer, weil er schon Markup ist. ImageBuffer und OCR nur dort, wo der Inhalt wirklich Pixel ist (CBZ/CBR, bild-only Spine). Keine Seitenvorschau von Reflow.

Ein Ship, keine Produkt-v1/v2. Phasen unten = interne Bau-Reihenfolge. **Erster Merge = A–C + Docs.** MOBI = D danach. Example-App = E, nicht in diesem Ship.

---

## 0  Festgehaltene Entscheidungen (nicht wieder öffnen)

| # | Entscheidung |
|---|---|
| D1 | Wo Markup-Text existiert, **kein OCR**. OCR ist nur Fallback für Pixel — wie PDF. |
| D2 | Fließtext → **TextBuffer** (`origin: 'markup'`). Keine Layout-Engine, WebView, Print, SDK-Seitenraster. |
| D3 | **Zwei Public-Funktionen**, ein Buffer-Typ pro Call: `extractDocumentText` → TextBuffer; `extractDocumentImages` → ImageBuffer. |
| D4 | `extractDocumentText` führt **nie** OCR aus. Gemischte Bücher: Metadaten `imageOnlySections`; der User orchestriert `extractDocumentImages` + `recognize`. |
| D5 | `extractDocumentImages` hat **eine** Bedeutung: CBZ/CBR = alle Seiten; EPUB/FB2/MOBI = nur Abschnitte **ohne** extractierbaren Text. Kein Cover, keine Kapitel-`<img>`, kein `sections: 'all' \| 'imageOnly' \| ids`. |
| D6 | Keine Pixel-Quads auf Markup-Spans. `sectionIndex` + optional `href`. Kein `blockKind`. |
| D7 | Kein neues Prebuilt, kein Copyleft (kein MuPDF/AGPL, Poppler/GPL, Okular, libmobi/LGPL). libarchive Default an; Disable → `ERR_DOC_ARCHIVE_DISABLED`. |
| D8 | Kein Extra-Enable-Flag analog PDFium. Kein `isLibarchiveEnabled()`. |
| D9 | DRM, KFX, AZW4, Topaz, DjVu, CHM, Office, TXT, lose HTML, PDF: **nicht** dieses Modul. PDF bleibt [`pdf/`](../pdf-offline.md). TXT → `createOfflineTextBufferFromText`. CBR **doch**: gleicher Pixel-Pfad wie CBZ, Decoder steckt schon in libarchive (kein neues `.so`). |
| D10 | Kein Reader, kein Reflow-Preview-Widget. Die App zeigt den TextBuffer-String; FrameView nur nach `extractDocumentImages`. Example-App ist **nicht** Teil dieses Ships. |
| D11 | Kein öffentliches `detectDocumentFormat`. Sniff intern in den beiden Extract-Calls. `format` steht auf dem Result. |
| D12 | Kein `interleaveDocumentText`, kein Document-Pipeline-Orchestrator. Lesereihenfolge mixed = App, zehn Zeilen. |
| D13 | `textOut` **Pflicht**, wie PDF: leerer Offline-TextBuffer. Kein intern anlegen. `result.buffer` ist derselbe Handle. |
| D14 | Ein Markup-Span **pro Block-Element** (`p`, `h1`–`h6`, `li`, `blockquote`, `pre`, `td`), nicht pro Spine-Item. Dasselbe `sectionIndex` (+ `href`) auf jedem Span des Abschnitts. |
| D15 | Image-only = sichtbarer DOM-Text leer oder nur Whitespace nach Drop von `script` / `style` / `head` / `template`. **`alt` / `title` / `aria` zählen nicht als Text.** Kein CSS (`display:none` kommt mit). EPUB `linear="no"` überspringen. |
| D16 | CBZ/CBR: **Natural Sort** über den Archivpfad (nicht Roh-Archivreihenfolge). Non-Images (`ComicInfo.xml`, Thumbs, `.`-Dateien) skippen. `pageNumber` = 1-basierter Anzeigeindex **nach** Sort. |
| D17 | Undekodierbare Frames (WebP ohne libwebp, SVG, HEIC-Fail, unbekannter Codec) **skippen** und loggen. 0 Frames danach → `ERR_DOC_NO_IMAGES`. Kein neues Error-Code, kein erzwungenes libwebp. |
| D18 | HTML: **lexbor** (HTML only, kein CSS). XML: pugixml. MOBI-v1 (Phase D): PalmDOC + HUFF/CDIC + KF8-HTML; kein Audio, kein Dictionary, kein Index. |
| D19 | **Kein Archiv-Temp.** Seekable Handle Pflicht. `FileIOResolver.ReadHandle` über den Extract halten und in `finally` schließen. Path / iOS security-scoped Datei → `archive_read_open_filename`. Android `contentUri` mit PFD → `archive_read_open_fd`. Kein `resolveSourceToFilePath`, kein `readBytes` des ganzen Archivs. Nur-Stream / nicht-seekable `apkAsset` → **`ERR_DOC_OPEN_FAILED`** (kein Callback-/RAM-Trostpfad). Limits → `ERR_DOC_OPEN_FAILED`: **10 000** Einträge, **64 MiB** einzelne Datei, **512 MiB** unkomprimiert gesamt. Font-only `encryption.xml` ≠ DRM; Content-Encryption = `ERR_DOC_DRM`. |
| D20 | **Keine halben Fallbacks, damit es „irgendwie geht“.** Ein I/O-Pfad, sonst die bestehenden Error-Codes. Verboten: Temp-Kopie, ganzes File in RAM, `zip_streamable` wenn Seek fehlt, zweiter Loader nach Fehlschlag. D17 (einzelne undekodierbare **Frames** skippen) bleibt Content-Regel, kein I/O-Fallback. Dieselbe Regel gilt für PDFium im Follow-up nach diesem Plan. |

### Verworfen (Absicht, nicht „später“)

| Ansatz | Warum nicht |
|---|---|
| MuPDF / crengine / Okular / Poppler / Readium | Copyleft oder falsche Schicht (Reader, nicht Buffer). |
| Eigene MIT-Paginator-Lib, litehtml, WebView ± Print | Layout-Produkt; App will den Text, kein Fake-Bild. |
| StaticLayout / TextKit-Seiten | Koordinaten auf *unseren* Seiten. TTS braucht UTF-16-Bereiche. |
| Calibre/WeasyPrint im Prozess | Nicht mobil / GPL. Convert außerhalb → dann `pdf/`. |
| Cover + alle Illustrationen als ImageBuffer | Reader-Vorschau, nicht TTS. Pfade/SVG/CSS unnötig komplex. |
| PDF-Delegation aus `document/` | Zweites Fehlermodell + PDFium-Opt-in in einem Modul, das keine Engine ist. |
| TXT / lose HTML als E-Doc | Kein Container; bestehende TextBuffer-APIs. |
| gumbo | Unmaintained; lexbor ist die HTML-Wahl (D18). |
| `isLibarchiveEnabled()` | libarchive ist Default-an; Disable reicht als `ERR_DOC_ARCHIVE_DISABLED` (D8). |
| Internen TextBuffer anlegen | Ownership unklar; PDF verlangt `textOut` ebenfalls (D13). |
| Archiv nach Cache kopieren (`resolveSourceToFilePath`) | Crash hinterlässt Dateien; PDF macht das heute — nach diesem Plan am PDF nachziehen, Document nicht nachbauen. |
| Nur-Stream / ganzes Archiv in RAM / `zip_streamable` als Trost | Halber Fallback (D20). Ohne Seek → `ERR_DOC_OPEN_FAILED`. |

---

## 1  Formate

Sniff über **Datei-Signatur / Container**, nicht über die Endung. Intern, nicht als Public-API.

### 1.1 Unterstützt

| Format | `extractDocumentText` | `extractDocumentImages` |
|---|---|---|
| EPUB 2 / 3 reflow | Spine-XHTML, Lesereihenfolge, `linear="no"` skip; Scripts strippen, nicht ausführen | nur Spine-Items **ohne** Text (Scan/Bild-only) |
| EPUB 3 FXL | XHTML-Text, falls vorhanden | Seiten **ohne** Text (Vollseiten-Grafik) |
| FB2, FB2.ZIP / FBZ | XML-Text in Dokumentreihenfolge; `format: 'fb2'` auch bei `.zip`/`.fbz` | nur `<binary>`-Abschnitte ohne begleitenden Text, analog image-only |
| MOBI / PRC / AZW / AZW3 (KF8), PalmDOC-PDB, **ohne DRM** | dekomprimiertes Markup (Phase D) | nur Parts ohne Text |
| CBZ | `ERR_DOC_NO_TEXT` | ZIP, eine Bilddatei = ein Frame, Natural Sort über Archivpfad |
| CBR | `ERR_DOC_NO_TEXT` | wie CBZ, Container RAR/RAR5 über dasselbe libarchive |

Reines Text-EPUB: Text-Extract Erfolg, `imageOnlySections = []`. `extractDocumentImages` → `ERR_DOC_NO_IMAGES`.

Reines CBZ/CBR / Scan-EPUB: Text-Extract → `ERR_DOC_NO_TEXT`. Images Erfolg (nach Skip undekodierbarer Dateien, D17).

Gemischtes EPUB: Text-Extract Erfolg + `imageOnlySections.length > 0`. Images = genau diese Abschnitte, `sectionIndex` an den Frames.

`sectionCount` / `sections` = nur die Items der Lesereihenfolge (`linear="yes"` bzw. fehlendes Attribut). `imageOnlySections` ist eine Teilmenge davon.

### 1.2 Nicht unterstützt (harter Fehler)

| Format | Code |
|---|---|
| DRM-EPUB (Content in `encryption.xml`), Kindle-DRM, verschlüsseltes / passwortgeschütztes RAR oder ZIP | `ERR_DOC_DRM` |
| KFX, AZW4, Topaz, DjVu, CHM, DOC/DOCX, XPS, PDF, TXT, HTML-Datei, unbekannt, PDB das kein MOBI/PalmDOC-Buch ist | `ERR_DOC_UNSUPPORTED_FORMAT` |
| Kaputter Container, RAR-Filter den libarchive nicht kann, nicht-seekable Source, Limits (D19) | `ERR_DOC_OPEN_FAILED` |

Kindle **ohne** DRM = Text-Extract (D1), nicht OCR.

Font-Obfuscation und font-only `encryption.xml`: ignorieren, Text trotzdem extrahieren. Nur verschlüsselte Content-Dokumente → `ERR_DOC_DRM`.

FB2-`<binary>`: nur dann ImageBuffer, wenn der Abschnitt sonst keinen Text hat (gleiche Regel wie EPUB-Spine). Dekorative Bilder in einem Textabsatz werden **nicht** geharvestet.

---

## 2  Public API

Export `./document` in `package.json`. Analog `src/pdf/`, schmaler.

```ts
extractDocumentText(source, textOut, options?): Promise<ExtractDocumentTextResult>
extractDocumentImages(source, options?): Promise<ExtractDocumentImagesResult>
```

`source`: `FileSource`, wie PDF (kein `fromBytes` in diesem Ship).

`textOut`: **Pflicht**, leerer Offline-TextBuffer (D13). `recognize` unverändert (Image in, leerer Text out).

`options` nur das Übliche: `signal`, `onProgress`, bei Images zusätzlich `maxSide` (Decode-Cap wie ImageBuffer). Kein `sections`-Selektor, kein lazy-lru-Sonderweg (bestehende ImageBuffer-Strategie nur nutzen, wenn der Decode-Pfad sie schon hat — nicht neu erfinden).

Progress-Phasen analog PDF, z. B. `open` / `section` bzw. `entry` / `decode` / `done`. `done`/`total` = Kapitel- bzw. Archiv-Index.

### 2.1 Text

```ts
interface DocumentSectionInfo {
  sectionIndex: number; // 0-based Lesereihenfolge
  href?: string;        // EPUB-Pfad / FB2-id / MOBI-part
  kind: 'text' | 'image';
}

interface ExtractDocumentTextResult {
  buffer: OfflineTextBufferHandle; // === textOut
  format: 'epub' | 'fb2' | 'mobi';
  sectionCount: number;
  sections: DocumentSectionInfo[];
  imageOnlySections: DocumentSectionInfo[]; // kind === 'image'
  spatialSpanCount: number;
}
```

- `ERR_DOC_NO_TEXT` — **ganzes** Dokument ohne Markup-Text (CBZ/CBR, reiner Scan).
- Gemischtes EPUB ist **kein** Fehler.

Markup-Spans (`origin: 'markup'`), **ein Span pro Block** (D14):

| Feld | Inhalt |
|---|---|
| `utf16Start` / `utf16End` | Bereich im Buffer |
| `level` | `'block'` |
| `origin` | `'markup'` |
| `sectionIndex` | Lesereihenfolge des Spine-/FB2-/MOBI-Items |
| `href` | EPUB-Pfad / FB2-id / MOBI-part, wenn vorhanden |
| `sourceImageBufferId` | leer |
| `quad` | Schema bleibt Pflicht: **Null-Quad** `(0,0,…,0)`. AnnotatedView zeichnet `markup` nicht |
| `frameIndex` | `0` |
| `blockKind` | **nicht** hinzufügen |
| `pageNumber` | ungenutzt |

Text-Extrakt (TTS):

- Block-Elemente → `\n\n` dazwischen; `<br>` → `\n`; Inline mit Space.
- Ruby: nur `rb`; `rt` / `rp` droppen.
- `script`, Event-Handler, `javascript:`, `style`, `head`, `template` droppen.
- Kein CSS. Tokens / Timestamps bleiben leer (wie PDF-Textlayer).

Image-only (D15): nach den Drops ist der sichtbare Text leer oder Whitespace. `alt` / `title` / `aria` machen aus einem Scan-Kapitel **kein** Markup.

### 2.2 Bilder

```ts
interface ExtractDocumentImagesResult {
  buffer: OfflineImageBufferHandle;
  format: 'epub' | 'fb2' | 'mobi' | 'cbz' | 'cbr';
  frameCount: number;
}

// ImageFrameInfo, optional:
//   sectionIndex, href
//   pageNumber nur bei CBZ/CBR (1-based Anzeigeindex nach Natural Sort)
```

| Input | Frames |
|---|---|
| CBZ / CBR | Bilddateien im Archiv, Natural Sort, Non-Images und Decode-Fails skip (D16, D17) |
| EPUB/FB2/MOBI mit image-only Abschnitten | genau die, Reihenfolge = `sectionIndex` |
| reines Text-Dokument | `ERR_DOC_NO_IMAGES` |

Unabhängig vom Text-Call: man muss nicht erst `ERR_DOC_NO_TEXT` abfangen. Nach einem erfolgreichen Text-Extract mit leerem `imageOnlySections` ist Images trotzdem `ERR_DOC_NO_IMAGES`.

`href` bei CBZ/CBR = Archivpfad der Datei.

### 2.3 Gemischte Bücher (App, nicht SDK-Produkt)

```ts
const text = await extractDocumentText(src, textOut);
if (text.imageOnlySections.length > 0) {
  const images = await extractDocumentImages(src);
  const ocrOut = await createEmptyOfflineTextBuffer();
  await ocr.recognize(images, ocrOut);
  // TTS: Markup- und OCR-Slices in sectionIndex-Reihenfolge in der App zusammenziehen
}
```

Frames tragen `sectionIndex`, damit die App OCR-Seiten den Lücken zuordnen kann. Overlay nur auf dem OCR-Buffer + ImageBuffer. Kein natives Merge, kein SDK-Helfer.

### 2.4 Fehlercodes

| Code | Wann |
|---|---|
| `ERR_DOC_ARCHIVE_DISABLED` | libarchive aus, Format braucht ZIP/RAR |
| `ERR_DOC_UNSUPPORTED_FORMAT` | D9 / unbekannter Container |
| `ERR_DOC_DRM` | Content-Verschlüsselung erkannt |
| `ERR_DOC_OPEN_FAILED` | unlesbar, nicht-seekable Source, Zip-Bombe, Limits (D19) |
| `ERR_DOC_NO_TEXT` | kein Markup im ganzen Dokument |
| `ERR_DOC_NO_IMAGES` | keine image-only Abschnitte / kein dekodierbares Bild |
| `ERR_DOC_INVALID_ARGUMENT` | Source / schon befüllter oder fehlender textOut |
| `ERR_DOC_CANCELLED` | AbortSignal |
| `ERR_DOC_PARSE_FAILED` | OPF/XHTML/FB2/MOBI kaputt |

---

## 3  Anzeige (kein Reader)

| Inhalt | Wer zeigt was |
|---|---|
| Fließtext | App: `getOfflineTextBufferTextSlice`, TTS-Cursor über UTF-16-Spans |
| CBZ / CBR / image-only Frames | `OfflineImageBufferFrameView`; nach OCR `OfflineImageBufferAnnotatedView` (`origin: 'ocr'`) |
| `origin: 'markup'` | keine Quad-Box (`mapTextSpatialSpansToFrame` skippt `markup` bereits) |

Kein `OfflineTextBufferView` in diesem Plan. Kein Cover-Carousel. Example-Screen = Phase E, nicht DoD dieses Ships.

---

## 4  Lizenzen und Abhängigkeiten

| Schicht | Wahl | SPDX |
|---|---|---|
| ZIP / RAR / RAR5 (EPUB, CBZ, CBR, FBZ) | bestehendes libarchive **3.8.10-1** (`ENABLE_ZLIB=ON`); Document-Reader ruft `archive_read_support_format_zip` plus `…_rar` / `…_rar5` auf — **nicht** `format_all`. Der Download-Helper bleibt tar-only. RAR-Codec ist schon in `libarchive/CMakeLists.txt` kompiliert, kein `ENABLE_RAR`, kein unrar. | BSD |
| XML (container.xml, OPF, NCX, FB2) | pugixml, vendored | MIT |
| HTML5 (kaputtes XHTML) | **lexbor**, nur HTML-Parser (kein CSS) | Apache-2 |
| MOBI PalmDOC / HUFF/CDIC / KF8-HTML | eigene C++-Umsetzung, Logik angelehnt an foliate-js `mobi.js`; v1-Subset D18 | MIT; `THIRD_PARTY_LICENSES` |
| cp1252/cp1251 | eigene Tabellen | — |
| Bilder | bestehender ImageDecoder | wie ImageBuffer |

Nicht vendorn: libmobi, FriBidi, MuPDF, crengine, litehtml, gumbo.

---

## 5  Robustheit

- Archive nicht auf Platte explodieren und **nicht** als Zip-Kopie im Cache materialisieren (D19). Ohne Seekable Handle: Fehler, kein zweiter Weg (D20).
- Limits: 10 000 Einträge, 64 MiB/Datei, 512 MiB unkomprimiert Summe → `ERR_DOC_OPEN_FAILED`.
- XML ohne XXE (pugixml: keine File-Entities).
- `<script>`, Event-Handler, `javascript:` droppen.
- Font-Obfuscation ignorieren (Fonts werden nicht geladen).
- Progress/Cancel analog PDF (Kapitel- bzw. Archiv-Index).
- Host-Tests: kleine **synthetische** Fixtures im Repo (EPUB mit Spine, image-only Item, FB2, CBZ inkl. `page2`/`page10`, CBR RAR3). Optional ein kleines Public-Domain-Sample, keine Verlagsbücher, nichts Großes. MOBI-Fixtures erst in Phase D.
- Fuzz der Parser in `test/cpp`.

Logs: Format, Spine-Länge, Skip-Grund (DRM, `linear=no`, leeres XHTML, Decode-Fail, Non-Image), `imageOnlySections.length`, Limits.

---

## 6  Bau-Reihenfolge

Dieselbe Public-Signatur von Anfang an (`textOut` Pflicht).

### A — Vertrag

- `src/document/types.ts`, Error-Codes. Kein `detectDocumentFormat`-Export. Kein `isLibarchiveEnabled()`.
- `TextSpatialSpan`: optionales `sectionIndex`, `href`. Kein `blockKind`.
- `ImageFrameInfo`: optionales `sectionIndex`, `href` (CBZ/CBR: `pageNumber` nach Sort).
- AnnotatedView: Boxen nur `ocr` \| `textLayer` (ist schon so).
- Jest: Typen, Error-Mapping.

### B — EPUB + FB2 Text

- C++ `document/` (Android/iOS geteilt): libarchive zip+rar+rar5, OPF-Spine, XHTML→Text, FB2-XML.
- pugixml + **lexbor**.
- `extractDocumentText` Bridge + TS.
- Host-Tests: EPUB, FB2, gemischtes Spine-Item → `imageOnlySections`; `linear="no"` fehlt in `sections`.

### C — Bilder

- `extractDocumentImages`: CBZ- und CBR-Frames (Natural Sort); EPUB/FB2 nur image-only Abschnitte. Decode über ImageRegistry + `maxSide`.
- Frame-Metadaten `sectionIndex` / `href` / `pageNumber`.
- `ERR_DOC_NO_IMAGES` auf reinem Text-EPUB und nach Skip aller undekodierbaren Dateien.
- Kein Cover-Harvest.

**Erster Merge nach C + Docs (unten, ohne Example).**

### D — MOBI/KF8 ohne DRM (nach A–C)

- Eigener Decoder, v1-Subset D18. DRM → `ERR_DOC_DRM`. AZW4/Topaz → `ERR_DOC_UNSUPPORTED_FORMAT`.
- Host-Tests: öffentliches MOBI + AZW3.

### E — Example (nicht dieses Ship)

- Example: Text-EPUB → Text + TTS. CBZ/CBR → Frames + OCR. Gemischtes EPUB → beide Calls, Concat in der Screen-Logik.
- Separater Auftrag.

### Docs (mit erstem Merge, nicht E)

- `docs/document-offline.md` analog `pdf-offline.md`. See-also in `ocr-offline.md`, `imagebuffer-offline.md`, `feature-pipelines.md`, `textbuffer-offline.md`.
- `THIRD_PARTY_LICENSES` (pugixml, lexbor, foliate-js-Hinweis sobald D).
- `docs/disable-libarchive.md`: Document-APIs brauchen libarchive.

---

## 7  Pipeline

```
FileSource
  ├─ extractDocumentText ──► OfflineTextBuffer (markup) ──► Punct / TTS / Alignment
  └─ extractDocumentImages ──► OfflineImageBuffer ──► createOCR().recognize ──► OfflineTextBuffer (ocr)
                                      └── FrameView / AnnotatedView (nur diese Frames)
```

Document-Modul = Source-Adapter wie `pdf`, kein drittes Recognize, keine Engine.

---

## 8  Vor der ersten Code-Zeile

Erledigt, nicht wieder prüfen:

1. AnnotatedView ignoriert `markup` (`mapToFrame.ts`).
2. `quad` in der TurboModule nicht optional.
3. libarchive 3.8.10-1: ZIP/Deflate (`ENABLE_ZLIB=ON`) plus RAR/RAR5 in den Prebuilds. Helper für Modelle bleibt tar-only. Document-Pfad aktiviert zip+rar+rar5.
4. HTML-Parser = lexbor (D18).

Keine offenen Produktpunkte mehr. Implementierung startet erst mit explizitem Auftrag, Phase A.

---

## 9  Out of scope

- Layout, WebView, Print, litehtml, MuPDF, Readium, CSS.
- Pixel-Koordinaten auf Reflow; Cover; Illustration-Harvest.
- Öffentliches Detect; PDF/TXT/HTML in diesem Modul.
- `interleaveDocumentText`; Auto-OCR; natives TextBuffer-Merge.
- KFX, AZW4, Topaz, DRM-Lesen, DjVu, Office. `archive_read_support_format_all` (ISO/CAB/…).
- Neues Enable-Flag; `isLibarchiveEnabled()`.
- Example-App (Phase E), VoiceLab — außer separater Auftrag.
- MOBI Audio / Dictionary / Index; `fromBytes` als Source.
- `resolveSourceToFilePath` / ganze Archiv-Temp-Kopie / Stream-Trostpfad für Document (D20).
- PDF-I/O-Umbau **in diesem Ship** — kommt **danach** (siehe §10 Später).

---

## 10  Definition of Done

### Erster Merge (A–C + Docs)

- EPUB 2/3, FB2/FBZ, CBZ, CBR auf Android (iOS: selber C++).
- Text-EPUB → TextBuffer, Spans pro Block, `linear="no"` skip.
- CBZ/CBR → `ERR_DOC_NO_TEXT` → Images (Natural Sort) → OCR-fähig (kein Example).
- Gemischtes EPUB → Text + `imageOnlySections` → Images; kein SDK-Concat.
- Reines Text-EPUB → `extractDocumentImages` = `ERR_DOC_NO_IMAGES`.
- DRM/KFX/AZW4/PDF → `UNSUPPORTED` oder `DRM`.
- Keine neue `.so`. Lizenzen in `THIRD_PARTY_LICENSES`.
- Host-Tests + Jest analog `src/pdf/__tests__/offline-api.test.ts`.
- Public Docs `document-offline.md`.
- **Kein** Example-Screen.

### Später

- Phase D: MOBI/AZW3 ohne DRM (Subset D18).
- Phase E: Example (Text-EPUB TTS, CBZ/CBR OCR, mixed Concat in der Screen-Logik).
- **Nach Fertigstellung dieses Plans:** PDF-I/O auf denselben Contract wie D19/D20. Heute: Android `resolveSourceToFilePath` + `readBytes` → `FPDF_LoadMemDocument`; `lazy-lru` kopiert die Bytes noch einmal. Soll: seekable Path → `FPDF_LoadDocument`; PFD → `FPDF_LoadCustomDocument` / `pread` (Handle bis `releaseOfflineImageBuffer` halten); nicht-seekable → `ERR_PDF_OPEN_FAILED`. Kein Temp, kein RAM-Slurp „damit es geht“. Kurz auch in [`docs/pdf-offline.md`](../pdf-offline.md).
