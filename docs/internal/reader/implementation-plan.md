> Maintainer plan (German).

# SDK: Reader-API (`react-native-sherpa-onnx/reader`)

## Stand (2026-11-14)

Phasen 0–8 umgesetzt auf `feat/reader-api` (nicht gepusht).

**Abweichungen vom Plan**
- `debugRowCount` bleibt als internes Prop (`__debugRowCount`) für Tests, über ein gemeinsames `MakePlaceholderSnapshot`.
- Keine Struktur-Getter am Text-Buffer; Blöcke liest man über `getReaderBlocks`.
- Die Android-Bilder nutzen `OfflineImageBufferFrameView` direkt.
- Bei Reflows (Theme, Breite) hält Android das Zeichen an der Lese-Oberkante. iOS behält die erste sichtbare Zeile samt Versatz.
- Die Frankenstein-Probe dient als S9.

**Smoke-Ergebnisse**

| # | iOS (Simulator, iOS 27, DeviceHub) | Android (A142P, adb) |
|---|---|---|
| S1 | `structure.epub`: 15 Blöcke, 4 Abschnitte, `documentKey` = SHA-256 | gleich |
| S2 | `furthest` steigt, `sectionEnd s0`/`s1`, Einschub sichtbar | gleich |
| S3 | `jump scrollTo` (s0 → s31, 4776 Blöcke) | gleich |
| S4 | `jump fling`, Frontier unverändert | gleich (Distanz 77) |
| S5 | Tippen im Einschub nach Scrollen und mit Wackeln; Ziehen scrollt ohne Tippen | gleich |
| S6 | erster Block ±1 nach Schriftgröße; unverändert nach Theme/Zeilenhöhe | gleich; Drehen behält den Block |
| S7 | Merken/Wiederherstellen landet auf Block + Offset | gleich (s31.b80, Offset 51) |
| S8 | Header-Traits, `alt`-Labels, Einschübe zugänglich | `alt` als contentDescription im a11y-Baum geprüft; Überschriften setzen `setAccessibilityHeading` (der uiautomator-Dump zeigt das Flag nicht, also nicht am Gerät geprüft) |
| S9 | Frankenstein: 850 Blöcke, 39 Abschnitte, bis zum Ende ohne Absturz, Bilder da | gleich |

Hinweis zum Testen auf Android: Ein CDP-Log-Client, der sich ständig neu verbindet, löst laufend das „Refreshing…“-Banner aus. Dann scheitert `uiautomator dump` mit „could not get idle state“. Die JS-Logs liest man auf Android besser über `adb logcat` (Tag `ReactNativeJS`).

## Context
Reader-Apps brauchen mehr als einen Text-Buffer: Sie zeigen ein Buch in einer eigenen Ansicht, merken sich Lesestände absatzgenau und blenden eigene Inhalte in den Lesefluss ein.

Eine solche App braucht vom SDK:
- **Stabile Block-IDs**, damit Lesestand und Analyse auf jedem Gerät absatzgenau zusammenpassen.
- **App-eigene Abschnitte**, also Text, der nicht in der Datei steht.
- **Einschübe** als React-Native-Views im Lesefluss.
- **Ereignisse** (sichtbarer Bereich, weiteste Position, Abschnittsende, Sprung, Tipp) und eine **native, virtualisierte ReaderView** für iOS und Android.

Heute liefert das SDK nur Text-Buffer mit Absatz-Spans. Überschriften, Bilder im Text, Inhaltsverzeichnis, Metadaten und IDs gehen bei der Extraktion verloren, und es gibt keine Anzeige.

**Entscheidungen des Users**
- Die Example-App bleibt auf **RN 0.83.10**.
- **iOS und Android** werden gleichzeitig umgesetzt; Android wird über adb auf dem angeschlossenen Gerät (A142P) getestet.
- Die ReaderView ist eine **Fabric-Komponente**, läuft also **nur mit New Architecture**.

**Git-Ablauf**
- Neuer Branch `feat/reader-api` vom Branch `refactor/refactor-before-release-1-0`.
- Commits pro Phase im Conventional-Commits-Format, ohne Co-Authored-By. Nichts pushen.

**Smoke-Tests ohne den User**
- **iOS** über DeviceHub: Xcode 27.1 `xcrun mcpbridge` bietet MCP-Tools zum Tippen und Wischen auf dem Simulator. Jeder Aufruf liefert einen Screenshot und den UI-Baum. Dazu kommt `GetConsoleOutput` für das Log.
- **Android** über adb: `uiautomator dump`, `input`, `screencap` und `logcat`.

## Architektur (Kurzfassung)
1. **Struktur-Extraktion** (gemeinsames C++): Die lexbor-Auswertung behält Blocktyp und Überschriften-Ebene sowie `<img>` und `<hr>`. Leerraum wird zusammengefasst. EPUB-Inhaltsverzeichnis (nav.xhtml oder NCX) und `dc:`-Metadaten werden ausgelesen. Die Struktur liegt nativ am Text-Buffer (`TxtStructure` in `TxtOfflineEntry`); JS bekommt nur eine Zusammenfassung, Blöcke seitenweise.
2. **ReaderDocument**: native Registry `rdr_*` in C++, hält den Text-Buffer und optional einen Bild-Buffer.
   - Snapshots sind unveränderlich, jede Änderung erhöht `revision`. Buchtext geht nie über die JS-Bridge.
   - IDs:
     - `documentKey` = SHA-256 der Datei.
     - `structureVersion` = 1 und `textHashVersion` = 1.
     - Block-IDs `s{sectionIndex}.b{blockIndex}`, beide 0-basiert.
     - `textHash` = die ersten 8 Bytes von SHA-256 über den normalisierten Text, hex.
   - App-Abschnitte `app:<id>` mit Blöcken `app:<id>.<key>`.
3. **ReaderView**: zwei Codegen-Fabric-Komponenten.
   - `SherpaReaderView` ist die native Liste: iOS `UITableView` mit TextKit-1-`UITextView`-Zellen, Android `RecyclerView` mit `TextView`.
   - `SherpaReaderInsertView` ist der Host für Einschübe. Er ist ein React-Kind, das nativ in die passende Listenzelle umgehängt wird.
   - Die Ereignislogik steckt in einem gemeinsamen C++-`ReaderTracker` und ist per gtest getestet.
4. **Bilder im Fluss**: `extractDocumentImages(source, { scope: 'all' })` dekodiert auch Inline-Bilder, einmal pro Pfad. Der Reader ordnet sie über `href` zu. `loadReaderDocument(source)` bündelt alles.

### Strukturregeln v1 (festgeschrieben, per Golden-JSON abgesichert)
- **Blockbildende Tags**:
  - P, H1–H6, LI, BLOCKQUOTE, PRE und TD wie bisher.
  - Neu: `HR` erzeugt einen Trenner (`separator`).
  - Neu: `IMG` und SVG `<image>` erzeugen einen Bild-Block. Liegt das Bild in einem offenen Absatz, kommt es erst nach dessen Ende, damit der Absatz nicht zerteilt wird.
- **Leerraum** in Textknoten wird zu einem Leerzeichen zusammengefasst. `<br>` wird zu `\n`. `PRE` bleibt roh.
  - Diese Regel ändert die Textausgabe von EPUB und MOBI → CHANGELOG-Eintrag nötig.
- **Text-Buffer**: Er enthält nur Textblöcke, verbunden mit `\n\n` wie heute. Bild- und Trenner-Blöcke haben einen leeren Bereich.
- **Abschnitte**:
  - Nummeriert werden nur lineare Spine-Einträge, wie heute.
  - Der Titel kommt zuerst aus nav/NCX, sonst aus der ersten Überschrift. Das Feld `titleSource` sagt, woher.
- **Normalisierung für `textHash`**:
  - Weiche Trennzeichen und Zero-Width-Zeichen entfernen.
  - Typografische Anführungszeichen, Bindestriche und „…“ vereinheitlichen.
  - Unicode-Leerraum zu einem Leerzeichen zusammenfassen und an den Rändern abschneiden.
  - **Keine** Groß-/Kleinschreibung angleichen, **keine** NFC-Normalisierung (damit das Backend es leicht nachbauen kann).
  - Bild-Blöcke hashen `"\x1Fimage:"+href`, Trenner `"\x1Fseparator"`.

### Ereignisregeln (ReaderTracker)
- **Sichtbar** heißt: mindestens 50 % von min(Blockhöhe, Viewport) sind zu sehen. Die Indizes zählen nur Blöcke, keine Einschübe.
- **Sprung**, Schwelle N = 20 (Prop `jumpThreshold`):
  - Abstand > N beim Ziehen oder Stehen → Ursache `scroll`.
  - Wischer, der mehr als N Blöcke weit landet → Ursache `fling`.
  - `scrollTo` → immer Ursache `scrollTo`.
- **Weiteste Position**: Sie rückt nur bei fortlaufendem Lesen vor, also wenn das zusammenhängend gelesene Stück direkt an die bisherige weiteste Position anschließt.
  - Startwert kommt aus der neuen Prop `furthestLocator`.
  - Nach einem Sprung nach vorn bleibt sie stehen; bestätigt die App den Sprung, setzt sie die Prop neu.
- **`onSectionEnd`** feuert einmal, wenn der letzte Block eines Abschnitts beim fortlaufenden Lesen sichtbar wird.

### API-Entscheidungen (bewusst)
- **`createReaderDocument`**: Die Signatur ist `createReaderDocument({ text, images?, documentKey })`. Die Struktur wird nativ vom Text-Buffer gelesen statt aus JS übergeben.
- **`insertSection`** ändert das Dokument nicht, sondern liefert ein neues `ReaderDocument` mit höherer `revision`.
- **Event-Payloads** sind Objekte, z. B. `onSectionEnd({sectionId, blockId})`.
- **Neue Prop `furthestLocator`**: die von der App gesetzte Grenze für die weiteste Position, denn über Sprünge entscheidet die App.
- **`highlight()`** existiert schon in der Ref, tut aber noch nichts (Warnung in `__DEV__`).

## Phasen und Commits

### Phase 0: Branch, Gerüst, Spezifikation ins SDK
**Branch:** `git checkout -b feat/reader-api refactor/refactor-before-release-1-0`.

**`package.json`**
- `exports["./reader"]` hinzufügen, nach dem Muster von `./document`.
- `codegenConfig.type` auf `"all"` setzen.
- `codegenConfig.ios.componentProvider` für beide Komponenten eintragen.
- Codegen erfasst nur Dateien nach dem Muster `*NativeComponent.ts`.

**`tsconfig.json` und `example/tsconfig.json`:** `paths` für `reader` ergänzen und das fehlende `document` gleich mit.

**Neue Dateien**
- `src/reader/{types.ts,index.ts,ReaderView.tsx}`
- `SherpaReaderViewNativeComponent.ts` und `SherpaReaderInsertViewNativeComponent.ts`

**Codegen-Props, flach gehalten**
- `documentId`, `documentRevision`.
- Startposition und weiteste Position.
- Theme-Felder: Schrift, `fontScale` (-1 = System), Zeilenhöhe, Abstände, Ränder und die Farben als `ColorValue`.
- `inserts[{key, kind, target}]`, `jumpThreshold` und `debugRowCount` (nur für den Spike).

**Events:** `onReady`, `onVisibleRangeChange`, `onFurthestPositionChange`, `onSectionEnd`, `onJump`, `onTap`, `onError`.

**Command:** `scrollToLocator`.

**Doku:** `docs/reader.md` als englischer Entwurf der Spezifikation und `docs/internal/reader/implementation-plan.md`.

**Prüfen**
- `yarn typecheck`, `yarn lint`, `yarn test`.
- `pod install` und danach prüfen, ob `ComponentDescriptors.h` beide Komponenten enthält.
- Android: `generateCodegenArtifactsFromSchema` und prüfen, ob `SherpaReaderViewManagerInterface` erzeugt wird.

**Commits**
- `docs(reader): move reader API spec into the SDK`
- `chore(reader): scaffold reader subpath and Fabric codegen components`

### Phase 1: Spike für die Einschübe zuerst, das größte Risiko
Echte `SherpaReaderView` mit `debugRowCount` Testzeilen. Die Einschübe werden per `afterBlock`/`beforeBlock` platziert.

**iOS** (`ios/reader/`)
- `SherpaReaderComponentView` ist ein `RCTViewComponentView`.
  - Er überschreibt `mountChildComponentView` und `unmountChildComponentView` ohne `super` aufzurufen und hält eine Zuordnung Key → Host.
  - Die Zeilen aus Blöcken und Einschüben baut er im nächsten Main-Queue-Tick neu auf.
- Eine Einschub-Zelle hängt den Host ein. Die Höhe kommt aus `host.layoutMetrics`, also von Yoga.
- `SherpaReaderInsertComponentView.updateLayoutMetrics` meldet Größenänderungen. Der Anker (erste sichtbare Zeile und Versatz) bleibt dabei erhalten.
- Der Tipp-Recognizer ignoriert Berührungen in Einschüben.

**Android** (`android/.../com/sherpaonnx/reader/`)
- `SherpaReaderViewManager` ist ein `ViewGroupManager`.
  - Er überschreibt `addView`, `removeViewAt`, `getChildCount` und `getChildAt` auf einer logischen Kinderliste, und `needsCustomLayoutForChildren` liefert `true`.
  - `removeViewAt` löst das Kind aus seiner Zelle.
- `ReaderRecyclerView` ruft `NativeGestureUtil` auf (wie `ReactScrollView`).
- `SherpaReaderInsertView` merkt sich die Größe, die Yoga vorgibt.
- `ReaderInsertContainer` misst mit genau dieser Größe.
- Beide Manager werden in `SherpaOnnxPackage.kt` registriert.

**Example:** Spike-Bereich in `example/src/screens/reader/ReaderScreen.tsx`; Route und Intro-Text gleich mit anlegen.

**Prüfliste (iOS-Simulator und A142P)** → Ergebnis in `docs/internal/reader/insert-spike.md`
1. Einschübe einfügen, entfernen und umsortieren, während die Liste gescrollt ist.
2. Die Höhe eines Einschubs ändert sich, ohne dass die Liste springt.
3. Tippen auf ein Pressable in einem Einschub weit unten, auch mit leichtem Wackeln.
4. Ein Ziehen auf einem Einschub scrollt die Liste und löst kein Tippen aus.
5. VoiceOver und TalkBack lesen in der richtigen Reihenfolge.
6. Zellen werden korrekt wiederverwendet.
7. Fast Refresh und das Entfernen des Readers funktionieren.
8. Drehen des Geräts.

**Fallback 1b, nur wenn Punkt 3 scheitert** (Pressability misst über den Shadow-Tree, deshalb kann das Tippen verloren gehen)
- Eigener Shadow-Node für den Einschub-Host mit State `{offsetX, offsetY}` und `getContentOriginOffset()`, nach dem Muster von ScrollView.
- Etwa ein Tag zusätzlicher Aufwand.

**Commits**
- `feat(reader): native ReaderView skeleton hosting React inserts (iOS, Android)`
- Falls nötig: `feat(reader): insert host shadow state for correct measure`

### Phase 2: Struktur-Extraktion (gemeinsames C++)
**2a** `refactor(document): collapse HTML whitespace and keep block kinds in lexbor walk`
- `DocHtmlText.{h,cpp}`: `HtmlExtract::blocks` wird zu `items` vom Typ `HtmlBlock{kind, level, text, image_src, alt}`.
- Eine Hilfsfunktion `TextBlocks()` bedient die bisherigen Aufrufer `DocEpub.cpp` und `DocMobi.cpp`.
- Die Regeln aus „Strukturregeln v1“ umsetzen und in `test/cpp/document/document_host_test.cpp` testen.

**2b** `feat(document): EPUB structure with sections, blocks, TOC titles and metadata`
- **Neue Typen:** `android/src/main/cpp/textbuffer/TxtStructure.h` mit `TxtStructure`, `TxtStructSection` und `TxtStructBlock`.
- **Text-Buffer:**
  - `TxtOfflineEntry` bekommt `shared_ptr<const TxtStructure>`.
  - `TextRegistry` bekommt ein `txt_populate_offline_if_empty` mit Struktur sowie `txt_get_offline_structure`.
- **EPUB-Auswertung** (`DocEpub.cpp`):
  - `LoadPackage` liest zusätzlich nav, NCX, die Manifest-`properties` und die Metadaten.
  - Neu `LoadTocTitles`.
  - `AppendStructuredBlocks` ersetzt `AppendBlocks` und füllt Spans und Struktur in einem Durchgang.
- **Bridges:**
  - iOS: `ios/document/bridge/SherpaOnnx+Document.mm` gibt die Struktur weiter und ergänzt die Zusammenfassung im Ergebnis.
  - Android: neu `nativeExtractTextInto`, das das C++-Register direkt füllt. Der Buchtext läuft dann nicht mehr C++ → Kotlin → C++.
- **Turbo-Spec** (`src/NativeSherpaOnnx.ts`): Ergebnis von `extractDocumentText` erweitern, dazu `getOfflineTextBufferStructure` und `getOfflineTextBufferStructureBlocks` (seitenweise, höchstens 4096 pro Aufruf).
- **TS:** die Typen `DocumentStructure*` in `src/document/types.ts` und die Getter in `src/textbuffer/index.ts`, mit Jest-Tests.
- **Fixtures** über `test/fixtures/document/gen_fixtures.py`, nur neue Dateien:
  - `structure.epub`: nav und NCX, h1–h3, Bild in einem Absatz, `<hr>`, `<pre>`, eingerückter Leerraum.
  - `structure-ncx.epub`: nur NCX.
  - `long.epub`: etwa 40 Kapitel × 150 Absätze plus Bilder.

**2c** `feat(document): extract inline EPUB images (scope: 'all')`
- `ExtractOptions.image_scope` in C++.
- `ExtractDocumentImagesOptions.scope` in TS, Auswertung in beiden Bridges.

### Phase 3: ReaderDocument-Kern
- **3a** `refactor(crypto): namespace sha256 and build it on iOS`: `crypto/sha256` in einen Namespace legen, im Podspec aufnehmen und den einen Aufrufer anpassen.
- **3b** `feat(reader): ReaderDocument registry with stable block IDs and textHash`
  - Neue C++-Dateien in `android/src/main/cpp/reader/`:
    - `ReaderTextHash` für Normalisierung und Hash.
    - `ReaderDocument.h` mit den Snapshots.
    - `ReaderRegistry`: Create, Insert/RemoveSection, Snapshot, ResolveLocator, Release.
    - `ReaderLocatorRemap`: Neuzuordnung über `textHash`.
  - Einbinden in CMake und Podspec.
  - gtest-Ziel `reader_host_test` mit `test/fixtures/reader/texthash-v1.json` und dem Golden-File `structure.reader-v1.json`. Jede Änderung der Zerlegung schlägt fehl, bis `structureVersion` erhöht wird.
- **3c** `feat(reader): reader bridges and the TS reader API`
  - Spec-Methoden:
    - `computeFileSourceSha256` und `createReaderDocument`.
    - `insertReaderSection`, `removeReaderSection`, `getReaderBlocks`.
    - `resolveReaderLocator`, `releaseReaderDocument`.
  - Umsetzung:
    - iOS in `ios/reader/bridge/SherpaOnnx+Reader.mm`.
    - Android über JNI in `jni/reader/`, `ReaderNative.kt` und `SherpaOnnxReaderHelper.kt`, angebunden in `SherpaOnnxModule.kt`.
  - Öffentliche TS-API:
    - `computeDocumentKey` und `createReaderDocument`.
    - `insertSection` und `removeSection`.
    - `getReaderBlocks` und `remapLocator`.
    - `loadReaderDocument(source)`.
    - Hilfsfunktionen für Block-IDs und Locator.
    - `ReaderErrorCode` mit Codes `ERR_READER_*`.
  - Jest-Tests in `src/reader/__tests__/api.test.ts`, danach `yarn check:ios-turbo-signatures`.
- **3d** `feat(reader): shared reading-progress tracker`: `reader/ReaderTracker.{h,cpp}` mit gtest-Szenarien:
  - normal vorwärts lesen;
  - Wischer unter und über N;
  - schnelles Durchziehen;
  - `scrollTo`;
  - zurück und wieder vor lesen;
  - weiteste Position aus der Prop;
  - Abschnittsende feuert nur einmal;
  - App-Abschnitte.

### Phase 4: iOS-ReaderView mit echtem Dokument
- **Vorarbeit:** `refactor(imagebuffer): share frame loader`. Der Code, der Bild-Frames im Hintergrund lädt, wandert aus `OfflineImageBufferFrameView.mm` in einen gemeinsamen `SherpaImageFrameLoader`.
- **Commit** `feat(reader): iOS ReaderView rendering, theme, events and scrollTo`
  - **Steuerung:** `ReaderTableController` als DataSource und Delegate.
  - **Zellen:**
    - Text: TextKit 1 mit Absatzstil, Silbentrennung und Sprache. Überschriften bekommen den Accessibility-Trait „Header“.
    - Bild: auf die Breite skaliert, höchstens 0,9 × Viewport, `alt` als Label.
    - Trenner.
  - **Theme:** Schrift über `RCTFont`, Dynamic Type über `UIFontMetrics`.
  - **Text** pro Block per `txt_copy_offline_text_utf16_units` und im `NSCache` gehalten.
  - **Höhen** pro Zeile geschätzt.
  - **Position und Ereignisse:**
    - Wiederherstellen und `scrollTo` in zwei Schritten (grob scrollen, dann genau nachkorrigieren). Der Anker bleibt bei Theme-, Breiten- und Revisionswechsel erhalten.
    - Die Scroll-Phasen gehen an den Tracker.
    - Events über `SherpaReaderViewEventEmitter`, Commands über `RCTSherpaReaderViewHandleCommand`.

### Phase 5: Android-ReaderView mit echtem Dokument
**Commit** `feat(reader): Android ReaderView rendering, theme, events and scrollTo`. Er entfernt auch `debugRowCount` auf beiden Plattformen.

- **`ReaderAdapter`:** Zeilentypen Text, Überschrift, Bild, Trenner und Einschub.
  - Die Blocktabelle kommt als gepacktes `IntArray` über JNI.
  - Text wird erst bei Bedarf geholt und im `LruCache` gehalten.
- **Text:** `TextView`.
  - Größe in SP bei Systemskalierung, sonst DIP × Faktor.
  - Zeilenabstand, Silbentrennung, `textLocale` und `ReactFontManager`.
  - Überschriften bekommen `setAccessibilityHeading`.
- **Bilder** über `ImageBufferService.copyFrameBitmap` im Hintergrund.
- **Scrollen und Ereignisse:**
  - `OnScrollListener` liefert die Scroll-Phasen für den Tracker.
  - `scrollTo` über `scrollToPositionWithOffset` mit Korrektur auf die Zeile.
  - Den Tracker erreicht Kotlin über einen JNI-Handle.
  - Events über `UIManagerHelper`, Tipp über `GestureDetector`.
  - Konfigurationswechsel (Schriftgröße, Breite) laden neu und behalten den Anker.

### Phase 6: Example-App
**Commits:** `feat(example): add Reader screen` und `chore(example): bundle long reader samples`.

**Einbindung (vorhandene Stellen)**
- `example/src/types/navigation.ts`: `Reader` und `'reader'`.
- `example/src/navigation/RootNavigator.tsx`.
- `example/src/screens/home/HomeScreen.tsx` im Bereich „Documents (EPUB, MOBI, PDF, …)“.
- `example/src/components/ScreenIntroModal.tsx`: `INTRO_COPY.Reader`.

**Screen** `example/src/screens/reader/ReaderScreen.tsx` plus `.styles.ts`, mit diesen vorhandenen Bausteinen:
- **Quelle:** `FileSourcePicker` und `ExampleDocumentFileList` mit `DOCUMENT_FILES`.
  - Mitgelieferte Dateien über `fileSourceFromBundledPath`, eigene über `toFileSource`.
  - Die Liste der EPUB-Dateitypen kommt aus `DocumentsScreen.handleChooseFile`.
- **Einstellungs-Chips:** `ocr/OcrChoiceRow` für Schriftgröße (System, 0,9, 1,2, 1,5), Zeilenhöhe und die Themes Papier, Sepia und Kontrast.
- **Intro:** `ScreenIntroModal`.
- **Banner:** Stil von DocumentsScreen und VideoPreviewScreen. Eine kleine gemeinsame `StatusBanner` nur, wenn sie an zwei Stellen gebraucht wird.

**Ablauf im Screen**
- `loadReaderDocument` lädt das Buch, dann fügt `insertSection` ein Demo-Kapitel `app:demo` nach `s1` ein.
- Einschub-Karten mit Pressable, eine am Abschnittsende `sectionEnd` von `s0` und eine `beforeBlock`.
- Ereignis-Log mit höchstens 50 Zeilen.
- Knöpfe für „Zu Abschnitt springen“, „Position merken“ und „Wiederherstellen“.
- `testID` und `accessibilityLabel` an allen Bedienelementen.
- In `__DEV__` schreibt jeder Handler eine Zeile `READER_SMOKE {json}` ins Log.

**Beispieldateien**
- `long.epub` aus Phase 2.
- *Frankenstein* von Standard Ebooks (CC0, Lizenz beim Download prüfen). Das testet echtes nav-Markup und eine SVG-Titelseite.
- Ablage in `example/ios/sherpa_models/test_edocs/` und `example/android/app/src/main/assets/test_edocs/`.
- Dazu `example/src/documentConfig.ts` und die beiden README-Dateien aktualisieren.

### Phase 7: Smoke-Tests ohne den User, danach `fix(reader): …`-Commits
**iOS**
- Metro mit `yarn example start` im Hintergrund.
- Bauen mit `xcodebuild` (Workspace `example/ios/SherpaOnnxExample.xcworkspace`, Scheme `SherpaOnnxExample`), dann `simctl install` und `simctl launch com.xdcobra.sherpaonnxexample`.
- Steuerung über ein Python-MCP-Client-Skript im Scratchpad (wird nicht committet), das mit `xcrun mcpbridge` spricht:
  - `DeviceInteractionStartSession` mit iPhone 17 Pro.
  - `DeviceInteractionSynthesize`: tippen und wischen nach dem UI-Baum. Jeder Aufruf liefert Screenshot und Hierarchie.
  - `GetConsoleOutput` bzw. `simctl spawn … log stream`, gefiltert auf `READER_SMOKE`.
  - `DeviceInteractionEndSession` zum Schluss.
- Am Ende Metro stoppen und die App beenden.

**Android (A142P)**
- `./gradlew installDebug`, dann `adb reverse tcp:8081 tcp:8081`.
- `uiautomator dump` und Elemente über `content-desc` finden.
- `input tap`/`swipe`, `screencap` und `logcat` mit Filter `READER_SMOKE`.

**Szenarien auf beiden Plattformen**

| # | Szenario | Erwartung |
|---|---|---|
| S1 | `mixed.epub` öffnen | `ready` mit der richtigen Zahl an Blöcken und Abschnitten |
| S2 | Langsam wischen | Sichtbarer Bereich ändert sich, weiteste Position steigt, `sectionEnd s0` |
| S3 | Zu einem fernen Abschnitt springen | `jump` mit Ursache `scrollTo` |
| S4 | Langer Wischer in `long.epub` | `jump` mit Ursache `fling`, weiteste Position unverändert |
| S5 | Knopf im Einschub tippen, Einschub mitten im Bild | `insertPress` |
| S6 | Theme oder Schrift ändern | erster sichtbarer Block bleibt (±1) |
| S7 | Position merken, neu laden, wiederherstellen | gleicher erster Block |
| S8 | Barrierefreiheit | Header-Traits und Einschub-Labels vorhanden; Reihenfolge stimmt |
| S9 | *Frankenstein* bis zum Ende scrollen | kein Absturz, Bildzeilen vorhanden |

### Phase 8: Doku
**Commit:** `docs(reader): document the reader API and structure v1`.

- **`docs/reader.md` (fertige Fassung):**
  - API, Props und Events.
  - Strukturregeln v1, Format der IDs und `textHash` v1 mit einer kurzen Python-Referenz für das Backend.
  - Tracker-Regeln.
  - Hinweis, dass die View nur mit Fabric läuft und lexbor eingeschaltet sein muss.
  - Grenzen: nur EPUB, kein Zoom, kein Blättern, noch keine Hervorhebung.
- **Weitere Dateien:**
  - `docs/README.md`: Eintrag im Index.
  - `docs/document-offline.md`: Den Satz „not a reader“ ersetzen; `structure` und `scope:'all'` beschreiben.
  - `docs/textbuffer-offline.md`: die neuen Struktur-Getter.
  - `docs/ocr/edocument-offline-plan.md`: D10 als ersetzt markieren.
  - `docs/internal/sdk-feature-support-matrix.md`: Zeile für den Reader.
  - `CHANGELOG.md`: die geänderte Leerraum-Behandlung.

## Risiken
- **Tippen in Einschüben**, weil die Messung über den Shadow-Tree läuft: wird in Phase 1 geprüft, Fallback 1b liegt bereit.
- **Springen bei Höhenänderungen** von Einschüben: Der Anker bleibt bei Batch-Updates erhalten.
- **Geschätzte Höhen** machen weites `scrollTo` und das Wiederherstellen ungenau. Lösung: in zwei Schritten scrollen und danach korrigieren.
- **Speicher mit `scope:'all'`:** `maxSide` 2048, mmap-Auslagerung im ImageRegistry, jedes Bild nur einmal.
- **Codegen mit `type:"all"`:** wird gleich in Phase 0 geprüft.
- **Namenskonflikt bei `sha256` auf iOS:** wird in 3a per Namespace gelöst.

## Verifikation (pro Phase)
- **C++:** `cd test/cpp/build && cmake .. && cmake --build . --target document_host_test reader_host_test && ctest -R "document_host_test|reader_host_test"`.
- **JS:** `yarn typecheck`, `yarn lint` (nur eigene Dateien und Zeilen), `yarn test`, `yarn check:ios-turbo-signatures`.
- **Builds:**
  - iOS: Example nach `pod install` mit `xcodebuild` für den Simulator.
  - Android: `cd example/android && ./gradlew assembleDebug`.
- **Smoke-Tests:** Szenarien S1–S9 auf iOS-Simulator (DeviceHub) und A142P. Screenshots und `READER_SMOKE`-Logs zeigen, dass es klappt.
