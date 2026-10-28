# Phase 2 — `DocVlmBackend` spike (Granite-Docling ONNX)

> Branch: `feat/add-ocr-doc-vlm`
> Prereq: Phase 1 pack `docvlm-granite-258m` (layout and `ocr_manifest.json` in [phase1-doc-vlm-packs-plan.md](phase1-doc-vlm-packs-plan.md))
> Out of scope: factory branch, public TS API, detect, download, docs outside this plan, example app (Phases 3–5)

High-level contract: [`.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md`](../../.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md).

This phase implements `DocVlmBackend : OcrBackend` and proves one RGB frame → DocTags → plain text + markdown + at least one `OcrSpan`. It does not register the family in `CreateOcrBackend`. Host tests construct `doc_vlm::DocVlmBackend` directly.

Local pack used to pin every tensor name and token id below (2026-10-15):

```text
build/ocr-models/docvlm-granite-258m/
```

If that tree is missing, unpack the release asset (do not re-download inside the test binary):

```bash
mkdir -p build/ocr-models
curl -fsSL -o /tmp/docvlm-granite-258m.tar.bz2 \
  https://github.com/XDcobra/react-native-sherpa-onnx/releases/download/ocr-models/docvlm-granite-258m.tar.bz2
tar xjf /tmp/docvlm-granite-258m.tar.bz2 -C build/ocr-models
```

Graphs inspected: `vision_encoder.onnx` (opset 14), `embed_tokens.onnx` (opset 21), `decoder_model_merged.onnx` (opset 21 + `com.microsoft`). Weights stay in the sibling `*.onnx_data` files. Create each `Ort::Session` from the `.onnx` path. Do not `CreateSessionFromArray` on a copied buffer; ORT resolves external data locations as basenames next to the graph.

---

## 0  Decisions

| Decision | Choice |
| --- | --- |
| Class | `sherpa_onnx::ocr::doc_vlm::DocVlmBackend`, `Family()` returns `"doc_vlm"` |
| Decode | Greedy argmax. Temperature, top-p, penalties, and beams stay out. |
| Stop ids | `100257` (`<\|end_of_text\|>`, eos) and `100328` (`</doctag>`). Eos is not appended to the decoded string. `</doctag>` is kept. |
| `max_new_tokens` | Default **8192** (same cap as Docling's Granite preset). `0` on the new load field means this default. Host smoke passes `512`. Early stop usually fires first. |
| Prompt | Hardcoded chat expansion. Do not embed a Jinja interpreter. User text is the exact string `Convert this page to docling.` |
| Tokenizer | Small C++ GPT-2 byte-level BPE over `tokenizer.json` only. Do not link Hugging Face `tokenizers` / Rust. `vocab.json` and `merges.txt` are duplicates; do not parse them. |
| Image processor | Match Transformers 4.57 `Idefics3ImageProcessor` (`do_image_splitting=true`, longest edge 2048, tile 512, Lanczos). The first resize **sets** the long side to 2048, including upscaling. Do not add a "small image" shortcut. |
| DocTags | v1 regex extractor: plain text, lossy markdown, axis-aligned quads from `<loc_N>`. Not a Docling document model. |
| `OcrResult` | Add `doctags_utf8` and `markdown_utf8` now (empty string default). ppocr/doctr leave them empty. TS/JNI export is Phase 3. |
| Factory | Do not edit `OcrFactory.cpp`. |
| OpenCV | None. Lanczos is in-tree. |
| ORT provider | `ApplyOrtProvider` (same as other first-party sessions). Empty/`cpu` → CPU. `nnapi` / `xnnpack` / `coreml` attach when available; missing or unusable EP logs and stays on CPU. `qnn` is unknown here and falls back to CPU. |
| Threads | `SetIntraOpNumThreads(max(1, options.num_threads))`. Leave inter-op at 1. Vision, embed, and decoder run one after another on the calling thread. `Recognize` is not thread-safe. |
| Graph opt | `ORT_ENABLE_EXTENDED` on all three sessions. `ORT_ENABLE_ALL` on the 628 MiB decoder spends init memory on fusions this spike does not need. |
| CI | Do not add this pack to `.github/workflows/test-ocr-host.yml` (Phase 5). The new ctest skips the ORT smoke when the pack is absent. |

---

## 1  Architecture

```text
OcrFrameView RGB8
  │
  ├─ DocVlmImageOps     longest-edge 2048 → tile grid + global → NCHW fp32 + bool mask
  ├─ vision_encoder     pixel_values + pixel_attention_mask → image_features [N, 64, 576]
  ├─ DocVlmPrompt       chat ids with <image> expanded to N × 64 image-token runs
  ├─ embed_tokens       input_ids → inputs_embeds [1, S, 576]
  ├─ scatter            replace embeds at token 100270 with image_features, in order
  └─ decoder loop       prefill (S tokens, empty KV) then greedy steps (1 token, present→past)
        │
        └─ DocVlmTokenizer decode (skip_special_tokens = false)
              └─ DocVlmDocTags → text_utf8, markdown_utf8, spans, doctags_utf8
```

`OcrEngine` is unchanged. `Recognize` still takes `OcrFrameView` and returns `OcrResult`.

Three sessions live for the `Load`/`Release` lifetime. KV cache lives only inside one `Recognize` and is discarded before return. The next frame starts from an empty past.

Log tag is the existing `[SherpaOnnx:ocr]` (`OCR_LOGI` / `OCR_LOGW` block copied from `doctr/DoctrBackend.cpp`). Do not extract a shared header. Log phase, shapes, tile rows/cols, prompt length, image-token count, stop reason, and output sizes. Inside the decode loop, log token id and step every 32 steps plus the last step.

---

## 2  ONNX I/O (from the unpacked graphs)

Element types: float32 = ONNX `1`, int64 = `7`, bool = `9`.

### 2.1  `vision_encoder.onnx`

| | Name | Type | Shape |
| --- | --- | --- | --- |
| in | `pixel_values` | float32 | `[batch_size, num_images, 3, 512, 512]` |
| in | `pixel_attention_mask` | bool | `[batch_size, num_images, 512, 512]` |
| out | `image_features` | float32 | `[num_images, 64, 576]` when `batch_size` is 1 |

The output's first dim is a single dynamic dimension whose *name* is the string `batch_size * num_images`. At runtime with batch 1 it is `num_images`. Assert rank 3, `dims[1]==64`, `dims[2]==576`, `dims[0]==num_images`.

`64` is `(512/16)^2 / scale_factor^2` = `1024/16`. The connector (pixel-shuffle + project 768→576) is inside this graph. There is no separate connector session.

`pixel_values` is NCHW RGB, already rescaled and normalized. The mask is true on real pixels and false on bottom/right pad. Batch is always 1, so the tensors stay rank 5 and rank 4 even when `num_images==1`.

### 2.2  `embed_tokens.onnx`

| | Name | Type | Shape |
| --- | --- | --- | --- |
| in | `input_ids` | int64 | `[batch_size, sequence_length]` |
| out | `inputs_embeds` | float32 | `[batch_size, sequence_length, 576]` |

One `Gather`. Valid ids are `0 .. 100351` (`vocab_size` 100352). `<end_of_utterance>` is id **100352** and is outside the embedding. Never emit it.

`tie_word_embeddings` is true upstream, but the decoder graph owns its own lm-head. Call the embed session only to build `inputs_embeds`. Do not share its weight with the decoder.

### 2.3  `decoder_model_merged.onnx`

62 inputs, 61 outputs. No `position_ids`, no `use_cache_branch`, no `If` node. RoPE is inside Microsoft `GroupQueryAttention` (`do_rotary=1`, `rotary_interleaved=0`, `num_heads=9`, `kv_num_heads=3`, `scale=0.125` = `1/sqrt(64)`, `local_window_size=-1`). `cos_cache` / `sin_cache` are initializers. Positions are `0 .. total_length-1` derived from the mask. Do not compute RoPE in C++.

| | Name | Type | Shape |
| --- | --- | --- | --- |
| in | `inputs_embeds` | float32 | `[1, sequence_length, 576]` |
| in | `attention_mask` | int64 | `[1, total_sequence_length]` |
| in | `past_key_values.{i}.key` | float32 | `[1, 3, past_sequence_length, 64]` |
| in | `past_key_values.{i}.value` | float32 | `[1, 3, past_sequence_length, 64]` |
| out | `logits` | float32 | `[1, sequence_length, 100352]` |
| out | `present.{i}.key` | float32 | `[1, 3, total_sequence_length, 64]` |
| out | `present.{i}.value` | float32 | `[1, 3, total_sequence_length, 64]` |

`i` is `0 .. 29` (30 layers). Pass names in that order: embeds, mask, then for each layer key then value. Output order is `logits`, then `present.0.key`, `present.0.value`, … `present.29.value`.

The graph turns the mask into the two GQA scalars itself:

- `seqlens_k = ReduceSum(attention_mask, axis=1) - 1`
- `total_sequence_length = shape(attention_mask)[1]`

v1 mask is all ones (batch 1, no padding). Causal masking is inside GQA. Do not build a triangular mask.

`present` already contains past concatenated with the new keys. Feed `present.*` back as `past_key_values.*` on the next call. Do not concatenate in C++.

First call uses `past_sequence_length = 0`, shape `[1, 3, 0, 64]`. `CreateTensor<float>` with a non-null dummy pointer and element count 0. A zero-length past is valid on ORT 1.28 (the pin in `third_party/onnxruntime_prebuilt/VERSIONS`). If `Run` rejects it, stop and record the ORT error. Do not invent a length-1 dummy past; that shifts RoPE.

`GroupQueryAttention` is a contrib op (`com.microsoft`). The official host ORT zip includes it. A mobile ORT built without contrib ops fails at `Session` create with an unregistered-op error. Phase 2 only has to pass on the host ORT zip. Note the mobile risk for Phase 3; do not rebuild ORT here.

Prefill logits are large: `S * 100352 * 4` bytes. `en_hello` is 347 prompt tokens → ~133 MiB for that output, freed when the `Ort::Value` dies. Argmax only the last row: index `(S - 1) * 100352 + v`. Ties take the lowest index.

---

## 3  Image preprocessing

Source: Transformers v4.57.1 `image_processing_idefics3.py`, driven by this pack's `preprocessor_config.json`.

`OcrFrameView` is already RGB8. `do_convert_rgb` is a no-op. Resample is PIL `Resampling.LANCZOS` (`preprocessor_config.json` `"resample": 1`).

### 3.1  Resize math

Constants from the manifest (`vision` object): `size_longest_edge=2048`, `max_image_size_longest_edge=512`, `image_size=512`. Absolute cap `MAX_IMAGE_SIZE=4096` is hardcoded in the HF processor (not in our manifest). After the 2048 step both sides are ≤ 2048, so the 4096 clamp does not change these fixtures.

**Step A — longest edge becomes 2048** (`_resize_output_size_rescale_to_max_len`). This upscales small images.

```text
aspect = width / height
if width >= height:
  out_w = 2048
  out_h = int(out_w / aspect)
  if out_h is odd: out_h += 1
else:
  out_h = 2048
  out_w = int(out_h * aspect)
  if out_w is odd: out_w += 1
out_h = max(out_h, 1); out_w = max(out_w, 1)
```

`int` truncates toward zero. The odd-side bump is only in this step.

**Step B — round each side up to a multiple of 512** (`resize_for_vision_encoder`), aspect taken from step A **before** the assignment:

```text
aspect = out_w / out_h          # step A result
if out_w >= out_h:
  out_w = ceil(out_w / 512) * 512
  out_h = int(out_w / aspect)   # uses the updated out_w
  out_h = ceil(out_h / 512) * 512
else:
  out_h = ceil(out_h / 512) * 512
  out_w = int(out_h * aspect)
  out_w = ceil(out_w / 512) * 512
```

**Step C — `split_image`.** If either side is **>** 512:

```text
rows = ceil(out_h / 512)
cols = ceil(out_w / 512)
tile_h = ceil(out_h / rows)
tile_w = ceil(out_w / cols)
crops in row-major order (r, then c):
  x0 = c * tile_w;  x1 = min(x0 + tile_w, out_w)
  y0 = r * tile_h;  y1 = min(y0 + tile_h, out_h)
then append one global image: stretch the step-B image to exactly 512×512
num_images = rows * cols + 1
```

If both sides are ≤ 512, `rows = 0`, `cols = 0`, `num_images = 1`, and the only frame is the step-B image (no extra global). The prompt uses the single-image form in §5.2. Our fixtures do not hit this branch. A unit test still covers a synthetic 512×512 **after** step B (pass the post-step-B size in, or factor `SplitGrid` so the test calls it directly).

Ignore `get_number_of_image_patches` in the same HF file. It overwrites the aspect-derived side and is not what `preprocess()` runs.

### 3.2  Fixture grids (locked)

| Image | Pixels | After step A | After step B | Grid |
| --- | --- | --- | --- | --- |
| `test/fixtures/ocr/en_hello.png` | 1000×240 | 492×2048 | 512×2048 | 1×4 + global = **5** |
| `test/fixtures/ocr/de_guten_tag.png` | 900×200 | 456×2048 | 512×2048 | 1×4 + global = **5** |
| `test/fixtures/ocr/zh_nihao.png` | 600×200 | 682×2048 | 1024×2048 | 2×4 + global = **9** |
| any square, including 64×64 and 512×512 | | 2048×2048 | 2048×2048 | 4×4 + global = **17** |

Longest edge 2048 and tile 512 cap the grid at 4×4. `rows>4` or `cols>4` is a throw. Smoke uses `en_hello` (5 images). A square fixture makes a 17-image prefill (~480 MiB logits); do not use one for the smoke test.

### 3.3  Pixels

Lanczos, lobe `a=3`, separable. PIL maps output pixel `x` to input coordinate `(x + 0.5) * in_size / out_size - 0.5`. Same for `y`. Reflect or clamp samples that fall outside. Stretch-to-512 for the global image uses the same filter (not nearest).

Order per tile, matching HF `preprocess`:

1. Resize / crop (uint8 RGB).
2. Rescale: `pixel * rescale_factor` with `rescale_factor = 1/255` from the manifest.
3. Normalize: `(v - mean) / std` per channel. This pack's mean and std are all `0.5`, so the fused form is `pixel / 127.5 - 1`.
4. Pad bottom and right with **normalized** value `0` up to 512×512 (HF pads after normalize, constant 0, not normalized black `-1`).
5. Mask: `true` on the unpadded rectangle, `false` on the pad. ONNX bool. Store as `uint8` 0/1 if `CreateTensor<bool>` is unavailable; the tensor type must still be BOOL.

For the locked fixtures, crops and the global image are already 512×512, so the mask is all true. Implement pad anyway for a short last tile.

Layout: `pixel_values[0, image_index, c, y, x]` with image 0 the top-left crop and the last index the global image. Channel order RGB.

---

## 4  Tokenizer

`tokenizer.json` (Hugging Face tokenizers v1.0): `model.type = "BPE"`, `pre_tokenizer.type = "ByteLevel"`, `add_prefix_space = false`, `use_regex = true`, `byte_fallback = false`. Vocab length 100352 (ids 0..100351). Merges length 100000, each entry a two-string pair (`["Ġ", "Ġ"]`, not the `merges.txt` line format). Merge rank is the array index.

Added tokens are ids 100256..100352 (97 entries). 100352 is not in the embedding. Ids 100256..100351 are also the tail of `model.vocab`; building `id → string` from `model.vocab` is enough. Treat ids `>= 100256` as specials (literal strings). Treat ids `< 100256` as byte-level pieces.

### 4.1  What to load

One pass over `tokenizer.json`. A general JSON library is not already linked from OCR code (`DoctrManifest.cpp` is a hand scanner for a 2 KiB file). A 4 MiB scan is fine if it only extracts:

- `model.vocab` object → `vector<string>` of size 100352, keyed by id
- `model.merges` array of pairs → `unordered_map<pair, int>` rank
- `added_tokens[].content` for ids 100256..100351, to confirm they match the vocab tail

Reject the pack if `model.type` is not `BPE` or vocab size is not 100352.

Byte map: the standard GPT-2 `bytes_to_unicode()` (printable bytes stay themselves; the rest map to `chr(256+n)`). Inverse map is decode. `Ġ` (U+0120) is the space byte. `\n` encodes as `Ċ` (U+010A), vocab id **198**.

### 4.2  Encode (prompt ASCII only)

v1 encode is for the fixed prompt, which is ASCII plus the specials in §5. Decode must handle the full UTF-8 DocTags stream (English, and the experimental ja/ar/zh pieces the model may emit).

1. Longest-match scan against added-token strings (sort by byte length descending). A hit emits that id and skips the matched bytes. This is what keeps `<|start_of_role|>` as id 100264. Byte-level BPE of that string is nine pieces starting with `<` (id 27) and is wrong.
2. Remaining spans go through the GPT-2 regex, then BPE. `add_prefix_space` is false: do not insert a leading space.
3. Regex, ASCII subset of the HF pattern (`use_regex: true`):

```text
's|'t|'re|'ve|'m|'ll|'d| ?[A-Za-z]+| ?[0-9]+| ?[^\sA-Za-z0-9]+|\s+(?!\S)|\s+
```

4. Each regex piece: map bytes through `bytes_to_unicode`, then BPE (repeatedly merge the in-vocab pair with the lowest rank). Map the final pieces through `vocab`. A missing piece throws. Do not substitute `<|unk|>` (100338).

Locked encode of the user sentence (verified against this pack's vocab and merges):

| Piece | Id |
| --- | --- |
| `Convert` | 12281 |
| `Ġthis` | 420 |
| `Ġpage` | 2199 |
| `Ġto` | 311 |
| `Ġdoc` | 4733 |
| `ling` | 2785 |
| `.` | 13 |

`docling` is two pieces (`Ġdoc` + `ling`), not one id. `user` → 882. `assistant` → 78191. `\n` → 198.

### 4.3  Decode (`skip_special_tokens = false`)

Walk generated ids. Accumulate a run of ids `< 100256`. On a special, or at the end:

- Map each accumulated piece through the inverse byte table, concatenate **all** bytes, then UTF-8-decode **once**. Per-token UTF-8 decode splits CJK code points that BPE cut mid-sequence.
- Append the special's vocab string as raw UTF-8 (`<doctag>`, `<text>`, …).

Do not drop specials. Location markers are not specials; they appear as the decoded ASCII `<loc_N>` inside the BPE run. The DocTags parser depends on that.

`lstrip` the decoded generation on ASCII space, tab, CR, LF before storing `doctags_utf8` (the IBM sample does this).

---

## 5  Prompt

Do not execute `chat_template.jinja`. The file is the spec; the C++ expansion below is what that template produces for one user turn with one image and `add_generation_prompt=true`, and with `controls` omitted.

Unexpanded template result (one `<image>` placeholder):

```text
<|start_of_role|>user<|end_of_role|><image>Convert this page to docling.<|end_of_text|>
<|start_of_role|>assistant<|end_of_role|>
```

There is a real newline (id 198) between `<|end_of_text|>` and `<|start_of_role|>assistant`. There is no space before `assistant`.

### 5.1  Special ids (this pack)

| String | Id |
| --- | --- |
| `<\|start_of_role\|>` | 100264 |
| `<\|end_of_role\|>` | 100265 |
| `<\|end_of_text\|>` | 100257 |
| `<image>` | 100270 |
| `<fake_token_around_image>` | 100339 |
| `<global-img>` | 100340 |
| `</doctag>` | 100328 |
| `<doctag>` | 100327 |

`<row_R_col_C>` ids are **not** a dense rectangle (`<text>` sits at 100260 between `<row_1_col_2>` and `<row_1_col_3>`). Look up by exact string. Locked table:

| | col 1 | col 2 | col 3 | col 4 |
| --- | --- | --- | --- | --- |
| row 1 | 100258 | 100259 | 100261 | 100262 |
| row 2 | 100263 | 100267 | 100268 | 100341 |
| row 3 | 100342 | 100343 | 100344 | 100345 |
| row 4 | 100346 | 100347 | 100348 | 100349 |

`Load` checks these strings in `tokenizer.json` against the manifest ids for bos/eos/image (`100264`, `100257`, `100270`). The row-token table is checked by a unit test, not by the manifest (the manifest does not list them).

### 5.2  Image-token block

`image_seq_len = 64`.

When `rows==0 && cols==0` (one image, no split):

```text
<fake_token_around_image><global-img><image>×64<fake_token_around_image>
```

When splitting (`rows>=1`, `cols>=1`), from `processing_idefics3.py` `_prompt_split_image`:

```text
for r in 1..rows:
  for c in 1..cols:
    <fake_token_around_image><row_r_col_c><image>×64
  "\n"
"\n"
<fake_token_around_image><global-img><image>×64<fake_token_around_image>
```

The per-tile fake token is a prefix only. The closing fake token exists on the global image only. Newlines are token 198, not the characters backslash-n.

Image-token count must equal `num_images * 64`. For a split, `num_images = rows*cols + 1`. For `en_hello` (1×4): `5 * 64 = 320` ids equal to 100270.

### 5.3  Full id list for `en_hello` (347 ids)

The two newlines between the tile rows and the global image are adjacent in the chat string. This pack's BPE merges `ĊĊ` (`\n\n`) to id **271**, so they are one id, not two copies of 198. The newline before `assistant` stays 198 because a special follows it.

```text
100264, 882, 100265,
# four tiles:
100339, 100258, 100270 ×64,
100339, 100259, 100270 ×64,
100339, 100261, 100270 ×64,
100339, 100262, 100270 ×64,
271,
100339, 100340, 100270 ×64, 100339,
12281, 420, 2199, 311, 4733, 2785, 13,
100257,
198,
100264, 78191, 100265
```

A unit test builds this list and also `Encode`s the expanded string. The two sequences match. That locks specials-before-BPE and the image block together.

---

## 6  Decode algorithm

`Recognize` steps. Batch is 1. `S0` is the prompt length from §5.

1. Reject a null `rgb` or non-positive size (`std::invalid_argument`, prefix `DocVlmBackend:`).
2. Build tiles, `pixel_values`, `pixel_attention_mask` (§3). Log `rows`, `cols`, `num_images`.
3. Run `vision_encoder`. Assert `image_features` shape `[num_images, 64, 576]`.
4. Build prompt ids (§5). Count ids equal to `image_token_id`. Throw if the count is not `num_images * 64`.
5. Run `embed_tokens` on the full prompt. Copy the float output (the session output dies at the next `Run`).
6. Scatter: walk prompt ids, and wherever the id is `image_token_id`, copy the next 576 floats from `image_features` in row-major order (`image 0` tokens `0..63`, then image 1, …). The learned embedding at 100270 is discarded. Throw if the cursor does not land on `num_images * 64`.
7. Prefill. `inputs_embeds` is `[1, S0, 576]`. `attention_mask` is `S0` ones, int64. Past is 30 empty pairs `[1, 3, 0, 64]`. `Run` the decoder. `next = argmax(logits[0, S0-1, :])`. Move `present.*` into the past slots. Drop the logits value.
8. Loop while `generated < max_new_tokens`:
   - If `next == 100257`: stop. Reason `eos`. Do not append.
   - If `next == 100328`: append it, stop. Reason `doctag_end`.
   - Append `next`. If `generated == max_new_tokens`: stop. Reason `max_new_tokens`.
   - Embed the single id → `[1, 1, 576]`. It must not be the image token.
   - `total = S0 + generated`. Mask is `total` ones.
   - `Run` with `sequence_length = 1` and the previous `present` as past. `next = argmax` of the single row. Replace past with the new `present`.
9. Decode the appended ids (§4.3), `lstrip`, store as `doctags_utf8`.
10. `ParseDocTags` (§7) fills `text_utf8`, `markdown_utf8`, `spans`. `frame_index` on every span is `frame.frame_index`.
11. Log stop reason, generated count, `text_utf8.size()`, `spans.size()`.

KV buffers are locals of `Recognize`, not members. `Release()` drops the three sessions and the tokenizer tables.

`max_new_tokens` comes from `OcrLoadOptions` (§8). The backend clamps a negative value to the default. Cap the loop at `min(max_new_tokens, 8192)` so a caller cannot ask for past `max_position_embeddings` worth of junk in the spike; 8192 is also `text.max_position_embeddings`. A prompt plus 8192 can exceed 8192. If `S0 + max_new_tokens > 8192`, lower the cap so the total stays ≤ 8192 and log the clamp. RoPE tables in the graph are sized for 8192.

---

## 7  DocTags → text, markdown, spans

Docling location tokens `<loc_0>` … `<loc_499>` are **not** in this tokenizer as single ids (`DocumentToken.get_location` in docling-core uses `rnorm=500` and clamps to `0 .. 499`). They show up as decoded text. Order is `x0, y0, x1, y1` as fractions of the **source frame** (the `OcrFrameView`), not of the 2048 canvas and not of a tile.

```text
<doctag><text><loc_12><loc_40><loc_480><loc_90>Hello World</text></doctag>
```

### 7.1  Plain text and spans

Walk with one DOTALL regex, in match order (DocTags are already reading order; do not re-sort by y):

```text
<(text|paragraph|title|list_item|caption|footnote|formula|code|page_header|page_footer|section_header_level_[1-6])>
  (?:<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>)?
  (.*?)
</\1>
```

For each match:

- Inner text: delete any nested `<[^>]+>`, turn runs of space/tab into one space, trim.
- Skip the element if the trimmed text is empty.
- Append to `text_utf8`. `utf16_start = Utf8ToUtf16Length(plain_so_far)` before the append, `utf16_end` after. Then, if another element follows, append `\n` **outside** the span.
- Span `confidence = 1.f`. This pack's loop does not record logprobs. Document that in a comment on the assignment.
- Level: `title` and `section_header_level_*` → `OcrSpanLevel::kBlock`. Everything else in the regex → `kLine`. v1 does not emit `kWord`.
- Quad: `loc / 500.0 * frame_width` (and height for y). Clamp each loc to `[0, 499]` if the model emits 500 or more. If `x1 < x0` or `y1 < y0`, swap. Axis-aligned quad `x0,y0, x1,y0, x1,y1, x0,y1`. Missing loc group → full-frame quad `(0,0)-(width,height)`.

`picture`, `chart`, `otsl` / table cells, checkboxes, and key-value regions are not text elements. Their captions are, when the caption regex hits. OTSL (`<fcel>`, `<ecel>`, `<lcel>`, `<ucel>`, `<xcel>`, `<nl>`, `<ched>`, `<rhed>`) is not turned into a grid in v1.

If the regex yields no elements and `doctags_utf8` is non-empty, fallback: delete every `<[^>]+>`, collapse whitespace, trim. If that string is non-empty, one `kBlock` span with the full-frame quad and `confidence = 1`. Log `doctags_parse=fallback`.

### 7.2  Markdown (lossy, same walk)

| Element | Line |
| --- | --- |
| `title` | `# ` + text |
| `section_header_level_N` | `N+1` hashes (level 1 → `##`, cap 6) + text |
| `list_item` | `- ` + text |
| `formula` | `$$` + text + `$$` when the text does not already contain `$$` |
| `code` | fenced block |
| `text`, `paragraph`, `caption`, `footnote`, `page_header`, `page_footer` | the text |

Join with `\n`. A `<picture>` or `<chart>` or `<otsl>` element, if present as a wrapper with no captured prose, contributes a single line `[picture]`, `[chart]`, or `[table]` and, when four locs are on that wrapper, one `kBlock` span. Do not invent those lines when the tags are absent.

`markdown_utf8` may be empty only when `text_utf8` is empty.

### 7.3  Synthetic parser fixture (no ORT)

Input frame 1000×240. DocTags:

```text
<doctag><text><loc_0><loc_0><loc_250><loc_250>Hello</text></doctag>
```

Expect `text_utf8 == "Hello"`, one span, `utf16_start==0`, `utf16_end==5`, quad approximately `(0, 0, 500, 0, 500, 120, 0, 120)` because `250/500 * 1000 = 500` and `250/500 * 240 = 120`.

Second string `<doctag><title><loc_0><loc_0><loc_10><loc_10>Hi</title></doctag>` → markdown `# Hi`.

---

## 8  `OcrResult` and `OcrLoadOptions`

Extend `android/src/main/cpp/ocr/OcrTypes.h` only. ppocr and doctr stay source-compatible: new fields are defaulted, and those backends never write them.

```cpp
struct OcrResult {
  std::string text_utf8;
  std::vector<OcrSpan> spans;
  /** doc_vlm: raw DocTags after ASCII lstrip. Empty for ppocr/doctr. */
  std::string doctags_utf8;
  /** doc_vlm: lossy markdown from DocTags. Empty for ppocr/doctr. */
  std::string markdown_utf8;
};

struct OcrLoadOptions {
  // ...existing fields...
  /**
   * doc_vlm generation cap. 0 → 8192. Ignored by ppocr/doctr.
   * Phase 3 maps TS `docVlm.maxNewTokens` here.
   */
  int max_new_tokens = 0;
};
```

Phase 3 (do not do it now):

- JNI `sherpa-onnx-ocr-jni.cpp` today writes `text` and `spans` only (around the `PutString(..., "text", ...)` call). Add `doctags` and `markdown` string fields there, empty for the other families.
- TS `recognize` result: `doctags?: string`, `markdown?: string`. Absent or `""` for ppocr/doctr.
- `docVlm?: { maxNewTokens?: number }` on create options → `OcrLoadOptions::max_new_tokens`.
- No third "overlays" channel. Spans are the overlays.

`OcrFactory.cpp` is unchanged. `CreateOcrBackend("doc_vlm")` still throws. Phase 3 adds the branch and the aliases `docvlm`, `doc-vlm`, `granite-docling`, `docling`.

---

## 9  Files

### 9.1  New: `android/src/main/cpp/ocr/doc_vlm/`

| File | Role |
| --- | --- |
| `DocVlmBackend.h` / `.cpp` | `OcrBackend`. Three `Ort::Session`s, `Load` / `Recognize` / `Release`, scatter, greedy loop. ORT includes stay in the `.cpp`. |
| `DocVlmManifest.h` / `.cpp` | Read `ocr_manifest.json`. Hand scanner in the style of `DoctrManifest.cpp` (the file is ~2 KiB). Fields: `family`, `arch`, `onnx_dtype`, vision `image_size`, `patch_size`, `scale_factor`, `image_seq_len`, `mean[3]`, `std[3]`, `rescale_factor`, `size_longest_edge`, `max_image_size_longest_edge`, `do_image_splitting`, text `hidden_size`, `num_hidden_layers`, `num_key_value_heads`, `head_dim`, `vocab_size`, `max_position_embeddings`, special-token ids. Throw unless `family=="doc_vlm"`, `arch=="idefics3"`, `onnx_dtype=="fp32"`, `image_size==512`, `image_seq_len==64`, `hidden_size==576`, `num_hidden_layers==30`, `vocab_size==100352`. |
| `DocVlmImageOps.h` / `.cpp` | Step A/B sizes, split, Lanczos, normalize, mask. No ORT. `struct DocVlmTiles { int rows, cols, num_images; vector<float> nchw; vector<uint8_t> mask; }`. |
| `DocVlmTokenizer.h` / `.cpp` | Load, `Encode`, `Decode`. No ORT. |
| `DocVlmPrompt.h` / `.cpp` | `BuildPromptIds(tokenizer, rows, cols) → vector<int32_t>`. Uses tokenizer ids, not hardcoded numbers, except the unit test locks the granite numbers from §5.3. |
| `DocVlmDocTags.h` / `.cpp` | `ParseDocTags(doctags, frame_w, frame_h, frame_index) → {text, markdown, spans}`. Uses `Utf8ToUtf16Length`. |

`DocVlmBackend::Load` requires these paths under `model_dir` and throws if any is missing or empty:

```text
vision_encoder.onnx
vision_encoder.onnx_data
embed_tokens.onnx
embed_tokens.onnx_data
decoder_model_merged.onnx
decoder_model_merged.onnx_data
tokenizer.json
ocr_manifest.json
```

Other pack files (`chat_template.jinja`, `vocab.json`, `config.json`, …) stay on disk for Phase 4 detect. The backend does not read them.

Session input/output names are the literals in §2. On `Load`, also query the session and throw if a required name is absent, so a future export fails at load instead of at `Run`.

Copy the `OCR_LOGI` macro into `DocVlmBackend.cpp`. `Ort::Env` name: `sherpa-onnx-ocr-doc-vlm`. Logging level `ORT_LOGGING_LEVEL_WARNING`.

### 9.2  Edit

| File | Change |
| --- | --- |
| `android/src/main/cpp/ocr/OcrTypes.h` | The two result strings and `max_new_tokens` (§8). |
| `android/src/main/cpp/CMakeLists.txt` | Append the six new `.cpp` files next to the doctr sources (the list is explicit, around the `ocr/doctr/*.cpp` lines). Add `${CMAKE_CURRENT_SOURCE_DIR}/ocr/doc_vlm` to the OCR include directories next to `ocr/doctr`. |
| `SherpaOnnx.podspec` | The sources glob `android/src/main/cpp/ocr/**/*.{h,cpp}` already compiles the new files. Add the header search path `android/src/main/cpp/ocr/doc_vlm` beside `ocr/doctr`, or the pod build breaks on `#include "DocVlmBackend.h"`. |
| `test/cpp/CMakeLists.txt` | New `doc_vlm_host_test` target, same ORT wiring as `doctr_host_test` (`_ORT_API_WRAPPER`, host include, `onnxruntime`, rpath, GTest). |
| `test/cpp/ocr/doc_vlm_host_test.cpp` | New. |

Android and the podspec change so the new translation units compile on both platforms. They do not make the family selectable. `OcrFactory.cpp` does not reference `DocVlmBackend`, so the linked code is unused until Phase 3. That is intentional: the podspec glob would otherwise fail the iOS build the moment the `.cpp` files exist, and Android's explicit list would drift.

`doc_vlm_host_test` sources:

```text
test/cpp/ocr/doc_vlm_host_test.cpp
test/cpp/ocr/ocr_test_image.cpp
android/src/main/cpp/ocr/OcrTextUtils.cpp
android/src/main/cpp/ocr/doc_vlm/*.cpp
```

Do not link `OcrFactory.cpp`, ppocr, or doctr into this binary. Include directories: `ocr/`, `ocr/doc_vlm`, `test/cpp/ocr`, `test/cpp/ocr/vendor` (stb), the ORT wrapper and headers. Working directory of the ctest is the repo root, same as `doctr_host_test`. Set `TIMEOUT 300`.

### 9.3  Do not edit

`OcrFactory.cpp`, `OcrEngine.cpp`, `src/ocr/**`, JNI, detect, `docs/ocr-offline.md`, `.github/workflows/test-ocr-host.yml`, ppocr/doctr sources.

---

## 10  Memory and threads

Weights on disk, fp32 external data:

| File | Size |
| --- | --- |
| `vision_encoder.onnx_data` | 357 MiB |
| `embed_tokens.onnx_data` | 220.5 MiB |
| `decoder_model_merged.onnx_data` | 628 MiB |
| tokenizer + manifest | ~6 MiB |

ORT mmaps external data when the session is created from a filesystem path. RSS is still about 1.2 GiB of weights plus arenas.

| Buffer | `en_hello` (5 images, S=347) | Square page (17 images, S≈1.2k) |
| --- | --- | --- |
| `pixel_values` | 5×3×512×512×4 ≈ 16 MiB | ≈ 53 MiB |
| Prefill logits | 347×100352×4 ≈ 133 MiB | ≈ 480 MiB |
| KV at end of prefill | 30×2×3×347×64×4 ≈ 15 MiB | ≈ 55 MiB |
| KV if the loop actually hits 8192 new tokens | ~350 MiB | ~400 MiB |

Host smoke should land well under that last row because `</doctag>` stops a one-line fixture. Plan on **4 GiB RSS** and **6 GiB free** before running the smoke. A 7 GiB GitHub runner is the reason this pack stays out of the PR workflow until Phase 5 budgets a dedicated job.

`SetIntraOpNumThreads` from `OcrLoadOptions::num_threads` (default 4). The host smoke sets `2`. One `Ort::Env` for all three sessions. Do not run two `Recognize` calls on the same backend concurrently. Do not keep the vision output alive across the decode loop; free it after scatter.

Init cost is dominated by opening the 628 MiB decoder. Log milliseconds for each `Session` constructor.

---

## 11  Host tests

`test/cpp/ocr/doc_vlm_host_test.cpp`. Pack resolution mirrors doctr:

```text
DOCVLM_MODEL_DIR if set and a directory
else build/ocr-models/docvlm-granite-258m
else dist/ocr-models/docvlm-granite-258m
```

Valid pack: the eight paths in §9.1 exist and each `*.onnx_data` is at least the Phase 1 minimum (vision ≥ 300 MiB, embed ≥ 200 MiB, decoder ≥ 600 MiB).

Fixtures: `RepoRelativeFixture` / `TEST_FIXTURES_DIR` / `ocr_test::LoadRgbImage`, same as `doctr_host_test.cpp`. Images already in `test/fixtures/ocr/`: `en_hello.png`, `de_guten_tag.png`, `zh_nihao.png`.

### 11.1  Always run (no pack, no ORT session)

| Test | Assert |
| --- | --- |
| `GridMath.Fixtures` | The four rows of §3.2, including square → 17. Call the size functions, do not resize pixels. |
| `GridMath.SingleImageBranch` | A post-step-B 512×512 reports `rows==0`, `cols==0`, `num_images==1`. |
| `Tokenizer.UserSentence` | Encode `Convert this page to docling.` → `{12281,420,2199,311,4733,2785,13}`. Encode `user`, `assistant`, `"\n"` → 882, 78191, 198. This test needs `tokenizer.json`. If the pack is absent, `GTEST_SKIP`. |
| `Tokenizer.SpecialsBeforeBpe` | Encode `<\|start_of_role\|>` → `{100264}`, not a multi-piece BPE split. |
| `Tokenizer.DecodeSpecial` | Id 100327 → `<doctag>`, id 100257 → `<\|end_of_text\|>`. Round-trip the user sentence through decode (byte-level, so the space before `this` comes back). |
| `Prompt.EnHelloIds` | `BuildPromptIds` for rows=1, cols=4 equals the 347-id sequence in §5.3, and `Encode(expanded_string)` equals the same sequence. Skip when the pack is absent. |
| `Prompt.ImageTokenCount` | 0×0 → 64 image ids. 1×4 → 320. 2×4 → 576. 4×4 → 1088. |
| `DocTags.HelloQuad` | The synthetic fixture in §7.3. |
| `DocTags.TitleMarkdown` | `# Hi`. |
| `DocTags.FallbackStripsTags` | A string with no known element, e.g. `<doctag>Hello</doctag>`, still yields plain `Hello` and one full-frame span. |
| `OcrResult.ExtrasDefaultEmpty` | Value-initialized `OcrResult` has empty `doctags_utf8` and `markdown_utf8`. |

Tokenizer tests skip without the pack because `tokenizer.json` is not vendored into `test/fixtures/` (it is 4 MiB and already in the pack). Grid math and DocTags tests do not need it; they always run.

### 11.2  Smoke (pack required, ORT)

`TEST(DocVlmSmoke, EnHello)`:

- Pack missing → `GTEST_SKIP` with the unpack command from the top of this doc. Do not `FAIL`. Doctr's golden `FAIL`s because CI always downloads a 22 MiB pack. This pack is ~1.2 GiB and is not on the PR workflow in this phase.
- Pack present → run. `num_threads = 2`, `max_new_tokens = 512`, `provider` left empty.
- Assertions:
  - `doctags_utf8` contains `<doctag` and `</doctag>`
  - `text_utf8` is non-empty
  - alphanumeric casefold of `text_utf8` contains `hello`
  - `markdown_utf8` is non-empty
  - `spans.size() >= 1`, every quad component finite, `confidence == 1.f`, `frame_index == 0`
- Log wall time. Expect on the order of tens of seconds for the prefill, not minutes, on a laptop CPU. The ctest timeout is 300 s.

`de_guten_tag` and `zh_nihao` are not smoke gates. Chinese is experimental on this model, and `zh_nihao` is a 9-image prefill.

### 11.3  Strict golden (opt-in)

`TEST(DocVlmStrict, EnHello)`:

- Runs only when `DOCVLM_STRICT_GOLDEN=1` and `test/fixtures/ocr/expected/docvlm_en_hello.json` exists. Otherwise `GTEST_SKIP`.
- JSON fields written by the implementer after a smoke they have compared to an ORT reference run (same graphs, same preprocess): `text`, `doctags`, `markdown`.
- Compare `doctags` exactly (after the same ASCII lstrip) and `text` exactly. Markdown exact too.
- Do not check in a guessed DocTags string before the C++ path has produced one. Do not weaken the smoke `hello` check to "any non-empty string" to make a bad preprocess pass.

Reference procedure (not a repo script, not a CI step): Python `onnxruntime` 1.x + Pillow Lanczos + the token ids in §5, **or** `@huggingface/transformers` pointed at `onnx-community/granite-docling-258M-ONNX` with `dtype=fp32`. The oracle is fp32 ONNX greedy, not the bf16 PyTorch checkpoint (`config.json` `"dtype": "bfloat16"` is the training dtype; the graphs are fp32). If C++ text disagrees with that oracle, fix resize or the prompt before locking the JSON. Greedy fp32 on CPU is deterministic for a fixed ORT version; once it matches, the strict file is a regression lock.

Phase 5 may turn the strict file into a required CI artifact. Phase 2 only has to make the skip/assert behavior real.

---

## 12  Acceptance checklist

- [ ] `DocVlmBackend::Family()` is `"doc_vlm"`. `Load` / `Recognize` / `Release` implement `OcrBackend`.
- [ ] `CreateOcrBackend` still has no `doc_vlm` branch. `OcrFactory.cpp` diff is empty.
- [ ] Sessions open the three `.onnx` paths. External data is not copied into a buffer for `CreateSessionFromArray`.
- [ ] Input and output names match §2, including `past_key_values.{0..29}.key/value` and `present.{0..29}.key/value`.
- [ ] Empty past is `[1, 3, 0, 64]`. The next iteration passes `present` through unchanged.
- [ ] Attention mask is int64 ones of length `past + current`. No `position_ids` tensor is created.
- [ ] Image-token embeds are overwritten with `image_features` in crop-then-global order. Counts must match or `Recognize` throws.
- [ ] `en_hello` grid is 1×4+global (5). Square input is 4×4+global (17). The first resize sets the long side to 2048.
- [ ] Prompt for `en_hello` is the 347-id sequence in §5.3.
- [ ] Encode of `Convert this page to docling.` is the seven ids in §4.2. `<|start_of_role|>` is one id.
- [ ] Decode keeps specials. `<loc_N>` survives as text. Byte concatenation happens before UTF-8 decode.
- [ ] Stop on 100257 (not included) and 100328 (included). Loop also stops at the clamped `max_new_tokens`.
- [ ] `OcrResult` has `doctags_utf8` and `markdown_utf8`, default empty. `max_new_tokens == 0` means 8192.
- [ ] Synthetic DocTags test yields `Hello` and the half-frame quad in §7.3.
- [ ] Smoke on a present pack: `en_hello` text contains `hello`, doctags contain the doctag pair, at least one span, confidence 1.
- [ ] Smoke `GTEST_SKIP`s when the pack is absent. Strict golden `GTEST_SKIP`s unless `DOCVLM_STRICT_GOLDEN=1` and the JSON exists.
- [ ] `doc_vlm_host_test` is a ctest with `TIMEOUT 300`, working directory repo root. `ppocr_host_test` and `doctr_host_test` source lists are unchanged.
- [ ] Android `CMakeLists.txt` compiles the new `.cpp` files. Podspec header search path includes `ocr/doc_vlm`.
- [ ] Logs use `[SherpaOnnx:ocr]` and include tile grid, prompt length, and stop reason.
- [ ] No OpenCV, no Jinja, no Rust tokenizers, no factory/TS/JNI/detect/workflow edits.

---

## 13  What this phase must not do

- Register `doc_vlm` (or aliases) in `OcrFactory.cpp`, JNI, or TypeScript. Phase 3.
- Export `doctags` / `markdown` through JNI or the TS result. The C++ fields exist so Phase 3 has a stable shape; the public surface waits.
- Detect (`kDocVlm`, manifest `family` parsing, download hints, `ocr.doc_vlm` catalog). Phase 4.
- Add `docvlm-granite-258m` to `test-ocr-host.yml` or any job that downloads every OCR pack per PR. Phase 5.
- A second weight variant (fp16, q4, q4f16) or PaddleOCR-VL.
- PDF pages, multi-image prompts, `controls` in the chat template, OTSL→CSV, picture classification tokens, beam search, logprob spans.
- Rebuilding ONNX Runtime to add contrib ops. If the host zip lacks `GroupQueryAttention`, stop; that zip is the official 1.28.x release and does include it.
- Skipping the 2048 upscale, letterboxing instead of the HF tile grid, or treating `<image>` as one embedding.
- Parsing `vocab.json` / `merges.txt` in addition to `tokenizer.json`.
- Sharing a new JSON library or moving the `OCR_LOGI` macro out of each backend.
- Example app / VoiceLab.
- Checking in `build/ocr-models/` or `dist/ocr-models/`.
]]