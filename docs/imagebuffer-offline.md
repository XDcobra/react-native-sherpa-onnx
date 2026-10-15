# Pipeline image buffers — offline (`imagebuffer`)

## Introduction

**Immutable offline image clips** (decoded RGB8 on the native side): one or more frames per buffer. Used as input for **batch OCR** (and later PDF page ingestion).

**Import path:** `react-native-sherpa-onnx/imagebuffer`

Live / streaming ImageBuffer is **not** implemented yet (types may be reserved). For file resolution shared with other buffers, see [fileio.md](fileio.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **[Offline image buffer](imagebuffer-offline.md)** | Multi-frame RGB8, **immutable** after create. Small buffers stay on the heap (`storageKind: 'ram'`); larger ones upgrade to per-frame mmap temp files (`storageKind: 'mmap'`). | Batch OCR `recognize`, multi-page prep. |
| **Live image buffer** | Reserved (`liveImageBuffer` types only). | Future camera / streaming OCR. |

**Why this is fast:** apps orchestrate with **ids and small control calls**; decoded pixels stay on the native side. Native code owns decode, orientation, optional `maxSide` downscale, and RAM|mmap backing. OCR (later) reads frames via C++ `GetFrameRgbPtr` without shuttling full bitmaps through the JS bridge.

**Decode path**

| Format | Decoder |
| --- | --- |
| JPEG / PNG / BMP / GIF | C++ `stb_image` |
| WebP | C++ **libwebp** (prebuilt; Maven `com.xdcobra.sherpa:libwebp`, see `third_party/libwebp_prebuilt`) |
| HEIC / HEIF | Platform only (iOS ImageIO, Android `ImageDecoder` API 28+) |

EXIF orientation is applied for JPEG in C++. HEIC orientation comes from the platform decoder. Optional **`maxSide`** downscales the longest edge (default **4096**; `<= 0` disables).

---

## Main API (summary)

### Offline buffer

- `createEmptyOfflineImageBuffer`
- `createOfflineImageBufferFromFiles`
- `createOfflineImageBufferFromBase64`
- `getOfflineImageBufferInfo`
- `getOfflineImageBufferFrameInfo`
- `releaseOfflineImageBuffer`

Types: see [`src/imagebuffer/types.ts`](../src/imagebuffer/types.ts). Create helpers return **`OfflineImageBufferRef`** (`info` + `OfflineImageBufferHandle`). Buffer parameters use **`OfflineImageBufferIdSource`**: pass the ref, last **`OfflineImageBufferInfo`**, a branded handle, or a raw string id.

---

## Quick start

```ts
import {
  createOfflineImageBufferFromFiles,
  getOfflineImageBufferInfo,
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';

// 1) Decode one or more images once on the native side (optional maxSide).
const fromFiles = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.webp' },
  ],
  { maxSide: 2048 }
);

// Single FileSource also works:
const one = await createOfflineImageBufferFromFiles({
  kind: 'contentUri',
  uri: 'content://…',
});

// 2) Inspect metadata and a frame without copying pixels into JS.
const info = await getOfflineImageBufferInfo(fromFiles);
console.log(info.frameCount, info.storageKind, info.totalBytes);

const f0 = await getOfflineImageBufferFrameInfo(fromFiles, 0);
console.log(f0.width, f0.height, f0.byteSize);

// 3) Release when done.
await releaseOfflineImageBuffer(fromFiles);
await releaseOfflineImageBuffer(one);
```

The common pattern is: decode once, pass refs/ids to batch feature APIs (OCR later), then release buffers explicitly.

---

## API reference

All signatures below are exported from `react-native-sherpa-onnx/imagebuffer`. Unless noted, buffer arguments accept **`OfflineImageBufferIdSource`** (ref, info snapshot, handle, or string).

Ref-first usage is recommended: pass the buffer ref directly. Raw string ids are optional; malformed ids are rejected early with `ERR_IMAGE_INVALID_ARGUMENT`.

### Offline buffer creation

#### `createEmptyOfflineImageBuffer()`

```ts
function createEmptyOfflineImageBuffer(): Promise<OfflineImageBufferRef>;
```

```ts
const empty = await createEmptyOfflineImageBuffer();
console.log(empty.info.frameCount); // 0
console.log(empty.bufferId); // img_off_<uuid>
```

Creates an empty offline image buffer (`img_off_*`) that can later be populated by native producers (for example HEIC append / OCR paths). The buffer starts with `frameCount = 0` and remains immutable once create-from-files/base64 completes for a populated buffer.

#### `createOfflineImageBufferFromFiles(sources, options?)`

```ts
function createOfflineImageBufferFromFiles(
  sources: FileSource | FileSource[],
  options?: CreateOfflineImageBufferOptions
): Promise<OfflineImageBufferRef>;
```

```ts
const offline = await createOfflineImageBufferFromFiles(
  { kind: 'fs', path: '/tmp/page.jpg' },
  { maxSide: 2048 }
);
console.log(offline.info.frameCount, offline.info.storageKind);

// From a content URI (Android):
const fromUri = await createOfflineImageBufferFromFiles({
  kind: 'contentUri',
  uri: pickedUri,
});

// Multi-file with progress + cancellation:
const controller = new AbortController();
const pages = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.png' },
  ],
  {
    maxSide: 2048,
    onProgress: (event) => console.log(event.phase, event.done, '/', event.total),
    signal: controller.signal,
  }
);
console.log(pages.info.frameCount);
// Cancel later with: controller.abort();
```

`FileSource` resolution is shared with `react-native-sherpa-onnx/fileio`, so `fs`, `app`, `contentUri`, `securityScoped`, and `pad` sources follow the same native resolver rules. See [fileio.md](fileio.md).

Options (`CreateOfflineImageBufferOptions`):

- `maxSide`: longest-edge cap after decode; default `4096`; `<= 0` disables
- `onProgress`: receives `ImageProgressEvent` (`done`, `total`, `phase`) during create
- `signal`: aborts create and rejects with `ERR_IMAGE_CANCELLED`

#### `createOfflineImageBufferFromBase64(base64List, options?)`

```ts
function createOfflineImageBufferFromBase64(
  base64List: string[],
  options?: CreateOfflineImageBufferOptions
): Promise<OfflineImageBufferRef>;
```

```ts
const offline = await createOfflineImageBufferFromBase64([jpegBase64, webpBase64], {
  maxSide: 1024,
});
```

Decodes one or more image blobs (base64 strings) into a multi-frame offline buffer. Uses the **heap-origin** mmap threshold (same idea as audio samples import vs file decode).

### Inspect / release

#### `getOfflineImageBufferInfo(buffer)`

```ts
function getOfflineImageBufferInfo(
  buffer: OfflineImageBufferIdSource
): Promise<OfflineImageBufferInfo>;
```

```ts
const info = await getOfflineImageBufferInfo(offline);
console.log(info.kind, info.state, info.frameCount, info.storageKind);
```

`OfflineImageBufferInfo` always includes `storageKind: 'ram' | 'mmap'`:

- `'ram'` — frames held in process memory
- `'mmap'` — one or more frames upgraded to per-frame temp files under the cache (`img_off_<uuid>_f<N>.rgb8`)

#### `getOfflineImageBufferFrameInfo(buffer, frameIndex)`

```ts
function getOfflineImageBufferFrameInfo(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number
): Promise<OfflineImageFrameInfo>;
```

```ts
const frame = await getOfflineImageBufferFrameInfo(offline, 0);
console.log(frame.width, frame.height, frame.byteSize, frame.storageKind);
```

Returns metadata for a single frame (no pixel copy into JS). Engine/OCR access uses native `GetFrameRgbPtr` later.

#### `releaseOfflineImageBuffer(buffer)`

```ts
function releaseOfflineImageBuffer(
  buffer: OfflineImageBufferIdSource
): Promise<void>;
```

```ts
await releaseOfflineImageBuffer(offline);
```

Unmaps and unlinks any frame temp files, then removes the buffer from the registry.

---

## JS Events

Create-time callbacks on `createOfflineImageBufferFromFiles` / `createOfflineImageBufferFromBase64` (not `createEmptyOfflineImageBuffer`).

| Callback / control | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onProgress` | `ImageProgressEvent` | per source during create | `{ done, total, phase }` (`decode` / `done`) |
| `signal` | `AbortSignal` | caller aborts | rejects with `ERR_IMAGE_CANCELLED` |

```ts
const controller = new AbortController();
const pages = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.png' },
  ],
  {
    maxSide: 2048,
    onProgress: (e) => console.log(e.phase, e.done, '/', e.total),
    signal: controller.signal,
  }
);
// controller.abort();
```

## Types and constants

```ts
import type {
  OfflineImageBufferRef, // created offline buffer ref { info, bufferId }
  OfflineImageBufferInfo, // metadata for immutable offline RGB buffer
  OfflineImageBufferIdSource, // ref/handle/info/id accepted by offline APIs
  OfflineImageBufferHandle, // branded img_off_* id
  OfflineImageFrameInfo, // per-frame width/height/byteSize/storageKind
  CreateOfflineImageBufferOptions, // maxSide + onProgress + signal
  ImageProgressEvent, // { done, total, phase }
  ImageStorageKind, // 'ram' | 'mmap'
  LiveImageBufferInfo, // reserved live type
  FileSource, // re-exported from fileio
} from 'react-native-sherpa-onnx/imagebuffer';

import {
  ImageErrorCode, // runtime constants for error-code checks
} from 'react-native-sherpa-onnx/imagebuffer';
```

---

## Error codes

| Code | Meaning |
| --- | --- |
| `ERR_IMAGE_INVALID_ARGUMENT` | Invalid buffer id, empty sources, or bad argument |
| `ERR_IMAGE_DECODE_FAILED` | Decode / I/O failure while reading an image |
| `ERR_IMAGE_FORMAT_UNSUPPORTED` | HEIC without platform support, or WebP with libwebp disabled |
| `ERR_IMAGE_BUFFER_NOT_FOUND` | Referenced image buffer id or frame does not exist |
| `ERR_IMAGE_CANCELLED` | Create cancelled via `AbortSignal` |
| `ERR_IMAGE_INTERNAL` | Generic native image buffer failure |

Optional disable of libwebp: `sherpaOnnxDisableLibwebp=true` (Gradle) / `SHERPA_ONNX_DISABLE_LIBWEBP=1` (iOS). WebP then fails with `ERR_IMAGE_FORMAT_UNSUPPORTED`.

---

## See also

- [File I/O (`FileSource`)](fileio.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline text buffers — offline](textbuffer-offline.md)
- Prebuilt resolution (libwebp): [`docs/internal/PREBUILT_RESOLUTION.md`](internal/PREBUILT_RESOLUTION.md)
- Storage internals: [`docs/internal/imagebuffer-storage.md`](internal/imagebuffer-storage.md)
- Future perf ideas: [`docs/future-work/imagebuffer-perf-future-work.md`](future-work/imagebuffer-perf-future-work.md)

## Use case examples

<details>
<summary>Decode multi-page images once and reuse for batch OCR</summary>

```ts
const pages = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.jpg' },
  ],
  { maxSide: 2048 }
);

// Reuse `pages` for multiple offline OCR passes once createOCR lands.
// Release once all consumers are finished.
await releaseOfflineImageBuffer(pages);
```

</details>

<details>
<summary>Cancel a long multi-file decode</summary>

```ts
const controller = new AbortController();

const createPromise = createOfflineImageBufferFromFiles(manySources, {
  maxSide: 2048,
  onProgress: (e) => console.log(e.done, '/', e.total, e.phase),
  signal: controller.signal,
});

// Later (e.g. user cancel):
controller.abort();

try {
  await createPromise;
} catch (err) {
  // ERR_IMAGE_CANCELLED
}
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
