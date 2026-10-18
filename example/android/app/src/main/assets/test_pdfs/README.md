# test_pdfs

Bundled fixtures for `react-native-sherpa-onnx/pdf` in the example app.

| File | Expected |
|------|----------|
| `digital_hello.pdf` | Has a native text layer → `extractPdfTextLayer` succeeds (`origin: textLayer`) |
| `scan_only_page.pdf` | Image-only page → `ERR_PDF_NO_TEXT_LAYER` (no OCR/raster fallback) |

Android: `assets/test_pdfs/`. iOS: `sherpa_models/test_pdfs/` (copied into the app bundle at build time).
