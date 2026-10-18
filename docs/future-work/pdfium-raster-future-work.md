# Future work: PDFium page raster → ImageBuffer

Follow-on to [pdf-offline.md](../pdf-offline.md) text-layer extract.

## Goal

Deterministic API to rasterize PDF pages into an `OfflineImageBuffer` (RGB8 frames with `pageNumber`), then let the app call `createOCR().recognize` **explicitly**. No auto-OCR inside PDF APIs.

## Prerequisites

- PDFium opt-in prebuilts already linked (`sherpaOnnxEnablePdfium` / `SHERPA_ONNX_ENABLE_PDFIUM`)
- ImageBuffer frame metadata: `pageNumber` (and possibly DPI)
- Memory policy: full document raster vs page-at-a-time / LRU — see [imagebuffer-perf-future-work.md](./imagebuffer-perf-future-work.md)

## Non-goals

- Silent fallback from text-layer extract to raster/OCR
- Dual-path `mode: 'auto'`

## Suggested API sketch

```ts
rasterizePdfPages(source, options?: { pages?, dpi?, maxSide? })
  → OfflineImageBufferRef
```

Branch name suggestion: `feat/add-ocr-support-pdfium-raster`.
