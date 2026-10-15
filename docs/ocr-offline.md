# Offline OCR (`ocr`)

## Introduction

**Offline OCR** runs on decoded image frames held in an [`OfflineImageBuffer`](imagebuffer-offline.md) and writes plain text plus optional [`TextSpatialSpan`](textbuffer-offline.md) metadata into an empty [`OfflineTextBuffer`](textbuffer-offline.md).

**Import path:** `react-native-sherpa-onnx/ocr`

v1 ships one family: **`ppocr`** (PP-OCR Det/Rec/optional Cls). The public API is multi-family-ready (`modelType: 'auto' | 'ppocr'`; more families later).

---

## Quick start

```ts
import {
  createOfflineImageBufferFromFiles,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferSpatialSpansSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';
import { createOCR } from 'react-native-sherpa-onnx/ocr';

const ocr = await createOCR({
  modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
  modelType: 'auto',
});

const image = await createOfflineImageBufferFromFiles([
  { kind: 'fs', path: '/tmp/page.png' },
]);
const textOut = await createEmptyOfflineTextBuffer();

try {
  await ocr.recognize(image, textOut, {
    granularity: 'line',
    onProgress: ({ done, total, phase }) => {
      console.log(phase, done, '/', total);
    },
  });
  const info = (await getPipelineTextBufferInfo(textOut)) as OfflineTextBufferInfo;
  const text = await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length);
  const spans = info.hasSpatialSpans
    ? await getOfflineTextBufferSpatialSpansSlice(textOut, 0, info.spatialSpanCount)
    : [];
  console.log(text, spans.length);
} finally {
  await releaseOfflineImageBuffer(image);
  await releasePipelineTextBuffer(textOut);
  await ocr.destroy();
}
```

---

## API

### `createOCR(options)`

```ts
type OcrModelType = 'auto' | 'ppocr';

createOCR({
  modelSource: FileSource,
  modelType?: OcrModelType, // default 'auto'
  provider?: string,        // default cpu
  numThreads?: number,
  ppocr?: { maxSideLen?: number; useOrientationCls?: boolean },
}): Promise<OcrEngine>
```

`modelType: 'auto'` runs family-aware pack detect (see [Detect](#detect)).

### `ocr.recognize(imageBuffer, textOut, options?)`

```ts
ocr.recognize(imageBuffer, textOut, {
  frames?: number[],                 // default: all frames
  granularity?: 'line' | 'word' | 'block', // v1 emits line
  onProgress?: (p: { done: number; total: number; phase: string }) => void,
  signal?: AbortSignal,
}): Promise<void>
```

- `textOut` must be an **empty** offline text buffer (populate-once).
- Spans use `origin: 'ocr'` and `sourceImageBufferId` set to the input image buffer id.
- **Granularity:** v1 PpocrBackend produces **line** spans. Requesting `word`/`block` filters to that level (typically empty spans; text is still filled).

### `ocr.destroy()`

Releases the native engine (idempotent).

### `detectOcrModel(source, options?)`

```ts
detectOcrModel(
  source: FileSource,
  options?: { modelType?: OcrModelType }
): Promise<OcrDetectModelResult>
```

Returns the shared detect contract (`ModelDetectResultBase`): `success`, `isStreaming: false`, `detectedModels`, optional `modelType` / `paths` / `detectionSources` / `quantization` / `sizeTier`.

On success for ppocr, use `isOcrPpocrDetectSuccess(result)` to narrow `paths` to required `{ det, rec, rec_dict }` (`cls` optional). No downloads.

---

## Detect

Detect lives under `jni/model_detect/ocr/` (same pattern as punctuation / alignment): recursive file listing → capability co-occurrence → `DetectionSource` trace. Public API accepts `FileSource` like `detectAlignmentModel`.

**ppocr (v1)** requires Det ONNX + Rec ONNX + recognition dictionary (`paths.rec_dict`). Prefer canonical names (`det.onnx`, `rec.onnx`, `rec_inference.yml`, optional `cls.onnx`), but fall back to filename tokens (`detection` / `dbnet`, `recognition` / `crnn` / `svtr`, `inference.yml` / `dict.txt` / `ppocr_keys*`, optional `cls` / `ori` / `orientation`).

`auto` only selects known families. Unknown layouts → detect `success: false`. A `doctr` capability hook is reserved for a future backend.

**No ORT online-guard** for OCR: packs are offline multi-file layouts. Guards in this repo exist where they discriminate streaming/online contracts (punctuation CNN-BiLSTM, enhancement, STT-online). OCR follows alignment: file co-occurrence is the signal. A weak “session opens” check would not discriminate meaningfully.

---

## Download

- **Category:** `ModelCategory.Ocr`
- **Release tag:** `ocr-models` on `XDcobra/react-native-sherpa-onnx` (default source `github_xdcobra`)
- **Assets:** `.tar.bz2` packs (`ppocrv6-tiny` / `small` / `medium`, …)
- Catalog refresh uses unified name-only detect (`ppocr` from asset basename heuristics)

```ts
import { ModelCategory, ensureModel } from 'react-native-sherpa-onnx/download';

const model = await ensureModel(ModelCategory.Ocr, 'ppocrv6-tiny');
```

Collect stream `ocr` in `collect-model-structures` refreshes `test/fixtures/ocr-models-structure.txt` + expected CSV for host detect tests.

---

## Progress / cancel

Same DX as offline ImageBuffer create:

- `onProgress` listens to `SherpaOnnxOcrProgress` filtered by an internal `operationId`
- `signal` aborts via `cancelOcrRecognize(operationId)` between frames

---

## How to add an OCR family

1. Implement `OcrBackend` (`Load` / `Recognize` / `Release` / `Family`) under `android/src/main/cpp/ocr/<family>/`.
2. Register in `OcrFactory::CreateOcrBackend`.
3. Add a detect capability rule in `jni/model_detect/ocr/` (co-occurrence / tokens; optional ORT guard only if it discriminates).
4. Publish pack layout docs + collect fixtures; extend `OcrModelType` and optional family options.
5. Do **not** change ImageBuffer, `TextSpatialSpan`, or `recognize(image → text)` signatures.

---

## Related

- [ImageBuffer offline](imagebuffer-offline.md)
- [TextBuffer spatial spans](textbuffer-offline.md)
- [Execution providers](execution-providers.md)
