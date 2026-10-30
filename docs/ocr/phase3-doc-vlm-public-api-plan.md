# Phase 3 — Factory + public API (`doc_vlm`)

> Branch: `feat/add-ocr-doc-vlm`
> Prereq: Phase 1 pack published; Phase 2 `DocVlmBackend` under `android/src/main/cpp/ocr/doc_vlm/`. `OcrResult` already has `doctags_utf8` and `markdown_utf8`. `OcrLoadOptions::max_new_tokens` already exists (`0` → 8192). Host tests construct `DocVlmBackend` directly. `CreateOcrBackend("doc_vlm")` still throws.
> High-level contract: [`.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md`](../../.cursor/plans/ocr_doc_vlm_family_547b4fa4.plan.md)
> Phase 2 contract this phase consumes: [phase2-doc-vlm-backend-plan.md](phase2-doc-vlm-backend-plan.md) §8

The SDK is unpublished. This phase may change TypeScript types. Callers of `ppocr` and `doctr` keep the same buffer behavior. The migration is the return type of `recognize` and a stricter init-options union. There is no deprecation shim.

---

## 0  Decisions

| Decision | Choice |
| --- | --- |
| Family id | `"doc_vlm"`. `Family()` already returns that. Factory accepts it plus the aliases below. |
| Aliases | Exact strings `docvlm`, `doc-vlm`, `granite-docling`, `docling`. Normalized to `doc_vlm` before the backend is constructed. Not members of `OcrModelType`. |
| `OcrModelType` | `'auto' \| 'ppocr' \| 'doctr' \| 'doc_vlm'`. `auto` stays last in `OCR_MODEL_TYPES`. |
| Init options | Discriminated by `modelType`, same idea as `TTSInitializeOptions`. Property name is `docVlm` (the high-level plan’s name). `modelType` strings stay snake_case. |
| `docVlm` fields | `maxNewTokens?: number` only. Greedy decode stays. No temperature, top-p, penalty, beam, or seed. |
| `maxNewTokens` | Init-time, stored on `OcrLoadOptions`. Not a recognize option. Changing it means a new `createOCR()`. Omit or `0` → backend default 8192. The 8192 / `max_position_embeddings` clamp stays inside `DocVlmBackend` (`ResolveMaxNewTokens`). TS does not reimplement that clamp. |
| `recognize` return | `Promise<OcrRecognizeResult>`. Text and spans still land on the empty `OfflineTextBuffer`. DocTags and markdown are **not** written into the text buffer. |
| Extras on the result | `doctags` and `markdown` are required strings. ppocr and doctr resolve them to `""`. A missing native field is `OCR_INTERNAL_ERROR`, not a silent empty string. |
| Overlays | Spans on the text buffer. No third channel. |
| `auto` → doc_vlm | Not this phase. `DetectOcrModel` does not know the pack yet (Phase 4). Explicit `modelType: 'doc_vlm'` (or an alias) is what loads `DocVlmBackend`. |
| Detect guard | `isOcrDocVlmDetectSuccess` and `OcrDocVlmSuccessPaths` land now, so Phase 4 emits a key set that already type-checks. Native detect stays unchanged. |
| ORT contrib op | `decoder_model_merged.onnx` needs `com.microsoft.GroupQueryAttention`. Do not rebuild ONNX Runtime. A mobile build without that op fails `Session` create; the existing load `catch` surfaces it. |
| CMake / podspec app targets | Already compile `ocr/doc_vlm/*.cpp` and add the header search path. Do not re-list them. Host-test binaries that link `OcrFactory.cpp` must gain the doc_vlm sources or they fail to link. |
| Docs outside this file | Phase 5 (`docs/ocr-offline.md` and the rest). |
| Example app | Out of scope. |

---

## 1  What is already true

| Surface | State |
| --- | --- |
| `OcrFactory.cpp` | `"ppocr"` / `"auto"` → `PpocrBackend`. `"doctr"` → `DoctrBackend`. Anything else throws. Error text: `Supported in this build: ppocr, doctr (auto → ppocr).` |
| `OcrEngine::Load` | `"auto"` calls `DetectOcrModel` and passes the resolved id to `CreateOcrBackend`. Explicit ids skip detect. |
| `OcrEngine::RecognizeMulti` | Concatenates `text_utf8` and shifts span utf16 offsets. **Drops `doctags_utf8` and `markdown_utf8`.** A single frame loses them too, because `merged` starts empty and those fields are never assigned. |
| `OcrTypes.h` | Extras and `max_new_tokens` exist. ppocr/doctr leave the strings empty and ignore the int. |
| Android `CMakeLists.txt` | Lists the six `ocr/doc_vlm/*.cpp` files and `ocr/doc_vlm` on the include path. |
| `SherpaOnnx.podspec` | Glob `ocr/**/*.{h,cpp}` plus header search path `ocr/doc_vlm`. |
| JNI `nativeRecognize` | HashMap has `ok`, `cancelled`, `errorCode`, `errorMessage`, `family`, `text`, `spans`. No `doctags` / `markdown`. |
| JNI `nativeLoad` | No `maxNewTokens` argument. Kotlin `OcrNative.nativeLoad` matches that signature. |
| Kotlin `ocrRecognize` | Populates the text buffer, then `promise.resolve(null)`. |
| iOS `ocrRecognize:` | `txt_populate_offline_if_empty` then `resolve(nil)`. |
| TS `recognize` | `Promise<void>`. `OcrModelType` / `OcrFamily` stop at doctr. No `docVlm`. |
| `detectOcrModel` completeness | doctr: `det+rec+manifest`. Everything else: `det+rec+rec_dict`. A future `modelType: 'doc_vlm'` payload would be marked failed. |
| Host tests | `ppocr_host_test` and `doctr_host_test` compile `OcrFactory.cpp` plus ppocr and doctr sources, **not** doc_vlm. `doc_vlm_host_test` does not link the factory. |
| `docs/ocr-offline.md` | Documents `recognize(...): Promise<void>`. Leave the file for Phase 5. The migration in §3 is the note callers need. |

`DocVlmBackend.h` still says `CreateOcrBackend` does not construct this type. Update that comment in the same change as the factory branch.

---

## 2  Public TypeScript shapes

File: `src/ocr/types.ts`. Re-export every new type and `isOcrDocVlmDetectSuccess` from `src/ocr/index.ts` the same way `isOcrDoctrDetectSuccess` is re-exported. Re-export `OcrDocVlmSuccessPaths` from `src/types/modelDetect.ts` next to `OcrDoctrSuccessPaths`.

### 2.1  Unions and the runtime list

```ts
/** Public OCR model types. `auto` resolves via layout detect. */
export type OcrModelType = 'auto' | 'ppocr' | 'doctr' | 'doc_vlm';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** OCR backend family. Matches `OcrBackend::Family()` after a successful load. */
export type OcrFamily = 'ppocr' | 'doctr' | 'doc_vlm';

export const OCR_MODEL_TYPES: readonly OcrModelType[] = [
  'ppocr',
  'doctr',
  'doc_vlm',
  'auto',
] as const;
```

`isOcrModelType` stays a membership test on `OCR_MODEL_TYPES`. `'docvlm'`, `'doc-vlm'`, `'granite-docling'`, and `'docling'` return **false**. Aliases are accepted only as an input string to `createOCR` / the factory, then rewritten to `'doc_vlm'`.

### 2.2  Family options

`ppocr` and `doctr` option types stay as they are. Add:

```ts
/**
 * doc_vlm generation options. Applied only when the loaded family is `doc_vlm`
 * (`modelType: 'doc_vlm'`, or `auto` once Phase 4 detect can resolve this pack).
 * Ignored by ppocr and doctr. Decode is greedy; this object does not grow
 * sampling fields in v1.
 */
export type OcrDocVlmOptions = {
  /**
   * Cap on newly generated token ids.
   * Omit or `0` → 8192 (Docling granite preset, also `text.max_position_embeddings`).
   * The backend lowers the cap when `prompt_length + maxNewTokens` would pass 8192
   * and logs the clamp under `[SherpaOnnx:ocr]`.
   * A positive value is forwarded as-is. Non-integers and negatives are
   * `OCR_INVALID_ARGUMENT` at `createOCR`, before native load.
   */
  maxNewTokens?: number;
};
```

### 2.3  `createOCR` options (discriminated union)

Shared fields stay `modelSource`, `provider?`, `numThreads?`. Family bags:

- `modelType` omitted or `'auto'`: `ppocr?`, `doctr?`, and `docVlm?` are all legal. Native copies every provided field onto `OcrLoadOptions`. The backend that actually loads reads its own fields.
- `modelType: 'ppocr'`: `ppocr?` only. `doctr?: never`. `docVlm?: never`.
- `modelType: 'doctr'`: `doctr?` only.
- `modelType: 'doc_vlm'`: `docVlm?` only.

```ts
type OcrInitShared = {
  modelSource: FileSource;
  provider?: string;
  numThreads?: number;
};

export type OcrInitializeOptionsAuto = OcrInitShared & {
  modelType?: 'auto';
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  docVlm?: OcrDocVlmOptions;
};

export type OcrInitializeOptionsPpocr = OcrInitShared & {
  modelType: 'ppocr';
  ppocr?: OcrPpocrOptions;
  doctr?: never;
  docVlm?: never;
};

export type OcrInitializeOptionsDoctr = OcrInitShared & {
  modelType: 'doctr';
  ppocr?: never;
  doctr?: OcrDoctrOptions;
  docVlm?: never;
};

export type OcrInitializeOptionsDocVlm = OcrInitShared & {
  modelType: 'doc_vlm';
  ppocr?: never;
  doctr?: never;
  docVlm?: OcrDocVlmOptions;
};

export type OcrInitializeOptions =
  | OcrInitializeOptionsAuto
  | OcrInitializeOptionsPpocr
  | OcrInitializeOptionsDoctr
  | OcrInitializeOptionsDocVlm;
```

This replaces the single `OcrInitializeOptions` interface. Excess-property checks reject a fresh object literal that pairs `modelType: 'ppocr'` with `docVlm: { maxNewTokens: 64 }`. A widened variable can still sneak through; native then ignores the unused field. That is the same contract TTS uses.

`buildOcrInitBridgeOptions` should read the three bags off one widened view so it does not have to switch on the union:

```ts
type OcrInitBags = OcrInitShared & {
  modelType?: OcrModelType | string;
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  docVlm?: OcrDocVlmOptions;
};
```

### 2.4  Recognize result

`OcrEngine.recognize` changes from `Promise<void>` to `Promise<OcrRecognizeResult>`.

```ts
/**
 * Resolved value of `OcrEngine.recognize`.
 * Plain text and spatial spans are on `textOut` (`origin: 'ocr'`).
 * This object is the structured extras channel plus a family tag.
 * Failures still reject (`OCR_CANCELLED`, `OCR_RECOGNIZE_FAILED`, …);
 * they do not come back as `status: 'failed'`.
 */
export type OcrRecognizeResult = {
  /**
   * `OcrBackend::Family()` of the loaded engine.
   * `createOCR({ modelType: 'auto' })` still echoes `'auto'` from `initializeOcr`.
   * This field is the concrete family.
   */
  family: OcrFamily;
  /** Spans written to `textOut` after the granularity filter. */
  spanCount: number;
  /**
   * Raw DocTags after ASCII lstrip. `""` for ppocr and doctr.
   * doc_vlm: the decoded generation, specials kept (`<doctag>` … `</doctag>`).
   */
  doctags: string;
  /**
   * Lossy markdown from the same DocTags walk. `""` for ppocr and doctr.
   * doc_vlm: empty only when the plain text is empty (Phase 2 §7.2).
   */
  markdown: string;
};
```

Do not echo `text` or the span quads. Callers read those from the text buffer (`getOfflineTextBufferTextSlice`, spatial-span APIs), same as TTS audio living on the audio buffer while `TtsSynthesisResult` carries the run metadata. DocTags and markdown have no buffer field, so they live here. A caller that drops the return value keeps plain text and spans and loses the markup. There is no `getLastRecognizeExtras()`.

`OcrRecognizeOptions` is unchanged: `frames?`, `granularity?`, `onProgress?`, `signal?`. `maxNewTokens` is not a per-call option.

Default `granularity` is `'line'`. `DocVlmBackend` emits `kLine` for body elements and `kBlock` for `title` / `section_header_level_*`. The existing filter keeps one level. Title quads are absent from `textOut` at the default granularity; their text is still inside `text`, `doctags`, and `markdown`. Passing `'block'` keeps titles and drops lines. Do not change that filter in this phase.

### 2.5  Bridge types (`src/NativeSherpaOnnx.ts`)

Add to `OcrInitBridgeOptions` (flat, same style as `detBoxThresh`):

```ts
/** doc_vlm generation cap. Omit → native 0 → backend default 8192. */
maxNewTokens?: number;
```

`ocrRecognize` return type becomes:

```ts
export type OcrRecognizeNativeResult = {
  family: string;
  spanCount: number;
  doctags: string;
  markdown: string;
};

ocrRecognize(
  instanceId: string,
  imageBufferId: string,
  textOutBufferId: string,
  options?: OcrRecognizeBridgeOptions
): Promise<OcrRecognizeNativeResult>;
```

Do not change the method’s argument list. Android `SherpaOnnxModule.ocrRecognize` and the iOS category selector stay the same arity; only the resolved value changes.

`OcrDetectNativeResult.paths` gains the keys in §7. `initializeOcr`’s resolved `{ instanceId, modelType }` stays. `modelType` there is the string after alias normalization, which is still `'auto'` when the caller asked for auto. It is not `Family()`.

### 2.6  Detect success paths

In `src/types/modelDetect.ts`, extend the loose `OcrDetectModelResult.paths` object with optional keys, and add the required-success alias:

```ts
/** Required paths when OCR detect succeeds for doc_vlm (granite-docling pack). */
export type OcrDocVlmSuccessPaths = {
  /** `vision_encoder.onnx` */
  vision_encoder: string;
  /** `vision_encoder.onnx_data` */
  vision_encoder_data: string;
  /** `embed_tokens.onnx` */
  embed_tokens: string;
  /** `embed_tokens.onnx_data` */
  embed_tokens_data: string;
  /** `decoder_model_merged.onnx` */
  decoder: string;
  /** `decoder_model_merged.onnx_data` */
  decoder_data: string;
  /** `tokenizer.json` */
  tokenizer: string;
  /** `ocr_manifest.json` */
  manifest: string;
};
```

`OcrDetectModelResult.paths` keeps `det?`, `rec?`, `cls?`, `rec_dict?`, `manifest?` and adds the eight keys above as optional. `cls` is not part of a doc_vlm success.

Guard in `src/ocr/types.ts`, next to `isOcrDoctrDetectSuccess`:

```ts
const DOC_VLM_PATH_KEYS = [
  'vision_encoder',
  'vision_encoder_data',
  'embed_tokens',
  'embed_tokens_data',
  'decoder',
  'decoder_data',
  'tokenizer',
  'manifest',
] as const;

export function isOcrDocVlmDetectSuccess(
  result: OcrDetectModelResult
): result is OcrDetectModelResult & {
  success: true;
  modelType: 'doc_vlm';
  paths: OcrDocVlmSuccessPaths;
} {
  if (!result.success || result.modelType !== 'doc_vlm' || result.paths == null) {
    return false;
  }
  const paths = result.paths;
  return DOC_VLM_PATH_KEYS.every((key) => {
    const value = paths[key];
    return typeof value === 'string' && value.length > 0;
  });
}
```

External-data files are required because `DocVlmBackend::Load` refuses a pack without them. A directory that has the graphs and is missing `decoder_model_merged.onnx_data` is not a success.

---

## 3  Migration for existing ppocr / doctr callers

Buffer contract is the same: empty `OfflineTextBuffer` in, plain text + `origin: 'ocr'` spans out, reject on cancel / already-populated / missing image.

```ts
import { createOCR } from 'react-native-sherpa-onnx/ocr';

// Before
await ocr.recognize(image, textOut, { granularity: 'line' });

// After — discard is still valid JavaScript. The type is no longer Promise<void>.
await ocr.recognize(image, textOut, { granularity: 'line' });

// After — typed use
const page = await ocr.recognize(image, textOut, { granularity: 'line' });
page.family;    // 'ppocr' | 'doctr' | 'doc_vlm'
page.spanCount; // number written to textOut
page.doctags;   // ''
page.markdown;  // ''
```

| Caller change | Required? |
| --- | --- |
| `await ocr.recognize(...)` with the return ignored | Runtime: no. Types: update any explicit `Promise<void>` annotation or `void`-returning wrapper. |
| Read text via `getOfflineTextBufferTextSlice` | No. |
| `createOCR({ modelType: 'ppocr', ppocr: { maxSideLen } })` | No. |
| `createOCR({ modelType: 'doctr', doctr: { detBoxThresh } })` | No. |
| `createOCR({ modelType: 'ppocr', doctr: { … } })` or the reverse | Type error. Move the bag onto `modelType: 'auto'`, or drop the bag that does not match. |
| `isOcrModelType` / `OCR_MODEL_TYPES.length === 3` | Length is 4. `'doc_vlm'` is a member. Aliases are not. |
| Docs samples in `docs/ocr-offline.md` | Phase 5 updates the prose. Behavior of those snippets stays valid if they ignore the return value. |

`doc_vlm` call site this phase enables:

```ts
const ocr = await createOCR({
  modelSource: { kind: 'fs', path: '/abs/path/to/docvlm-granite-258m' },
  modelType: 'doc_vlm',
  docVlm: { maxNewTokens: 512 },
});

const page = await ocr.recognize(image, textOut, { granularity: 'line' });
// page.family === 'doc_vlm'
// page.doctags includes '<doctag' and '</doctag>' on a real pack
// page.markdown is the lossy rendering
// textOut holds the plain text and the line spans
```

`modelType: 'auto'` on that directory still does **not** select `doc_vlm` until Phase 4 detect. It fails or resolves to another family, whichever `DetectOcrModel` does today.

---

## 4  Factory

`android/src/main/cpp/ocr/OcrFactory.cpp`

```cpp
#include "doc_vlm/DocVlmBackend.h"
#include "doctr/DoctrBackend.h"
#include "ppocr/PpocrBackend.h"

namespace {

std::string CanonicalOcrModelType(const std::string& model_type) {
  if (model_type == "docvlm" || model_type == "doc-vlm" ||
      model_type == "granite-docling" || model_type == "docling") {
    return "doc_vlm";
  }
  return model_type;
}

}  // namespace

std::unique_ptr<OcrBackend> CreateOcrBackend(const std::string& model_type) {
  const std::string type = CanonicalOcrModelType(model_type);
  if (type == "ppocr" || type == "auto") {
    return std::make_unique<ppocr::PpocrBackend>();
  }
  if (type == "doctr") {
    return std::make_unique<doctr::DoctrBackend>();
  }
  if (type == "doc_vlm") {
    return std::make_unique<doc_vlm::DocVlmBackend>();
  }
  throw std::invalid_argument(
      "Unknown OCR modelType/backend '" + model_type +
      "'. Supported in this build: ppocr, doctr, doc_vlm "
      "(aliases: docvlm, doc-vlm, granite-docling, docling; "
      "auto → ppocr when passed straight to CreateOcrBackend).");
}
```

`CreateOcrBackend("auto")` stays `PpocrBackend`. `OcrEngine::Load` resolves `"auto"` through detect **before** this function, so the factory fallback is only the direct-call path the existing host test locks. Do not teach the factory to detect.

Matching alias list in TypeScript, private to `src/ocr/ocrNativeBridge.ts` (do not export):

```ts
const OCR_MODEL_TYPE_ALIASES: Readonly<Record<string, OcrModelType>> = {
  docvlm: 'doc_vlm',
  'doc-vlm': 'doc_vlm',
  'granite-docling': 'doc_vlm',
  docling: 'doc_vlm',
};

function canonicalOcrModelType(raw: string): string {
  return OCR_MODEL_TYPE_ALIASES[raw] ?? raw;
}
```

Apply it to `options.modelType` before the bridge object is built. Unknown strings pass through; native throws. Case-sensitive. `DocVlm` and `DOC_VLM` are not aliases.

`OcrEngine::Load` does not need its own alias table if every public entry (TS bridge and `CreateOcrBackend`) canonicalizes. JNI and iOS pass `modelType` through. A native caller that passes `docling` still works because the factory canonicalizes. Log the canonical id:

```text
loaded family=%s provider=%s threads=%d maxSide=%d maxNew=%d dir=%s
```

`maxNew` is `options_.max_new_tokens` (0 means “backend default”, which is fine to log as 0).

Header comment on `OcrFactory.h`: supported ids are `ppocr`, `doctr`, `doc_vlm`, plus the four aliases. `DocVlmBackend.h` drops the sentence that says the factory does not construct this type.

---

## 5  Extras from `Recognize` to JavaScript

### 5.1  Merge in `OcrEngine::RecognizeMulti`

After the existing text/span append for each frame, append extras **without** touching `utf16_cursor`. The newline that joins plain text stays the only utf16 adjustment.

```cpp
auto appendField = [](std::string& dest, const std::string& chunk) {
  if (chunk.empty()) return;
  if (!dest.empty()) dest.push_back('\n');
  dest += chunk;
};
appendField(merged.doctags_utf8, frame_result.doctags_utf8);
appendField(merged.markdown_utf8, frame_result.markdown_utf8);
```

| Frames | `doctags_utf8` / `markdown_utf8` |
| --- | --- |
| One frame | That frame’s string, including `""`. |
| Two non-empty | `first + '\n' + second`. Same separator as plain text. No blank line, no page header. |
| Empty chunk | Skipped. No leading or doubled newline. |
| ppocr / doctr | Both stay `""`. |

`FilterSpansByGranularity` runs after the merge and does not clear extras. A `'word'` filter that drops every doc_vlm span still returns the markup.

Extend the done log with `doctags=%zu markdown=%zu` byte sizes. Tag stays `[SherpaOnnx:ocr]`.

### 5.2  JNI (`sherpa-onnx-ocr-jni.cpp`)

On the success path of `nativeRecognize`, after `PutString(..., "text", ...)`, always put both strings (empty is a real value):

```cpp
PutString(env, map, put, "doctags", outcome.result.doctags_utf8);
PutString(env, map, put, "markdown", outcome.result.markdown_utf8);
```

`family` is already on the map. Do not add a second copy of `text` for the JS result; Kotlin already reads `text` to populate the buffer.

### 5.3  Kotlin (`SherpaOnnxOcrHelper.ocrRecognize`)

Keep the populate block (`text`, `spatialSpans`, empty tokens). Replace `promise.resolve(null)` with a map:

| Key | Source |
| --- | --- |
| `family` | `raw["family"]` as `String`. Blank → reject `OCR_INTERNAL_ERROR` (`"recognize result missing family"`). |
| `spanCount` | `spans.size` after `mapNativeSpan` (post-filter count the buffer received). |
| `doctags` | `raw["doctags"]` as `String`. Null → the same internal-error reject. `""` is valid. |
| `markdown` | Same rule. |

Log `doctagsLen` and `markdownLen` on the existing `recognize ok` line.

`SherpaOnnxModule.ocrRecognize` does not change. The generated / hand-written override still takes a `Promise`.

### 5.4  iOS (`ios/ocr/bridge/SherpaOnnx+OCR.mm`)

After `txt_populate_offline_if_empty` succeeds, replace `resolve(nil)` with:

```objc
resolve(@{
  @"family" : [NSString stringWithUTF8String:outcome.family.c_str()] ?: @"",
  @"spanCount" : @(static_cast<NSInteger>(spans.size())),
  @"doctags" : [NSString stringWithUTF8String:outcome.result.doctags_utf8.c_str()] ?: @"",
  @"markdown" : [NSString stringWithUTF8String:outcome.result.markdown_utf8.c_str()] ?: @"",
});
```

If `outcome.family` is empty, `reject` with `OCR_INTERNAL_ERROR` instead of resolving. Empty markup strings resolve as `@""`.

Populate arguments stay `(text_utf8, spans)`. Do not pass doctags as the buffer text.

### 5.5  TS mapper (`src/ocr/index.ts`)

```ts
function readRecognizeResult(raw: OcrRecognizeNativeResult): OcrRecognizeResult {
  const family = raw?.family;
  if (family !== 'ppocr' && family !== 'doctr' && family !== 'doc_vlm') {
    throw Object.assign(new Error('OCR recognize result missing family'), {
      code: OcrErrorCode.INTERNAL_ERROR,
    });
  }
  if (typeof raw.doctags !== 'string' || typeof raw.markdown !== 'string') {
    throw Object.assign(new Error('OCR recognize result missing extras'), {
      code: OcrErrorCode.INTERNAL_ERROR,
    });
  }
  if (typeof raw.spanCount !== 'number' || !Number.isFinite(raw.spanCount)) {
    throw Object.assign(new Error('OCR recognize result missing spanCount'), {
      code: OcrErrorCode.INTERNAL_ERROR,
    });
  }
  return {
    family,
    spanCount: raw.spanCount,
    doctags: raw.doctags,
    markdown: raw.markdown,
  };
}
```

`recognize` returns that object. `finally` still runs `cleanup()` for the progress subscription and the abort listener. Destroy-before-recognize still throws `OCR_INSTANCE_NOT_FOUND` and does not call native.

---

## 6  `maxNewTokens` plumbing

End-to-end, one integer, default 0 on the native side.

| Layer | Rule |
| --- | --- |
| TS `buildOcrInitBridgeOptions` | If `docVlm.maxNewTokens` is `undefined`, omit `maxNewTokens`. If it is set: require `Number.isInteger(n) && n >= 0`. Otherwise throw `OCR_INVALID_ARGUMENT` (`"docVlm.maxNewTokens must be an integer >= 0"`). `0` is forwarded. |
| `OcrInitBridgeOptions.maxNewTokens` | Optional number. |
| Kotlin `initializeOcr` | `hasKey("maxNewTokens")` → `getDouble(...).toInt()`, else `0`. Pass as the new last argument of `nativeLoad`. |
| JNI `nativeLoad` | Append `jint maxNewTokens`. `opts.max_new_tokens = maxNewTokens`. Do not rewrite `<= 0` here. |
| iOS `initializeOcr:` | Missing key → `0`. Present → `intValue`. `opts.max_new_tokens = that`. |
| `DocVlmBackend` | Unchanged. `<= 0` → 8192, then the position clamp. |
| ppocr / doctr | Field is stored and ignored. |

JNI / Kotlin signature after the change (new argument last, so existing argument order is untouched):

```text
nativeLoad(
  instanceId, modelDir, modelType, numThreads, provider,
  maxSideLen, useOrientationCls,
  detBoxThresh, detBoxScoreThresh, detUnclipRatio,
  maxNewTokens
)
```

`OcrNative.kt` default the new parameter to `0` so the signature has a Kotlin default. The only caller is `SherpaOnnxOcrHelper`.

Do not add `maxNewTokens` to `OcrRecognizeBridgeOptions`.

---

## 7  Detect guard (TypeScript only)

`detectOcrModel` in `src/ocr/index.ts` learns the eight keys. Read each with the existing `pathFromRaw` from `raw.paths` then `raw.files`. No new top-level legacy (`visionEncoderPath` and similar).

Completeness, in this order:

```ts
if (family === 'doctr') {
  pathsComplete = Boolean(det && rec && manifest);
} else if (family === 'doc_vlm') {
  pathsComplete = Boolean(
    visionEncoder && visionEncoderData && embedTokens && embedTokensData &&
    decoder && decoderData && tokenizer && manifest
  );
} else {
  pathsComplete = Boolean(det && rec && recDict);
}
```

Missing-path error when native said success:

```text
OCR detect reported success but required paths (vision_encoder/embed_tokens/decoder/tokenizer/manifest and .onnx_data) were missing
```

The substring `required paths` keeps the existing Jest style (`/required paths/i`).

Partial paths are still returned with `success: false`, same as ppocr.

Native detect (`OcrDetect.cpp`, JNI `nativeDetect`, Kotlin `detectMapToWritable`, iOS `detectOcrModel:`) does **not** grow new keys in this phase. Phase 4 must emit the key strings in §2.6 on `paths` (and the same strings on `files`). Until then, `detectOcrModel` on a real granite directory does not return `modelType: 'doc_vlm'`. Jest covers the guard with a mocked native payload and with a hand-built `OcrDetectModelResult`.

---

## 8  CMake and podspec

No edit to the app source list:

- `android/src/main/cpp/CMakeLists.txt` already has `ocr/doc_vlm/DocVlm{Backend,DocTags,ImageOps,Manifest,Prompt,Tokenizer}.cpp` and the include directory.
- `SherpaOnnx.podspec` already has the glob and `"ocr/doc_vlm"` on the header search path.

`CreateOcrBackend` referencing `DocVlmBackend` makes every **host** binary that compiles `OcrFactory.cpp` need those six translation units. Today that is:

- `ppocr_host_test`
- `doctr_host_test`

In `test/cpp/CMakeLists.txt`, append to both executables:

```text
${OCR_CPP_ROOT}/doc_vlm/DocVlmBackend.cpp
${OCR_CPP_ROOT}/doc_vlm/DocVlmDocTags.cpp
${OCR_CPP_ROOT}/doc_vlm/DocVlmImageOps.cpp
${OCR_CPP_ROOT}/doc_vlm/DocVlmManifest.cpp
${OCR_CPP_ROOT}/doc_vlm/DocVlmPrompt.cpp
${OCR_CPP_ROOT}/doc_vlm/DocVlmTokenizer.cpp
```

Add `"${OCR_CPP_ROOT}/doc_vlm"` to both `target_include_directories` lists. Both already link `onnxruntime`, which `DocVlmBackend.cpp` includes.

Leave `doc_vlm_host_test` without `OcrFactory.cpp`. Its smoke test keeps constructing `DocVlmBackend` directly. The factory assertion goes in `ppocr_host_test.cpp`, which already hosts `OcrFactory.PpocrAndAutoCreate`.

Do not add the granite pack to `.github/workflows/test-ocr-host.yml`.

---

## 9  Mobile ORT and `GroupQueryAttention`

Phase 2 pinned this and left it for later. It does not change the public types.

`decoder_model_merged.onnx` (opset 21 + `com.microsoft`) uses contrib op `GroupQueryAttention`. The host zip at `third_party/onnxruntime_prebuilt` (1.28.x) includes it. A mobile ORT built without contrib ops fails when the decoder `Ort::Session` is created, with an unregistered-op error.

This phase:

- Does not rebuild or swap ONNX Runtime.
- Does not add a `supportsDocVlm` probe, a new `OcrErrorCode`, or a provider fallback that pretends the graph loaded.
- Lets `DocVlmBackend::Load` throw. JNI / iOS already map that exception to `OCR_INTERNAL_ERROR` (or the platform equivalent of a native exception on the initialize promise). The message is ORT’s.

Phase 5 `docs/ocr-offline.md` should say that `doc_vlm` needs an ORT build with Microsoft contrib ops, and that a stock mobile build without them fails at `createOCR`, not at the first token. That sentence is not written in this phase.

`provider` is unchanged at the API and is passed to `ApplyOrtProvider` like ppocr/doctr (`cpu`, `nnapi`, `xnnpack`, `coreml`). Missing or unusable EP logs and stays on CPU.

---

## 10  File-by-file

### 10.1  Edit

| File | Change |
| --- | --- |
| `android/src/main/cpp/ocr/OcrFactory.cpp` | §4 branch, aliases, error string. Include `doc_vlm/DocVlmBackend.h`. |
| `android/src/main/cpp/ocr/OcrFactory.h` | Comment lists `doc_vlm` and the aliases. |
| `android/src/main/cpp/ocr/doc_vlm/DocVlmBackend.h` | Remove “factory does not construct this type”. |
| `android/src/main/cpp/ocr/OcrEngine.cpp` | §5.1 merge. Add `maxNew` and extras sizes to the existing logs. |
| `android/src/main/cpp/jni/ocr/sherpa-onnx-ocr-jni.cpp` | `nativeLoad` gains `jint maxNewTokens` (last). `nativeRecognize` puts `doctags` and `markdown`. |
| `android/src/main/java/com/sherpaonnx/ocr/OcrNative.kt` | `nativeLoad` last parameter `maxNewTokens: Int = 0`. |
| `android/src/main/java/com/sherpaonnx/ocr/facade/SherpaOnnxOcrHelper.kt` | Read `maxNewTokens`. `ocrRecognize` resolves the four-field map instead of `null`. |
| `ios/ocr/bridge/SherpaOnnx+OCR.mm` | Read `maxNewTokens` into `OcrLoadOptions`. `resolve` the four-field dictionary. |
| `src/ocr/types.ts` | §2.1–§2.4 and `isOcrDocVlmDetectSuccess`. |
| `src/ocr/ocrNativeBridge.ts` | Alias canonicalization, `maxNewTokens` validation and flatten. |
| `src/ocr/index.ts` | Return `OcrRecognizeResult`. Detect completeness for `doc_vlm`. Header comment lists three backends. Re-exports. |
| `src/NativeSherpaOnnx.ts` | `maxNewTokens` on init options. `OcrRecognizeNativeResult`. Detect `paths` keys. `ocrRecognize` promise type. |
| `src/types/modelDetect.ts` | `OcrDocVlmSuccessPaths` and optional keys on `OcrDetectModelResult.paths`. |
| `src/ocr/__tests__/offline-api.test.ts` | §11. |
| `test/cpp/ocr/ppocr_host_test.cpp` | §12 factory test. |
| `test/cpp/CMakeLists.txt` | doc_vlm sources on `ppocr_host_test` and `doctr_host_test`. |

### 10.2  Do not edit

`DocVlmBackend.cpp` decode loop, image preprocess, tokenizer, prompt, DocTags parser. `OcrDetect.cpp` and `jni/model_detect/ocr/*`. Download, language catalog, `docs/ocr-offline.md`, `docs/model-languages.md`, `docs/feature-pipelines.md`, README, example app, `test-ocr-host.yml`. `doc_vlm_host_test.cpp` assertions from Phase 2 (no factory link). Text-buffer schema (`TextSpatialSpan` / `txt_populate_offline_if_empty` signature).

`SherpaOnnxModule.kt` method signatures stay. The helper owns the resolved map.

---

## 11  Jest (`src/ocr/__tests__/offline-api.test.ts`)

Update the default `ocrRecognize` mock from `undefined` to a ppocr-shaped result so every existing `await ocr.recognize(...)` still type-checks at runtime when the mapper runs:

```ts
mockNative.ocrRecognize.mockResolvedValue({
  family: 'ppocr',
  spanCount: 1,
  doctags: '',
  markdown: '',
});
```

Existing tests that only assert `toHaveBeenCalledWith` stay. Add:

| Test | Assert |
| --- | --- |
| `isOcrModelType` / `OCR_MODEL_TYPES` | `'doc_vlm'` is a member. Length is 4. `'docvlm'`, `'doc-vlm'`, `'granite-docling'`, `'docling'` are not members. |
| `createOCR` doc_vlm forwards `maxNewTokens` | `initializeOcr` called with `modelType: 'doc_vlm'` and `maxNewTokens: 512`. |
| `createOCR` doc_vlm omits the key | No `docVlm` on the options → bridge object has no `maxNewTokens`. |
| `createOCR` alias | Runtime `modelType: 'docling'` (cast through `OcrInitializeOptions`) is sent as `'doc_vlm'`. Repeat once for `'docvlm'`. |
| `createOCR` rejects a bad cap | `maxNewTokens: -1`, `1.5`, and `Number.NaN` reject with `code: 'OCR_INVALID_ARGUMENT'` and do not call `initializeOcr`. |
| ppocr recognize result | Default mock → `{ family: 'ppocr', spanCount: 1, doctags: '', markdown: '' }`. |
| doctr recognize result | Mock `{ family: 'doctr', spanCount: 2, doctags: '', markdown: '' }` → same strings, `family: 'doctr'`. |
| doc_vlm recognize result | Mock `{ family: 'doc_vlm', spanCount: 3, doctags: '<doctag><text>Hi</text></doctag>', markdown: 'Hi' }` → those strings, `spanCount: 3`. |
| Missing extras | Mock `{ family: 'doc_vlm', spanCount: 0 }` (no `doctags`) rejects `OCR_INTERNAL_ERROR`. |
| Missing family | Mock `{ spanCount: 0, doctags: '', markdown: '' }` rejects `OCR_INTERNAL_ERROR`. |
| `isOcrDocVlmDetectSuccess` narrows | Hand-built success with all eight non-empty paths → true, and `paths.decoder` is a string inside the branch. |
| Guard rejects other families | ppocr success and doctr success → false. |
| Guard rejects a short pack | `success: true`, `modelType: 'doc_vlm'`, paths missing `decoder_data` → false. |
| `detectOcrModel` doc_vlm mock | Native returns `modelType: 'doc_vlm'` plus the eight `paths` keys → `success: true`, `isOcrDocVlmDetectSuccess` true, `paths.rec_dict` undefined, `paths.vision_encoder` contains `vision_encoder.onnx`. |
| `detectOcrModel` incomplete doc_vlm | Native `ok: true` with only `vision_encoder` → `success: false`, error matches `/required paths/i`. |
| Destroyed engine | Unchanged: `OCR_INSTANCE_NOT_FOUND` before native recognize. |

One `// @ts-expect-error` (or `@ts-expect-error` on the next line, matching the repo’s Jest/TS setup) on this object literal:

```ts
createOCR({
  modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
  modelType: 'ppocr',
  docVlm: { maxNewTokens: 32 },
});
```

If the test runner does not type-check that file, keep the example in this plan and skip the expect-error test rather than adding a new ts-jest project. The runtime tests above are the gate.

Do not start ORT, and do not point Jest at `build/ocr-models/docvlm-granite-258m`.

---

## 12  Host gtest

Add to `test/cpp/ocr/ppocr_host_test.cpp` (always runs, no pack, no `Load`):

```cpp
TEST(OcrFactory, DocVlmAndAliasesCreate) {
  for (const char* id :
       {"doc_vlm", "docvlm", "doc-vlm", "granite-docling", "docling"}) {
    auto backend = CreateOcrBackend(id);
    ASSERT_NE(backend, nullptr) << id;
    EXPECT_STREQ(backend->Family(), "doc_vlm") << id;
  }
}
```

Extend `OcrFactory.UnknownBackendThrows` (or add a sibling) so the `easyocr` exception text contains `doc_vlm`. The existing `Unknown OCR` substring check must still pass.

`OcrFactory.PpocrAndAutoCreate` stays: `"auto"` → `Family() == "ppocr"`.

No new smoke. `DocVlmSmoke.EnHello` in `doc_vlm_host_test` is unchanged and still `GTEST_SKIP`s without the pack.

Link fix in §8 is part of this gate: `ppocr_host_test` and `doctr_host_test` must build after the factory include.

---

## 13  Acceptance checklist

- [ ] `CreateOcrBackend("doc_vlm")` returns a backend whose `Family()` is `"doc_vlm"`.
- [ ] Aliases `docvlm`, `doc-vlm`, `granite-docling`, `docling` do the same. `DocVlm` does not.
- [ ] `CreateOcrBackend("auto")` is still ppocr. `CreateOcrBackend("easyocr")` still throws, and the message lists `doc_vlm`.
- [ ] `OcrModelType` includes `'doc_vlm'`. `OCR_MODEL_TYPES` has length 4 with `'auto'` last. `isOcrModelType('docvlm')` is false.
- [ ] `createOCR({ modelType: 'doc_vlm', docVlm: { maxNewTokens: 512 } })` sends `maxNewTokens: 512`. Omit and `0` both mean native `0`.
- [ ] Negative / non-integer `maxNewTokens` fails in TS with `OCR_INVALID_ARGUMENT` and does not call `initializeOcr`.
- [ ] JNI `nativeLoad` and Kotlin `nativeLoad` take `maxNewTokens` as the last argument. iOS reads the same key into `OcrLoadOptions::max_new_tokens`.
- [ ] `OcrEngine::RecognizeMulti` copies `doctags_utf8` and `markdown_utf8`, joining non-empty chunks with one `\n`, and does not shift span offsets for that newline.
- [ ] ppocr and doctr still populate the text buffer and resolve `doctags: ''`, `markdown: ''`.
- [ ] doc_vlm resolves the backend strings. Spans remain on the text buffer only.
- [ ] A recognize native payload missing `family`, `doctags`, `markdown`, or a finite `spanCount` rejects `OCR_INTERNAL_ERROR`.
- [ ] Cancel, progress `operationId` filtering, and destroy-then-recognize behavior are unchanged.
- [ ] `isOcrDocVlmDetectSuccess` requires `modelType: 'doc_vlm'`, `success: true`, and all eight path strings. It rejects ppocr, doctr, and a pack missing `decoder_data`.
- [ ] `detectOcrModel` marks a mocked doc_vlm payload incomplete when any of those eight are missing, and does not apply the ppocr `rec_dict` rule to that family.
- [ ] `ppocr_host_test` and `doctr_host_test` link the six doc_vlm `.cpp` files. `doc_vlm_host_test` still does not link `OcrFactory.cpp`.
- [ ] Android CMake and the podspec are not given a second copy of sources they already list.
- [ ] No detect C++ change, no catalog/download change, no `docs/ocr-offline.md` edit, no example app, no ORT rebuild.
- [ ] Logs that this phase adds use `[SherpaOnnx:ocr]`.

---

## 14  Not in this phase

| Item | Owner |
| --- | --- |
| `OcrModelKind::kDocVlm`, `CanDocVlmLayout`, manifest `family` as a detect discriminator, JNI/iOS/Kotlin detect maps emitting the §2.6 keys | Phase 4 |
| `createOCR({ modelType: 'auto' })` selecting a granite pack | Phase 4 (detect), factory branch from this phase is the other half |
| Download asset id, `ModelCategory.Ocr` hints, catalog domain `ocr.doc_vlm`, `yarn generate:model-language-catalog` | Phase 4 |
| `docs/ocr-offline.md`, `docs/model-languages.md`, `docs/feature-pipelines.md`, README, including the GroupQueryAttention sentence | Phase 5 |
| CI job that downloads `docvlm-granite-258m` (`test-ocr-host.yml`) | Phase 5 |
| Strict golden `DOCVLM_STRICT_GOLDEN` promotion | Phase 5 |
| Example app / VoiceLab | Out of scope for the whole epic |
| Rebuilding ONNX Runtime to add contrib ops, or a public “device supports doc_vlm” API | Not this epic unless a later decision says otherwise |
| Temperature, top-p, beams, logprobs, `confidence` other than `1` | Phase 2 decision, still closed |
| Per-recognize `maxNewTokens` | Would be a new load or a backend setter; v1 is init-only |
| Storing DocTags or markdown on `OfflineTextBuffer` | Extras stay on `OcrRecognizeResult` |
| A separate overlays array | Spans are the overlays |
| PDF pages, OTSL → CSV, picture tokens, a second weight variant | Later |
| Returning resolved `Family()` from `initializeOcr` when `modelType` was `'auto'` | Callers read `recognize().family`. Init still echoes the requested id |
