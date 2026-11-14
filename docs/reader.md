# Reader API (`react-native-sherpa-onnx/reader`)

The reader API turns an EPUB into a **reader document with stable block IDs** and shows it in a **native, virtualized `ReaderView`** on iOS and Android. It works on the SDK's text and image buffers, so text, images and (later) read-aloud share the same positions.

```
1. Structure extraction   file → text/image buffers + structure (sections, blocks, ranges)
2. ReaderDocument         structure + buffers → document with stable IDs (+ app sections)
3. ReaderView             native display, React Native inserts, reading events, commands
```

Requirements and scope:

- **New Architecture (Fabric) only.** `ReaderView` is a Fabric component. It shows React children (inserts) inside the native list.
- **EPUB needs lexbor** (`sherpaOnnxEnableLexbor=true` on Android, `SHERPA_ONNX_ENABLE_LEXBOR=1` on iOS), the same as `extractDocumentText`.
- **v1 scope:**
  - EPUB only, in scroll mode, with simple image blocks.
  - Not yet supported: paging, zoom, highlight, and PDF / TXT / OCR pages.

The example app has a **Reader** screen (`example/src/screens/reader/`) that demonstrates the whole API.

---

## Quick start

```tsx
import { useRef } from 'react';
import {
  loadReaderDocument,
  insertSection,
  releaseReaderDocument,
  ReaderView,
  type ReaderViewHandle,
} from 'react-native-sherpa-onnx/reader';

const doc = await loadReaderDocument(source); // FileSource of an .epub
const withPath = await insertSection(doc, {
  after: 's11',
  id: 'app:path-a',
  title: 'Another way',
  blocks: [{ key: 'p1', type: 'paragraph', text: '…' }],
});

const reader = useRef<ReaderViewHandle>(null);

<ReaderView
  ref={reader}
  document={withPath}
  initialLocator={saved}
  furthestLocator={furthest}
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
await releaseReaderDocument(withPath); // when the book is closed
```

---

## 1. Structure extraction

For EPUB, `extractDocumentText` attaches a **structure** to the text buffer it fills (see [document-offline.md](document-offline.md)). The structure stays in native memory next to the text. JS gets a summary in the result's `structure` field. Book text is never sent over the bridge unless you ask for it (`getReaderBlocks(…, { includeText: true })`).

| Element | Fields |
|---|---|
| Section | `sectionIndex`, `href`, `kind` (`text` \| `image`), `title?`, `titleSource` (`toc` \| `heading` \| `none`), UTF-16 text range |
| Block | `type` (`paragraph` \| `heading` \| `image` \| `separator`), UTF-16 text range (empty for image and separator), `headingLevel` (1–6), `imageHref`, `alt` |
| Metadata | `title`, `creator`, `language` (from `dc:` in the OPF) |

`extractDocumentImages(source, { scope: 'all' })` decodes every image the reading order references, inline images included. Each path is decoded once. The reader matches images to blocks by `href`. `loadReaderDocument` calls it for you.

### Structure rules, version 1

These rules are frozen as `structureVersion: 1`. Any change to them bumps the version (see [IDs](#2-readerdocument-and-stable-ids)). A golden file (`test/fixtures/reader/structure.reader-v1.txt`) makes the native tests fail on any unversioned change.

- **Sections** are the *linear* spine items, numbered from 0. Items with `linear="no"` are skipped.
- **Block-forming tags:** `p`, `h1`–`h6`, `li`, `blockquote`, `pre`, `td`.
  - `hr` produces a `separator` block.
  - `img` and SVG `<image>` produce an `image` block. An image inside an open block is emitted **after** that block, so a paragraph is never split.
- **Block type** comes from the tag that closes the block:
  - `h1`–`h6` → `heading` with `headingLevel` 1–6.
  - Loose text at body level → `paragraph`.
- **Whitespace:**
  - Runs of space, tab and newline inside text collapse to one space.
  - `<br>` becomes `\n`.
  - Block ends are trimmed.
  - `pre` keeps its text unchanged.
- **Text buffer layout:**
  - The buffer holds text blocks only, joined by `\n\n`.
  - Image and separator blocks have an empty range at the cursor position.
  - `alt` text is not part of the buffer.
- **Titles:**
  - First choice is the EPUB 3 nav document (`nav[epub:type=toc]`, else the first `nav`), then the EPUB 2 NCX. The first TOC entry per file wins (`titleSource: 'toc'`).
  - Fallback: the text of the section's first heading (`'heading'`).
- **Image-only sections** (raw image spine items, or XHTML that holds only images) get one `image` block per image.

---

## 2. ReaderDocument and stable IDs

| Field | Example | Purpose |
|---|---|---|
| `documentKey` | SHA-256 of the file (hex) | Same file → same document on every device |
| `structureVersion` | `1` | Version of the decomposition rules above |
| `textHashVersion` | `1` | Version of the normalization and hash below |
| `revision` | `1`, `2`, … | Increases with every `insertSection` / `removeSection` |
| `blockId` | `s11.b42` | Section 11, block 42 (both 0-based); short, readable, ordered |
| `textHash` | `9f2c41d07a3be511` | Remaps stored positions if the decomposition changes |

**App sections** hold text that is not in the file, for example generated path chapters.
- They have their own namespace: section ID `app:<id>` (`[A-Za-z0-9_-]+`), block IDs `app:<id>.<key>`.
- Each one is inserted after an existing section.
- Their blocks have the types `paragraph`, `heading` and `separator`.

**Locator:** `{ sectionId, blockId, offset? }`. `offset` is an optional UTF-16 offset inside the block.

### Functions

| Function | Result |
|---|---|
| `loadReaderDocument(source, { imagesMaxSide? })` | Extracts the text, images (`scope: 'all'`, max side 2048 by default) and `documentKey`, then calls `createReaderDocument`. The document owns the image buffer; the temporary text handle is released. |
| `createReaderDocument({ text, images?, documentKey })` | Builds a document from a text buffer that carries a structure (`ERR_READER_NO_STRUCTURE` otherwise) and an optional image buffer. |
| `computeDocumentKey(source)` | SHA-256 (hex) of the file, computed natively. |
| `insertSection(doc, { after, id, title?, blocks })` | Returns a **new** `ReaderDocument` value with a higher `revision`; pass it to the view. The old value stays readable until it is released. |
| `removeSection(doc, sectionId)` | Removes an app section; returns a new value. |
| `getReaderBlocks(doc, start?, count?, { includeText? })` | Blocks in reading order with `id`, `sectionId`, `type`, `textHash`, … The native side pages in chunks of 4096. |
| `remapLocator(doc, { textHash, offset? }, hint?)` | The block with the same `textHash` nearest to `hint`, or `null`. Use it when `structureVersion` changed since a position was stored. |
| `releaseReaderDocument(doc)` | Frees the native document and, when created by `loadReaderDocument`, its image buffer. |
| `formatBlockId`, `parseBlockId`, `compareLocators` | Helpers. `compareLocators` returns `null` when the order is not defined, for example between an app section and a file section. |

Errors carry `code` from `ReaderErrorCode`:
- `ERR_READER_NOT_FOUND`
- `ERR_READER_NO_STRUCTURE`
- `ERR_READER_UNSUPPORTED_STRUCTURE`
- `ERR_READER_INVALID_ARGUMENT`

Store positions together with `documentKey`, `structureVersion` and the block's `textHash`. Then a position survives a later structure version.

### textHash, version 1

1. Decode UTF-8 to code points (invalid bytes → U+FFFD).
2. Remove U+00AD, U+200B–U+200D, U+2060 and U+FEFF.
3. Quotes:
   - U+2018, U+2019, U+201A, U+201B, U+2032, U+02BC, U+0060, U+00B4, U+2039, U+203A → `'`.
   - U+201C–U+201F, U+2033, U+00AB, U+00BB → `"`.
4. U+2010–U+2015 and U+2212 → `-`; U+2026 → `...`.
5. Unicode whitespace (U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000): each run collapses to one U+0020, and both ends are trimmed.
6. No case folding and no Unicode normalization (NFC/NFKC).
7. `textHash` = lowercase hex of the first 8 bytes of SHA-256 over the normalized UTF-8.
8. Image blocks hash `"\x1Fimage:" + href`, separators hash `"\x1Fseparator"`. The block type is not part of the hash.

Reference implementation (Python 3; matches the native code byte for byte, for backends):

```python
import hashlib

DROP = {0x00AD, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF}
SQ = {0x2018, 0x2019, 0x201A, 0x201B, 0x2032, 0x02BC, 0x0060, 0x00B4, 0x2039, 0x203A}
DQ = {0x201C, 0x201D, 0x201E, 0x201F, 0x2033, 0x00AB, 0x00BB}
WS = (set(range(0x09, 0x0E)) | set(range(0x2000, 0x200B))
      | {0x20, 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000})

def normalize_v1(text: str) -> str:
    out, space = [], False
    for ch in text:
        cp = ord(ch)
        if cp in DROP:
            continue
        if cp in WS:
            space = bool(out)  # leading whitespace is dropped
            continue
        if space:
            out.append(" ")
            space = False
        if cp in SQ:
            out.append("'")
        elif cp in DQ:
            out.append('"')
        elif 0x2010 <= cp <= 0x2015 or cp == 0x2212:
            out.append("-")
        elif cp == 0x2026:
            out.append("...")
        else:
            out.append(ch)
    return "".join(out)  # trailing whitespace never emits a space

def text_hash_v1(text: str) -> str:
    return hashlib.sha256(normalize_v1(text).encode("utf-8")).hexdigest()[:16]

def image_hash_v1(href: str) -> str:
    return hashlib.sha256(("\x1fimage:" + href).encode("utf-8")).hexdigest()[:16]

SEPARATOR_HASH_V1 = hashlib.sha256(b"\x1fseparator").hexdigest()[:16]
```

---

## 3. ReaderView

The view is a native list: `UITableView` with TextKit 1 text cells on iOS, `RecyclerView` with `TextView` rows on Android. It is virtualized and runs in scroll mode. Book text is read from native memory per visible block.

### Props

| Prop | Type | Notes |
|---|---|---|
| `document` | `ReaderDocument \| null` | Value from `createReaderDocument` / `insertSection`. A new `revision` keeps the reading position. |
| `initialLocator` | `ReaderLocator?` | Applied once, on the first layout of a document. `onReady` fires afterwards. |
| `furthestLocator` | `ReaderLocator?` | Start value of the frontier for `onFurthestPositionChange`. The app owns it, for example after confirming a jump. |
| `mode` | `'scroll'` | Paged mode comes later. |
| `theme` | `ReaderTheme` | See below. |
| `inserts` | `ReaderInsert[]` | `{ key, at: { sectionEnd } \| { beforeBlock } \| { afterBlock } }` |
| `renderInsert` | `(key) => ReactNode` | A React Native view in the reading flow: full width, its own height (Yoga). Presses, height changes and accessibility work as usual. |
| `jumpThreshold` | `number` | In blocks; default 20. |

`ReaderTheme` fields:

| Field | Meaning |
|---|---|
| `fontFamily` | Font family, resolved as for `<Text>`; default is the system serif. |
| `fontSize` | Size in pt/dp; default 18. |
| `fontScale` | `'system'` (default) follows Dynamic Type / the system font scale; a number multiplies `fontSize`. |
| `maxFontScale` | Upper limit for the `'system'` scale. |
| `lineHeight` | Line-height multiplier; default 1.5. |
| `paragraphSpacing` | Space between blocks, in em; default 0.75. |
| `margins` | `{ horizontal, vertical }`; default 20 / 24. |
| `textAlign` | `'start'` or `'justify'`. |
| `hyphenation` | Default `true`. Uses the book's `language`. |
| `colors` | `{ background, text, accent }`; `accent` is reserved for highlights. |

When the theme changes, the first visible block stays in place. The same holds for a width change (rotation) and for a new `revision`.

### Events

| Event | Payload | Rule |
|---|---|---|
| `onReady` | `{ blockCount, sectionCount }` | First layout of a document done, initial locator applied. |
| `onVisibleRangeChange` | `{ first, last, firstOffset, settled, visibleInserts }` | Fires when the first or last visible block changes, and once more with `settled: true` when scrolling stops. `firstOffset` (settled only) is the UTF-16 offset of the first visible line of `first`. |
| `onFurthestPositionChange` | `ReaderLocator` | The frontier advanced while reading continuously. |
| `onSectionEnd` | `{ sectionId, blockId }` | The last block of a section came into view while reading continuously. Fires once per transition into view; scrolling away and back fires it again. |
| `onJump` | `{ from, to, distance, cause }` | The position moved more than `jumpThreshold` blocks. The app decides whether the jump counts as reading. |
| `onTap` | `{ blockId }` | Tap on text, not on inserts; for example to toggle toolbars. |
| `onError` | `{ code, message }` | For example `ERR_READER_NOT_FOUND` for a released document. |

Event rules (shared C++ `ReaderTracker`, identical on both platforms):

- **Visible:** a block counts when at least 50 % of `min(blockHeight, viewportHeight)` is on screen. Inserts are reported in `visibleInserts` but are not blocks.
- **Furthest position:** advances only when the continuously visible range touches the current frontier. A jump forward does not move it. The app can accept a jump by setting `furthestLocator`.
- **Jump causes:**
  - `'scroll'`: the visible range moved more than N blocks without continuous visibility, for example by dragging the scroll indicator.
  - `'fling'`: a fling landed more than N blocks away.
  - `'scrollTo'`: the jump came from the command; this cause is always reported.

### Commands (ref)

- `scrollTo(locator, { animated? })`: puts the block, and the line holding `offset`, at the top of the reading area. If `blockId` is unknown, `sectionId` is used. Restoring a stored `{ blockId, offset }` from a settled `onVisibleRangeChange` lands on the same line.
- `highlight(range)`: reserved for read-aloud; it does nothing in v1 and warns in development.

### Accessibility

- VoiceOver and TalkBack read the blocks in order.
- Headings carry the header trait (`accessibilityHeading` on Android).
- Image blocks use `alt`; images without `alt` are hidden.
- Inserts are regular React Native views and stay accessible.

### Limits (v1)

- EPUB only; scroll mode only; no zoom, no text selection, no highlight.
- An image is scaled to the text width and is at most 90 % of the viewport high.
- The text in a block has a single style; inline formatting such as italics is not kept yet.
