# Nemotron-3.5-Parse — SDK implementation plan

> Branch: `feat/add-ocr-support-nemotron-parser`
> Locked research: [`nemotron-parse-sdk-findings.md`](nemotron-parse-sdk-findings.md)
> Granite pattern (do not copy classes): [`phase2-doc-vlm-backend-plan.md`](phase2-doc-vlm-backend-plan.md)
> Local pack: `build/ocr-models/nemotron-3.5-parse/onnx-fp16` (or `onnx-int8`)

Implement a **new** family. Do not reuse `DocVlmBackend`, `ParseDocTags`, `DocVlmDocTagsPrefix`, `DocVlmImageOps`, `DocVlmPrompt`, `DocVlmTokenizer`, or `kDocVlmReqs`. Do not extract a shared “VLM backend” base.

Q1–Q7 in the findings are locked. This plan only sequences the work.

Android first. Log tag `[SherpaOnnx:ocr]`, prefix `nemotron_parse`. Gate with existing `OCR_LOGI` / `__DEV__` on TS. Do not publish GitHub / HF packs unless asked.

---

## 0  Locked contract (do not reopen)

| # | Lock |
|---|------|
| Family | `nemotron_parse` everywhere (detect, `createOCR`, `OcrRecognizeResult.family`). Alias **only** `nemotron-parse`. Never bare `nemotron` (STT). Never `doc_vlm` / `docling`. Pack ids `nemotron-3.5-parse-<quant>`. |
| Tokenizer | C++ over `tokenizer.json` only. New codec. |
| Image | LongestMaxSizeHW **2048×1664** (shrink only) + top-left white pad `H%16` / `W%64` + `/255` + CLIP + 16×16 unfold. No `maxSide` API in v1. |
| Archive | One quant per `.tar.bz2`, flatten to pack root. Hub twins stay desktop. |
| Decode | Greedy + HF repetition penalty **1.1**. Stop EOS id `2`. No NVIDIA table/repetition-stop processors. |
| `pos_embed` | Read `.npy` (`<f4>` / `<f2>`). Expand f16→f32 once at `Load`. |
| Result | New arm: `raw` + native `markdown` + `complete` / `stopReason` (`eos` \| `max_new_tokens`). New C++ `raw_utf8`. Never `doctags`. |

Prompt (hardcoded, no Jinja):

```text
</s><s><predict_bbox><predict_classes><output_markdown><predict_text_in_pic>
```

`max_new_tokens`: `0` → 8192, then clamp to remaining context (same idea as granite: `8192 − prompt`, here also subtract vision prefix length). Nest on TS: `nemotronParse: { maxNewTokens }` — **not** `docVlm`.

---

## Phase 0 — Export / manifest (must land first)

Detect reads `"family"` and treats unknown as unsupported. Today export writes `"family": "doc_vlm"` and `"id": "docvlm-nemotron-3.5-parse-<dtype>"`. A Nemotron folder would be classified as granite, drop `patch_embed` / `pos_embed`, and fail granite KV checks.

Change, in [`scripts/ocr-models/nemotron-parse/`](../../scripts/ocr-models/nemotron-parse/):

| Site | After |
|------|--------|
| `write_manifest` (`export_onnx.py`, `quantize_onnx.py`) | `"family": "nemotron_parse"`, `"id": "nemotron-3.5-parse-<dtype>"` |
| HF-stage root (`prepare_hf_repo.py`) | same family; root id `nemotron-3.5-parse-onnx`; variants stay `onnx/fp16` / `onnx/int8` (desktop Hub only) |
| `hf_model_card.md` / README pack table | ids without `docvlm-` |

Regenerate local `ocr_manifest.json` in `onnx-*` (re-run `write_manifest` or hand-edit the existing files under `build/`). Do not publish.

`arch` already is `nemotron_parse`. Keep it.

---

## Phase 1 — Native backend (host tests construct it directly)

New tree `android/src/main/cpp/ocr/nemotron_parse/`. Namespace `sherpa_onnx::ocr::nemotron_parse`. `Family()` returns `"nemotron_parse"`.

Do **not** edit `OcrFactory.cpp` in this phase (same as granite Phase 2). Host tests call `NemotronParseBackend` directly.

### 1.1  Files

| File | Role |
|------|------|
| `NemotronParseBackend.{h,cpp}` | `OcrBackend`: Load / Recognize / Release |
| `NemotronParseTokenizer.{h,cpp}` | HF BPE + added tokens over `tokenizer.json` |
| `NemotronParseImageOps.{h,cpp}` | Q3 preprocess → `[N, 768]` patches + sizes |
| `NemotronParseNpy.{h,cpp}` | v1/v2 npy, `<f4>`/`<f2>`, shape 16384×1152 |
| `NemotronParseNavit.{h,cpp}` | content-normalized interpolate (port `navit_pos.py`) |
| `NemotronParseMarkup.{h,cpp}` | raw / markdown / plaintext / `line` spans |
| `NemotronParseManifest.{h,cpp}` | require `family == nemotron_parse`; optional file map |

Wire sources in `android/src/main/cpp/CMakeLists.txt` and `test/cpp/CMakeLists.txt`. New `nemotron_parse_host_test`. Skip ORT smoke when the local pack dir is absent (`NEMOTRON_PARSE_MODEL_DIR` or default `build/ocr-models/nemotron-3.5-parse/onnx-fp16`).

### 1.2  `OcrResult` / `OcrLoadOptions`

In [`OcrTypes.h`](../../android/src/main/cpp/ocr/OcrTypes.h):

- Add `std::string raw_utf8` (empty default). Granite leaves it empty. Do not write Nemotron markup into `doctags_utf8`.
- `markdown_utf8` reused (native, not `MarkdownFor`).
- `stop_reason`: `eos` \| `max_new_tokens` only for this family.
- `complete`: `stop_reason == "eos"`.
- New path overrides: `path_patch_embed`, `path_patch_embed_data`, `path_pos_embed`. Resolve with `OcrResolvePath`.

`RecognizeMulti` already copies `stop_reason` / `complete` / `markdown`. Also concatenate `raw_utf8` the same way as `doctags_utf8`.

### 1.3  Sessions and I/O

Four ORT sessions, external `*.onnx_data` next to the graph (do not `CreateSessionFromArray`). Provider via existing `ApplyOrtProvider`. Intra-op `max(1, num_threads)`, inter-op 1. Graph opt `ORT_ENABLE_EXTENDED` (same granite reason).

| Graph | Input | Output |
|-------|--------|--------|
| `patch_embed.onnx` | `patches` `[N, 768]` f32 | `[N, 1152]` f32 |
| `vision_encoder.onnx` | `patch_tokens` `[1, rows, cols, 1152]` f32 | `vision` `[1, rows*(cols/4)+1, 1024]`, `visual_mask` |
| `embed_tokens.onnx` | `input_ids` `[1, S]` i64 | `[1, S, 1024]` f32 |
| `decoder_model_merged.onnx` | `inputs_embeds` `[1, S, 1024]`, `attention_mask` `[1, past+S]` f32, `past_key_L` / `past_value_L` `[1, 8, past, 64]` × 10 | `logits` `[1, S, 72512]`, `present_key_L` / `present_value_L` |

Empty past: `past = 0`. Prefill: concat `vision` then text embeds on dim 1; concat `visual_mask` then ones for prompt tokens. Step: last token embed only; append one to the mask; take last logit row.

Hard-check at Load: 10 layers, 8 KV heads, head dim 64, vocab 72512. Log and reject otherwise.

### 1.4  Host pipeline (one RGB frame)

```text
RGB8
  → ImageOps (content_sizes, image_sizes, patches [N,768])
  → patch_embed
  → Npy + Navit (f32 [1, N, 1152]) → reshape [1, rows, cols, 1152]
  → vision_encoder
  → tokenizer.Encode(DEFAULT_PROMPT) → embed_tokens
  → concat vision ‖ text
  → decoder prefill + greedy+1.1 until EOS or cap
  → tokenizer.Decode(generated, keep specials)
  → Markup → raw_utf8, markdown_utf8, text_utf8, line spans
```

Repetition penalty (CTRL, unique ids in prompt ∪ generated): logit `< 0` × 1.1 else ÷ 1.1; then argmax. First step uses prompt ids only.

Logs: phase, image/content sizes, rows/cols, vision_len, prompt_len, cap, every 32th token + last, stop, sizes of raw/markdown/text/spans.

### 1.5  Tokenizer

Parse `tokenizer.json`: `model.type == BPE`, vocab dict, merge pairs, **all** `added_tokens`. Encode: longest-match added tokens, then NFKC + Sequence pretok (drop `SPL1T-TH1S-Pl3A5E`, individual digits, isolated punct, isolated `\n`, ByteLevel `add_prefix_space=false`) + BPE. Decode: id → token, ByteLevel unescape, keep specials. Do not apply TemplateProcessing (`add_special_tokens=false`).

Host tests: encode the control prompt to the known special ids (`</s>=2`, `<s>=0`, `<predict_bbox>=50004`, …); round-trip a short ASCII string; decode a fake `<x_0.0>Hi<x_0.9961><y_0.9938><class_Text>` id sequence.

### 1.6  Image + npy + NaViT

ImageOps: RGB → LongestMaxSizeHW 2048×1664 → record content H/W → pad bottom/right white to 16/64 → `/255` → CLIP mean/std → unfold 16×16 → `[N, 768]`. Bilinear resize (PIL equivalent). No Idefics3, no Lanczos, no granite upscale.

Npy: magic `\x93NUMPY`, v1/v2 header, `descr` `<f4>`/`<f2>` only, `fortran_order` false, shape `(1, 16384, 1152)` or squeezed `(16384, 1152)`. Expand f16→f32 once; keep one 72 MiB working copy.

Navit: port `interpolate_pos_grid` (bilinear + `align_corners=false` + antialias on the 128×128 field, then content-normalized `grid_sample`, border). Host test: load the pack npy, run one known `image_size`/`content_size` if a golden exists; otherwise check output shape `rows*cols × 1152` and finite values.

### 1.7  Markup

Input: generated decode, strip trailing `</s>` / EOS.

| Output | Rule |
|--------|------|
| `raw_utf8` | that string |
| `markdown_utf8` | strip `<x_*>` `<y_*>` `<class_*>` (and leftover `<s>`/`</s>`) |
| `text_utf8` | same as markdown for v1 (LaTeX `tabular` left as-is) |
| spans | each `<x_a><y_b> … <x_c><y_d><class_*>` → one `kLine` span; box × frame W/H → axis-aligned `OcrQuad` |

Do not run `ParseDocTags`. Host test: the Hello World stream from the findings → one line span + markdown `Hello World`.

---

## Phase 2 — Detect, validate, factory, load copy

### 2.1  Kind + paths

[`OcrModelKind`](../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h): add `kNemotronParse`.

`OcrModelPaths` / `OcrDetectResult` / `OcrLoadOptions`: add

- `patch_embed` / `patch_embed_data`
- `pos_embed` (`pos_embed.npy`)

Plus the shared octet (`vision_encoder` + data, `embed_tokens` + data, `decoder` + data, `tokenizer`, `manifest`).

`kNemotronParseReqs`: those eleven (or ten if `patch_embed_data` optional when the graph is self-contained). **Do not** add Nemotron files to `kDocVlmReqs`.

`ReadManifestFamily`: `nemotron_parse` → `kNemotronParse`. Unknown family still unsupported (no fallthrough to granite).

`ParseOcrModelTypeStrict` / iOS twin / `CanonicalOcrModelType`:

- `nemotron_parse`, `nemotron-parse` → `nemotron_parse`
- **not** `nemotron`, `doc_vlm`, `docling`

`InferOcrModelTypeFromKey`: match `nemotron_parse` / `nemotron-3.5-parse` / `nemotron-parse` **before** any granite `docvlm` heuristic. Do not match the bare token `nemotron`.

### 2.2  Auto detect

Reuse the existing token/quant picker and flatten-folder fallback. New complete suffix-group (or generic “required basenames present”) for:

`patch_embed.onnx`, `pos_embed.npy`, `vision_encoder.onnx`, `embed_tokens.onnx`, `decoder_model_merged.onnx`, `tokenizer.json`, `ocr_manifest.json`.

If the manifest says `nemotron_parse`, trust it even when a granite-looking octet is also present.

### 2.3  Unified detect (STT / enhancement collision)

[`preferDocVlm`](../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect-unified.cpp) today only overrides when `selectedKind == kDocVlm`. Nemotron packs also contain `decoder_model_merged.onnx` (token `model` → enhancement) and the filename token `nemotron` (STT).

Rename/generalize: a successful OCR detect of **`kDocVlm` or `kNemotronParse`** wins over enhancement / speaker-embedding / STT. Host `model_detect_test` cases for a Nemotron-shaped folder.

### 2.4  Factory + engine

`CreateOcrBackend("nemotron_parse")` → `NemotronParseBackend`.

`CopyDetectPaths` / `HasCustomOcrPaths`: copy the three new path fields.

`OcrEngine::Load` folder init must pass them through (same granite bug class as “detect paths not copied”).

### 2.5  Custom config

[`customConfig.ts`](../../src/ocr/customConfig.ts): `OcrNemotronParseCustomConfig` with the required keys above. `GetOcrPathRequirements` / validate-custom must list them.

---

## Phase 3 — Public API

### 3.1  TypeScript

[`src/ocr/types.ts`](../../src/ocr/types.ts):

- `OcrModelType` / `OcrFamily` += `'nemotron_parse'`
- `OcrNemotronParseOptions = { maxNewTokens?: number }` (same 0 → 8192 rule)
- New init arm; `auto` may take `nemotronParse?`
- `OcrRecognizeResult` new arm (`raw`, `markdown`, `complete`, `stopReason`: `'eos' | 'max_new_tokens'`)
- Alias map: `'nemotron-parse' → 'nemotron_parse'` only

[`readRecognizeResult`](../../src/ocr/index.ts): accept the new family; require `raw` + `markdown` + `complete` + those two stop reasons; **reject** if `doctags` is the only markup field.

Bridge: forward `nemotronParse.maxNewTokens` onto existing native `maxNewTokens` (already on `OcrLoadOptions`). Do not send it as `docVlm`.

### 3.2  Native bridges

JNI [`sherpa-onnx-ocr-jni.cpp`](../../android/src/main/cpp/jni/ocr/sherpa-onnx-ocr-jni.cpp): put `raw`; put `stopReason`/`complete` for `nemotron_parse` as well as `doc_vlm`.

Kotlin helper: extras check **branches on family** — granite still needs `doctags`; Nemotron needs `raw` and must not treat missing `doctags` as `recognize result missing extras`.

iOS: same discriminant and path keys.

`NativeSherpaOnnx.ts` / `modelDetect.ts` path maps: document the new keys.

Jest: create/recognize round-trip, alias, missing-`raw` reject, granite tests unchanged (still no `raw`).

---

## Phase 4 — Example + docs

[`example/src/screens/ocr/OCRScreen.tsx`](../../example/src/screens/ocr/OCRScreen.tsx):

- Treat `family === 'nemotron_parse'` as VLM extras.
- Tabs: `Spans | Markdown | Raw` (not DocTags).
- Copy-all / per-span unchanged (they use `textOut` / span text).

[`docs/ocr-offline.md`](../ocr-offline.md): new family subsection — pack layout, `createOCR({ modelType: 'nemotron_parse' })`, result arm, prompt/stop, “not DocTags”.

Do not change VoiceLab in this plan.

---

## Phase 5 — First-party pack pipeline (no upload unless asked)

[`scripts/ocr-models/build_and_upload.js`](../../scripts/ocr-models/build_and_upload.js) + `sources.csv`:

- `VALID_FAMILIES` += `nemotron_parse`
- Flatten one variant folder → `<id>/` with canonical names + `ocr_manifest.json` + `LICENSE` + `tokenizer.json` + `pos_embed.npy`
- Ids: `nemotron-3.5-parse-fp16`, `nemotron-3.5-parse-int8`
- Do **not** pack Hub `onnx/fp16`+`onnx/int8` as one archive

Fixtures (`ocr-models-expected.csv`, structure txt) and license CSV rows when an archive is actually built. Catalog language hints: take from the NVIDIA card; do not copy granite `en/ja/ar/zh` blindly.

GitHub release `ocr-models` upload stays a later, explicit ask.

---

## Tests (minimum)

| Layer | Cases |
|-------|--------|
| Host tokenizer / npy / image size / markup | no pack required |
| Host ORT smoke | Hello-page or fixture image when `NEMOTRON_PARSE_MODEL_DIR` set; skip otherwise |
| `model_detect_test` | manifest family; complete pack; mixed folder + quant token; unified override vs STT `nemotron` / enhancement `model` |
| Jest OCR API | new arm, alias, extras reject, customConfig keys |
| Example | manual Android: INT8 pack, overlay boxes, Markdown/Raw tabs, copy |

Do not add the ~1.4 GB pack to the default `test-ocr-host.yml` job. Optional `workflow_dispatch` later (granite Phase 5 pattern).

---

## Out of scope

- Publishing HF or GitHub assets
- Generic VLM base class
- NVIDIA `TableInsertion` / `RepetitionStop`
- Recognize-time `maxSide`
- `OcrSpan` class metadata
- VoiceLab wiring
- Changing granite `doc_vlm` extras

---

## Suggested commit groups (when asked)

1. `fix(ocr-models): set Nemotron pack family to nemotron_parse` (Phase 0)
2. `feat(ocr): add Nemotron-Parse backend and host tests` (Phase 1)
3. `feat(ocr): detect and load nemotron_parse packs` (Phase 2)
4. `feat(ocr): expose nemotron_parse recognize extras` (Phase 3)
5. `feat(example): add Nemotron Parse result tabs` + `docs(ocr): document nemotron_parse` (Phase 4)
6. Pack pipeline commit only when sources/packer land (Phase 5)

---

## Implementation order

Phase 0 → 1 (prove one frame on Android host / device logs) → 2 → 3 → 4. Phase 5 can wait until a pack is ready to archive.

One hypothesis per change when debugging decode/spans; keep the new logs until the Hello World stream and overlay boxes match `infer_ort.py`.
