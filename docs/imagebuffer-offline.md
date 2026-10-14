# Pipeline image buffers — offline (`imagebuffer`)

## Introduction

**Immutable offline image clips** (decoded RGB8 on the native side): one or more frames per buffer. Used as input for **batch OCR** (and later PDF page ingestion).

**Import path:** `react-native-sherpa-onnx/imagebuffer`

Storage follows the same RAM-vs-mmap model as [OfflineAudioBuffer](audiobuffer-offline.md): small buffers stay on the heap (`storageKind: 'ram'`); larger ones upgrade to per-frame mmap temp files (`storageKind: 'mmap'`).

Live / streaming ImageBuffer is **not** implemented yet (types may be reserved).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **Offline ImageBuffer** | Multi-frame RGB8, immutable after create | OCR `recognize`, multi-page prep |
| **Live ImageBuffer** | Reserved | Future camera / streaming OCR |

**Decode path**

| Format | Decoder |
| --- | --- |
| JPEG / PNG / BMP / GIF | C++ `stb_image` |
| WebP | C++ **libwebp** (prebuilt; see `third_party/libwebp_prebuilt`) |
| HEIC / HEIF | Platform only (iOS ImageIO, Android `ImageDecoder` API 28+) |

EXIF orientation is applied for JPEG in C++. HEIC orientation comes from the platform decoder. Optional **`maxSide`** downscales the longest edge (default **4096**).

---

## Main API

```ts
import {
  createEmptyOfflineImageBuffer,
  createOfflineImageBufferFromFiles,
  createOfflineImageBufferFromBase64,
  getOfflineImageBufferInfo,
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
  cancelOfflineImageBufferCreate,
  addImageProgressListener,
} from 'react-native-sherpa-onnx/imagebuffer';
```

### Create

- `createEmptyOfflineImageBuffer()` — empty `img_off_*` buffer (append via native HEIC/OCR paths later).
- `createOfflineImageBufferFromFiles(sources, { maxSide?, operationId? })` — one `FileSource` or an array; same kinds as audio (`fs` / `app` / `contentUri` / `securityScoped` / `pad`). See [fileio.md](fileio.md).
- `createOfflineImageBufferFromBase64(base64List, { maxSide?, operationId? })` — heap-origin threshold.

### Inspect / release

- `getOfflineImageBufferInfo(buffer)`
- `getOfflineImageBufferFrameInfo(buffer, frameIndex)`
- `releaseOfflineImageBuffer(buffer)`

### Progress / cancel

- Pass `operationId` in create options.
- `addImageProgressListener` → events `SherpaOnnxImageProgress` `{ operationId, done, total, phase }`.
- `cancelOfflineImageBufferCreate(operationId)` — releases a partially filled buffer.

---

## Quick start

```ts
import {
  createOfflineImageBufferFromFiles,
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';

const buf = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.webp' },
  ],
  { maxSide: 2048, operationId: 'ocr-pages-1' }
);

// Single FileSource also works:
const one = await createOfflineImageBufferFromFiles({
  kind: 'contentUri',
  uri: 'content://…',
});

console.log(buf.info.frameCount, buf.info.storageKind);
const f0 = await getOfflineImageBufferFrameInfo(buf, 0);
console.log(f0.width, f0.height);

await releaseOfflineImageBuffer(buf);
```

---

## Storage

| Concern | Behavior |
| --- | --- |
| Threshold | Shared C++ policy (`ImageMmapThreshold`): Android file/heap bases 6/10 MB; iOS 8/12 MB; same RAM-class multipliers and 4–32 MB clamp as audio |
| Backing | Per-frame temp file `img_off_<uuid>_f<N>.rgb8` (raw RGB8, no header) |
| `storageKind` | Always set on info: `'ram'` \| `'mmap'` |
| Release | Unmap + unlink all frame files |
| Orphan sweep | Startup: prefix `img_off_`, suffix `.rgb8`, max age 1 h (same idea as audio `.f32`) |
| Engine access | C++ `ImageRegistry::GetFrameRgbPtr(bufferId, frameIndex)` for OCR |

Optional disable of libwebp: `sherpaOnnxDisableLibwebp=true` (Gradle) / `SHERPA_ONNX_DISABLE_LIBWEBP=1` (iOS). WebP then fails with `ERR_IMAGE_FORMAT_UNSUPPORTED`.

---

## Errors

| Code | Meaning |
| --- | --- |
| `ERR_IMAGE_INVALID_ARGUMENT` | Bad paths / ids |
| `ERR_IMAGE_DECODE_FAILED` | Decode / I/O failure |
| `ERR_IMAGE_FORMAT_UNSUPPORTED` | HEIC without platform support, or WebP with libwebp disabled |
| `ERR_IMAGE_BUFFER_NOT_FOUND` | Unknown id / frame |
| `ERR_IMAGE_CANCELLED` | Cancelled mid-create |

---

## Internal notes

- C++ source of truth: `android/src/main/cpp/image/` (shared with iOS).
- Prebuilts: [`docs/internal/PREBUILT_RESOLUTION.md`](internal/PREBUILT_RESOLUTION.md) (libwebp row).
- Future perf ideas (compressed retain, lazy decode, LRU): [`docs/future-work/imagebuffer-perf-future-work.md`](future-work/imagebuffer-perf-future-work.md).
