# OCR instructions — SDK implementation plan

> Families: `ppocr`, `doctr`, `doc_vlm` (Granite Docling), `nemotron_parse`, `paddleocr_vl`
> Prior plans: [`paddleocr-vl-sdk-plan.md`](paddleocr-vl-sdk-plan.md), [`nemotron-parse-sdk-plan.md`](nemotron-parse-sdk-plan.md), [`phase3-doc-vlm-public-api-plan.md`](phase3-doc-vlm-public-api-plan.md)
> Findings: [`paddleocr-vl-sdk-findings.md`](paddleocr-vl-sdk-findings.md), [`nemotron-parse-sdk-findings.md`](nemotron-parse-sdk-findings.md), [`doc-vlm-instructions-findings.md`](doc-vlm-instructions-findings.md)
> Public docs to update: [`../ocr-offline.md`](../ocr-offline.md)

The SDK is **unpublished**. This plan replaces the current per-family task knob (`paddleocrVl.task`) and the VLM result extras (`markdown`, `doctags`) with one strict, family-discriminated **instruction** API and one shared result shape. Backward compatibility is **not** a goal; a cleaner surface wins.

Android first. Log tag `[SherpaOnnx:ocr]`, prefix `instruction` (shared layer) or the family id (backend layer). Gate TS logs with `__DEV__`, native with existing `OCR_LOGI`.

---

## 0  Design rules (map to the request)

| # | Requirement | How this plan enforces it |
|---|-------------|---------------------------|
| 1 | Little logic / code duplication | One TS encoder + one C++ parser for all recognize-time knobs (§4). Kotlin/ObjC forward **one string**. Shared C++ modules for geometry, crop, OTSL, table rendering, element kinds, capabilities (§5.1). One TS result reader (§3.4). |
| 2 | Deterministic, no half truths | Result **echoes the executed instruction**. No fabricated geometry (a requested region is never reported as a detected element). Unsupported combinations are **errors**, never silently ignored (incl. `granularity`, which today silently drops spans — §6.6). `complete` / `stopReason` stay mandatory on VLM results. |
| 3 | Only robust instructions | Every model-side instruction passes a **Phase 0 evidence gate** (§7, Phase 0) before it enters the public union. Free-form query prompts are rejected (§1.4). |
| 4 | Strict, self-explaining TS API | The engine type carries the family (§2.0). `recognize` options, result and `capabilities` are typed per family, so a task of another family is a **compile error**. `createOCR` / `recognize` keep their shape. Typed `OcrPixelRect`; Nemotron output as a typed profile that makes invalid token combinations **unrepresentable**. |
| 5 | Shared logic across families | Backends stay one class per family (no shared `VlmBackend` base, as in prior plans). Shared code is **helpers + data tables**, each with exactly one owner (§5.1). |

---

## 1  Instruction inventory

### 1.1  Evidence verified locally (2026-10-29)

From the shipped pack tokenizers (`example/.model-cache/*/tokenizer.json`):

| Family | Verified | Consequence |
|--------|----------|-------------|
| `nemotron_parse` | Added specials: `<output_plain>` 50000, `<output_markdown>` 50001, `<output_no_text>` 50002, `<output_ocr>` 50003, `<predict_bbox>` 50004, `<no_bbox>` 50005, `<no_classes>` 50007, `<predict_classes>` 50008, `<predict_text_in_pic>` 50009, `<predict_no_text_in_pic>` 50010; 15 `<class_*>` tokens (Text, Title, Section-header, List-item, TOC, Bibliography, Footnote, Page-header, Page-footer, Picture, Formula, Code, Table, Caption, Chart). | Every documented output profile can be encoded exactly. `<output_ocr>` is undocumented → rejected (§1.4). Class vocabulary is closed (15) → total mapping to `OcrElementKind`. |
| `paddleocr_vl` | 1004 `<\|LOC_*\|>` tokens; OTSL cell tokens `<fcel> <ecel> <lcel> <ucel> <xcel> <nl>`. | `table` output is OTSL-like → shares the OTSL parser with Granite. Spotting quads stay token-exact. |
| `doc_vlm` | 97 added specials incl. DocTags tags, `<otsl>`, `<fcel>…<nl>`, `<ched> <rhed>`, `<code>`, `<chart>`, `<formula>`. **No `<loc_*>` in vocab or added tokens.** | Locations are produced/consumed as **BPE text**. Region prompts need a tokenizer-parity test against HF ids (§6.2). Closed tag vocabulary → total mapping to `OcrElementKind`. |

### 1.2  Accepted instructions (subject to Phase 0 gate)

| Family | Public task | Model prompt / control | Expected input | Output grammar | Parser |
|--------|-------------|------------------------|----------------|----------------|--------|
| `doc_vlm` | `page` (default) | `Convert this page to docling.` | full page | DocTags | `ParseDocTags` |
| `doc_vlm` | `element` / `table` | `Convert table to OTSL.` | element crop | DocTags `<otsl>` | `ParseDocTags` → shared OTSL |
| `doc_vlm` | `element` / `chart` | `Convert chart to table.` | element crop | **gated** — HF emits `<unknown>` before OTSL cells (§1.4) | — |
| `doc_vlm` | `element` / `formula` | `Convert formula to LaTeX.` | element crop | DocTags `<formula>` | `ParseDocTags` |
| `doc_vlm` | `element` / `code` | `Convert code to text.` | element crop | DocTags `<code>` (+ language tag, gate confirms) | `ParseDocTags` |
| `doc_vlm` | `regionText` | `OCR the text in a specific location: <loc_x1><loc_y1><loc_x2><loc_y2>` | full page + region | **plain prose** (HF `page_01`; no DocTags/locs) | `ParseDocTags` + `AdoptBareProse` |
| `doc_vlm` | `identifyElement` | `Identify element at: <loc_x1><loc_y1><loc_x2><loc_y2>` | full page + region | **plain prose** (HF 3/3; no DocTags) | `ParseDocTags` + `AdoptBareProse` |
| `nemotron_parse` | `page` (default) | 4 control groups (§2.3) | full page | Nemotron markup | `ParseNemotronMarkup` |
| `paddleocr_vl` | `ocr` (default) | `OCR:` | page or crop | markdown/HTML text | `ParsePaddleocrVlMarkup` |
| `paddleocr_vl` | `table` | `Table Recognition:` | table crop | OTSL tokens | shared OTSL |
| `paddleocr_vl` | `formula` | `Formula Recognition:` | formula crop | LaTeX | passthrough |
| `paddleocr_vl` | `chart` | `Chart Recognition:` | chart crop | text table (gate records exact grammar) | shared table parser or reject |
| `paddleocr_vl` | `seal` | `Seal Recognition:` | seal crop | plain text | passthrough |
| `paddleocr_vl` | `spotting` | `Spotting:` | page or crop | text + 8×`<\|LOC_n\|>` per line | existing spotting parser |

`ppocr` / `doctr` have no model-side instructions. They gain: the shared `crop` (§2.2), shared DB detector options (§2.5), and capability-checked granularity.

### 1.3  Per-task preprocessing (PaddleOCR-VL)

| Task | `max_pixels` default | Upscale |
|------|----------------------|---------|
| `spotting` | 1 605 632 | 2× LANCZOS when **both** sides < 1500 px (after crop) |
| all others | 1 003 520 (`1280·28·28`) | none |

The init option `maxPixels` becomes a **cap**: `effective = min(cap, taskDefault)`. This is deterministic, mobile-safe, and logged (`effective_max_pixels`).

### 1.4  Rejected (documented, not implemented)

| Candidate | Reason |
|-----------|--------|
| Granite page queries (`Find all 'text' elements…`, `Detect footer elements…`) | Free-form templates with no fixed output grammar. Deterministic equivalent: run `page` and filter `elements` by `kind` in the caller. |
| Granite short-form instruction tokens | No documented contract. The long prompts above are the documented form. |
| Nemotron `<output_ocr>` | Undocumented control token. Revisit only with an NVIDIA spec. |
| Nemotron "no text + no boxes", "classes without boxes" | No output / undefined. Unrepresentable in the TS type (§2.3). |
| Nemotron layout `boxes` / `boxesAndClasses` (all 10 profiles) and the 3 non-default `none`-layout profiles | Phase 0 CPU HF vs `nemotron-3.5-parse-int8`: only `markdown_none_pic` is token-identical on ≥ 3 fixtures. Stay out of the public union until a pack matches. |
| Granite `element` / `chart` (`Convert chart to table.`) | CPU HF on 3/3 fixtures emits `<chart>…<unknown><fcel>…`. `<unknown>` is not a tokenizer special (closed vocab miss). Stay out of the public union until a pack emits a known DocTags stream. |
| Granite `page` identity | CPU HF vs ORT 0/3 token-identical (prefix=5). Title **text** matches; loc grid differs (HF `loc_11,14,263,30` vs ORT `loc_26,21,278,37` on page_01). The Phase 0 ORT probe uses the HF image processor, so this is pack numerics, not C++ `DocVlmImageOps`. Grammar+semantics pass; `page` stays the public default until a pack matches. |
| Granite `formula` / `code` / `regionText` / `identifyElement` identity | CPU HF vs ORT is 1/3, 2/3, 1/3, 1/3. Grammar+semantics pass on the HF side. Stay public with the recorded miss; only `element`/`table` is 3/3 identical. |
| Arbitrary user prompt strings (any family) | Not robust or parseable; it breaks rule 2. |
| PP-Structure / PP-DocLayout pipelines, Docling HTML/JSON export | These are separate products (multi-model pipelines or document models), not instructions. |
| DocTR word-level spans | No evidence that the current pack/postprocess produces them. Out of scope. |

---

## 2  Public TS API

All new types live in `src/ocr/types.ts`. Remove: `OcrRecognizeOptions.paddleocrVl`, `OcrPaddleocrVlOptions.task` (init-time task), and `assertOcrPaddleocrVlTask`. There is **one** source of truth: the recognize-time instruction, typed by the engine's family.

### 2.0  Family-typed engine (no API shape break)

`createOCR(options)` → `engine.recognize(image, textOut, options)` stays as today. What changes is that the family flows from init into the engine type.

```ts
export interface OcrEngineOf<F extends OcrFamily> {
  readonly instanceId: string;
  readonly family: F;
  readonly capabilities: OcrCapabilitiesOf<F>;
  recognize(
    imageBuffer: OfflineImageBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OcrRecognizeOptionsOf<F>,
  ): Promise<OcrRecognizeResultOf<F>>;
  destroy(): Promise<void>;
}

/** A real union (not `OcrEngineOf<OcrFamily>`), so `engine.family === …` narrows. */
export type OcrEngine = { [F in OcrFamily]: OcrEngineOf<F> }[OcrFamily];
```

`createOCR` overloads map the init options to the engine type. The init options are already a union discriminated on `modelType`:

| Init | Return type |
|------|-------------|
| `modelType: 'ppocr' \| 'doctr' \| 'doc_vlm' \| 'nemotron_parse' \| 'paddleocr_vl'` (folder) | `OcrEngineOf<that family>` |
| `initMode: 'custom'` (`modelType` is required) | `OcrEngineOf<that family>` |
| `modelType: 'auto'` / omitted, or a `modelType` variable typed as `OcrModelType` | `OcrEngine` (union) |

The implementation is one function. The overloads are type-only and share one helper type, `OcrEngineForInit<O>`, so they do not duplicate logic.

Usage rules that follow from the types:

```ts
const paddle = await createOCR({ modelType: 'paddleocr_vl', modelDir });
await paddle.recognize(img, out, { instruction: { task: 'spotting' } }); // ok
await paddle.recognize(img, out, { instruction: { task: 'page' } });     // compile error
const r = await paddle.recognize(img, out);   // r: OcrRecognizeResultOf<'paddleocr_vl'>, no narrowing

const engine = await createOCR({ modelType: 'auto', modelDir });
await engine.recognize(img, out);                                   // ok: family default
await engine.recognize(img, out, { instruction: { task: 'ocr' } }); // compile error until narrowed
if (engine.family === 'paddleocr_vl') {
  await engine.recognize(img, out, { instruction: { task: 'spotting' } }); // ok
}
```

- **Un-narrowed `auto` allows only the default.** Calling a method on a union of engines intersects the parameter types. The `task` literals of different families conflict, so `instruction` collapses to `never`. This needs no extra type machinery, and it holds even though `ppocr` / `doctr` options have no `instruction` field.
- **No `family` field on instructions.** The single source of truth is `engine.family`. The TS encoder writes it into the wire spec (§4).
- **`ppocr` / `doctr`:** `OcrRecognizeOptionsOf<'ppocr' | 'doctr'>` has **no** `instruction` key. An object literal with `instruction` fails the excess-property check. A wider-typed variable can still slip through, and native rejects it with `OCR_INSTRUCTION_UNSUPPORTED`.
- **Runtime still checks.** Casts and plain JS bypass the types.
  - TS checks before the bridge: `instruction.task` must be in `engine.capabilities.tasks`, and `instruction` is not allowed on ppocr / doctr. Otherwise it throws `OCR_INSTRUCTION_UNSUPPORTED`.
  - Native checks again: a spec family different from the loaded backend gives `OCR_INSTRUCTION_FAMILY_MISMATCH`, and an unknown task gives `OCR_INSTRUCTION_UNSUPPORTED`.
  - There is no fallback to the default.

### 2.1  Geometry (shared)

```ts
/** Axis-aligned rectangle in decoded-frame pixels (same space as span quads). */
export interface OcrPixelRect {
  x: number;      // left, >= 0
  y: number;      // top, >= 0
  width: number;  // > 0
  height: number; // > 0
}
```

One coordinate space is used everywhere in the public API. Family grids (Granite 0–500, Paddle 0–1000, Nemotron 0–1) are never exposed. Conversion happens only in native `OcrGeometry` (§5.1).

### 2.2  Recognize options

```ts
/** Options valid for every family. */
export interface OcrRecognizeOptionsBase {
  frames?: OcrFrameSelection;            // unchanged
  granularity?: OcrGranularity;          // now capability-checked (§6.6)
  /** Engine-level crop applied before any family preprocessing; spans/elements are mapped back to full-frame pixels. */
  crop?: OcrPixelRect;
  onProgress?: …; progressMinIntervalMs?: number; signal?: AbortSignal; // unchanged
}

/** Families that accept model-side instructions. */
export type OcrInstructionFamily = 'doc_vlm' | 'nemotron_parse' | 'paddleocr_vl';

export type OcrVlmRawMode = 'accepted' | 'full';

export type OcrRecognizeOptionsOf<F extends OcrFamily> = F extends OcrInstructionFamily
  ? OcrRecognizeOptionsBase & {
      /** Omitted → `OCR_DEFAULT_INSTRUCTIONS[family]`. */
      instruction?: OcrInstructionOf<F>;
      /**
       * Granite DocTags / prompt-only reject. Default `'accepted'` stops
       * decode so the SDK parser does not wait on a stream it will not use.
       * `'full'` keeps generating through EOS / `maxNewTokens` so a custom
       * parser can read the complete model answer on `result.raw`.
       * Paddle / Nemotron have no prefix abort; the flag is accepted and
       * ignored. Omit → `'accepted'`. Not valid on ppocr / doctr.
       */
      raw?: OcrVlmRawMode;
    }
  : OcrRecognizeOptionsBase; // ppocr / doctr: no `instruction` / `raw` key
```

`crop` applies to every selected frame and must lie inside each frame; otherwise the call fails with `OCR_INVALID_REGION` naming the frame index. It is the **only** way to feed an element crop (Granite `element`, Paddle `table|formula|chart|seal`), so no task carries its own crop field.

`raw: 'accepted'` (default) is the performant SDK path. `raw: 'full'` is the power-user escape hatch. `stopReason: 'invalid_sequence'` still means the stream left the DocTags grammar; only the decode length changes.

### 2.3  Instructions (discriminated on `task`, no `family` field)

Every instruction family uses `task` as the discriminant, including Nemotron with its single `page` task. This keeps one shape for readers, encoders and `capabilities.tasks`.

```ts
export type OcrInstructionOf<F extends OcrInstructionFamily> = {
  doc_vlm: OcrDocVlmInstruction;
  nemotron_parse: OcrNemotronParseInstruction;
  paddleocr_vl: OcrPaddleocrVlInstruction;
}[F];

/** Task ids per family, derived from the instruction types (never listed twice). */
export type OcrTaskOf<F extends OcrInstructionFamily> = OcrInstructionOf<F>['task'];

// ---- doc_vlm (Granite Docling) ----
export type OcrDocVlmElement = 'table' | 'formula' | 'code';
export type OcrDocVlmInstruction =
  | { task: 'page' }
  | { task: 'element'; element: OcrDocVlmElement }
  | { task: 'regionText'; region: OcrPixelRect }
  | { task: 'identifyElement'; region: OcrPixelRect };

// ---- nemotron_parse (Phase 0 lock: only markdown_none_pic) ----
export type OcrNemotronParseLayout = 'none';
export type OcrNemotronParseOutput = {
  text: 'markdown';
  layout: 'none';
  textInPictures: true;
};
export type OcrNemotronParseInstruction = {
  task: 'page';
  output: OcrNemotronParseOutput;
};

// ---- paddleocr_vl ----
export type OcrPaddleocrVlTask = 'ocr' | 'table' | 'formula' | 'chart' | 'seal' | 'spotting';
export type OcrPaddleocrVlInstruction = { task: OcrPaddleocrVlTask };

/** Defaults applied when `instruction` is omitted; exported so callers and docs read one table. */
export const OCR_DEFAULT_INSTRUCTIONS: { [F in OcrInstructionFamily]: OcrInstructionOf<F> };
```

Encoding notes:
- Public output is only `markdown` + `layout: 'none'` + `textInPictures: true`. Other control-token combinations stay in C++ `BuildNemotronPrompt` and host prompt-id tests; they are not in the TS union.
- `layout: 'classes'` (classes without boxes) remains unrepresentable.
- `text: 'none'` + `layout: 'none'` remains unrepresentable.

Nemotron default (Phase 0 lock): `{ task: 'page', output: { text: 'markdown', layout: 'none', textInPictures: true } }` (`markdown_none_pic`). The NVIDIA card default `boxesAndClasses` + no text-in-pic is **not** token-identical to `nemotron-3.5-parse-int8` (`prefix_len=0` on all 3 pages). Layout-token profiles stay out of the public union until a pack matches HF greedy. See [`nemotron-parse-sdk-findings.md`](nemotron-parse-sdk-findings.md).

`identifyElement` and `regionText` require the whole frame as input, so combining them with `crop` is rejected (`OCR_INSTRUCTION_UNSUPPORTED`). This avoids two region semantics in one call.

Storing an instruction outside a call (UI state, presets, tests) uses the family-parameterised type, e.g. `const preset: OcrInstructionOf<'paddleocr_vl'> = { task: 'table' }`.

### 2.4  Capabilities (self-explaining, typed per family)

```ts
export interface OcrCapabilitiesOf<F extends OcrFamily> {
  family: F;
  /** Tasks the loaded model accepts in `instruction.task`; `[]` for ppocr / doctr. */
  tasks: F extends OcrInstructionFamily ? readonly OcrTaskOf<F>[] : readonly [];
  granularities: readonly OcrGranularity[];
  supportsCrop: true;
  /** True when results may contain `elements` (layout). */
  producesElements: boolean;
}
```

The native engine returns capabilities on init from one C++ table (`OcrCapabilities.cpp`). TS does not duplicate the values; it types them per family. `createOCR` validates on init that every reported task is a known `OcrTaskOf<F>` literal; an unknown task means the TS and native tables disagree and fails init (`OCR_CAPABILITIES_MISMATCH`), instead of silently widening the type.

After narrowing, the example app can render a typed task picker straight from `engine.capabilities.tasks`.

### 2.5  Init options (cleanup)

```ts
/** Shared by ppocr and doctr (both DB detectors). */
export interface OcrDbDetectorOptions {
  detBoxThresh?: number;
  detBoxScoreThresh?: number;
  detUnclipRatio?: number;
}
export interface OcrPpocrOptions extends OcrDbDetectorOptions {
  maxSideLen?: number;
  useOrientationCls?: boolean;
}
export type OcrDoctrOptions = OcrDbDetectorOptions;
export interface OcrPaddleocrVlOptions { maxPixels?: number } // cap, see §1.3; no `task`
```

Native fields `det_box_thresh` / `det_box_score_thresh` already exist in `OcrLoadOptions`. Only the TS exposure and `appendOcrScalarBridgeFields` mapping are new, and both are shared by the two families.

---

## 3  Result shape

### 3.1  Shared VLM extras

Replace `markdown` / `doctags` with typed content and layout elements:

```ts
export type OcrContent =
  | { format: 'markdown'; value: string }
  | { format: 'plain'; value: string }
  | { format: 'latex'; value: string }
  | { format: 'code'; value: string; language: string | null };

export type OcrElementKind =
  | 'text' | 'title' | 'sectionHeader' | 'listItem' | 'caption' | 'footnote'
  | 'pageHeader' | 'pageFooter' | 'formula' | 'code' | 'table' | 'picture'
  | 'chart' | 'tableOfContents' | 'bibliography' | 'checkbox' | 'form' | 'keyValueRegion';

export interface OcrElement {
  kind: OcrElementKind;
  frameIndex: number;
  /** Decoded-frame pixels, mapped back through `crop`. Present only when the model emitted a location. */
  quad: OcrQuad | null;
  /** UTF-16 range into `textOut` when the element has text; null for layout-only output. */
  utf16Start: number | null;
  utf16End: number | null;
  /** Only for kind 'sectionHeader' (Granite levels 1–6); null otherwise. */
  headingLevel: number | null;
  /** Only for kind 'checkbox'. */
  checked: boolean | null;
}

/** Stop reasons per instruction family; one table, used by types and the TS reader. */
export type OcrStopReasonOf<F extends OcrInstructionFamily> = {
  doc_vlm: 'doctag_end' | 'eos' | 'max_new_tokens' | 'invalid_sequence';
  nemotron_parse: 'eos' | 'max_new_tokens';
  paddleocr_vl: 'eos' | 'max_new_tokens';
}[F];

interface OcrVlmResult<F extends OcrInstructionFamily> {
  family: F;
  instruction: OcrInstructionOf<F>; // the resolved instruction actually executed (defaults filled in)
  spanCount: number;
  raw: string;               // decoded model stream. `'accepted'` (default) may be only the rejected prefix; `'full'` is the complete answer even when our parsers fail
  content: OcrContent | null;// null exactly when the instruction requests no text (Nemotron text:'none')
  elements: OcrElement[];    // [] when the family/instruction produces no layout
  complete: boolean;
  stopReason: OcrStopReasonOf<F>;
}

interface OcrDetectorResult<F extends 'ppocr' | 'doctr'> {
  family: F;
  spanCount: number;
}

export type OcrRecognizeResultOf<F extends OcrFamily> = F extends OcrInstructionFamily
  ? OcrVlmResult<F>
  : F extends 'ppocr' | 'doctr'
    ? OcrDetectorResult<F>
    : never;

/** Union over all families; what an un-narrowed `OcrEngine` returns. */
export type OcrRecognizeResult = OcrRecognizeResultOf<OcrFamily>;
```

`OcrEngineOf<F>.recognize` returns `OcrRecognizeResultOf<F>`, so a family-typed engine needs no `result.family` check. On an un-narrowed `OcrEngine` the result is the union and narrows on `result.family` as before.

Rationale:
- `doctags` duplicated `raw` for Granite, so it is dropped.
- `markdown` was wrong for formula, code and seal output; `content.format` now states what the string is.
- `elements` keeps `TextSpatialSpan` (shared with PDF/EPUB) untouched and still supports layout-only output.

### 3.2  Content format per instruction (single native table)

| Instruction | `content.format` |
|-------------|------------------|
| Granite `page`, Nemotron public page (`markdown_none_pic`), Paddle `ocr` | `markdown` |
| Granite `element:table`, Paddle `table`, Paddle `chart` | `markdown` (GFM table from shared renderer) |
| Granite `element:formula`, Paddle `formula` | `latex` |
| Granite `element:code` | `code` (`language` from `<_Lang_>`, else null) |
| Granite `regionText`, Granite `identifyElement`, Paddle `seal`, Paddle `spotting` | `plain` |

### 3.3  No fabricated truth

- `elements[].quad` comes only from model-emitted locations.
- `regionText` produces **no** span or element whose geometry is the requested region. The request is echoed in `instruction.region`.
- `identifyElement` yields `elements` exactly as the model emits them; zero elements is a valid, truthful result.
- An unknown tag or class cannot occur, because both vocabularies are closed (§1.1). If one ever appears (new checkpoint), the parser throws `OCR_PARSE_UNKNOWN_KIND` (host tests). `recognize` keeps `stopReason` and `raw`, leaves `content`/`elements` empty, and logs the code. It never skips the unknown token silently. Granite prefix / prompt-only reject is `invalid_sequence`: default `raw: 'accepted'` stops decode; `raw: 'full'` continues so `result.raw` is the complete stream.

### 3.4  One TS reader

Replace the per-family branches in `readRecognizeResult` (`src/ocr/index.ts`) with:
- `readVlmBase(raw, family, stopReasons)`;
- `readInstruction(raw, family)`, which decodes `instructionSpec` with the same decoder as the wire spec (§4) and asserts that its family equals `engine.family`;
- `readContent` / `readElements`.

The family only selects the allowed `stopReason` set from a `const` map.

---

## 4  Wire format (one encoder, one parser)

Today every recognize knob touches TS, Kotlin, JNI, ObjC and C++. New recognize-time knobs travel in **one string**, `recognizeSpec`:

```text
v1;family=doc_vlm;task=regionText;rx=120;ry=340;rw=600;rh=80
v1;family=doc_vlm;task=element;element=table;raw=full
v1;family=nemotron_parse;task=page;text=markdown;layout=none;pic=1
v1;family=paddleocr_vl;task=spotting;cx=0;cy=0;cw=800;ch=600
```

`raw=full` is omitted when the mode is the default `'accepted'`. `raw=accepted` is accepted on decode and dropped on serialize.

| Layer | Owner | Responsibility |
|-------|-------|----------------|
| TS | `src/ocr/ocrRecognizeSpec.ts` | `encodeOcrRecognizeSpec(engine.family, options)` and `decodeOcrRecognizeSpec(spec)` for result echo and tests. `family=` in the spec always comes from `engine.family`, because instructions carry no family. Validates finiteness and positivity of numbers and enum membership. |
| Kotlin / ObjC | `OcrNative.kt`, `SherpaOnnx+OCR.mm` | Forward the string unchanged. **No per-field code.** |
| C++ | `ocr/OcrRecognizeSpec.{h,cpp}` | `ParseOcrRecognizeSpec(string) → OcrRecognizeRequest {OcrInstruction, crop, raw_mode}`. Strict: unknown keys, duplicate keys, missing required keys and bad numbers are errors. Also `SerializeOcrRecognizeSpec` for the result echo (`instructionSpec` in the native result). |

Fixed key order, decimal integers only for pixels (rounded in TS with `Math.round`, documented), and the `v1` prefix together make the format deterministic and versionable. Remove the `has_paddleocr_vl` / `paddleocr_vl_task` fields from `OcrLoadOptions`, `RecognizeOptions` and `OcrRecognizeContext`; the context holds `OcrRecognizeRequest`.

---

## 5  Native architecture

### 5.1  Shared modules (single owner each)

| Module | Contents | Used by |
|--------|----------|---------|
| `ocr/OcrInstruction.h` | `enum class` per family task, `DocVlmInstruction`, `NemotronParseOutput`, `PaddleocrVlInstruction`, `OcrInstruction` as a `std::variant`, `OcrVlmRawMode`, and family defaults. | all VLM backends, engine |
| `ocr/OcrRecognizeSpec.{h,cpp}` | Wire parse and serialize (§4). | JNI, iOS bridge, engine |
| `ocr/OcrCapabilities.{h,cpp}` | Per-family tasks, granularities and `producesElements`; `ValidateRequest(family, request, granularity)`. | engine, init result |
| `ocr/OcrGeometry.{h,cpp}` | `PixelsToGrid(rect, frame, grid)`, `GridToPixels`, `RectToQuad`, `ClampRect`, `TranslateQuad(dx,dy)`. Grids: Granite 500, Paddle 1000, Nemotron 1.0. | doc_vlm prompt and DocTags, paddle spotting, nemotron markup, engine crop |
| `ocr/OcrCrop.{h,cpp}` | Crops an `OcrFrameView` to a rect (copy or view). Translates result spans and elements back. | `OcrEngine::RecognizeMulti` only; backends never see full-frame coordinates when a crop is set |
| `ocr/markup/OcrTable.{h,cpp}` | Table model (cells with row/col span) plus `RenderGfm` / `RenderPlain`. | DocTags (`EmitTable`), Nemotron (`GfmTable` / `PlainTable` replaced), Paddle table |
| `ocr/markup/OcrOtsl.{h,cpp}` | OTSL cell-token stream → `OcrTable`. Extracted from `DocVlmDocTags.cpp` (`IsOtslCell`, `ParseOtsl`). | doc_vlm, paddleocr_vl |
| `ocr/markup/OcrElementKind.{h,cpp}` | `OcrElementKind` enum plus total maps `FromDocTagsTag`, `FromNemotronClass`. | doc_vlm, nemotron_parse |
| `ocr/OcrTypes.h` | `OcrResult` gains `content {format, value, language}`, `elements`, and `instruction_spec`; loses `doctags_utf8` / `markdown_utf8`. | all |

Backends stay family-owned: prompt building, tokenizer, image ops and decode loops do **not** move.

### 5.2  Per-family task profiles (one table per family)

Each VLM backend owns one `constexpr` table, so adding a task is a one-row change:

```cpp
struct PaddleocrVlTaskProfile {
  PaddleocrVlTask task;
  const char* prompt_suffix;        // "OCR:", "Spotting:", …
  int default_max_pixels;           // 1003520 / 1605632
  bool upscale_small_2x;            // spotting only
  OcrContentFormat content_format;  // §3.2
  PaddleocrVlParser parser;         // Text | Otsl | Spotting | Passthrough
};
```

Granite gets `DocVlmTaskProfile {task, element, user_text_template, needs_region, content_format}`. Nemotron has no table, because its prompt is a pure function `BuildNemotronPrompt(NemotronParseOutput)` with an exhaustive switch.

### 5.3  Engine flow

`OcrEngine::RecognizeMulti`:
1. `ValidateRequest`.
2. For each frame: `OcrCrop` if set.
3. `backend.Recognize(ctx)`, where ctx carries the `OcrRecognizeRequest`.
4. Translate spans and elements back by the crop origin.
5. Merge.
6. Granularity filter, now only after a capability check.

The crop and translation logic exists only here.

---

## 6  Family details

### 6.1  PaddleOCR-VL

- Replace `BuildPrompt(task)` with the profile table, so the `prompt_suffix` comes from the table.
- Preprocess reads `default_max_pixels`, the init cap and `upscale_small_2x`. The 2× LANCZOS upscale is a new helper in `PaddleocrVlImageOps` (the family keeps its own image ops).
- Parsing:
  - `table` → `OcrOtsl` → `OcrTable` → GFM table plus plain text. `raw` keeps the tokens.
  - `formula` → LaTeX passthrough after EOS strip.
  - `seal` → plain text.
  - `chart` → enters only if Phase 0 records a stable grammar parsable into `OcrTable`; otherwise it moves to §1.4.
  - `spotting` → unchanged parser, but quads go through `OcrGeometry::GridToPixels(…,1000)`.
- `elements` is always `[]`, because the family emits no classes.

### 6.2  Granite Docling (`doc_vlm`)

- `DocVlmPrompt.cpp`: replace `kUserText` with the profile `user_text_template`. Region tasks render `<loc_%d>` ×4 from `OcrGeometry::PixelsToGrid(region, frame, 500)`, rounded half-up and clamped to [0, 500], with x1 < x2 and y1 < y2 enforced (otherwise `OCR_INVALID_REGION`). The tile layout is unchanged.
- **Tokenizer parity**: `<loc_*>` is not a special token, so `DocVlmTokenizer` must BPE-encode the region prompt exactly as HF does. Add a host test with HF-produced ids for 3 fixed region prompts.
- `ParseDocTags` emits `elements` via `FromDocTagsTag` (paragraph → text, references → bibliography, `section_header_level_n` → sectionHeader + level, otsl → table, checkbox_* → checkbox + checked, form, key_value_region). OTSL parsing moves to `OcrOtsl`, `EmitTable` to `OcrTable`.
- Content format comes from the profile (§3.2).
- Phase 0 confirms the `code` language tag shape. If it is absent or unstable, `language` is always `null`; the API still uses `string | null`.
- `DocTagsPrefix` + prompt-only ids abort greedy decode (`invalid_sequence`). Default `raw: 'accepted'` stops there. `raw: 'full'` keeps the rejected token in `raw` and continues to EOS / `maxNewTokens`; `ParseDocTags` still sees only the accepted prefix.
- A parse `OcrCodedError` must not drop `raw`: assign the decoded stream first, then parse.

### 6.3  Nemotron Parse

- `kPrompt` becomes `BuildNemotronPrompt(output)`, always emitting exactly one token per group in NVIDIA's documented order: `</s><s>` + bbox + classes + text + pic.
- `layout:'none'` → `<no_bbox><no_classes>`; `'boxes'` → `<predict_bbox><no_classes>`; `'boxesAndClasses'` → `<predict_bbox><predict_classes>`.
- `ParseNemotronMarkup` handles the following cases, each covered by a host test with fixtures:
  - with or without bbox tokens;
  - with or without classes, with classes mapped through `FromNemotronClass` into `elements`;
  - plain text instead of markdown, where `content.format = 'plain'` and the LaTeX tabular → `OcrTable` path still applies;
  - no text, where `content = null`, `elements` have `utf16 = null` and spans are empty.
- The repetition penalty stays at 1.1 for all profiles unless Phase 0 shows a profile needs a different value (it would then become a profile field, not a branch).

### 6.4  PP-OCR / DocTR

- Expose `detBoxThresh` and `detBoxScoreThresh` for ppocr through `OcrDbDetectorOptions`.
- `appendOcrScalarBridgeFields` writes the three DB fields once for both families.
- Crop and granularity rules come from the shared layer; nothing else changes.

### 6.5  Example app

- `OCRScreen.tsx` narrows on `engine.family` once, then renders the instruction controls from the typed `engine.capabilities.tasks`. Family switches only render each typed instruction arm.
- Granite recognize options include the `raw` chip (`accepted` / `full`).
- Add a crop/region editor with numeric fields first; drag-rect comes later and is optional.
- The result view shows `content.format`, `elements` grouped by `kind`, `instruction` echo, `stopReason`, and a Raw tab (including `invalid_sequence`).
- `OcrCustomInitForm.tsx`: remove the init-time Paddle task; add the ppocr DB thresholds.

### 6.6  Granularity (fix silent half truth)

`FilterSpansByGranularity` currently drops all spans when a family never emits the requested level, so `word` on DocTR silently yields 0 spans. Instead, `ValidateRequest` rejects granularities missing from `OcrCapabilities.granularities` with `OCR_UNSUPPORTED_GRANULARITY`. Capability values come from a Phase 1 audit of what each backend actually emits.

### 6.7  Errors

There is one native error enum, mirrored once in `OcrErrorCodes.kt` and the iOS bridge (existing pattern). New codes:
- `OCR_INSTRUCTION_FAMILY_MISMATCH`
- `OCR_INSTRUCTION_UNSUPPORTED`
- `OCR_INVALID_REGION`
- `OCR_UNSUPPORTED_GRANULARITY`
- `OCR_INVALID_RECOGNIZE_SPEC`
- `OCR_PARSE_UNKNOWN_KIND`
- `OCR_CAPABILITIES_MISMATCH` (TS-only, on init: native reported a task that TS does not know, §2.4)

There are no fallbacks: an error is never downgraded to the default instruction.

---

## 7  Phases

Each phase lands as conventional commits and ends Android-verified (logcat `[SherpaOnnx:ocr]`) before iOS.

### Phase 0 — Evidence gate (scripts only, no SDK code)

**Run name:** `instruction-parity` (HF greedy ≡ ORT pack). Docs and the
operator README use that name; this section stays Phase 0 in the plan.
How to launch it and what the **test suite** calls the related cases:
[`scripts/ocr-models/instructions/README.md`](../../scripts/ocr-models/instructions/README.md).

- Add `scripts/ocr-models/doc-vlm/probe_instructions.py`. Extend `scripts/ocr-models/{paddleocr-vl,nemotron-parse}/infer_ort.py` with `--task` / `--output-profile`.
- For each accepted instruction in §1.2, on fixed fixtures (page, table crop, formula crop, code crop, chart crop, seal crop, small-text page for spotting), produce:
  - an HF transformers reference output (greedy) and the ORT pack output;
  - prompt token ids from HF (Granite region prompts, all Paddle prompts, all 14 Nemotron profiles).
- Store the goldens under `test/fixtures/ocr/instructions/<family>/<task>/` as `prompt_ids.json`, `raw.txt` and `meta.json` with the pack id and preprocess params.
- **Pass criteria per instruction**:
  1. ORT output is token-identical to HF on ≥ 3 fixtures.
  2. The output grammar parses with zero unknown constructs.
  3. The output is semantically right for the task (manual review recorded in findings).

  Failing instructions move to §1.4, with the reason added to this doc.
- Lock the Nemotron default profile and the Paddle chart grammar here.
- Update `paddleocr-vl-sdk-findings.md` and `nemotron-parse-sdk-findings.md`; add `doc-vlm-instructions-findings.md`.

### Phase 1 — Shared foundations (no output change)

- Add `OcrInstruction.h`, `OcrRecognizeSpec`, `OcrCapabilities`, `OcrGeometry`, `OcrCrop`, `markup/OcrTable`, `markup/OcrOtsl` and `markup/OcrElementKind`.
- Migrate the existing Paddle `ocr|spotting` and the current Granite/Nemotron prompts onto the instruction struct and profiles.
- Remove the `paddleocr_vl_task` plumbing (TS, Kotlin, JNI, ObjC, context).
- TS:
  - `OcrEngineOf<F>`, the `OcrEngine` union and the type-only `createOCR` overloads (§2.0);
  - `OcrRecognizeOptionsOf<F>`, `OcrRecognizeResultOf<F>` and `OcrCapabilitiesOf<F>`;
  - `ocrRecognizeSpec.ts`, `OcrPixelRect`, and `OcrInstructionOf<F>`, with only the tasks already supported;
  - the unified `readRecognizeResult`.
  - Update existing callers (example app, tests) to narrow on `engine.family` where they pass instructions.
- Audit the span levels per backend and fill the `granularities` table.
- **Acceptance**:
  - Existing host tests stay green.
  - The current outputs (`raw`, plaintext, spans) on the Phase 0 default-instruction goldens are byte-identical before and after.
  - The spec round-trips in TS and C++ host tests.

### Phase 2 — Result shape

- `OcrResult` / TS gain `content`, `elements` and `instruction`, and lose `markdown` / `doctags`.
- Implement the `FromDocTagsTag` / `FromNemotronClass` maps.
- Nemotron and Granite emit `elements`; Paddle emits `[]`.
- **Acceptance**: the element kinds and quads on the goldens match the expected JSON; no `null` quad appears where the model emitted a location.

### Phase 3 — PaddleOCR-VL tasks

- Add the `table`, `formula`, `seal` and (gated) `chart` profiles, spotting max_pixels and upscale, and the init `maxPixels` cap semantics.
- Add the `PADDLEOCR_VL_SPOTTING_MAX_PIXELS = 1605632` constant.
- **Acceptance**: the ORT-on-device raw output matches the Phase 0 ORT golden on Android (FP16 pack), and the `effective_max_pixels` and `upscaled` logs are correct.

### Phase 4 — Granite instructions

- Add the `element` (4) and `regionText` / `identifyElement` prompts, the region → loc conversion, and the tokenizer parity test.
- **Acceptance**: prompt ids equal the HF ids, raw output equals the golden, and `crop` + region-task rejection is tested.

### Phase 5 — Nemotron output profiles

- Add `BuildNemotronPrompt` and the parser variants (§6.3).
- **Acceptance**: all 14 valid profiles have prompt-id tests, and parser fixture tests cover the bbox × classes × text × pic axes.

### Phase 6 — Detector options, crop for ppocr/doctr

- Expose the TS DB detector options.
- Crop end-to-end on ppocr and doctr: span quads are translated back, and the host test asserts offset quads.

### Phase 7 — Example, docs, iOS

- Example UI (§6.5).
- `docs/ocr-offline.md`: an instruction table per family, the content-format table, the crop semantics, capabilities and error codes.
- iOS simulator run of the same scenarios, then Android device and iOS device smoke.

---

## 8  Tests

**Suite binaries** (CI `Test – OCR host (C++)`, no VLM weights):
`ocr_instruction_host_test`, `ppocr_host_test` (`ppocrv6-tiny`),
`doctr_host_test` (`doctr-mobile`), `doc_vlm_host_test`,
`nemotron_parse_host_test`, `paddleocr_vl_host_test`. Jest:
`recognizeSpec.test.ts`, `ocrTypes.test-d.ts`, `offline-api.test.ts`.

Goldens from Phase 0 / instruction-parity are consumed as **parser + prompt-id**
cases (`*.InstructionGoldenRawsParse*`, `*.TaskIdsMatchGoldens`,
`NemotronParsePrompt.FourteenProfilesMatchGoldens`). Pack smokes
(`DocVlmSmoke.EnHello`, `NemotronParseSmoke.EnHello`,
`PaddleocrVlBackend.EnHelloSmoke`) skip unless the matching `*_MODEL_DIR` is
set. The large-pack generate check itself is **not** a suite target; it is the
manual `instruction-parity` run (`probe_instructions.py`).

| Layer | File | Covers |
|-------|------|--------|
| C++ host | `test/cpp/ocr/ocr_recognize_spec_host_test.cpp` (new) | Parse, serialize and round-trip, plus strict rejection of unknown, duplicate, missing or NaN fields. |
| C++ host | `test/cpp/ocr/ocr_geometry_host_test.cpp` (new) | Grid conversions for 500, 1000 and 1.0; rounding; clamp; translate. |
| C++ host | `test/cpp/ocr/ocr_markup_shared_host_test.cpp` (new) | OTSL → table with spans, GFM and plain rendering, total kind maps. |
| C++ host | existing `doc_vlm_host_test.cpp`, `nemotron_parse_host_test.cpp`, `paddleocr_vl_host_test.cpp` | Prompt-id goldens per task/profile, parser fixtures per task, `content.format`, `elements`. |
| C++ host | `ocr_recognize_context_host_test.cpp` | Crop translate-back, capability rejection, family mismatch. |
| TS | `src/ocr/__tests__/recognizeSpec.test.ts` (new) | Encoder and decoder; runtime rejection of `crop` + `regionText` / `identifyElement` and of tasks not in `capabilities.tasks`. |
| TS types | `src/ocr/__tests__/ocrTypes.test-d.ts` (new, checked by `tsc`) | `// @ts-expect-error` cases: Nemotron classes without boxes; `text:'none'` + `layout:'none'`; a Paddle task on `OcrEngineOf<'doc_vlm'>`; any `instruction` on un-narrowed `OcrEngine`; an `instruction` literal on `OcrEngineOf<'ppocr'>`. Positive cases: narrowing `auto` via `engine.family`; result type of a family-typed engine without a `result.family` check; `capabilities.tasks` element type per family. |
| TS | `src/ocr/__tests__/offline-api.test.ts` | Unified reader, result echo, error codes. |
| Device | Android logcat | Instruction resolution, prompt length, effective max pixels, upscale, parse counts (`elements=`, `spans=`, `unknown=0`), stop reason. |

---

## 9  Logging contract

| Point | Line (tag `[SherpaOnnx:ocr]`) |
|-------|-------------------------------|
| Validation reject | `instruction reject code=… reason=…` |
| Parse | `<family> parse content_format=… elements=… spans=… unknown=0 stop=…` |

Phase 7 verified; verbose spec / prompt / preprocess / crop-translate lines removed.

---

## 10  Out of scope

- Custom/free-form prompts.
- Multi-model pipelines (layout → per-element VLM). The `crop` + `element` primitives make them composable in app code later without SDK changes.
- Per-recognize `maxNewTokens` override; the init-time cap stays.
- VoiceLab migration (separate change after Phase 7).
