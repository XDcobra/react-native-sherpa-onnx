# test_pdfs

Bundled fixtures for `react-native-sherpa-onnx/pdf` in the example app.

| File | Expected |
|------|----------|
| `digital_hello.pdf` | Has a native text layer → `extractPdfTextLayer` succeeds (`origin: textLayer`) |
| `digital_multipage.pdf` | 3 pages + text layer → extract ok; lazy-lru preview / FramePager on pick |
| `scan_only_page.pdf` | Image-only page → `ERR_PDF_NO_TEXT_LAYER` |
| `scan_only_multipage.pdf` | Image-only ×3 → `ERR_PDF_NO_TEXT_LAYER` → rasterize (lazy-lru) → OCR |
| `book.pdf` | 6 pages for the reader (`layout: 'paragraphs'`): headings by font size, running header and page numbers, outline, page labels, two columns, an image-only plate. Copy of `test/fixtures/pdf/book.pdf` (regenerate with `test/fixtures/pdf/gen_pdf_fixtures.py`). |
| `book_scan.pdf` | The pages of `book.pdf` as 150 dpi gray images, no text layer: a scanned book for reader OCR. Copy of `test/fixtures/pdf/book_scan.pdf` (regenerate with `swift test/fixtures/pdf/gen_book_scan.swift`, macOS). |

Android: `assets/test_pdfs/`. iOS: `sherpa_models/test_pdfs/` (copied into the app bundle at build time).
