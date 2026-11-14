# Reader API (`react-native-sherpa-onnx/reader`)

> **Status: in development** on `feat/reader-api`. This page is the specification the implementation follows; it becomes the user guide once the API ships.

The reader API turns an extracted document into a **reader document with stable block IDs** and shows it in a **native, virtualized `ReaderView`** (iOS and Android). It works on the SDK's text and image buffers, so the same positions are shared by text, audio (read-aloud, later) and images.

```
1. Structure extraction   file → text/image buffers + structure (sections, blocks, ranges)
2. ReaderDocument         structure + buffers → document model with stable IDs (+ app sections)
3. ReaderView             native display (iOS, Android), inserts, events, commands
```

Requirements:

- **New Architecture (Fabric) only.** `ReaderView` is a Fabric component; it renders React children (inserts) inside the native list.
- **EPUB needs lexbor** (`sherpaOnnxEnableLexbor=true` on Android, `SHERPA_ONNX_ENABLE_LEXBOR=1` on iOS), same as `extractDocumentText`.
- MVP scope: EPUB, scroll mode, simple image blocks. PDF / TXT / OCR pages, paging and highlight come later.

---

## Quick start

```tsx
import {
  loadReaderDocument,
  insertSection,
  releaseReaderDocument,
  ReaderView,
  type ReaderDocument,
  type ReaderLocator,
} from 'react-native-sherpa-onnx/reader';

const doc = await loadReaderDocument(source); // FileSource of an .epub
const withPath = await insertSection(doc, {
  after: 's11',
  id: 'app:path-a',
  title: 'Another way',
  blocks: [{ key: 'p1', type: 'paragraph', text: '…' }],
});

<ReaderView
  ref={reader}
  document={withPath}
  initialLocator={saved}
  theme={{
    fontFamily: 'Literata',
    fontScale: 'system',
    lineHeight: 1.6,
    colors: { background: '#FBF8F1', text: '#2A2724', accent: '#3F3AB8' },
  }}
  inserts={[
    { key: 'invite-s11', at: { sectionEnd: 's11' } },
    { key: 'turning-point', at: { beforeBlock: 's24.b7' } },
  ]}
  renderInsert={(key) => <InviteCard id={key} />}
  onVisibleRangeChange={(range) => {}}
  onFurthestPositionChange={(locator) => {}}
  onSectionEnd={({ sectionId }) => {}}
  onJump={({ from, to, distance, cause }) => {}}
  onTap={() => {}}
/>;

reader.current?.scrollTo(locator);
await releaseReaderDocument(withPath);
```

---

## 1. Structure extraction

`extractDocumentText` (EPUB in v1) attaches a **structure** to the text buffer it fills. The structure stays in native memory next to the text; JS gets a summary and can page through blocks.

| Element | Fields |
|---|---|
| Section | `sectionIndex`, `href`, `kind` (`text` \| `image`), `title?`, `titleSource` (`toc` \| `heading` \| `none`), UTF-16 text range |
| Block | `type` (`paragraph` \| `heading` \| `image` \| `separator`), UTF-16 text range (empty for image / separator), `headingLevel` (1–6), `imageHref`, `alt` |
| Metadata | `title`, `creator`, `language` (from `dc:` in the OPF) |

### Structure rules, version 1

These rules are frozen as `structureVersion: 1`. Any change to them bumps the version (see [IDs](#2-readerdocument-and-stable-ids)).

- **Sections** are the *linear* spine items, numbered from 0 (`linear="no"` items are skipped, as in `extractDocumentText` today).
- **Block-forming tags:** `p`, `h1`–`h6`, `li`, `blockquote`, `pre`, `td`. `hr` produces a `separator` block. `img` and SVG `<image>` produce an `image` block. An image inside an open block is emitted **after** that block, so a paragraph is never split.
- **Block type** comes from the tag that closes the block; `h1`–`h6` → `heading` with `headingLevel` 1–6; loose text at body level → `paragraph`.
- **Whitespace:** runs of space, tab and newline inside text collapse to one space; `<br>` becomes `\n`; block ends are trimmed. `pre` keeps its text unchanged.
- **Text buffer layout:** text blocks only, joined by `\n\n`. Image and separator blocks have an empty range at the cursor position. `alt` text is not part of the buffer.
- **Titles:** EPUB 3 nav document (`nav[epub:type=toc]`, else the first `nav`), else the EPUB 2 NCX; the first TOC entry per file wins (`titleSource: 'toc'`). Fallback: text of the section's first heading (`'heading'`).
- **Image-only sections** (raw image spine items or XHTML that holds only images) get one `image` block per image.

---

## 2. ReaderDocument and stable IDs

`createReaderDocument({ text, images?, documentKey })` builds a native document (`rdr_*` handle) from a text buffer that carries a structure, plus an optional image buffer with the document's images. `loadReaderDocument(source)` does extraction, image extraction and hashing in one call.

| Field | Example | Purpose |
|---|---|---|
| `documentKey` | SHA-256 of the file (hex) | same file → same document on every device |
| `structureVersion` | `1` | version of the decomposition rules above |
| `textHashVersion` | `1` | version of the normalization + hash below |
| `blockId` | `s11.b42` | section 11, block 42 (both 0-based); short, readable, ordered |
| `textHash` | `9f2c41d07a3be511` | remaps stored positions if the decomposition changes |

**App sections** (text that is not in the file, e.g. generated path chapters) live in their own namespace: section ID `app:<id>` (`[A-Za-z0-9_-]+`), block IDs `app:<id>.<key>`. They are inserted after an existing section. `insertSection` / `removeSection` return a **new** `ReaderDocument` value with a higher `revision`; pass it to the view.

**Locator:** `{ sectionId, blockId, offset? }` — `offset` is an optional UTF-16 offset inside the block.

### textHash, version 1

1. Decode UTF-8 to code points (invalid bytes → U+FFFD).
2. Remove U+00AD, U+200B–U+200D, U+2060, U+FEFF.
3. Quotes: U+2018 U+2019 U+201A U+201B U+2032 U+02BC U+0060 U+00B4 U+2039 U+203A → `'`; U+201C–U+201F U+2033 U+00AB U+00BB → `"`.
4. U+2010–U+2015 and U+2212 → `-`; U+2026 → `...`.
5. Unicode whitespace (U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000) → runs collapse to one U+0020; trim both ends.
6. No case folding, no Unicode normalization (NFC/NFKC).
7. `textHash` = lowercase hex of the first 8 bytes of SHA-256 over the normalized UTF-8.
8. Image blocks hash `"\x1Fimage:" + href`, separators `"\x1Fseparator"`. The block type is not hashed.

When `structureVersion` changes, stored positions are remapped with `remapLocator` (nearest block with the same `textHash`).

---

## 3. ReaderView

Native list (iOS `UITableView`, Android `RecyclerView`), virtualized, scroll mode.

### Props

| Prop | Type | Notes |
|---|---|---|
| `document` | `ReaderDocument` | value from `createReaderDocument` / `insertSection` |
| `initialLocator` | `ReaderLocator?` | applied once on first layout; `onReady` fires afterwards |
| `furthestLocator` | `ReaderLocator?` | frontier for `onFurthestPositionChange`; the app owns it (e.g. after confirming a jump) |
| `mode` | `'scroll'` | `'paged'` later |
| `theme` | `ReaderTheme` | `fontFamily`, `fontSize`, `fontScale` (`'system'` = Dynamic Type / system font scale, or a number), `maxFontScale`, `lineHeight` (multiplier), `paragraphSpacing` (em), `margins`, `textAlign`, `hyphenation`, `colors { background, text, accent }` |
| `inserts` | `ReaderInsert[]` | `{ key, at: { sectionEnd } \| { beforeBlock } \| { afterBlock } }` |
| `renderInsert` | `(key) => ReactNode` | React Native view shown in the reading flow; full width, own height |
| `jumpThreshold` | `number` | blocks; default 20 |

### Events

| Event | Payload | Rule |
|---|---|---|
| `onReady` | `{ blockCount, sectionCount }` | first layout done, initial locator applied |
| `onVisibleRangeChange` | `{ first, last, firstOffset, settled, visibleInserts }` | first or last visible block changed; once more with `settled: true` when scrolling stops |
| `onFurthestPositionChange` | `ReaderLocator` | highest block seen while reading continuously |
| `onSectionEnd` | `{ sectionId, blockId }` | last block of a section became visible while reading continuously (once per transition) |
| `onJump` | `{ from, to, distance, cause }` | `cause`: `'scroll'` (moved > N blocks while dragging / scrubbing), `'fling'` (a fling landed > N blocks away), `'scrollTo'` (command) — the app decides whether it counts |
| `onTap` | `{ blockId }` | tap on the text (not on inserts), e.g. to toggle toolbars |

Visibility: a block counts as visible when at least 50 % of `min(blockHeight, viewportHeight)` is on screen. Event logic is shared C++ (`ReaderTracker`) on both platforms.

### Commands (ref)

- `scrollTo(locator, { animated? })`
- `highlight(range)` — reserved for read-aloud; not implemented in v1.

### Accessibility

VoiceOver and TalkBack read blocks in order; headings carry the header trait; image blocks use `alt` (images without `alt` are hidden); inserts are regular React Native views and stay accessible.
