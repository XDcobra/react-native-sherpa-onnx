# Phase 3 — DocTR TS Integration Plan

> Branch: `feat/add-ocr-doctr`
> Prereqs: Phase 1 (packs) ✅ • Phase 2 (DoctrBackend C++) ✅

## 1  Current State Summary

### 1.1  TS types (`src/ocr/types.ts`)

| Symbol | Current | Gap |
|---|---|---|
| `OcrModelType` | `'auto' \| 'ppocr'` | Missing `'doctr'` |
| `OcrConcreteModelType` | `Exclude<OcrModelType, 'auto'>` | Derives correctly once union widens |
| `OcrFamily` | `'ppocr'` | Missing `'doctr'` |
| `OcrPpocrOptions` | `{ maxSideLen?, useOrientationCls? }` | ppocr-only; no doctr analog |
| `OcrInitializeOptions` | `ppocr?: OcrPpocrOptions` | No `doctr?:` field |
| `isOcrPpocrDetectSuccess` | Checks `modelType === 'ppocr'` + det/rec/rec_dict | No doctr equivalent |

### 1.2  Native bridge (`src/NativeSherpaOnnx.ts`)

| Type | Current | Gap |
|---|---|---|
| `OcrInitBridgeOptions` | `modelDir, modelType, numThreads?, provider?, maxSideLen?, useOrientationCls?` | No doctr-specific fields (`detBoxThresh`, `detBoxScoreThresh`, `detUnclipRatio`) |
| `OcrDetectNativeResult.paths` | `{ det?, rec?, cls?, rec_dict? }` | Missing `manifest?` for doctr |

### 1.3  Bridge builder (`src/ocr/ocrNativeBridge.ts`)

Flattens `ppocr.maxSideLen` / `ppocr.useOrientationCls` into top-level bridge fields.
No doctr options handling.

### 1.4  Public API (`src/ocr/index.ts`)

- `detectOcrModel()` extracts `det`, `rec`, `cls`, `rec_dict` from native result. Does NOT extract `manifest`.
- Success validation: hard-coded `det && rec && recDict` — ppocr-centric; doctr needs `det && rec && manifest`.
- Re-exports: `OcrPpocrSuccessPaths`, `isOcrPpocrDetectSuccess`. No doctr equivalents.

### 1.5  C++ (Phase 2 — already done)

- `OcrFactory.cpp` — `"doctr"` branch creates `DoctrBackend` ✅
- `OcrEngine::Load()` — `"auto"` calls `DetectOcrModel()` which resolves to `"doctr"` if `ocr_manifest.json` present ✅
- `OcrDetect.cpp` — bridge maps `kDoctr → "doctr"` ✅
- `model_detect/ocr` — `CanDoctrLayout`, sets `paths.manifest`, validates via `kDoctrReqs` (det+rec+manifest required) ✅
- BUT: `OcrDetect.cpp` (thin bridge) does NOT propagate `manifest` path — only `detPath`, `recPath`, `clsPath`, `recDictPath` ✅→⚠️ needs fix
- `ParseOcrModelTypeLocal` in `sherpa-onnx-validate-custom.cpp` does NOT recognize `"doctr"` — only `"ppocr"` ⚠️ needs fix

### 1.6  iOS podspec (`SherpaOnnx.podspec`)

- Source glob: `"android/src/main/cpp/ocr/**/*.{h,cpp}"` — already picks up `doctr/` subdir ✅
- Include paths list: has `ocr/` and `ocr/ppocr/` — missing `ocr/doctr/` ⚠️

### 1.7  Android CMake (`android/src/main/cpp/CMakeLists.txt`)

- Sources: all doctr .cpp files listed ✅
- Include dirs: `ocr/doctr` listed ✅

### 1.8  Jest tests (`src/ocr/__tests__/offline-api.test.ts`)

- All mocks/tests ppocr-only (detect returns ppocr paths + type)
- No doctr test cases

### 1.9  Parallel patterns

TTS uses the same pattern:
- `TTSModelType` = union of concrete types + `'auto'`
- `TTSConcreteModelType = Exclude<TTSModelType, 'auto'>`
- `TTS_MODEL_TYPES` runtime const array + `isTtsModelType()` runtime guard
- Per-family init options (e.g. `kokoro?:`, `vits?:`) in `TtsInitializeOptions`
- Per-family success guards (e.g. `isTtsKokoroDetectSuccess()`)

---

## 2  File-by-File Change List

### 2.1  `src/ocr/types.ts`

**A) Widen type unions**

```ts
export type OcrModelType = 'auto' | 'ppocr' | 'doctr';
export type OcrFamily = 'ppocr' | 'doctr';
```

`OcrConcreteModelType` auto-derives; no change needed.

**B) Add runtime const + guard (parallel TTS pattern)**

```ts
export const OCR_MODEL_TYPES: readonly OcrModelType[] = [
  'ppocr',
  'doctr',
  'auto',
] as const;

export function isOcrModelType(s: string): s is OcrModelType {
  return (OCR_MODEL_TYPES as readonly string[]).includes(s);
}
```

**C) Add `OcrDoctrOptions`**

DoctrBackend reads these from `OcrLoadOptions` (adapts ppocr defaults internally):

```ts
export type OcrDoctrOptions = {
  /**
   * Detection box binary-threshold (doctr default: 0.15).
   * DoctrBackend auto-lowers ppocr-range values; set explicitly to override.
   */
  detBoxThresh?: number;
  /**
   * Detection box score threshold (doctr default: 0.15).
   */
  detBoxScoreThresh?: number;
  /**
   * Unclip ratio for DB postprocessing (default: 1.5).
   */
  detUnclipRatio?: number;
};
```

> Rationale: `maxSideLen` and `useOrientationCls` are ppocr-specific (doctr stretches to fixed manifest size, has no cls session). The thresholds are the only tunable knobs doctr actually uses from `OcrLoadOptions`.

**D) Add `doctr?:` to `OcrInitializeOptions`**

```ts
export type OcrInitializeOptions = {
  modelSource: FileSource;
  modelType?: OcrModelType;
  provider?: string;
  numThreads?: number;
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
};
```

**E) Add `isOcrDoctrDetectSuccess` guard**

```ts
export function isOcrDoctrDetectSuccess(
  result: OcrDetectModelResult
): result is OcrDetectModelResult & {
  success: true;
  modelType: 'doctr';
  paths: OcrDoctrSuccessPaths;
} {
  if (!result.success || result.modelType !== 'doctr' || result.paths == null) {
    return false;
  }
  const { det, rec, manifest } = result.paths;
  return (
    typeof det === 'string' && det.length > 0 &&
    typeof rec === 'string' && rec.length > 0 &&
    typeof manifest === 'string' && manifest.length > 0
  );
}
```

### 2.2  `src/types/modelDetect.ts`

**A) Add `OcrDoctrSuccessPaths`**

```ts
/** Required paths when OCR detect succeeds for doctr (ocr_manifest.json). */
export type OcrDoctrSuccessPaths = {
  det: string;
  rec: string;
  /** `ocr_manifest.json` containing vocab, mean/std, input shapes. */
  manifest: string;
  cls?: string;
};
```

**B) Widen `OcrDetectModelResult.paths`**

```ts
export interface OcrDetectModelResult extends ModelDetectResultBase {
  sizeTier?: SizeTier;
  paths?: {
    det?: string;
    rec?: string;
    cls?: string;
    rec_dict?: string;
    /** `ocr_manifest.json` — doctr family. */
    manifest?: string;
  };
}
```

### 2.3  `src/NativeSherpaOnnx.ts`

**A) Widen `OcrInitBridgeOptions`**

```ts
export type OcrInitBridgeOptions = {
  modelDir: string;
  modelType: string;
  numThreads?: number;
  provider?: string;
  // ppocr
  maxSideLen?: number;
  useOrientationCls?: boolean;
  // doctr
  detBoxThresh?: number;
  detBoxScoreThresh?: number;
  detUnclipRatio?: number;
};
```

**B) Widen `OcrDetectNativeResult.paths`**

Add `manifest?: string` to the `paths` shape.

### 2.4  `src/ocr/ocrNativeBridge.ts`

Flatten `doctr` options alongside ppocr ones:

```ts
export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  const modelType: OcrModelType = options.modelType ?? 'auto';
  return {
    modelDir,
    modelType,
    ...(options.numThreads !== undefined ? { numThreads: options.numThreads } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    // ppocr
    ...(options.ppocr?.maxSideLen !== undefined ? { maxSideLen: options.ppocr.maxSideLen } : {}),
    ...(options.ppocr?.useOrientationCls !== undefined ? { useOrientationCls: options.ppocr.useOrientationCls } : {}),
    // doctr
    ...(options.doctr?.detBoxThresh !== undefined ? { detBoxThresh: options.doctr.detBoxThresh } : {}),
    ...(options.doctr?.detBoxScoreThresh !== undefined ? { detBoxScoreThresh: options.doctr.detBoxScoreThresh } : {}),
    ...(options.doctr?.detUnclipRatio !== undefined ? { detUnclipRatio: options.doctr.detUnclipRatio } : {}),
  };
}
```

### 2.5  `src/ocr/index.ts`

**A) Extract `manifest` path from detect result**

In `detectOcrModel()`, add manifest extraction alongside existing det/rec/cls/rec_dict:

```ts
const manifest =
  pathFromRaw(pathsRaw.manifest) ??
  pathFromRaw(filesRaw.manifest) ??
  pathFromRaw(raw.manifestPath);
```

Add `manifest` to the paths object construction:

```ts
const paths =
  det || rec || cls || recDict || manifest
    ? {
        ...(det ? { det } : {}),
        ...(rec ? { rec } : {}),
        ...(cls ? { cls } : {}),
        ...(recDict ? { rec_dict: recDict } : {}),
        ...(manifest ? { manifest } : {}),
      }
    : undefined;
```

**B) Family-aware success validation**

Replace the hard-coded ppocr path-completeness check with family-aware logic:

```ts
// Family-aware completeness: ppocr needs det+rec+rec_dict; doctr needs det+rec+manifest.
const family = typeof raw.modelType === 'string' ? raw.modelType : '';
let pathsComplete: boolean;
if (family === 'doctr') {
  pathsComplete = Boolean(det && rec && manifest);
} else {
  // ppocr or unknown — original contract
  pathsComplete = Boolean(det && rec && recDict);
}
const success = successFlag && pathsComplete;
```

Adjust the error message similarly to be family-aware.

**C) Re-exports**

```ts
export type {
  OcrDetectModelResult,
  OcrPpocrSuccessPaths,
  OcrDoctrSuccessPaths,
} from '../types/modelDetect';

export {
  OcrErrorCode,
  isOcrPpocrDetectSuccess,
  isOcrDoctrDetectSuccess,
  OCR_MODEL_TYPES,
  isOcrModelType,
} from './types';

export type {
  // ... existing types ...
  OcrDoctrOptions,
} from './types';
```

### 2.6  iOS — `SherpaOnnx.podspec`

Add doctr include path:

```ruby
"\"#{pod_root}/android/src/main/cpp/ocr/doctr\"",
```

After the existing `ocr/ppocr` line.

### 2.7  iOS — `ios/ocr/bridge/SherpaOnnx+OCR.mm`

In `initializeOcr:`, read and forward doctr bridge options to `OcrLoadOptions`:

```objc
float detBoxThresh =
    options[@"detBoxThresh"] ? [options[@"detBoxThresh"] floatValue] : 0.3f;
float detBoxScoreThresh =
    options[@"detBoxScoreThresh"] ? [options[@"detBoxScoreThresh"] floatValue] : 0.5f;
float detUnclipRatio =
    options[@"detUnclipRatio"] ? [options[@"detUnclipRatio"] floatValue] : 1.5f;

// ... existing opts setup ...
opts.det_box_thresh = detBoxThresh;
opts.det_box_score_thresh = detBoxScoreThresh;
opts.det_unclip_ratio = detUnclipRatio;
```

In `detectOcrModel:`, propagate `manifest` path from `OcrDetectResult`:

```objc
// After existing recDictPath check:
// (Need to add manifestPath field to C++ OcrDetectResult first)
```

### 2.8  C++ — `android/src/main/cpp/ocr/OcrDetect.h`

Add `manifestPath` field to `OcrDetectResult`:

```cpp
struct OcrDetectResult {
  // ... existing fields ...
  std::string manifestPath;
  // ...
};
```

### 2.9  C++ — `android/src/main/cpp/ocr/OcrDetect.cpp`

Propagate `manifest` from native detect result:

```cpp
out.manifestPath = native.paths.manifest;
```

Add a new `hasManifest` bool if desired (or skip — TS can just check string presence).

### 2.10  C++ — `android/src/main/cpp/jni/model_detect/common/sherpa-onnx-validate-custom.cpp`

Add doctr recognition to `ParseOcrModelTypeLocal`:

```cpp
OcrModelKind ParseOcrModelTypeLocal(const std::string& modelType) {
    const std::string t = ToLower(modelType);
    if (t == "ppocr" || t == "paddleocr" || t == "pp-ocr") {
        return OcrModelKind::kPpocr;
    }
    if (t == "doctr" || t == "onnxtr" || t == "doc-tr" || t == "doc_tr") {
        return OcrModelKind::kDoctr;
    }
    return OcrModelKind::kUnknown;
}
```

This mirrors `ParseOcrModelTypeStrict` in `sherpa-onnx-model-detect-ocr.cpp`.

### 2.11  iOS — `ios/ocr/bridge/SherpaOnnx+OCR.mm` (detect manifest propagation)

In `detectOcrModel:`, after the recDictPath check, add:

```objc
if (!detect.manifestPath.empty()) {
  NSString *p = [NSString stringWithUTF8String:detect.manifestPath.c_str()];
  files[@"manifest"] = p;
  paths[@"manifest"] = p;
}
```

### 2.12  Android JNI — `android/src/main/cpp/jni/ocr/sherpa-onnx-ocr-jni.cpp`

Read `detBoxThresh`, `detBoxScoreThresh`, `detUnclipRatio` from the Java bridge options map and set them on `OcrLoadOptions`.

Propagate `manifestPath` in the detect JNI response.

(Need to verify exact JNI bridge code — similar pattern to maxSideLen/useOrientationCls.)

---

## 3  Auto Resolution End-to-End Flow

```
createOCR({ modelSource, modelType: 'auto' | 'doctr' | 'ppocr' | undefined })
  ↓
buildOcrInitBridgeOptions()  → { modelDir, modelType: 'auto'|'ppocr'|'doctr', ...options }
  ↓
Native initializeOcr(instanceId, bridgeOptions)
  ↓
OcrEngine::Load(modelType, modelDir, loadOptions)
  ├─ if modelType == "auto":
  │    DetectOcrModel(modelDir)  → OcrDetectResult { modelType: "ppocr"|"doctr" }
  │    resolved = detect.modelType
  ├─ else:
  │    resolved = modelType
  ↓
CreateOcrBackend(resolved)  → PpocrBackend | DoctrBackend
  ↓
backend->Load(modelDir, loadOptions)
  ├─ PpocrBackend: reads det.onnx/rec.onnx/rec_dict
  └─ DoctrBackend: reads det.onnx/rec.onnx/ocr_manifest.json
```

**Auto-detect priority** (in `sherpa-onnx-model-detect-ocr.cpp`):
1. If both ppocr and doctr layouts are present: ppocr wins (fallbackOrder)
2. If explicit `modelType` requested: only that layout is checked
3. If name-only mode (no file listing): `InferDoctrNameOnly` heuristic checks dir basename

**No TS-side changes to auto resolution** — it's fully handled in C++ `OcrEngine::Load`. The TS layer just passes `modelType` through.

---

## 4  Jest Test Cases to Add/Update

All in `src/ocr/__tests__/offline-api.test.ts`:

### 4.1  New test: `createOCR with modelType: 'doctr'`

```ts
it('createOCR with doctr modelType passes doctr options to native', async () => {
  const ocr = await createOCR({
    modelSource: { kind: 'fs', path: '/models/onnxtr-default' },
    modelType: 'doctr',
    doctr: { detBoxThresh: 0.2, detBoxScoreThresh: 0.2 },
  });
  expect(mockNative.initializeOcr).toHaveBeenCalledWith(
    expect.stringMatching(/^ocr_/),
    expect.objectContaining({
      modelDir: '/models/onnxtr-default',
      modelType: 'doctr',
      detBoxThresh: 0.2,
      detBoxScoreThresh: 0.2,
    })
  );
  await ocr.destroy();
});
```

### 4.2  New test: `detectOcrModel returns doctr paths with manifest`

```ts
it('detectOcrModel returns doctr paths with manifest', async () => {
  mockNative.detectOcrModel.mockResolvedValue({
    success: true,
    ok: true,
    modelType: 'doctr',
    family: 'doctr',
    detectedModels: [{ type: 'doctr', modelDir: '/models/onnxtr-default' }],
    paths: {
      det: '/models/onnxtr-default/det.onnx',
      rec: '/models/onnxtr-default/rec.onnx',
      manifest: '/models/onnxtr-default/ocr_manifest.json',
    },
    detectionSources: ['fileListing', 'fallbackOrder'],
    sizeTier: 'medium',
    languages: [
      { iso6391Hint: 'en', id: 'en' },
      { iso6391Hint: 'fr', id: 'fr' },
    ],
  });
  const result = await detectOcrModel({
    kind: 'fs',
    path: '/models/onnxtr-default',
  });
  expect(result.success).toBe(true);
  expect(result.modelType).toBe('doctr');
  expect(result.paths?.manifest).toContain('ocr_manifest.json');
  expect(result.paths?.det).toContain('det.onnx');
  expect(result.paths?.rec).toContain('rec.onnx');
  expect(result.paths?.rec_dict).toBeUndefined();
});
```

### 4.3  New test: `isOcrDoctrDetectSuccess` guard

```ts
it('isOcrDoctrDetectSuccess narrows doctr paths', () => {
  const result: OcrDetectModelResult = {
    success: true,
    isStreaming: false,
    detectedModels: [{ type: 'doctr', modelDir: '/m' }],
    modelType: 'doctr',
    paths: {
      det: '/m/det.onnx',
      rec: '/m/rec.onnx',
      manifest: '/m/ocr_manifest.json',
    },
  };
  expect(isOcrDoctrDetectSuccess(result)).toBe(true);
  if (isOcrDoctrDetectSuccess(result)) {
    expect(result.paths.manifest.length).toBeGreaterThan(0);
  }
});

it('isOcrDoctrDetectSuccess rejects ppocr result', () => {
  const result: OcrDetectModelResult = {
    success: true,
    isStreaming: false,
    detectedModels: [{ type: 'ppocr', modelDir: '/m' }],
    modelType: 'ppocr',
    paths: { det: '/m/det.onnx', rec: '/m/rec.onnx', rec_dict: '/m/dict.yml' },
  };
  expect(isOcrDoctrDetectSuccess(result)).toBe(false);
});
```

### 4.4  New test: `doctr detect fails when manifest missing`

```ts
it('detectOcrModel fails for doctr when manifest is missing', async () => {
  mockNative.detectOcrModel.mockResolvedValue({
    success: true,
    ok: true,
    modelType: 'doctr',
    paths: { det: '/m/det.onnx', rec: '/m/rec.onnx' },
    detectedModels: [],
  });
  const result = await detectOcrModel({ kind: 'fs', path: '/m' });
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/required paths/i);
});
```

### 4.5  New test: `isOcrModelType runtime guard`

```ts
it('isOcrModelType recognizes valid types', () => {
  expect(isOcrModelType('ppocr')).toBe(true);
  expect(isOcrModelType('doctr')).toBe(true);
  expect(isOcrModelType('auto')).toBe(true);
  expect(isOcrModelType('tessaract')).toBe(false);
});
```

### 4.6  Update existing test imports

Add `isOcrDoctrDetectSuccess`, `isOcrModelType`, `OCR_MODEL_TYPES` to the import from `../index`.

### 4.7  No changes to existing ppocr tests

All ppocr tests remain valid and should pass unchanged (regression safety).

---

## 5  What NOT To Do in Phase 3

| Excluded | Why | Deferred to |
|---|---|---|
| Model download/pack catalog for doctr | Phase 4 scope (detect + download + language catalog) | Phase 4 |
| Automatic doctr model downloads | Requires download infra changes | Phase 4 |
| Per-language vocab/model selection for doctr | Needs pack catalog entries | Phase 4 |
| Word-level granularity in DoctrBackend | DoctrBackend only emits `line` spans (same as PpocrBackend v1) | Future |
| Any changes to `ImageBuffer` or `TextBuffer` APIs | Signature unchanged per contract | — |
| `recognize()` method signature changes | Must remain unchanged | — |
| Removing/deprecating ppocr support | Both families coexist | — |
| ORT provider selection per-family | Both use same `provider` string from `OcrLoadOptions` | — |
| New native module methods | `initializeOcr` / `detectOcrModel` / `ocrRecognize` are sufficient | — |
| Refactoring OcrLoadOptions into per-family substructs in C++ | Would break Phase 2 contract; doctr adapts shared fields | Future (if warranted) |

---

## 6  Acceptance Criteria Checklist

### Types & API Surface

- [ ] `OcrModelType` includes `'doctr'`; `OcrFamily` includes `'doctr'`
- [ ] `OcrDoctrOptions` type exported with `detBoxThresh`, `detBoxScoreThresh`, `detUnclipRatio`
- [ ] `OcrInitializeOptions` has `doctr?: OcrDoctrOptions`
- [ ] `OcrDoctrSuccessPaths` type exported (`det`, `rec`, `manifest` required; `cls` optional)
- [ ] `isOcrDoctrDetectSuccess()` exported and narrows correctly
- [ ] `OCR_MODEL_TYPES` runtime const and `isOcrModelType()` guard exported
- [ ] `OcrDetectModelResult.paths` includes optional `manifest` field

### Bridge

- [ ] `OcrInitBridgeOptions` includes `detBoxThresh?`, `detBoxScoreThresh?`, `detUnclipRatio?`
- [ ] `OcrDetectNativeResult.paths` includes `manifest?`
- [ ] `buildOcrInitBridgeOptions()` flattens `doctr` options correctly
- [ ] `detectOcrModel()` extracts and returns `manifest` path
- [ ] `detectOcrModel()` success validation is family-aware (ppocr: det+rec+rec_dict; doctr: det+rec+manifest)

### Native (C++)

- [ ] `OcrDetectResult` struct has `manifestPath` field
- [ ] `OcrDetect.cpp` bridge propagates `manifest` from native detect
- [ ] `ParseOcrModelTypeLocal` in `sherpa-onnx-validate-custom.cpp` recognizes `"doctr"`

### iOS

- [ ] Podspec has `ocr/doctr` include path
- [ ] `SherpaOnnx+OCR.mm` reads `detBoxThresh` / `detBoxScoreThresh` / `detUnclipRatio` from bridge options
- [ ] `SherpaOnnx+OCR.mm` propagates `manifestPath` in detect response

### Android

- [ ] JNI reads doctr bridge options and populates `OcrLoadOptions` threshold fields
- [ ] JNI propagates `manifestPath` in detect response

### Tests

- [ ] All existing ppocr tests pass (regression)
- [ ] `createOCR` with `modelType: 'doctr'` + `doctr: { ... }` test
- [ ] `detectOcrModel` returns doctr paths with `manifest` test
- [ ] `isOcrDoctrDetectSuccess` positive + negative tests
- [ ] `detectOcrModel` fails for doctr when manifest missing test
- [ ] `isOcrModelType` runtime guard test
- [ ] `jest --testPathPattern ocr` green

### Behavioral

- [ ] `createOCR({ modelType: 'auto' })` on a doctr pack auto-detects and loads DoctrBackend
- [ ] `createOCR({ modelType: 'doctr' })` directly loads DoctrBackend
- [ ] `createOCR({ modelType: 'ppocr' })` still loads PpocrBackend (regression)
- [ ] `recognize()` signature unchanged; ImageBuffer/TextBuffer contract unchanged

---

## 7  Suggested Implementation Order

1. **C++ bridge fixes** (2.8–2.10): `OcrDetectResult.manifestPath`, propagate in `OcrDetect.cpp`, fix `ParseOcrModelTypeLocal`
2. **iOS fixes** (2.6, 2.7, 2.11): podspec include path, `SherpaOnnx+OCR.mm` manifest + doctr options
3. **Android JNI** (2.12): doctr options + manifest propagation
4. **TS types** (2.1, 2.2): widen unions, add `OcrDoctrOptions`, `OcrDoctrSuccessPaths`, `isOcrDoctrDetectSuccess`
5. **TS bridge** (2.3, 2.4): widen `OcrInitBridgeOptions`/`OcrDetectNativeResult`, update `buildOcrInitBridgeOptions`
6. **TS public API** (2.5): manifest extraction, family-aware success, re-exports
7. **Jest tests** (Section 4): add all new test cases
8. **Smoke test**: build Android, run OCR with a doctr pack, verify `auto` + explicit `'doctr'`
