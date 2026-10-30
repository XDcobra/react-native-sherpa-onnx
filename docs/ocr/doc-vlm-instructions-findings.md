# Granite Docling (`doc_vlm`) — instruction findings

> Phase 0 of [`ocr-instructions-sdk-plan.md`](ocr-instructions-sdk-plan.md).
> Prompt-id goldens: `test/fixtures/ocr/instructions/doc_vlm/`
> Generate goldens (HF vs ORT) are still running; this note records what is already proven.

## Prompt ids (verified 2026-10-29)

Processor-only dump (`scripts/ocr-models/instructions/dump_prompt_ids.py`) plus
`verify_prompt_ids.py`. 21 prompts: 7 tasks × 3 fixtures.

| Task | User text | Prompt tokens (page/crop) |
|------|-----------|---------------------------|
| `page` | `Convert this page to docling.` | 878 |
| `element` / table | `Convert table to OTSL.` | 611 |
| `element` / chart | `Convert chart to table.` | 875 |
| `element` / formula | `Convert formula to LaTeX.` | 610 |
| `element` / code | `Convert code to text.` | 610 |
| `regionText` | `OCR the text in a specific location: <loc_*>×4` | 896 |
| `identifyElement` | `Identify element at: <loc_*>×4` | 893 |

Region locs are **BPE text**, not specials. For `page_01` title box
`(48,55,452×33)` on a 900×1200 frame, `granite_locs` emits
`<loc_27><loc_23><loc_278><loc_37>`, and that string is in the HF chat
prompt verbatim.

## HF greedy (CPU, 128-token cap, 2026-10-29)

Vast instance `58223589` (EPYC 7763). HF cache:
`build/ocr-models/phase0-cache/doc_vlm/`. HF **21/21** and ORT **21/21** done
(`granite CPU END rc=2`). Goldens under `test/fixtures/ocr/instructions/doc_vlm/`.

| Task | HF fixtures | Grammar (`inspect`) | Semantic (HF text) | Public union |
|------|-------------|---------------------|--------------------|--------------|
| `page` | 3/3 (hit 128-token cap) | ok, tags `doctag`/`section_header_level_1`/`text` | titles match; body truncated by cap | **0/3 identical** (prefix=5; loc numbers differ, text matches) |
| `element` / table | 3/3, EOS | ok, `<otsl>` + `<fcel>`/`<nl>` | cell text matches (Item/Qty/Price, City/Temp, Code/Status) | **3/3 identical — only Granite task that passes the gate** |
| `element` / chart | 3/3, EOS | **fail** — `<unknown>` on all 3; parser throws `OCR_PARSE_UNKNOWN_KIND` | table values match (Mon 12, Q1 40, A 8) after the unknown tag | **gated** |
| `element` / formula | 3/3, EOS | ok, `<formula>` + loc×4 | `E = m c ^ { \wedge } 2`, `a^2+b^2=c^2`; `formula_03` is `F = m` (missing `a`) | **1/3 identical** (formula_02) |
| `element` / code | 3/3, EOS | ok, `<code>` + `<_Python_>` / `<_JavaScript_>` / `<_SQL_>` | add/greet/SELECT match the crops; `content.language` is the tag without underscores | **2/3 identical** (code_02 differs by a newline before `</code>`) |
| `regionText` | 3/3 | page_01/03 **plain prose** + EOS; page_02 hits 128-cap and leaks `<text>`/`<loc_*>` after the title | titles match the boxes; page_02 then dumps the rest of the page | **1/3 identical** (page_01) |
| `identifyElement` | 3/3, EOS | **plain prose**, no DocTags (`Fixture page 01/02`, `Harbor Traffic Summary`) | short labels, not a DocTags element | **1/3 identical** (page_03); page_01 HF=`Fixture page 01` vs ORT=`Quarterly Operations Report` |

### Chart grammar lock

HF emits `<chart><loc_0><loc_0><loc_500><loc_500><unknown><fcel>Characteristic<fcel>Value<nl>…`.
`<unknown>` is **not** a Granite tokenizer special (closed vocab is the DocTags
added tokens; the nearest special is `<|unk|>`). Phase 0 criterion 2 fails on
3/3 fixtures. Public `OcrDocVlmElement` therefore omits `'chart'` until a pack
emits a known DocTags stream. Prompt-id goldens and the internal
`DocVlmElement::kChart` profile stay for host tests.

`test/fixtures/ocr/instructions/doc_vlm/` now holds the CPU 128-token HF/ORT
goldens (21 `meta.json`). A prior 32-token CUDA probe is no longer in that tree.

### regionText grammar

HF greedy on `page_01` / `page_03` (title boxes) is bare prose plus EOS, not
DocTags. The SDK keeps that string as `content.format=plain` and emits **no**
element/span for the requested region (`AdoptBareProse`). Do not wrap it in a
fabricated quad.

`page_02` at the 128-token cap starts with the title then leaks
`</ocr></text><text><loc_*>…` (a truncated page dump). The parser keeps the
emitted `<text>` elements; it does not invent a region quad.

### identifyElement grammar

HF 3/3 is short prose plus EOS, not a DocTags element. `content.format=plain`
holds that label. `elements` stays `[]` (the model emitted no kind/locs).

### Identity (CPU HF fp32 greedy vs CPU ORT pack)

| Task | identical | Notes |
|------|-----------|-------|
| `element` / table | 3/3 | Full-crop locs `loc_0…500`; tokens match. |
| `element` / code | 2/3 | code_02 prefix=37/40 — extra newline before `</code>`. |
| `element` / formula | 1/3 | formula_01 HF `E = m c` vs ORT `E = \text {mc}`. |
| `regionText` | 1/3 | page_01 match; page_03 ORT drops `Fixture page 03`; page_02 HF 128 vs ORT 23. |
| `identifyElement` | 1/3 | page_01 prefix=0: HF labels the subtitle, ORT the title. |
| `page` | 0/3 | prefix=5 (`<doctag><section_header_level_1>`). **Same title text, different loc grid**: HF `loc_11,14,263,30` vs ORT `loc_26,21,278,37` on page_01. ORT is close to `OcrGeometry` of the PNG title box (`loc_27,23,278,37`). HF vision preprocess maps the page differently. |
| `element` / chart | 0/3 | Already gated on `<unknown>`. |

The ≥3-fixture identity gate therefore passes **only** `element` / `table`. The
Phase 0 ORT probe feeds the pack through the **HF image processor**, so the
page loc drift is pack-vs-HF numerics, not C++ `DocVlmImageOps`. `page` stays
the public default (grammar+title text match; no replacement whole-page
default). Phase 0 is **not** locked.

## Still required

- Decide `page` / `formula` / `code` / `regionText` / `identifyElement`: match HF preprocess, or move to §1.4.
- Paddle spotting CPU (started 2026-10-29T10:53:45Z on the same box).
