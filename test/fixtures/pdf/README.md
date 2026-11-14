# PDF host-test fixtures

| File | What |
|------|------|
| `tiny-hello.pdf` | One-page Helvetica “Hello PDF” for `OpenPath` / `OpenFd` when PDFium is linked |
| `hello-encrypted.pdf` | Same page, standard PDF encryption (user/owner password `secret`) → `ERR_PDF_ENCRYPTED` without or with the wrong password |
| `truncated.pdf` | `%PDF-1.4` header only → `ERR_PDF_OPEN_FAILED` |
| `garbage.bin` | Unrecognized bytes → `ERR_PDF_OPEN_FAILED` |
| `book.pdf` | 6-page book from `gen_pdf_fixtures.py`: title page, preface, two chapters with headings, running header and page numbers, a hyphenated line break, a paragraph across a page break, a two-column page and an image-only page. Outline, document info, `/Lang` and page labels (i, ii, 1–4). Used by the PDF text layer, raster and reader structure tests. |

Host tests link real PDFium by default (`pdfium-binaries`, same `chromium/<N>` pin as `third_party/pdfium_prebuilt/ANDROID_RELEASE_TAG`, downloaded by `test/cpp/CMakeLists.txt`). Configure with `-DSHERPA_ONNX_HOST_ENABLE_PDFIUM=OFF` to run the disabled-path tests instead; the enabled-path tests then `GTEST_SKIP`.

Regenerate `book.pdf` with `python3 test/fixtures/pdf/gen_pdf_fixtures.py`.
