# Reader internals

How `react-native-sherpa-onnx/reader` works, for maintainers and AI agents changing it. The public contract is [docs/reader.md](../../reader.md); this file explains the implementation behind it and the rules a change must keep.

## Layers

```
JS (src/reader)            api.ts · ReaderView.tsx · readAloud.ts · *NativeComponent.ts
        │ TurboModule (NativeSherpaOnnx.ts)          │ Fabric props / events / commands
        ▼                                            ▼
Bridges                    ios/reader/bridge/SherpaOnnx+Reader.mm     ios/reader/SherpaReaderComponentView.mm (+Cells, +InsertComponentView)
                           android/.../reader/ReaderNative.kt         android/.../reader/SherpaReaderView.kt (+ViewManager, +InsertView)
                           cpp/jni/reader/sherpa-onnx-reader-jni.cpp  cpp/jni/reader/sherpa-onnx-reader-view-jni.cpp
        │                                            │
        ▼                                            ▼
Shared C++ core            android/src/main/cpp/reader/   (compiled into the iOS pod as well)
  ReaderRegistry · ReaderSnapshot · ReaderTracker · ReaderHighlights · ReaderJson · ReaderTextHash · ReaderFileHash · ReaderBridge
        │
        ▼
Structure source           android/src/main/cpp/document/DocEpub.cpp → textbuffer/TxtStructure.h (attached to TxtOfflineEntry)
```

All rules that must behave the same on both platforms live in the shared C++ core: IDs and hashes, the snapshot model, text-range mapping, highlight resolution and the reading tracker. The platform views only lay out rows, draw text and feed scroll samples into the tracker.

## 1. Structure extraction

- `DocEpub.cpp` walks the linear spine with lexbor (`DocHtmlText.cpp`) and appends, per section, the text plus a `TxtStructure` (`textbuffer/TxtStructure.h`): sections with href, kind, title, title source and UTF-16 range; blocks with type, heading level, UTF-16 range, image href and `alt`; OPF metadata (`title`, `creator`, `language`).
- The structure is attached to the offline text buffer entry (`TxtOfflineEntry::getStructure()`) and released with the buffer. JS only sees a summary in `extractDocumentText(...).structure`.
- Titles come from the EPUB 3 nav document, then the NCX, then the first heading.
- The rules are listed in [reader.md → Structure rules](../../reader.md#structure-rules) and frozen by `structureVersion` (`TxtStructure::version`, `reader::kStructureVersion`). The golden file `test/fixtures/reader/structure.reader-v1.txt` makes `reader_host_test` fail on any change. **Changing a rule means bumping the version**, updating the golden file and keeping `remapLocator` working for stored positions.
- `extractDocumentImages(source, { scope: 'all' })` decodes every referenced image once per href into an offline image buffer; each frame keeps its href, which is how image blocks find their frame.

## 2. Documents (`ReaderRegistry`, `ReaderSnapshot`)

- `ReaderRegistry` (singleton, mutex-guarded) maps `rdr_<n>` to `shared_ptr<const ReaderSnapshot>`.
- **Snapshots are immutable.** `InsertSection` / `RemoveSection` copy the current snapshot, change it, call `ReindexSnapshot` and publish it with `revision + 1`. A view keeps the snapshot it retained until it reloads, so it never reads a half-updated document.
- A snapshot holds:
  - `sections` and `blocks` in reading order (app sections are spliced in after their `after` section);
  - `blockIndexById`, `sectionIndexById`;
  - `textBlocks`: indices of file text blocks with a non-empty buffer range, sorted by `utf16Start` (for offset lookups);
  - `text`: a `shared_ptr<TxtOfflineEntry>`, so the book text stays alive even after JS released its text handle;
  - `imageBufferId` and per-block `imageFrame`.
- **IDs:** file blocks `s{section}.b{block}` (from `TxtStructure`), app sections `app:<id>` with blocks `app:<id>.<key>`. `ReaderTextHash.cpp` implements the textHash normalization (Python reference in reader.md); `ReaderFileHash.cpp` streams SHA-256 over a `SeekableSource` for `documentKey`.
- **Block text** is read on demand: file blocks slice the text buffer by UTF-16 range; app blocks carry `appText`.
- `MapTextRange(start, end)` uses two `partition_point` searches over `textBlocks`. A start in a `\n\n` gap snaps forward to the next block, an end snaps back; ranges that touch no text block return false. Used by `mapTextRanges` and read-aloud.
- `RemapBlockByHash` returns the block with a matching `textHash` nearest to a hint index (`remapLocator`).
- `ReaderJson.cpp` serializes the summary, block pages (`BlocksJson`, includes `textRange`) and text-range results for the TurboModule. `ReaderBridge.cpp` is the platform-neutral entry used by both bridges.

`loadReaderDocument` (JS) = `extractDocumentText` into a temporary buffer + `extractDocumentImages(scope 'all')` + `computeDocumentKey` + `createReaderDocument`; it then releases its text handle (the snapshot keeps the entry) and records the image buffer in `ownedImageBuffers` so `releaseReaderDocument` frees it.

## 3. The view

### JS wrapper (`ReaderView.tsx`)

- Flattens everything into codegen-friendly props: `documentId` + `documentRevision`, `initialSectionId/BlockId/Offset`, `furthestBlockId` + `furthestRevision`, theme fields (font, size, scale, line height, spacing, `readerMarginHorizontal/Vertical`, alignment, hyphenation, colors), `inserts` as `{ key, kind, target }`, `highlights` as `HighlightSpec`, follow options.
- **Do not name props like Yoga style props.** `marginHorizontal` / `marginVertical` were also read by Fabric as layout margins of the view itself; they are `readerMargin*` for that reason.
- `furthestRevision` increases only when the `furthestLocator` block changes, so native applies the app's frontier exactly when the app changed it.
- Colors go through `processColor` and are passed as signed Int32 (`toInt32`), because `ColorValue` inside object arrays is not reliable in codegen. Platform colors fall back to the accent.
- Inserts: for each spec, a `SherpaReaderInsertView` child with `insertKey` wraps `renderInsert(key)`.
- Commands: `scrollToLocator(sectionId, blockId, offset, animated)`, `resumeFollow()`.

### Rows

Both platforms build a row list from the snapshot: one row per block, plus insert rows placed by `sectionEnd` / `beforeBlock` / `afterBlock`. Rows are rebuilt (`scheduleRebuild` → `rebuildRows`) on a new document revision, a new insert list or an insert key change.

- **Android:** `RecyclerView` + `LinearLayoutManager`. Row updates use `DiffUtil` so holders stay valid and the first visible row stays put. Block metadata comes from JNI as flat int tables (`nativeBlockTable`: 6 ints per block; `nativeSectionTable`: 2 per section); text is fetched per row (`nativeBlockText`) into an `LruCache` of 256 entries. Text rows are `TextView`s; image rows use `OfflineImageBufferFrameView`.
- **iOS:** `UITableView` with TextKit 1 text cells (`SherpaReaderTextCell`), image cells (`OfflineImageBufferFrameView`), separator cells and insert cells. The view reads the snapshot directly from `ReaderRegistry` (same C++ core). Measured row heights are cached as estimates; `keepingAnchor:` keeps the first visible row in place across row changes (UIKit otherwise re-estimates rows above the viewport).
- Images are scaled to the text width and capped at 90 % of the viewport height.

### Reflow (theme, width, revision)

The reading position is kept by anchor: before a reflow the view records the first visible block and the character at the top of the reading area (`readingAnchor` on Android, the first visible line with its offset on iOS) and restores it after layout (`restoreAnchor`).

### Inserts (React Native views in the native list)

This is the part most likely to break with React Native updates. Background: [insert-spike.md](insert-spike.md).

- `SherpaReaderView` receives insert hosts as Fabric children but does **not** add them as subviews where Fabric expects. iOS overrides `mountChildComponentView` / `unmountChildComponentView` without calling `super`; Android keeps a logical child list in the view manager (`addView` / `removeViewAt` / `getChildAt`) with `needsCustomLayoutForChildren() = true`.
- Yoga lays each host out at full reader width at the reader's origin. The list uses the Yoga height as the row height and moves the host into the row's cell (`attachHost:` on iOS, the insert row container on Android). A Yoga height change (`onInsertResized` / `insertHostDidResize:`) updates that row while keeping the anchor.
- **Measure fix:** Pressability measures the press rect from the shadow tree, where every host sits at the reader's origin. The hand-written shadow node `cpp/fabric/react/renderer/components/SherpaOnnxSpec/SherpaReaderInsertShadowNode` reports the on-screen row position as `getContentOriginOffset`; the list pushes that position into Fabric state on scroll and layout (`setOnScreenOrigin` → `StateWrapper.updateState` / `ConcreteState::updateState`). The insert component is `interfaceOnly`; Android builds the codegen library from `android/src/main/jni-codegen`, and `react-native.config.js` registers both component descriptors.
- A drag in the list cancels the JS responder (iOS: toggles the surface touch handler; Android: `NativeGestureUtil`), so a scroll that starts on a button does not press it.
- Android only: react-native-screens calls `startViewTransition` on descendants while a screen is popped; `ReaderRecyclerView` and the insert row container ignore it, otherwise recycling throws "Scrapped or attached views may not be recycled".

### Reading events (`ReaderTracker`)

The view samples `(firstVisibleBlock, lastVisibleBlock, phase)` and the tracker returns events; the view only translates indices to locators and dispatches them.

| Phase | Source |
|---|---|
| `Drag` | finger on screen |
| `Momentum` | fling after the finger lifted |
| `Idle` | scrolling stopped (settled samples) |
| `Programmatic` | `scrollTo`, initial locator |
| `Layout` | size, theme or data change without scrolling |
| `Follow` | animated scroll that follows a highlight |

Rules (tested in `reader_host_test`):

- A block is visible when ≥ 50 % of `min(blockHeight, viewportHeight)` is on screen; inserts are reported separately and never count as blocks.
- **Jump:** a move of more than `jumpThreshold` blocks without continuous visibility: during a drag (`scroll`), a fling landing that far from where the finger lifted (`fling`), any programmatic scroll (`scrollTo`, always reported), or a far follow scroll (`follow`).
- **Furthest:** the end of the continuously read stretch, advanced only while that stretch starts at or before frontier + 1. The app can set the frontier (`furthestLocator`).
- **Section end:** the last block of a section enters the visible range during continuous reading; once per transition.
- **Follow:** like continuous reading; short follow moves never produce a jump.
- Flat block indices shift when app sections change, so the views carry the frontier over by block ID when they reload a snapshot.

### Highlights (`ReaderHighlights.cpp`)

- Input per highlight: `{ id, fromBlockId, fromOffset (-1 = block start), toBlockId, toOffset (-1 = block end), style, color, hasColor, follow }`.
- `ResolveHighlights(snapshot, inputs)` returns spans per block `[start, end)` with style and color, skipping image and separator blocks, clamping offsets to the block length and never splitting a surrogate pair. Unknown block IDs are reported as `invalidIds` (the view emits `onError` with `ERR_READER_INVALID_ARGUMENT`). It also returns the follow target (first highlight with `follow`): start block/offset and end block/offset.
- Android gets the result through JNI as a packed int array: `[followBlock, followOffset, invalidCount, invalid indices…, then per block: block, n, (start, end, style, color, hasColor)×n]`.
- **Drawing:**
  - Android: `SpannableString` with `BackgroundColorSpan` (accent at alpha 0x4D when no color), `ForegroundColorSpan`, and a custom `UnderlineColorSpan` (`TextPaint.underlineColor` on API 29+). Only rows whose spans changed are rebound, with the payload `PAYLOAD_HIGHLIGHT`, so no relayout happens.
  - iOS: `NSBackgroundColorAttributeName`, thick `NSUnderlineStyleAttributeName` + `NSUnderlineColorAttributeName`, `NSForegroundColorAttributeName`; visible cells are updated in place with `updateHighlights:theme:` (no `reloadData`).
- Highlights never change fonts, so row heights stay valid.

### Follow scrolling

- Target line: the line of the follow highlight's start offset (`layout.getLineTop` on Android, `lineTopForCharacterOffset:` on iOS).
- `keepVisible`: scroll only when that line is outside 10 %–85 % of the viewport, then place it at `anchor`. `center`: center it on every change. `off`: never.
- The follow scroll is animated and flagged (`followScroll` / `_followAnimation`); samples taken during it use `ScrollPhase::Follow`, so the tracker treats it as reading.
- A user drag while following (and `pauseOnUserScroll`) pauses following and emits `onFollowChange({ following: false, reason: 'user' })`. After the scroll settles, following resumes on its own when the target is back in the comfort zone (`'resumed'`). `resumeFollow()` resumes and places the target at the anchor even if it is already in the zone (`'command'`).

## 4. Read aloud

### TTS timeline (`src/pipeline/offlineOrchestrator.ts`, `src/tts/index.ts`)

- `tts.synthesize(…, { timeline: true })` records, for every orchestrated segment, its UTF-16 range in the input text buffer, `startSample` (running total of appended samples) and `numSamples`; skipped segments (silence) are marked `skipped`.
- Segmentation mode `off` yields one segment over the whole text (`wholeTextTimeline`).
- `exact: false` when the policy rewrites text (`overlapChars > 0`, `text_punctuation_assisted`).

### Timeline → reader (`src/reader/readAloud.ts`)

- **Sentences:** one per non-empty TTS segment, trimmed of surrounding whitespace; times from samples, so exact.
- **Words:** `splitWords` (whitespace tokens, edge punctuation trimmed) or the app's `words.split`. Each sentence's duration is spread over its words by weight = code-point length + pause bonus (5 after `.!?…`, 3 after `,;:`).
- **Aligned words:** matched in order against the word list with a normalized-text compare and a look-ahead of 6 words; matched words take the aligned sample times, the rest keep their estimates.
- All units are mapped with **one** `mapTextRanges` call, offset by `textOffset`.
- `at(ms)` is a binary search over sentences and words.
- `useReadAloudHighlights` memoizes on the spoken unit indices and the style options, so the native view receives a new `highlights` array only when the sentence or word changes. Default follow: the word when words are shown (a long sentence would otherwise scroll out of view), else the sentence.

## 5. Tests and checks

| What | Where | Run |
|---|---|---|
| Structure golden file, IDs, textHash, registry, MapTextRange, highlights, tracker (incl. Follow) | `test/cpp/reader/reader_host_test.cpp` | `cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target reader_host_test && ./test/cpp/build/reader_host_test` |
| JS API, highlight specs, read-aloud timeline | `src/reader/__tests__/` | `yarn jest src/reader` |
| TTS timeline | `src/tts/__tests__/synthesize-timeline.test.ts`, orchestrator tests | `yarn jest src/tts src/pipeline` |
| Turbo signatures | | `yarn check:ios-turbo-signatures` |

Device smoke checks (both platforms; build iOS and Android one after the other, never in parallel):

1. Example → **Reader**, Frankenstein: contents jump, chapter-end card, mark + note, search, appearance changes keep the first visible line, rotate.
2. Change the book and open it again: it resumes at the last position.
3. Example → **Read aloud**, Frankenstein: tap a paragraph, read aloud; sentence and word highlights move, follow keeps them in view, a drag pauses following, the button resumes it; playback continues across chunks and sections.

Android tips: drive the device with `adb shell input` and `uiautomator dump`; read JS logs with `adb logcat` (`ReactNativeJS`). A CDP log client that reconnects in a loop keeps the "Refreshing…" banner up and makes `uiautomator` fail with "could not get idle state". Fast Refresh re-runs effect cleanups, so a screen that releases its document in a cleanup must be reopened after an edit.

## 6. Change checklist

- New native prop: add it to `SherpaReaderViewNativeComponent.ts`, both view implementations and the Android view manager; check that its name does not collide with a Yoga style prop.
- New rule in the structure, IDs or hash: bump the matching version constant, update the golden file and reader.md.
- New tracker behavior: implement it in `ReaderTracker` only and add a host test; the views must stay thin.
- New highlight style: `ReaderHighlightStyle` (TS), `HighlightStyle` (C++), both renderers, docs.
- Keep the SDK use-case neutral: examples in code, tests and docs are generic (search, notes, read-aloud, guides).
