# Offline PDF (`react-native-sherpa-onnx/pdf`)

Two opt-in APIs:

1. **`extractPdfTextLayer`** — digital text → `OfflineTextBuffer` (`origin: 'textLayer'`).
2. **`rasterizePdfPages`** — pages → `OfflineImageBuffer` (frames may include `pageNumber` / `dpi`).

Neither runs OCR. Scan-only PDFs reject text extract with `ERR_PDF_NO_TEXT_LAYER`; raster still works so you can call `createOCR().recognize` explicitly.

## Opt-in PDFium (default OFF)

Default SDK builds do **not** include PDFium.

| Platform | Enable |
|----------|--------|
| Android | `sherpaOnnxEnablePdfium=true` in the app (or library) `gradle.properties` |
| iOS | `SHERPA_ONNX_ENABLE_PDFIUM=1` when installing pods / building |

iOS vendors `pdfium.xcframework` with `pdfium.framework` slices. An autolinked app build phase copies `pdfium.framework` into the app bundle.

Prebuilts: [third_party/pdfium_prebuilt/README.md](../third_party/pdfium_prebuilt/README.md).

Without enable, both APIs reject with `ERR_PDF_PDFIUM_DISABLED`.

## FileSource I/O

`source` is a `FileSource` (see [fileio.md](fileio.md)). `extractPdfTextLayer` and `rasterize-all` close the handle when the call returns. **`lazy-lru` keeps the open PDFium document (and the fd / security-scoped URL) until `releaseOfflineImageBuffer`.** Standard PDF encryption: pass `options.password` (user or owner). Missing or wrong → `ERR_PDF_ENCRYPTED`. Not Adobe DRM / FileOpen.

| Kind | How the file is opened |
| --- | --- |
| `fs` / `app` (`cache`, `files`, …) / `pad` / iOS `appBundle` / iOS `securityScoped` | Direct seekable path. |
| Android `app` + `apkAsset` | APK zip entry has no fd. Copied to `<cache>/fileio_apkasset/…` on first open; later opens are a cache hit. |
| Android `contentUri` with ParcelFileDescriptor | Opened via `/proc/self/fd/N` (seekable). |
| Android `contentUri` stream (no PFD) | `ERR_PDF_OPEN_FAILED` (not `fileio_nofd`). |

## Quick start — text layer

```ts
import { createEmptyOfflineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import {
  extractPdfTextLayer,
  isPdfiumEnabled,
} from 'react-native-sherpa-onnx/pdf';

if (!(await isPdfiumEnabled())) {
  throw new Error('Rebuild with sherpaOnnxEnablePdfium=true / SHERPA_ONNX_ENABLE_PDFIUM=1');
}

const textOut = await createEmptyOfflineTextBuffer();
const result = await extractPdfTextLayer(
  { kind: 'fs', path: '/path/to/doc.pdf' },
  textOut,
  { pages: 'all' } // or [1, 2]
);
console.log(result.pageCount, result.spatialSpanCount);
```

## Quick start — page raster

```tsx
import {
  getOfflineImageBufferFrameInfo,
  OfflineImageBufferFrameView,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import { rasterizePdfPages, isPdfiumEnabled } from 'react-native-sherpa-onnx/pdf';

if (!(await isPdfiumEnabled())) {
  throw new Error('Rebuild with sherpaOnnxEnablePdfium=true / SHERPA_ONNX_ENABLE_PDFIUM=1');
}

const pages = await rasterizePdfPages(
  { kind: 'fs', path: '/path/to/doc.pdf' },
  { pages: 'all', dpi: 144, maxSide: 4096 }
);
const f0 = await getOfflineImageBufferFrameInfo(pages, 0);
console.log(f0.width, f0.height, f0.pageNumber, f0.dpi);

// In-app preview (native RGB; no file materialize)
<OfflineImageBufferFrameView
  buffer={pages}
  frameIndex={0}
  resizeMode="contain"
  maxSide={1024}
  style={{ width: '100%', height: 240 }}
/>

// Optional OCR:
// const engine = await createOCR({ ... });
// await engine.recognize(pages, textOut);

await releaseOfflineImageBuffer(pages);
```

Large PDFs — limit how many pages stay decoded (`state: 'lazy'`):

```tsx
import {
  ensureOfflineImageBufferFrame,
  OfflineImageBufferFrameView,
} from 'react-native-sherpa-onnx/imagebuffer';

const pages = await rasterizePdfPages(pdfSource, {
  strategy: 'lazy-lru',
  hotFrames: 8, // default 8, clamped 1..32
  dpi: 144,
  maxSide: 2048,
});
console.log(pages.info.state); // 'lazy'

await ensureOfflineImageBufferFrame(pages, 0);
// Or preview — FrameView ensures the visible frame:
<OfflineImageBufferFrameView buffer={pages} frameIndex={0} />
```

Defaults: `dpi = 144`, `maxSide = 4096` (`<= 0` disables), `strategy = 'rasterize-all'`.

## Raster strategies

`rasterizePdfPages` chooses how pages become OfflineImageBuffer frames via `strategy` (+ `hotFrames` for lazy).

| Strategy | `info.state` | When pages are decoded | Memory | Typical use |
|----------|-------------|------------------------|--------|-------------|
| `'rasterize-all'` (default) | `'immutable'` | All selected pages up front | Grows with page count × resolution | Small PDFs, one-shot OCR of every page |
| `'lazy-lru'` | `'lazy'` | On demand (ensureOfflineImageBufferFrame / FrameView / OCR) | At most `hotFrames` decoded pages (default **8**, clamped **1..32**) | Large PDFs, page slider / swipe viewer |

Effects of `'lazy-lru'`:

| Observable | Behavior |
|------------|----------|
| `frameCount` | Equals selected page count (slots exist immediately) |
| Cold frame info | `width` / `height` may be `0` until that frame is ensured |
| `ensureOfflineImageBufferFrame` | Decodes that page; returns full frame info |
| `OfflineImageBufferFrameView` | Ensures the visible `frameIndex` when it changes |
| Over `hotFrames` | Least-recently used decoded page is dropped; ensure again to bring it back |
| `releaseOfflineImageBuffer` | Releases the buffer (and the open PDF session) |

Prefer `'rasterize-all'` when every page will be used soon and the document is small. Prefer `'lazy-lru'` when the user browses pages (slider) or only a subset is OCR’d.

## API reference

From `react-native-sherpa-onnx/pdf`.

#### `isPdfiumEnabled()`

```ts
function isPdfiumEnabled(): Promise<boolean>;
```

```ts
const on = await isPdfiumEnabled();
```

#### `extractPdfTextLayer(source, textOut, options?)`

```ts
function extractPdfTextLayer(
  source: FileSource,
  textOut: OfflineTextBufferIdSource,
  options?: ExtractPdfTextLayerOptions
): Promise<ExtractPdfTextLayerResult>;
```

```ts
const r = await extractPdfTextLayer(pdfSource, textOut, { layout: 'paragraphs' });
```

Writes digital text into an empty TextBuffer (`origin: 'textLayer'`). Options: `pages`, `password`, `layout`, `signal`, `onProgress`. `layout: 'lines'` (default) gives one line per text line and fails with `ERR_PDF_NO_TEXT_LAYER` when there is no text. `layout: 'paragraphs'` gives reading text plus a reading structure (`result.structure`, see [Reading text and structure](#reading-text-and-structure)).

#### `rasterizePdfPages(source, options?)`

```ts
function rasterizePdfPages(
  source: FileSource,
  options?: RasterizePdfPagesOptions
): Promise<RasterizePdfPagesResult>;
```

```ts
const pages = await rasterizePdfPages(pdfSource, { dpi: 144, maxSide: 2048 });
const lazy = await rasterizePdfPages(pdfSource, {
  strategy: 'lazy-lru',
  hotFrames: 10,
});
```

Returns a new OfflineImageBuffer (no OCR). See [Raster strategies](#raster-strategies). Options:

| Option | Default | Notes |
|--------|---------|--------|
| `pages` | `'all'` | 1-based indices or `'all'` |
| `dpi` | `144` | must be `> 0` |
| `maxSide` | `4096` | longest-edge cap; `<= 0` disables |
| `strategy` | `'rasterize-all'` | `'lazy-lru'` → on-demand decode; see table above |
| `hotFrames` | `8` | `lazy-lru` only; clamped **1..32** |
| `password` | — | user or owner password for standard PDF encryption |
| `signal` / `onProgress` | — | cancel / progress |

## Formats

Seekable PDF file. Sniff is the PDF signature (`%PDF`), not the extension. Needs opt-in PDFium.

| Input | `extractPdfTextLayer` | `rasterizePdfPages` |
| --- | --- | --- |
| Digital PDF (text layer) | UTF-16 `origin: 'textLayer'` | RGB8 ImageBuffer pages |
| Scan-only PDF | `ERR_PDF_NO_TEXT_LAYER`; with `layout: 'paragraphs'` sections with only their page (`pagesWithText: 0`) | RGB8 ImageBuffer pages |
| Standard encryption | `options.password` (user or owner); wrong/missing → `ERR_PDF_ENCRYPTED` | same |
| Adobe DRM / FileOpen | not supported | not supported |

Raster default **144 dpi**, `maxSide` **4096**. Non-seekable Android `contentUri` stream → `ERR_PDF_OPEN_FAILED`.

Out of scope: EPUB / Office ([`document/`](document-offline.md)), OCR (call `createOCR().recognize` on rasters), incremental save/edit.

## Spans and coordinates (text layer)

Text-layer spans on the TextBuffer:

| Field | Notes |
|-------|--------|
| `origin` | `'textLayer'` |
| `pageNumber` | 1-based |
| `pageWidth` / `pageHeight` | Page size in PDF user space |
| `sourceImageBufferId` | Empty (no ImageBuffer) |
| `quad` | Top-left origin, y-down, PDF user space |

Raster frames use the same top-left / y-down convention, so overlays can map quads onto frame pixels via page size and frame size (`mapTextSpatialSpansToFrame` or `OfflineImageBufferAnnotatedView` in [imagebuffer-offline.md](./imagebuffer-offline.md)).

With `layout: 'paragraphs'` the spans also carry `sectionIndex` (page − 1) and `href` (`page:N`).

See [textbuffer-offline.md](./textbuffer-offline.md) and [imagebuffer-offline.md](./imagebuffer-offline.md).

## Reading text and structure

`layout: 'paragraphs'` turns the text layer into reading text and attaches a reading structure (`format: 'pdf'`) to the buffer. The reader reads the same structure (see [reader.md](reader.md)).

```ts
const r = await extractPdfTextLayer(pdfSource, textOut, { layout: 'paragraphs' });
r.structure?.sections[0]; // { kind: 'page', href: 'page:1', label: 'i', title?, ... }
```

| What | How it is found |
| --- | --- |
| Paragraphs | Lines close below each other, without a first-line indent, after a line that ended where the next line's first word would not have fit. Wrapped lines are joined by a space (none between CJK characters), and a word hyphenated at a line end is rejoined. Paragraphs are separated by a blank line. |
| Headings | Lines clearly larger than the body text (≥ 1.15 × the most common font size). Sizes within 15 % of each other share a level; levels 1–3 from the largest down. Heading lines that wrap are merged. |
| Running headers, footers, page numbers | Lines in the top or bottom 10 % of the page that repeat on several pages (digits ignored), or that look like a page number. They stay in the text, flagged as furniture, so a reader can hide them. |
| Sections | One per page (`kind: 'page'`, `href: 'page:N'`, `label` from the PDF's page labels). The first block of each section is the page itself. A page without text is a section with only that block. |
| Contents | The PDF outline (bookmarks), pointed at the matching heading on its page; without an outline, the detected headings. A section's `title` comes from the contents first, else from its first heading. |
| Metadata | `metadata.title` and `metadata.creator` from the document info, `metadata.language` from the catalog (`/Lang`). |

The text keeps PDFium's order, which is the order the PDF draws its text in. Columns stay in the right order when the PDF draws them one after the other, which is the usual case. Columns drawn line by line across the page are not re-sorted. A paragraph that runs over a page break is split at the page. Reading text and blocks may change between versions; the structure carries a version for that (`structure.version`).

## Errors

| Code | Meaning |
|------|---------|
| `ERR_PDF_PDFIUM_DISABLED` | Binary built without PDFium |
| `ERR_PDF_INVALID_ARGUMENT` | Bad source / pages / dpi / layout / populated text buffer |
| `ERR_PDF_OPEN_FAILED` | Unreadable / corrupt PDF, or a non-seekable source (stream, PFD with no length) |
| `ERR_PDF_ENCRYPTED` | Encrypted PDF; missing or incorrect `options.password` |
| `ERR_PDF_NO_TEXT_LAYER` | No extractable text (extract with `layout: 'lines'` only) |
| `ERR_PDF_RENDER_FAILED` | Page raster failed |
| `ERR_PDF_CANCELLED` | AbortSignal / cancel |

## Use case examples

<details>
<summary>Page slider / swipe viewer for a large PDF (lazy-lru)</summary>

Keep memory bounded while the user flips through pages. FrameView ensures the visible page; older pages drop out of the hot set automatically. After extract or OCR, overlay boxes with [`OfflineImageBufferAnnotatedView`](imagebuffer-offline.md#offlineimagebufferannotatedview) (same `frameIndex`).

```tsx
import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import {
  OfflineImageBufferFrameView,
  releaseOfflineImageBuffer,
  type OfflineImageBufferRef,
} from 'react-native-sherpa-onnx/imagebuffer';
import { rasterizePdfPages } from 'react-native-sherpa-onnx/pdf';

const [pages, setPages] = useState<OfflineImageBufferRef | null>(null);
const [index, setIndex] = useState(0);

// Once, when the PDF is opened:
const buffer = await rasterizePdfPages(
  { kind: 'fs', path: '/path/to/large.pdf' },
  { strategy: 'lazy-lru', hotFrames: 4, dpi: 144, maxSide: 2048 }
);
setPages(buffer);
setIndex(0);

// UI: one FrameView + prev/next (or a pager that sets frameIndex)
{pages ? (
  <View>
    <OfflineImageBufferFrameView
      buffer={pages}
      frameIndex={index}
      resizeMode="contain"
      maxSide={1280}
      style={{ width: '100%', height: 400 }}
    />
    <Text>
      Page {index + 1} / {pages.info.frameCount}
    </Text>
    <Button
      title="Previous"
      disabled={index <= 0}
      onPress={() => setIndex((i) => Math.max(0, i - 1))}
    />
    <Button
      title="Next"
      disabled={index >= pages.info.frameCount - 1}
      onPress={() => setIndex((i) => Math.min(pages.info.frameCount - 1, i + 1))}
    />
  </View>
) : null}

// When leaving the screen:
await releaseOfflineImageBuffer(pages);
```

</details>

<details>
<summary>Rasterize once, then OCR every page (rasterize-all)</summary>

```ts
const pages = await rasterizePdfPages(pdfSource, {
  strategy: 'rasterize-all', // default
  dpi: 144,
  maxSide: 2048,
});
// const engine = await createOCR({ ... });
// await engine.recognize(pages, textOut);
await releaseOfflineImageBuffer(pages);
```

</details>

## Example app

Fixtures: `example/.../test_pdfs/` (`digital_hello.pdf` / `digital_multipage.pdf` / `scan_only_page.pdf` / `scan_only_multipage.pdf`). The example enables PDFium (`example/android/gradle.properties` + `example/ios/Podfile`); apps should leave the SDK default off unless they need PDF. See [example/README.md](../example/README.md).

Preview: [`OfflineImageBufferFrameView`](./imagebuffer-offline.md). Export: `exportOfflineImageBufferFrame` with a [`FileDestination`](./fileio.md).

## See also

- [ocr-offline.md](./ocr-offline.md)
- [imagebuffer-offline.md](./imagebuffer-offline.md)
- [textbuffer-offline.md](./textbuffer-offline.md)
