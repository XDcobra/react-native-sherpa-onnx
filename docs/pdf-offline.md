# Offline PDF text layer (`react-native-sherpa-onnx/pdf`)

Extract **digital PDF text** (native glyph layer) into an `OfflineTextBuffer` with spatial spans (`origin: 'textLayer'`).

This is **not** OCR and **not** page rasterization. Scan-only PDFs reject with `ERR_PDF_NO_TEXT_LAYER`. There is no automatic OCR fallback.

## Opt-in PDFium (default OFF)

PDFium is large. Default SDK builds do **not** link it.

| Platform | Enable |
|----------|--------|
| Android | `sherpaOnnxEnablePdfium=true` in the app (or library) `gradle.properties` |
| iOS | `SHERPA_ONNX_ENABLE_PDFIUM=1` when installing pods / building |

Prebuilts: [third_party/pdfium_prebuilt/README.md](../third_party/pdfium_prebuilt/README.md). Resolution mirrors libwebp (THIRD_PARTY → Maven → GitHub), but **only when enable is true**.

If you call the API without enable:

- Code: `ERR_PDF_PDFIUM_DISABLED`
- Message tells you to rebuild with the enable flags and resolve prebuilts.

## Quick start

```ts
import { createEmptyOfflineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import {
  extractPdfTextLayer,
  isPdfiumEnabled,
  PdfErrorCode,
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

## Spans and coordinates

- `origin: 'textLayer'`
- `pageNumber` — 1-based
- `pageWidth` / `pageHeight` — PDF user-space page size
- `sourceImageBufferId` — empty (no ImageBuffer)
- `quad` — top-left origin, y-down, PDF user-space (native normalizes PDFium’s bottom-left)

See [textbuffer-offline.md](./textbuffer-offline.md).

## Errors

| Code | Meaning |
|------|---------|
| `ERR_PDF_PDFIUM_DISABLED` | Binary built without PDFium |
| `ERR_PDF_INVALID_ARGUMENT` | Bad source / pages / populated text buffer |
| `ERR_PDF_OPEN_FAILED` | Unreadable / corrupt PDF |
| `ERR_PDF_ENCRYPTED` | Password-protected (no silent decrypt) |
| `ERR_PDF_NO_TEXT_LAYER` | Selected pages have no extractable text |
| `ERR_PDF_CANCELLED` | AbortSignal / cancel |

## Example app

OCR screen → **PDF text layer** → **Probe extractPdfTextLayer**. The example turns PDFium **on** (`example/android/gradle.properties` + `example/ios/Podfile`) so you can exercise the real extract path; consumer apps should keep the SDK default off unless they need PDF. See [example/README.md](../example/README.md).

## Next

Page raster → ImageBuffer (then explicit OCR) is tracked in [future-work/pdfium-raster-future-work.md](./future-work/pdfium-raster-future-work.md).

## See also

- [ocr-offline.md](./ocr-offline.md)
- [imagebuffer-offline.md](./imagebuffer-offline.md)
- [textbuffer-offline.md](./textbuffer-offline.md)
- [PREBUILT_RESOLUTION.md](./internal/PREBUILT_RESOLUTION.md)
