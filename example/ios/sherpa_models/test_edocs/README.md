# test_edocs

Self-authored fixtures for the Documents / Read aloud example screen. Markup books are a short retelling of *The North Wind and the Sun* (two chapters, quote/list/title), not a one-line stub.

| File | Expected |
|------|----------|
| `hello.epub` | Two text chapters + `linear="no"` nav; CSS present; `extractDocumentText` |
| `hello.fb2` | Two FB2 sections (title, epigraph, poem); text-only |
| `mixed.epub` | Two markup chapters (decorative img ignored) + one image-only scan spine item |
| `manga.cbz` | Cover + 2 manga pages, no markup → `ERR_DOC_NO_TEXT` |

## `manga.cbz` source

Pages from the University of Tsukuba BHE / RADD educational manga
[ヒトはそれを『発達障害』と名づけました](https://dac.tsukuba.ac.jp/radd/joint-base/manga/)
(CC0 1.0 public domain). Bundled pages: original p.1 (cover), p.3, p.4
(p.2 is a blank leaf in the source and is omitted).

Android: `assets/test_edocs/`. iOS: `sherpa_models/test_edocs/` (copied into the app bundle at build time).
