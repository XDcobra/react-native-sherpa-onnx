# Pipeline image buffers — offline (`imagebuffer`)

## Introduction

Offline image buffers hold one or more image frames for batch OCR and PDF page rasters ([`rasterizePdfPages`](pdf-offline.md)).

**Import path:** `react-native-sherpa-onnx/imagebuffer`

Live / streaming ImageBuffer is not implemented yet (types may be reserved). File sources use [fileio.md](fileio.md).

---

## Concepts

| Kind | What it is | Typical use |
| --- | --- | --- |
| **Offline image buffer** | Multi-frame buffer after create. Usually `state: 'immutable'` (all frames ready). PDF [`lazy-lru`](pdf-offline.md#raster-strategies) uses `state: 'lazy'`: call [`ensureOfflineImageBufferFrame`](#ensureofflineimagebufferframebuffer-frameindex) (or FrameView / OCR) before using a cold frame; at most `hotFrames` stay decoded. | Batch OCR `recognize`, multi-page prep / PDF slider. |
| **Live image buffer** | Reserved (`liveImageBuffer` types only). | Future camera / streaming OCR. |

**Supported formats**

| Format | Notes |
| --- | --- |
| JPEG / PNG / BMP / GIF | Via `createOfflineImageBufferFromFiles` / `FromBase64`. EXIF orientation applied for JPEG. |
| WebP | Same create APIs (libwebp; default SDK prebuilt). |
| HEIC / HEIF | Same create APIs. **Android: API 28+**; older devices → `ERR_IMAGE_FORMAT_UNSUPPORTED`. iOS: ImageIO. |
| PDF (page raster) | Not via image create APIs — use [`rasterizePdfPages`](pdf-offline.md). Frames may include `pageNumber` / `dpi`. |

Optional **`maxSide`** caps the longest edge after image decode (default **4096**; `<= 0` disables). PDF raster has its own `maxSide` / `dpi` — see [pdf-offline.md](pdf-offline.md).

---

## Main API (summary)

- `createEmptyOfflineImageBuffer`
- `createOfflineImageBufferFromFiles`
- `createOfflineImageBufferFromBase64`
- `getOfflineImageBufferInfo`
- `getOfflineImageBufferFrameInfo`
- `ensureOfflineImageBufferFrame` — ensure a frame is ready (`lazy` PDF buffers; no-op for `immutable`)
- `releaseOfflineImageBuffer`
- `exportOfflineImageBufferFrame` — write one frame to a [`FileDestination`](fileio.md) → `ResolvedFileRef`
- `OfflineImageBufferFrameView` — in-app preview of one frame

Create helpers return **`OfflineImageBufferRef`** (`info` + `OfflineImageBufferHandle`). Buffer parameters accept **`OfflineImageBufferIdSource`**: ref, `OfflineImageBufferInfo`, branded handle, or string id.

---

## Quick start

```tsx
import {
  createOfflineImageBufferFromFiles,
  getOfflineImageBufferInfo,
  getOfflineImageBufferFrameInfo,
  OfflineImageBufferFrameView,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';

const fromFiles = await createOfflineImageBufferFromFiles(
  [
    { kind: 'fs', path: '/tmp/page1.jpg' },
    { kind: 'fs', path: '/tmp/page2.webp' },
  ],
  { maxSide: 2048 }
);

const one = await createOfflineImageBufferFromFiles({
  kind: 'contentUri',
  uri: 'content://…',
});

const info = await getOfflineImageBufferInfo(fromFiles);
console.log(info.frameCount, info.storageKind, info.totalBytes);

const f0 = await getOfflineImageBufferFrameInfo(fromFiles, 0);
console.log(f0.width, f0.height, f0.byteSize);

// In-app preview (native RGB; no file materialize)
<OfflineImageBufferFrameView
  buffer={fromFiles}
  frameIndex={0}
  resizeMode="contain"
  maxSide={1024}
  style={{ width: '100%', height: 240 }}
/>

await releaseOfflineImageBuffer(fromFiles);
await releaseOfflineImageBuffer(one);
```

Typical flow: create once → preview and/or pass to [offline OCR](ocr-offline.md) → `releaseOfflineImageBuffer`.

---

## API reference

Exported from `react-native-sherpa-onnx/imagebuffer`. Buffer arguments accept **`OfflineImageBufferIdSource`** unless noted. Prefer the buffer ref; malformed string ids reject with `ERR_IMAGE_INVALID_ARGUMENT`.

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

Empty buffer (`frameCount = 0`) for native producers that append frames later.

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

const fromUri = await createOfflineImageBufferFromFiles({
  kind: 'contentUri',
  uri: pickedUri,
});

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
```

`FileSource` kinds (`fs`, `app`, `contentUri`, `securityScoped`, `pad`) follow [fileio.md](fileio.md).

Options (`CreateOfflineImageBufferOptions`):

| Option | Notes |
|--------|--------|
| `maxSide` | Longest-edge cap after decode; default `4096`; `<= 0` disables |
| `onProgress` | `ImageProgressEvent` (`done`, `total`, `phase`) during create |
| `signal` | Abort → `ERR_IMAGE_CANCELLED` |

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

Same options as create-from-files.

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

| Field | Values | Notes |
|-------|--------|--------|
| `bufferId` | `img_off_…` | Buffer id |
| `kind` | `'offlineImageBuffer'` | Discriminator |
| `state` | `'immutable'` \| `'lazy'` | `'lazy'` from PDF [`rasterizePdfPages({ strategy: 'lazy-lru' })`](pdf-offline.md) |
| `frameCount` | number | Number of frames (lazy includes not-yet-ensured frames) |
| `totalBytes` | number | Approximate decoded size; for `'lazy'`, currently ensured frames only |
| `storageKind` | `'ram'` \| `'mmap'` | How decoded frames are held |

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
// PDF rasters may also set frame.pageNumber, frame.dpi
```

Per-frame metadata. For `'lazy'` buffers, `width` / `height` may be `0` until [`ensureOfflineImageBufferFrame`](#ensureofflineimagebufferframebuffer-frameindex) (or FrameView / OCR) has run for that index.

#### `ensureOfflineImageBufferFrame(buffer, frameIndex)`

```ts
function ensureOfflineImageBufferFrame(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number
): Promise<OfflineImageFrameInfo>;
```

```ts
const frame = await ensureOfflineImageBufferFrame(offline, 0);
console.log(frame.width, frame.height);
```

Makes frame `frameIndex` ready and returns its info. For `'immutable'` buffers this is a no-op (returns current info). For PDF `'lazy'` buffers, ensures that page is decoded (may drop older decoded pages when over `hotFrames`). Optional before `recognize` if you want explicit control; FrameView and OCR also ensure on access.

#### `releaseOfflineImageBuffer(buffer)`

```ts
function releaseOfflineImageBuffer(
  buffer: OfflineImageBufferIdSource
): Promise<void>;
```

```ts
await releaseOfflineImageBuffer(offline);
```

Releases the buffer. Call when finished.

#### `exportOfflineImageBufferFrame(buffer, frameIndex, output, options?)`

Writes one frame to a [`FileDestination`](fileio.md) (same model as [`saveAudioAsFile`](audio-conversion.md)).

```ts
function exportOfflineImageBufferFrame(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number,
  output: FileDestination,
  options?: {
    format?: 'jpeg' | 'png' | 'webp'; // default jpeg
    quality?: number; // 1..100, jpeg/webp
    maxSide?: number; // export-only downsample; does not change the buffer
  }
): Promise<ResolvedFileRef>;
```

```ts
const ref = await exportOfflineImageBufferFrame(
  offline,
  0,
  { kind: 'app', base: 'cache', path: 'page0.jpg' },
  { format: 'jpeg', quality: 90, maxSide: 1280 }
);
// ref: { kind: 'fs', path: '...' } or { kind: 'contentUri', uri: '...' }
```

#### `OfflineImageBufferFrameView`

React Native view that shows one buffer frame.

```tsx
import { OfflineImageBufferFrameView } from 'react-native-sherpa-onnx/imagebuffer';

<OfflineImageBufferFrameView
  buffer={offline}
  frameIndex={0}
  resizeMode="contain"
  maxSide={1024}
  style={{ width: '100%', height: 240 }}
/>
```

| Prop | Notes |
|------|--------|
| `buffer` | `OfflineImageBufferIdSource` |
| `frameIndex` | Frame to show (default `0`) |
| `resizeMode` | `'contain'` \| `'cover'` \| `'stretch'` |
| `maxSide` | Optional preview downscale |
| `style` | View style |

For `'lazy'` PDF buffers, changing `buffer` / `frameIndex` ensures that frame before display.

---

## JS Events

Create-time only (`createOfflineImageBufferFromFiles` / `FromBase64`):

| Callback / control | Payload | Notes |
| --- | --- | --- |
| `onProgress` | `ImageProgressEvent` | `{ done, total, phase }` (`decode` / `done`) |
| `signal` | `AbortSignal` | Rejects with `ERR_IMAGE_CANCELLED` |

```ts
const controller = new AbortController();
const pages = await createOfflineImageBufferFromFiles(manySources, {
  maxSide: 2048,
  onProgress: (e) => console.log(e.phase, e.done, '/', e.total),
  signal: controller.signal,
});
// controller.abort();
```

## Types and constants

```ts
import type {
  OfflineImageBufferRef,
  OfflineImageBufferInfo,
  OfflineImageBufferState, // 'immutable' | 'lazy'
  OfflineImageBufferIdSource,
  OfflineImageBufferHandle,
  OfflineImageFrameInfo,
  CreateOfflineImageBufferOptions,
  ImageProgressEvent,
  ImageStorageKind, // 'ram' | 'mmap'
  LiveImageBufferInfo, // reserved
  FileSource,
  FileDestination,
  ResolvedFileRef,
} from 'react-native-sherpa-onnx/imagebuffer';

import { ImageErrorCode } from 'react-native-sherpa-onnx/imagebuffer';
```

---

## Error codes

| Code | Meaning |
| --- | --- |
| `ERR_IMAGE_INVALID_ARGUMENT` | Invalid buffer id, empty sources, or bad argument |
| `ERR_IMAGE_DECODE_FAILED` | Decode / I/O failure while reading an image |
| `ERR_IMAGE_FORMAT_UNSUPPORTED` | HEIC without platform support, or WebP disabled |
| `ERR_IMAGE_BUFFER_NOT_FOUND` | Unknown buffer id or frame |
| `ERR_IMAGE_CANCELLED` | Create cancelled via `AbortSignal` |
| `ERR_IMAGE_INTERNAL` | Generic failure |

Optional: disable WebP with `sherpaOnnxDisableLibwebp=true` (Gradle) / `SHERPA_ONNX_DISABLE_LIBWEBP=1` (iOS) → `ERR_IMAGE_FORMAT_UNSUPPORTED` for WebP.

---

## See also

- [Offline OCR](ocr-offline.md)
- [Offline PDF](pdf-offline.md)
- [File I/O (`FileSource` / `FileDestination`)](fileio.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline text buffers — offline](textbuffer-offline.md)

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

// Reuse `pages` for offline OCR (createOCR / recognize), then:
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

controller.abort();

try {
  await createPromise;
} catch (err) {
  // ERR_IMAGE_CANCELLED
}
```

</details>

<details>
<summary>Large PDF page slider (lazy-lru)</summary>

Use PDF [`strategy: 'lazy-lru'`](pdf-offline.md#raster-strategies) so only a few pages stay decoded while the user pages through a document. Full example: [pdf-offline.md — page slider](pdf-offline.md#use-case-examples).

```tsx
const pages = await rasterizePdfPages(pdfSource, {
  strategy: 'lazy-lru',
  hotFrames: 4,
});

<OfflineImageBufferFrameView
  buffer={pages}
  frameIndex={currentPage}
  resizeMode="contain"
/>
```

</details>
