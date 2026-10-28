# PDF host-test fixtures

| File | What |
|------|------|
| `tiny-hello.pdf` | One-page Helvetica “Hello PDF” for `OpenPath` / `OpenFd` when PDFium is linked |
| `truncated.pdf` | `%PDF-1.4` header only → `ERR_PDF_OPEN_FAILED` |
| `garbage.bin` | Unrecognized bytes → `ERR_PDF_OPEN_FAILED` |

Default host CI leaves `HAVE_PDFIUM` off; the enabled-path tests `GTEST_SKIP`.
