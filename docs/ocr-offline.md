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

`modelType: 'auto'` runs a lightweight pack-layout detect (`det.onnx` + `rec.onnx` + `rec_inference.yml` → `ppocr`). Full download/catalog integration comes later.

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

### `detectOcrModel(modelDir)`

Returns `{ ok, modelType, family, files: { det, rec, cls, recInferenceYml }, … }` for a local directory. No downloads.

---

## Progress / cancel

Same DX as offline ImageBuffer create:

- `onProgress` listens to `SherpaOnnxOcrProgress` filtered by an internal `operationId`
- `signal` aborts via `cancelOcrRecognize(operationId)` between frames

---

## How to add an OCR family

1. Implement `OcrBackend` (`Load` / `Recognize` / `Release` / `Family`) under `android/src/main/cpp/ocr/<family>/`.
2. Register in `OcrFactory::CreateOcrBackend`.
3. Extend layout detect in `OcrDetect` (and later Download `ModelCategory.Ocr`).
4. Add `modelType` to the TS `OcrModelType` union and optional family options map.
5. Do **not** change ImageBuffer, `TextSpatialSpan`, or `recognize(image → text)` signatures.

---

## See also

- [Offline ImageBuffer](imagebuffer-offline.md)
- [Offline TextBuffer](textbuffer-offline.md) (spatial spans)
- [Execution providers](execution-providers.md)
