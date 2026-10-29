# PaddleOCR-VL-1.6 — SDK implementation plan

> Locked research: [`paddleocr-vl-sdk-findings.md`](paddleocr-vl-sdk-findings.md)
> Granite pattern (do not copy classes): [`phase2-doc-vlm-backend-plan.md`](phase2-doc-vlm-backend-plan.md)
> Nemotron pattern (do not copy classes): [`nemotron-parse-sdk-plan.md`](nemotron-parse-sdk-plan.md)
> Export: [`scripts/ocr-models/paddleocr-vl/`](../../scripts/ocr-models/paddleocr-vl/)
> Local pack (when export finishes): `build/ocr-models/paddleocr-vl-1.6/onnx-fp16` (or `onnx/` FP32 / `onnx-int8` / `onnx-q4f16`)

Implement a **new** family with its **own backend class**. Do not reuse `DocVlmBackend` or `NemotronParseBackend`, and do not add `if (paddleocr_vl)` inside them. Do not copy `ParseDocTags`, `DocVlmImageOps`, `NemotronParseImageOps`, `NemotronParseNavit`, `DocVlmTokenizer`, or `NemotronParseTokenizer`.

**Avoid duplicating code and logic when it is actually the same.** Extract shared **helpers** (ORT session-from-path + `*.onnx_data`, provider, empty-KV, last-row argmax). Do **not** extract a shared `VlmBackend` base. Tokenizer, image, RoPE, prompt, markup, and graph I/O stay under `paddleocr_vl/`.

Q1–Q7 in the findings are locked. This plan only sequences the work.

The SDK is **unpublished**. Public API may break when a change is cleaner (shared VLM result extras, drop deprecated aliases, rename keys). Do not preserve a worse surface for compatibility. Native **backends** stay one class per family; shared C++ is helpers only. Example follows the new API; VoiceLab is out of this plan.

Android first. Log tag `[SherpaOnnx:ocr]`, prefix `paddleocr_vl`. Gate with existing `OCR_LOGI` / `__DEV__` on TS. Do not publish GitHub / HF packs unless asked.

---

## 0  Locked contract (do not reopen)

| # | Lock |
|---|------|
| Family | `paddleocr_vl` everywhere (detect, `createOCR`, `OcrRecognizeResult.family`). Alias **only** `paddleocr-vl`. Never bare `paddleocr` (PP-OCR). Never `doc_vlm` / `nemotron_parse`. Pack ids `paddleocr-vl-1.6-<quant>`. |
| Tokenizer | C++ over `tokenizer.json` only. New BPE + `▁` + byte_fallback codec. |
| Image | smart_resize factor 28, min 112896 / max 1003520 px, bicubic, `/255`, mean/std 0.5, 14×14 unfold, `t=1`. No `maxPixels` API in v1. |
| Archive | One quant per `.tar.bz2`, flatten. Files: `vision_encoder`, **`embedding`**, **`decoder`** (+ `_data`), `tokenizer.json`, `ocr_manifest.json`. |
| Decode | Greedy argmax. Stop EOS id `2`. Host 3D M-RoPE. Splice image embeds at id `100295`. |
| Vision pos | Inside the vision graph. No `pos_embed.npy`. |
| Result | `raw` + `markdown` + `complete` / `stopReason` (`eos` \| `max_new_tokens`). Never `doctags`. v1 spans empty. Reshape the VLM extras union if a third copy-paste arm is worse. |

Prompt (hardcoded, no Jinja). Expand one placeholder to `N = t·h·w/4` copies before encode:

```text
<|begin_of_sentence|>User: <|IMAGE_START|><|IMAGE_PLACEHOLDER|>×N<|IMAGE_END|>OCR:
Assistant:
```

`max_new_tokens`: `0` → 8192, then clamp. Reuse the shared TS/native `maxNewTokens` field — **not** a nested `paddleocrVl` object, **not** `docVlm`.

Export already writes `"family": "paddleocr_vl"`. There is **no** Nemotron-style Phase 0 family rewrite.

---

## Phase 0 — Local pack sanity (no code unless export is wrong)

When `build/ocr-models/paddleocr-vl-1.6/onnx*` exists:

1. Confirm `ocr_manifest.json` `family` / `files.embedding` / `files.decoder`.
2. Confirm graph input names match [`wrappers.py`](../../scripts/ocr-models/paddleocr-vl/wrappers.py) (`pixel_values`, `image_grid_thw`, `inputs_embeds`, `attention_mask`, `position_ids`, `past_key_values.{i}.{key,value}`).
3. Run `infer_ort.py --max-new-tokens 16` on the Hello fixture; keep that stream as the host-test golden.

If a name drifted during export, **fix the export** (or document the actual names here) before writing C++. Do not guess.

Do not publish.

---

## Phase 1 — Native backend (host tests construct it directly)

New tree `android/src/main/cpp/ocr/paddleocr_vl/`. Namespace `sherpa_onnx::ocr::paddleocr_vl`. `Family()` returns `"paddleocr_vl"`. That class is the only place this family’s Load/Recognize/Release live.

Do **not** edit `OcrFactory.cpp` in this phase (same as granite / Nemotron). Host tests call `PaddleocrVlBackend` directly.

If Load would copy granite/Nemotron session-create / provider / empty-past verbatim, pull that into a small helper under `ocr/` (not a backend base) and call it from this family. Leave family-specific feeds (splice, `position_ids`, 18×2 KV names) in `PaddleocrVlBackend`.

### 1.1  Files

| File | Role |
|------|------|
| `PaddleocrVlBackend.{h,cpp}` | `OcrBackend`: Load / Recognize / Release |
| `PaddleocrVlTokenizer.{h,cpp}` | BPE + `▁` + byte_fallback over `tokenizer.json` |
| `PaddleocrVlImageOps.{h,cpp}` | Q3 preprocess → `pixel_values` `[1,P,3,14,14]` + `image_grid_thw` |
| `PaddleocrVlRope.{h,cpp}` | port `rope_index.py` + `decode_position_ids` |
| `PaddleocrVlMarkup.{h,cpp}` | raw / markdown / plaintext; **no spans in v1** |
| `PaddleocrVlManifest.{h,cpp}` | require `family == paddleocr_vl`; optional file map |

Wire sources in `android/src/main/cpp/CMakeLists.txt` and `test/cpp/CMakeLists.txt`. New `paddleocr_vl_host_test`. Skip ORT smoke when the local pack dir is absent (`PADDLEOCR_VL_MODEL_DIR` or default `build/ocr-models/paddleocr-vl-1.6/onnx-fp16`, then `onnx/`).

### 1.2  `OcrResult` / `OcrLoadOptions`

In [`OcrTypes.h`](../../android/src/main/cpp/ocr/OcrTypes.h):

- Reuse `raw_utf8` / `markdown_utf8` / `stop_reason` / `complete` (already added for Nemotron). Do not write this stream into `doctags_utf8`.
- `stop_reason`: `eos` \| `max_new_tokens` only for this family.
- `complete`: `stop_reason == "eos"`.
- New path overrides: `path_embedding`, `path_embedding_data`. `path_decoder` already exists; resolve canonical **`decoder.onnx`** (not `decoder_model_merged.onnx`). `path_embed_tokens` stays granite/Nemotron.

`RecognizeMulti` already concatenates `raw_utf8`. Spans stay empty.

### 1.3  Sessions and I/O

Three ORT sessions, external `*.onnx_data` next to the graph (do not `CreateSessionFromArray`). Provider via existing `ApplyOrtProvider`. Intra-op `max(1, num_threads)`, inter-op 1. Graph opt `ORT_ENABLE_EXTENDED` (same granite reason).

| Graph | Input | Output |
|-------|--------|--------|
| `vision_encoder.onnx` | `pixel_values` `[1, P, 3, 14, 14]` f32, `image_grid_thw` `[1, 3]` i64 | `image_embeds` `[P/4, 1024]` f32 |
| `embedding.onnx` | `input_ids` `[1, S]` i64 | `embeddings` `[1, S, 1024]` f32 |
| `decoder.onnx` | `inputs_embeds` `[1, S, 1024]`, `attention_mask` `[1, past+S]` f32, `position_ids` `[3, 1, S]` i64, `past_key_values.{L}.{key,value}` `[1, 2, past, 128]` × 18 | `logits` `[1, S, 103424]`, `present.{L}.{key,value}` |

Empty past: `past = 0`. Prefill: splice `image_embeds` into rows where `input_ids == 100295`. Step: last token embed only; append one to the mask; take last logit row.

Hard-check at Load: 18 layers, 2 KV heads, head dim 64? **128**, vocab **103424**, hidden **1024**. Log and reject otherwise.

Quant packs keep I/O float32 (`keep_io_types=true`). C++ always feeds f32 / i64.

### 1.4  Host pipeline (one RGB frame)

```text
RGB8
  → ImageOps (pixel_values [1,P,3,14,14], grid [t,h,w], N=P/4)
  → vision_encoder → image_embeds [N,1024]
  → prompt with N × <|IMAGE_PLACEHOLDER|> → tokenizer.Encode
  → embedding
  → splice id 100295
  → rope_index(input_ids, grid, mask) → position_ids, rope_delta
  → decoder prefill + greedy until EOS 2 or cap
  → tokenizer.Decode(generated, keep specials)
  → Markup → raw_utf8, markdown_utf8, text_utf8, spans=[]
```

Logs: phase, src H/W, resized H/W, grid thw, N, prompt_len, cap, every 32th token + last, stop, sizes of raw/markdown/text.

### 1.5  Tokenizer

Parse `tokenizer.json`: `model.type == BPE`, vocab dict (~100295), merge pairs (~182926), **all** `added_tokens` (~1041). `byte_fallback == true`, `unk_token == <unk>`.

Encode:

1. Longest-match added tokens (`<|begin_of_sentence|>`, `<|IMAGE_START|>`, `<|IMAGE_PLACEHOLDER|>`, `<|IMAGE_END|>`, `</s>`, …).
2. Normalizer: replace `" "` → `"▁"`.
3. BPE with byte_fallback (`<0xXX>`). No GPT-2 ByteLevel pretok, no NFKC Sequence.
4. Do not apply TemplateProcessing.

Decode: id → token, `▁` → space, ByteFallback, Fuse; keep specials.

Host tests (no pack required for the JSON if we vendor a tiny fixture; otherwise skip until the pack exists):

- Encode the control prompt with `N=1` → ids include `100273, 101305, 100295, 101306, 2` is **not** in the prompt; EOS is generated.
- Known specials: `IMAGE_PLACEHOLDER=100295`, `IMAGE_START=101305`, `IMAGE_END=101306`, `begin_of_sentence=100273`, `</s>=2`.
- Round-trip a short ASCII string including a space (`▁`).
- Round-trip one CJK codepoint via byte_fallback or vocab.

### 1.6  Image + RoPE

ImageOps: RGB → `smart_resize` (port the Python function literally, including the `factor` lift for tiny sides and aspect `> 200` error) → bicubic → `/255` → `(x-0.5)/0.5` → unfold `[P,3,14,14]` → add batch dim. `grid = {1, H/14, W/14}`.

Bake constants; do not parse `preprocessor_config.json` in v1.

RoPE: port `rope_index_numpy` / `decode_position_ids`. Host test: synthetic `input_ids` with a block of `100295` and a known `image_grid_thw` → `position_ids` shape `[3,1,S]` and finite increasing text vs spatial h/w indices.

### 1.7  Markup

Input: generated decode, strip trailing `</s>` / EOS.

| Output | Rule |
|--------|------|
| `raw_utf8` | that string |
| `markdown_utf8` | strip leftover `<\|…\|>` / `<s>` / `</s>`; keep markdown and HTML |
| `text_utf8` | same as `test_parity.layout_text`: drop tags + `` `#*_` `` ticks, collapse whitespace |
| spans | empty vector |

Do not run `ParseDocTags`. Host test: a fake `Hello World` markdown stream → empty spans + plaintext `Hello World`.

---

## Phase 2 — Detect, validate, factory, load copy

### 2.1  Kind + paths

[`OcrModelKind`](../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h): add `kPaddleocrVl`.

`IsOcrVlmKind`: include it.

`OcrModelPaths` / `OcrDetectResult` / `OcrLoadOptions`: add

- `embedding` / `embedding_data`

Reuse `vision_encoder`, `decoder`, `tokenizer`, `manifest` fields. Decoder canonical file for this family is **`decoder.onnx`**.

`kPaddleocrVlReqs`: vision (+ data), embedding (+ data), decoder (+ data), tokenizer, manifest. **Do not** add these files to `kDocVlmReqs` / `kNemotronParseReqs`. **Do not** require `embed_tokens` or `decoder_model_merged`.

`ReadManifestFamily`: `paddleocr_vl` → `kPaddleocrVl`. Unknown family still unsupported.

`ParseOcrModelType` / iOS twin / `CanonicalOcrModelType`:

- `paddleocr_vl`, `paddleocr-vl` → `paddleocr_vl`
- **not** `paddleocr`, `ppocr`, `pp-ocr`, `doc_vlm`, `nemotron`

### 2.2  Name heuristics (collision)

**Before** any `paddleocr` → `ppocr` substring match:

- `InferOcrModelTypeFromKey`
- `InferPpocrNameOnly` (must **not** fire on `paddleocr-vl-1.6-fp16`)
- detect name-only helper `InferPaddleocrVlNameOnly`: `paddleocr_vl` / `paddleocr-vl` / `paddleocr-vl-1.6`

`InferPpocrNameOnly` may keep `paddleocr` for real PP-OCR packs (`paddleocrv4`, …) **after** the VL check.

### 2.3  Auto detect

New complete suffix-group `TryCompletePaddleocrVlGroup`:

`vision_encoder.onnx`, `embedding.onnx`, `decoder.onnx` (+ `_data`), `tokenizer.json`, `ocr_manifest.json`.

If the manifest says `paddleocr_vl`, trust it even when a granite-looking `vision_encoder.onnx` is present. Do **not** walk Hub `onnx/fp16` nesting.

### 2.4  Unified detect

[`IsOcrVlmKind`](../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h) already overrides STT / enhancement when OCR VLM detect succeeds. Add `kPaddleocrVl`. Host `model_detect_test`: VL pack named `paddleocr-vl-1.6-fp16` is **not** `ppocr`; mixed folder + `decoder.onnx` does not lose to enhancement.

### 2.5  Factory + engine

`CreateOcrBackend("paddleocr_vl")` → `PaddleocrVlBackend`. `auto` passed **straight** to the factory still means ppocr (unchanged). Folder `auto` uses detect.

`CopyDetectPaths` / `HasCustomOcrPaths`: copy the new embedding fields. `OcrEngine::Load` must pass them through.

### 2.6  Custom config

[`customConfig.ts`](../../src/ocr/customConfig.ts): `OcrPaddleocrVlCustomConfig` with `vision_encoder`, `vision_encoder_data`, `embedding`, `embedding_data`, `decoder`, `decoder_data`, `tokenizer`, `manifest`. `GetOcrPathRequirements` / validate-custom must list them. Path key union += `embedding` | `embedding_data`.

---

## Phase 3 — Public API

Unpublished: reshape shared OCR types if the third family would otherwise duplicate granite/Nemotron unions, `@deprecated` aliases (`OcrDocVlmOptions`, `doctags`-only extras checks), or nested per-family option bags. Prefer one VLM extras shape + family-only fields. Update example + `docs/ocr-offline.md` to the new surface in the same change. Do not keep shims “for 0.x callers.”

### 3.1  TypeScript

[`src/ocr/types.ts`](../../src/ocr/types.ts):

- `OcrModelType` / `OcrFamily` += `'paddleocr_vl'`
- New init arm `OcrInitializeOptionsPaddleocrVl` (shared `maxNewTokens`)
- `OcrRecognizeResult` new arm (`raw`, `markdown`, `complete`, `stopReason`: `'eos' | 'max_new_tokens'`)
- Alias map: `'paddleocr-vl' → 'paddleocr_vl'` only

[`ocrNativeBridge.ts`](../../src/ocr/ocrNativeBridge.ts) / [`readRecognizeResult`](../../src/ocr/index.ts): accept the new family; require `raw` + `markdown` + `complete` + those two stop reasons; **reject** if `doctags` is the only markup field.

Bridge: forward `maxNewTokens` onto existing native `maxNewTokens`. Do not send a nested `docVlm` / `nemotronParse` blob.

### 3.2  Native bridges

JNI: put `raw` / `stopReason` / `complete` for `paddleocr_vl` as well as `doc_vlm` / `nemotron_parse`.

Kotlin helper: extras check **branches on family** — granite still needs `doctags`; this family needs `raw`.

iOS: same discriminant and path keys.

`NativeSherpaOnnx.ts` / `modelDetect.ts` path maps: document `embedding` / `embedding_data`.

Jest: create/recognize round-trip, alias, missing-`raw` reject, `paddleocr` is still **not** this family. Granite still exposes `doctags`; tests follow whatever shared extras shape Phase 3 lands on.

---

## Phase 4 — Example + docs

[`example/src/screens/ocr/OCRScreen.tsx`](../../example/src/screens/ocr/OCRScreen.tsx):

- Treat `family === 'paddleocr_vl'` as VLM extras (same Markdown / Raw tabs as Nemotron).
- Spans overlay: empty is fine; do not fake boxes.

[`docs/ocr-offline.md`](../ocr-offline.md): new family subsection — pack layout, `createOCR({ modelType: 'paddleocr_vl' })`, result arm, prompt/stop, “not DocTags, not Nemotron xy, no layout model”.

Root README OCR models table: one row, same style as Granite / Nemotron (no extra bold).

Do not change VoiceLab in this plan.

---

## Phase 5 — First-party pack pipeline (no upload unless asked)

[`scripts/ocr-models/build_and_upload.js`](../../scripts/ocr-models/build_and_upload.js) + `sources.csv`:

- `VALID_FAMILIES` += `paddleocr_vl`
- Flatten one variant folder → `<id>/` with canonical names + `ocr_manifest.json` + `LICENSE` + `tokenizer.json`
- Ids: `paddleocr-vl-1.6-fp16` (and int8 / q4f16 only if export still ships them)
- `hf_repo` `XDcobra/PaddleOCR-VL-1.6-ONNX` when Hub exists
- Do **not** pack Hub `onnx/fp16`+`onnx/int8` as one archive

Fixtures (`ocr-models-expected.csv`) and license CSV rows when an archive is actually built. Catalog language hints: official card is multilingual (en/zh + more) — do not copy granite `en/ja/ar/zh` blindly.

GitHub release `ocr-models` upload stays a later, explicit ask.

---

## Tests (minimum)

| Layer | Cases |
|-------|--------|
| Host tokenizer / smart_resize size / rope indices / markup | no pack required (tiny JSON fixture or skip tokenizer until pack) |
| Host ORT smoke | Hello-page when `PADDLEOCR_VL_MODEL_DIR` set; skip otherwise |
| `model_detect_test` | manifest family; complete pack; **`paddleocr-vl-1.6-*` is not ppocr**; unified override vs enhancement `decoder.onnx` |
| Jest OCR API | new arm, alias, extras reject, customConfig keys, `paddleocr` still ppocr |
| Example | manual Android: overlay empty, Markdown/Raw tabs, copy |

Do not add a multi-GB pack to the default `test-ocr-host.yml` job. Optional `workflow_dispatch` later.

---

## Out of scope

- Publishing HF or GitHub assets
- A generic `VlmBackend` base / `if (family)` mega-backend (shared **helpers** are in scope)
- PP-DocLayoutV3 two-stage pipeline
- `Spotting:` / chart / seal prompts and `<LOC_*>` spans
- Recognize-time `maxPixels` / `maxSide`
- VoiceLab wiring
- Community `iaa2005` int8 graphs
- Keeping deprecated public aliases solely for compatibility

---

## Suggested commit groups (when asked)

1. `feat(ocr): add PaddleOCR-VL backend and host tests` (Phase 1)
2. `feat(ocr): detect and load paddleocr_vl packs` (Phase 2, includes ppocr name-collision fix)
3. `feat(ocr): expose paddleocr_vl recognize extras` (Phase 3)
4. `feat(example): add PaddleOCR-VL result tabs` + `docs(ocr): document paddleocr_vl` (Phase 4)
5. Pack pipeline commit only when sources/packer land (Phase 5)

---

## Implementation order

Phase 0 (pack present?) → 1 (prove one frame on Android host / device logs vs `infer_ort.py`) → 2 → 3 → 4. Phase 5 waits until a pack is ready to archive.

Backend work does **not** have to wait for quantization. FP32 `onnx/` is enough to lock I/O and goldens; later dtypes keep the same signatures.

One hypothesis per change when debugging decode; keep the new logs until the Hello World stream matches `infer_ort.py`.
