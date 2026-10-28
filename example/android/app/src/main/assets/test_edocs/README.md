# test_edocs

Tiny self-authored fixtures for the Documents / Read aloud example screen.

| File | Expected |
|------|----------|
| `hello.epub` | Text-only EPUB → `extractDocumentText` |
| `hello.fb2` | Text-only FictionBook → `extractDocumentText` |

Android: `assets/test_edocs/`. iOS: `sherpa_models/test_edocs/` (copied into the app bundle at build time).
