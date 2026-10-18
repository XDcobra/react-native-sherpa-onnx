# PDFium page raster — status

**Shipped** on `feat/add-ocr-support-pdfium-raster` as `rasterizePdfPages` → `OfflineImageBuffer` (see [pdf-offline.md](../pdf-offline.md)).

## Done

- Opt-in `HAVE_PDFIUM` path: `FPDF_RenderPageBitmap` → RGB8 frames with `pageNumber` + `dpi`
- Frame metadata on `getOfflineImageBufferFrameInfo`
- No auto-OCR; apps call `createOCR().recognize` explicitly
- No silent text-layer → raster fallback

## Remaining follow-ups

- Example app: PDF picker + preview + span overlays (separate slice)
- Page-at-a-time / LRU when rasterizing large documents — [imagebuffer-perf-future-work.md](./imagebuffer-perf-future-work.md)
