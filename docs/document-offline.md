# Offline e-documents (`react-native-sherpa-onnx/document`)

Two APIs, one buffer type per call:

1. **`extractDocumentText`** — markup → `OfflineTextBuffer` (`origin: 'markup'`). **Never OCR.**
2. **`extractDocumentImages`** — image-only sections / CBZ / CBR → `OfflineImageBuffer`.

This module is a source adapter like [`pdf/`](pdf-offline.md). It is not a reader, not a layout engine, and not a third recognize path. Mixed books: the app calls both APIs and concatenates TTS slices itself.

libarchive is **default-on** (same flag as archive helpers). Disable → `ERR_DOC_ARCHIVE_DISABLED`. There is no `isLibarchiveEnabled()` and no extra enable flag.

XML uses embedded pugixml (`third_party/pugixml`, v1.16). EPUB XHTML uses lexbor via the same TAG + prebuilt pipeline as libarchive (`third_party/lexbor` v3.0.0, `third_party/lexbor_prebuilt`). No lexbor disable flag.

**Android first.** Log tag `[SherpaOnnx:doc]`.

## Formats

Sniff is by file signature / container, not by extension. Format is returned on the result, not as a public detect API.

| Format | `extractDocumentText` | `extractDocumentImages` |
|--------|----------------------|-------------------------|
| EPUB 2 / 3 | Spine XHTML in reading order; `linear="no"` skipped | Only spine items **without** extractable text |
| FB2 / FB2.ZIP / FBZ | XML in document order (`format: 'fb2'` even inside a zip) | Only sections without accompanying text (`<binary>`) |
| CBZ | `ERR_DOC_NO_TEXT` | ZIP images, natural sort of archive paths |
| CBR | `ERR_DOC_NO_TEXT` | Same as CBZ; RAR/RAR5 via libarchive. Host tests read committed store-only RAR3 `test/fixtures/document/tiny-comic.cbr` (2 pages) |

Pure text EPUB: text succeeds, `imageOnlySections = []`. Images → `ERR_DOC_NO_IMAGES`.

Pure CBZ/CBR / scan EPUB: text → `ERR_DOC_NO_TEXT`. Images succeed (undecodable files are skipped).

Mixed EPUB: text succeeds with `imageOnlySections.length > 0`. Images are **exactly** those sections; frames carry `sectionIndex`.

Not this module: DRM content, KFX, AZW4, Topaz, DjVu, CHM, Office, TXT, loose HTML, PDF (use [`pdf/`](pdf-offline.md)), MOBI/KF8 (later). Password-protected ZIP/RAR → `ERR_DOC_DRM`.

Font-only `encryption.xml` is **not** DRM; content encryption is.

## Quick start — text

```ts
import { createEmptyOfflineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import { extractDocumentText } from 'react-native-sherpa-onnx/document';

const textOut = await createEmptyOfflineTextBuffer();
const result = await extractDocumentText(
  { kind: 'fs', path: '/path/to/book.epub' },
  textOut
);
console.log(result.format, result.sectionCount, result.spatialSpanCount);
```

`textOut` is **required** and must be empty (same ownership as PDF). `result.buffer === textOut`.

## Quick start — images

```ts
import {
  getOfflineImageBufferFrameInfo,
  OfflineImageBufferFrameView,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import { extractDocumentImages } from 'react-native-sherpa-onnx/document';

const images = await extractDocumentImages(
  { kind: 'fs', path: '/path/to/book.cbz' },
  { maxSide: 2048 }
);
const f0 = await getOfflineImageBufferFrameInfo(images.buffer, 0);
console.log(f0.width, f0.href, f0.pageNumber);

<OfflineImageBufferFrameView
  buffer={images.buffer}
  frameIndex={0}
  resizeMode="contain"
  style={{ width: '100%', height: 240 }}
/>

await releaseOfflineImageBuffer(images.buffer);
```

## Mixed books (app, not SDK)

```ts
const text = await extractDocumentText(src, textOut);
if (text.imageOnlySections.length > 0) {
  const images = await extractDocumentImages(src);
  const ocrOut = await createEmptyOfflineTextBuffer();
  await ocr.recognize(images.buffer, ocrOut);
  // TTS: join markup + OCR slices in sectionIndex order in the app
}
```

No native merge, no `interleaveDocumentText`, no cover harvest, no chapter illustrations from text spine items.

## API

From `react-native-sherpa-onnx/document`.

#### `extractDocumentText(source, textOut, options?)`

```ts
function extractDocumentText(
  source: FileSource,
  textOut: OfflineTextBufferIdSource,
  options?: ExtractDocumentTextOptions
): Promise<ExtractDocumentTextResult>;
```

`source` is `FileSource` (no `fromBytes` in this ship). Options: `signal`, `onProgress`.

```ts
type ExtractDocumentTextResult = {
  buffer: OfflineTextBufferHandle; // === textOut
  format: 'epub' | 'fb2' | 'mobi';
  sectionCount: number;
  sections: DocumentSectionInfo[];
  imageOnlySections: DocumentSectionInfo[];
  spatialSpanCount: number;
};

type DocumentSectionInfo = {
  sectionIndex: number; // 0-based reading order
  href?: string;
  kind: 'text' | 'image';
};
```

`sectionCount` / `sections` are linear spine items only (`linear="yes"` or missing). `imageOnlySections` is a subset.

Whole document without markup (CBZ/CBR, scan-only) → `ERR_DOC_NO_TEXT`. Mixed EPUB is **not** an error.

Progress events: `SherpaOnnxDocProgress` `{ done, total, phase }` (`open` / `section` / `entry` / `done`).

#### `extractDocumentImages(source, options?)`

```ts
function extractDocumentImages(
  source: FileSource,
  options?: ExtractDocumentImagesOptions
): Promise<ExtractDocumentImagesResult>;
```

```ts
type ExtractDocumentImagesResult = {
  buffer: OfflineImageBufferHandle;
  format: 'epub' | 'fb2' | 'mobi' | 'cbz' | 'cbr';
  frameCount: number;
};
```

| Option | Default | Notes |
|--------|---------|--------|
| `maxSide` | `4096` | longest-edge cap after decode; `<= 0` disables |
| `signal` / `onProgress` | — | cancel / progress |

| Input | Frames |
|-------|--------|
| CBZ / CBR | Image files, natural sort, skip `ComicInfo.xml` / thumbs / `.` files; skip undecodable codecs |
| EPUB / FB2 image-only sections | Those sections only, order = `sectionIndex` |
| Pure text document | `ERR_DOC_NO_IMAGES` |

You do **not** have to call text extract first. After a successful text extract with empty `imageOnlySections`, images still return `ERR_DOC_NO_IMAGES`.

CBZ/CBR `pageNumber` is 1-based display index **after** sort. `href` is the archive path. EPUB/FB2 frames use `sectionIndex` + `href`.

Zero decodable frames after skips → `ERR_DOC_NO_IMAGES`.

## Markup spans

One span per block element (`p`, `h1`–`h6`, `li`, `blockquote`, `pre`, `td`). Same `sectionIndex` (+ `href`) on every span of that section.

| Field | Content |
|-------|---------|
| `utf16Start` / `utf16End` | Range in the buffer |
| `level` | `'block'` |
| `origin` | `'markup'` |
| `sectionIndex` | Reading order |
| `href` | EPUB path / FB2 id / archive path when present |
| `sourceImageBufferId` | empty |
| `quad` | Required schema: **null quad** `(0,0,…,0)`. AnnotatedView does not draw `markup` |
| `frameIndex` | `0` |
| `pageNumber` | unused |

Text rules: blocks joined with `\n\n`; `<br>` → `\n`; ruby keeps `rb`, drops `rt`/`rp`; `script` / `style` / `head` / `template` dropped. `alt` / `title` / `aria` do **not** count as text (scan chapters stay image-only). No CSS. Tokens / timestamps stay empty.

## File I/O

Seekable handle required for the whole extract, then closed.

| Source | How |
|--------|-----|
| Filesystem path / iOS security-scoped file | `archive_read_open_filename` |
| Android `contentUri` with `ParcelFileDescriptor` | `archive_read_open_fd` |
| Stream-only / non-seekable `apkAsset` | `ERR_DOC_OPEN_FAILED` |

No temp zip copy, no full-archive RAM slurp, no `zip_streamable` consolation path. Limits → `ERR_DOC_OPEN_FAILED`: **10 000** entries, **64 MiB** per file, **512 MiB** uncompressed total.

Uncompressed FB2 is the document itself (64 MiB cap), not a zip consolation path.

## Errors

| Code | When |
|------|------|
| `ERR_DOC_ARCHIVE_DISABLED` | libarchive built out |
| `ERR_DOC_UNSUPPORTED_FORMAT` | PDF, HTML file, MOBI (this ship), unknown, KFX, … |
| `ERR_DOC_DRM` | Content encryption / password-protected archive |
| `ERR_DOC_OPEN_FAILED` | Unreadable, not seekable, zip bomb / limits |
| `ERR_DOC_NO_TEXT` | No markup in the whole document |
| `ERR_DOC_NO_IMAGES` | No image-only sections / no decodable image |
| `ERR_DOC_INVALID_ARGUMENT` | Bad source / missing or already populated `textOut` |
| `ERR_DOC_CANCELLED` | AbortSignal |
| `ERR_DOC_PARSE_FAILED` | Broken OPF / XHTML / FB2 |

No silent fallbacks. If the I/O contract cannot be met, reject with one of the codes above.

## Display (not a reader)

| Content | Who shows what |
|---------|----------------|
| Flowing text | App: `getOfflineTextBufferTextSlice`; TTS cursor over UTF-16 spans |
| CBZ / CBR / image-only frames | `OfflineImageBufferFrameView`; after OCR `OfflineImageBufferAnnotatedView` (`origin: 'ocr'`) |
| `origin: 'markup'` | no quad boxes (`mapTextSpatialSpansToFrame` already skips `markup`) |

No `OfflineTextBufferView` in this module. No example screen in this ship.

## See also

- [Offline PDF](pdf-offline.md)
- [Offline OCR](ocr-offline.md)
- [ImageBuffer](imagebuffer-offline.md)
- [TextBuffer](textbuffer-offline.md)
- [Feature pipelines](feature-pipelines.md)
- [Disable libarchive](disable-libarchive.md)
