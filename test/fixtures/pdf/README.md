# PDF host-test fixtures

| File | What |
|------|------|
| `tiny-hello.pdf` | One-page Helvetica “Hello PDF” for `OpenPath` / `OpenFd` when PDFium is linked |
| `hello-encrypted.pdf` | Same page, standard PDF encryption (user/owner password `secret`) → `ERR_PDF_ENCRYPTED` without or with the wrong password |
| `truncated.pdf` | `%PDF-1.4` header only → `ERR_PDF_OPEN_FAILED` |
| `garbage.bin` | Unrecognized bytes → `ERR_PDF_OPEN_FAILED` |

Default host CI leaves `HAVE_PDFIUM` off; the enabled-path tests `GTEST_SKIP`.
