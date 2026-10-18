# Offline PDF (`react-native-sherpa-onnx/pdf`)

Two opt-in PDFium APIs:

1. **`extractPdfTextLayer`** — digital glyph text → `OfflineTextBuffer` (`origin: 'textLayer'`).
2. **`rasterizePdfPages`** — page bitmaps → `OfflineImageBuffer` (RGB8 frames with `pageNumber` / `dpi`).

Neither runs OCR. Scan-only PDFs reject text extract with `ERR_PDF_NO_TEXT_LAYER`; raster still succeeds so you can call `createOCR().recognize` **explicitly**.

## Opt-in PDFium (default OFF)

PDFium is large. Default SDK builds do **not** link it.

| Platform | Enable |
|----------|--------|
| Android | `sherpaOnnxEnablePdfium=true` in the app (or library) `gradle.properties` |
| iOS | `SHERPA_ONNX_ENABLE_PDFIUM=1` when installing pods / building |

Prebuilts: [third_party/pdfium_prebuilt/README.md](../third_party/pdfium_prebuilt/README.md). Resolution mirrors libwebp (THIRD_PARTY → Maven → GitHub), but **only when enable is true**.

If you call either API without enable:

- Code: `ERR_PDF_PDFIUM_DISABLED`
- Message tells you to rebuild with the enable flags and resolve prebuilts.

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

```ts
import {
  getOfflineImageBufferFrameInfo,
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

// Optional: OCR on the rasterized frames
// const engine = await createOCR({ ... });
// await engine.recognize(pages, textOut);

await releaseOfflineImageBuffer(pages);
```

Defaults: `dpi = 144`, `maxSide = 4096` (longest-edge clamp after DPI scale; `<= 0` disables).

## API reference

From `react-native-sherpa-onnx/pdf`.

#### `isPdfiumEnabled()`

```ts
function isPdfiumEnabled(): Promise<boolean>;
```

```ts
const on = await isPdfiumEnabled();
```

Whether PDFium is linked in this binary.

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

Digital text → empty TextBuffer (`origin: 'textLayer'`). No text layer → `ERR_PDF_NO_TEXT_LAYER`. Options: `pages`, `signal`, `onProgress`.

#### `rasterizePdfPages(source, options?)`

```ts
function rasterizePdfPages(
  source: FileSource,
  options?: RasterizePdfPagesOptions
): Promise<RasterizePdfPagesResult>;
```

```ts
const pages = await rasterizePdfPages(pdfSource, { dpi: 144, maxSide: 2048 });
```

PDF pages → new OfflineImageBuffer (no OCR). Options: `pages`, `dpi` (default 144), `maxSide` (default 4096), `signal`, `onProgress`.

## Spans and coordinates (text layer)

- `origin: 'textLayer'`
- `pageNumber` — 1-based
- `pageWidth` / `pageHeight` — PDF user-space page size
- `sourceImageBufferId` — empty (no ImageBuffer)
- `quad` — top-left origin, y-down, PDF user-space (native normalizes PDFium’s bottom-left)

Raster bitmaps use the same top-left / y-down convention so overlays can map user-space quads onto frame pixels via `pageWidth`/`pageHeight` and frame size.

See [textbuffer-offline.md](./textbuffer-offline.md) and [imagebuffer-offline.md](./imagebuffer-offline.md).

## Errors

| Code | Meaning |
|------|---------|
| `ERR_PDF_PDFIUM_DISABLED` | Binary built without PDFium |
| `ERR_PDF_INVALID_ARGUMENT` | Bad source / pages / dpi / populated text buffer |
| `ERR_PDF_OPEN_FAILED` | Unreadable / corrupt PDF |
| `ERR_PDF_ENCRYPTED` | Password-protected (no silent decrypt) |
| `ERR_PDF_NO_TEXT_LAYER` | Selected pages have no extractable text (extract only) |
| `ERR_PDF_RENDER_FAILED` | Page bitmap create/render failed (raster only) |
| `ERR_PDF_CANCELLED` | AbortSignal / cancel |

## Example app

Bundled fixtures: `example/.../test_pdfs/` (`digital_hello.pdf` / `scan_only_page.pdf`). The example turns PDFium **on** (`example/android/gradle.properties` + `example/ios/Podfile`); consumer apps should keep the SDK default off unless they need PDF. See [example/README.md](../example/README.md).

In-app preview of raster frames: [`OfflineImageBufferFrameView`](./imagebuffer-offline.md) (no file materialize). Share/save: `exportOfflineImageBufferFrame` with a [`FileDestination`](./fileio.md).

## See also

- [ocr-offline.md](./ocr-offline.md)
- [imagebuffer-offline.md](./imagebuffer-offline.md)
- [textbuffer-offline.md](./textbuffer-offline.md)
- [PREBUILT_RESOLUTION.md](./internal/PREBUILT_RESOLUTION.md)
