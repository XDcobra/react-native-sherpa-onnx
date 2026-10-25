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

Prebuilts: [third_party/pdfium_prebuilt/README.md](../third_party/pdfium_prebuilt/README.md).

Without enable, both APIs reject with `ERR_PDF_PDFIUM_DISABLED`.

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
const r = await extractPdfTextLayer(pdfSource, textOut, { pages: [1] });
```

Writes digital text into an empty TextBuffer (`origin: 'textLayer'`). No text layer → `ERR_PDF_NO_TEXT_LAYER`. Options: `pages`, `signal`, `onProgress`.

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
| `signal` / `onProgress` | — | cancel / progress |

## Spans and coordinates (text layer)

Text-layer spans on the TextBuffer:

| Field | Notes |
|-------|--------|
| `origin` | `'textLayer'` |
| `pageNumber` | 1-based |
| `pageWidth` / `pageHeight` | Page size in PDF user space |
| `sourceImageBufferId` | Empty (no ImageBuffer) |
| `quad` | Top-left origin, y-down, PDF user space |

Raster frames use the same top-left / y-down convention, so overlays can map quads onto frame pixels via page size and frame size.

See [textbuffer-offline.md](./textbuffer-offline.md) and [imagebuffer-offline.md](./imagebuffer-offline.md).

## Errors

| Code | Meaning |
|------|---------|
| `ERR_PDF_PDFIUM_DISABLED` | Binary built without PDFium |
| `ERR_PDF_INVALID_ARGUMENT` | Bad source / pages / dpi / populated text buffer |
| `ERR_PDF_OPEN_FAILED` | Unreadable / corrupt PDF |
| `ERR_PDF_ENCRYPTED` | Password-protected |
| `ERR_PDF_NO_TEXT_LAYER` | No extractable text (extract only) |
| `ERR_PDF_RENDER_FAILED` | Page raster failed |
| `ERR_PDF_CANCELLED` | AbortSignal / cancel |

## Use case examples

<details>
<summary>Page slider / swipe viewer for a large PDF (lazy-lru)</summary>

Keep memory bounded while the user flips through pages. FrameView ensures the visible page; older pages drop out of the hot set automatically.

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
