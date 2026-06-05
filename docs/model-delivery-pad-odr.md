# Ship Model Delivery (PAD & ODR)

Fetch and resolve on-disk paths for models shipped via **Android Play Asset Delivery (PAD)** or **iOS On-Demand Resources (ODR)**.

| Platform | Identifier | Native layout |
| --- | --- | --- |
| **Android** | `packName` (Gradle `assetPack.packName`) | `…/models/` on disk when `STORAGE_FILES`; install-time may use APK assets at `assets/models/` |
| **iOS** | ODR tag (Xcode tag on the ship folder) | `{tag}/models/` via `pathForResource(tag)` after `ensureAssetPackReady` |

**Imports:** delivery — `react-native-sherpa-onnx/utils`; archives — `react-native-sherpa-onnx/extraction` ([extraction.md](./extraction.md)).

PAD/ODR APIs return a **path only** (no archive listing). Listing `.tar.zst` / `.tar.bz2` and `extractArchive` live in the extraction subpath.

---

## Table of Contents

- [Layout](#layout)
- [Quick start — on-demand PAD / ODR](#quick-start--on-demand-pad--odr)
- [Quick start — install-time PAD (Android)](#quick-start--install-time-pad-android)
- [Quick start — iOS main bundle](#quick-start--ios-main-bundle)
- [Example trees and APIs](#example-trees-and-apis)
- [Delivery modes](#delivery-modes)
- [API reference](#api-reference)
  - [`getAssetPackPath`](#getassetpackpathpackname)
  - [`fetchAssetPack`](#fetchassetpackpackname)
  - [`ensureAssetPackReady`](#ensureassetpackreadypackname-options)
  - [`getAssetPackState`](#getassetpackstatepackname)
  - [`removeAssetPack`](#removeassetpackpackname)
  - [`assetPackDownloadPercent`](#assetpackdownloadpercentstate)
  - [`listOdrDeliverySnapshot`](#listodrdeliverysnapshottag)
  - [`logOdrDeliveryDiagnostics`](#logodrdeliverydiagnosticstag)
  - [Types](#types)
- [Delivery status](#delivery-status)
- [Workflows](#workflows)
- [Native setup](#native-setup)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Quick start — on-demand PAD / ODR

```typescript
import {
  ensureAssetPackReady,
  getAssetPackPath,
  removeAssetPack,
} from 'react-native-sherpa-onnx/utils';
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { Platform } from 'react-native';

const PACK = 'sherpa_models'; // Gradle packName or Xcode ODR tag
const targetDir = `${DocumentDirectoryPath}/models`;

await ensureAssetPackReady(PACK, {
  onProgress: (_state, percent) => console.log('download', percent),
});

const packPath = await getAssetPackPath(PACK);
if (!packPath) throw new Error(`${PACK} not available after fetch`);

const archives = await listBundledArchives(packPath);
for (const archive of archives) {
  await extractArchive(archive, targetDir);
}

if (Platform.OS === 'android') {
  await removeAssetPack(PACK); // optional after extract
}

// detectSttModel({ kind: 'fs', path: `${targetDir}/<modelId>` })
```

**Uncompressed folders** (no `extractArchive`):

```typescript
import {
  ensureAssetPackReady,
  getAssetPackPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';

const PACK = 'sherpa_models';
await ensureAssetPackReady(PACK);
const packPath = await getAssetPackPath(PACK);
if (!packPath) throw new Error(`${PACK} not ready`);

const folders = await listModelsAtPath(packPath, false);
// Use packPath/folder or copy to your sandbox — app-defined
```

---

## Quick start — install-time PAD (Android)

Usually no `ensureAssetPackReady` on first launch.

```typescript
import {
  listBundledArchives,
  listBundledArchivesFromApkAssets,
  extractArchive,
} from 'react-native-sherpa-onnx/extraction';
import { getAssetPackPath, listModelsAtPath } from 'react-native-sherpa-onnx/utils';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

const PACK = 'sherpa_models';
const targetDir = `${DocumentDirectoryPath}/models`;

const packPath = await getAssetPackPath(PACK);
const archives = packPath
  ? await listBundledArchives(packPath)
  : await listBundledArchivesFromApkAssets('models');

for (const archive of archives) {
  await extractArchive(archive, targetDir);
}

if (packPath) {
  await listModelsAtPath(packPath, false); // if you ship folders
}
```

---

## Quick start — iOS main bundle

Not PAD/ODR — models in **Copy Bundle Resources**:

```typescript
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { bundledModelFileSource, listAssetModels } from 'react-native-sherpa-onnx/utils';
import { MainBundlePath, DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

await listAssetModels();
const archives = await listBundledArchives(`${MainBundlePath}/models`);
for (const archive of archives) {
  await extractArchive(archive, `${DocumentDirectoryPath}/models`);
}

bundledModelFileSource('models/my-model-id');
```

ODR-tagged ship: use the [on-demand quick start](#quick-start--on-demand-pad--odr) (`packName` = tag name).

---

## Layout

Ship under **`models/`** inside the pack module (Android) or tagged folder (iOS):

- **Archives** — `.tar.zst` / `.tar.bz2` in `models/` (list via [extraction.md](./extraction.md))
- **Folders** — `models/<modelId>/…` (list via `listModelsAtPath`)

`getAssetPackPath(packName)` returns the absolute `…/models` directory when the pack/tag is ready, **without checking contents**. Listing, extract, and engine init are app responsibility ([model-setup.md](./model-setup.md)).

### Example trees and APIs

Use the same identifier (`packName` / tag) in every delivery call. Replace `sherpa_models` and model IDs with your app’s names.

**Extraction is optional:** only needed when you ship **archives** (`.tar.zst` / `.tar.bz2`). If you ship **uncompressed folders** under `models/<modelId>/`, skip `listBundledArchives` / `extractArchive` and use `listModelsAtPath(packPath)` (or copy from the pack path) instead.

#### Android PAD — on-demand (`STORAGE_FILES`)

Gradle / disk layout:

```text
sherpa_models/                          ← assetPack.packName (= packName argument)
└── src/main/assets/models/             ← ship root; getAssetPackPath → …/models
    ├── whisper-tiny.tar.zst
    ├── my-tts.tar.zst
    └── optional-uncompressed/          ← optional folder ship
        └── model.onnx
```

| Step | Function | Parameter | Returns / notes |
| --- | --- | --- | --- |
| 1 | `ensureAssetPackReady` | `packName: 'sherpa_models'` | Resolves when Play status is `completed` |
| 2 | `getAssetPackPath` | `packName: 'sherpa_models'` | e.g. `/data/…/files/…/models` or `null` |
| 3 *(optional)* | `listBundledArchives` | `dir: packPath` | Only for archive ship; `[{ modelId, archivePath, fileSize }, …]` |
| 4 *(optional)* | `extractArchive` | `archive`, `targetDir` | Only for archives; extract to app sandbox (e.g. `Documents/models/`) |
| 5 *(optional)* | `removeAssetPack` | `packName: 'sherpa_models'` | Frees pack after extract (Android) |

#### Android PAD — install-time (`APK_ASSETS`)

```text
app/src/main/assets/models/             ← APK assets prefix for listBundledArchivesFromApkAssets
├── whisper-tiny.tar.zst
└── my-tts.tar.zst
```

| Step | Function | Parameter | Returns / notes |
| --- | --- | --- | --- |
| 1 | `getAssetPackPath` | `packName: 'sherpa_models'` | Usually `null` (not `STORAGE_FILES`) |
| 2 *(optional)* | `listBundledArchivesFromApkAssets` | `assetPrefix: 'models'` | Only for archive ship in APK `assets/models/` |
| 3 *(optional)* | `extractArchive` | `archive`, `targetDir` | Only for archives; same as on-demand |

#### iOS ODR

Xcode: tag the **folder** `sherpa_models` (On Demand Resource). Ship content inside it:

```text
sherpa_models/                          ← ODR tag (= packName / tag argument)
└── models/                             ← ship root; getAssetPackPath → …/models
    ├── whisper-tiny.tar.zst
    ├── my-tts.tar.zst
    └── optional-uncompressed/
        └── model.onnx
```

After `ensureAssetPackReady`, native code resolves  
`pathForResource('sherpa_models') + '/models'` (may point at an on-demand asset pack, not inside `.app`).

| Step | Function | Parameter | Returns / notes |
| --- | --- | --- | --- |
| 1 | `ensureAssetPackReady` | `packName: 'sherpa_models'` | Waits for `beginAccessingResources` |
| 2 | `getAssetPackPath` | `packName: 'sherpa_models'` | Absolute `…/sherpa_models/models` or `null` without access |
| 3 *(optional)* | `listBundledArchives` | `dir: packPath` | Only for archive ship; same as Android |
| 4 *(optional)* | `extractArchive` | `archive`, `targetDir` | Only for archives; runtime then uses extracted `fs` paths |
| 5 *(optional)* | `removeAssetPack` | `packName: 'sherpa_models'` | Ends ODR access (does not delete extracted files) |

#### After extract *(optional — archive ship only; both platforms)*

```text
Documents/models/                       ← app-defined sandbox (not PAD/ODR)
├── whisper-tiny/
│   └── …
└── my-tts/
    └── …
```

| Step | Function | Parameter |
| --- | --- | --- |
| List | `listModelsAtPath` | `dir: targetDir`, `recursive` |
| Init | `detectSttModel` / engines | `{ kind: 'fs', path: \`${targetDir}/<modelId>\` }` |

---

## Delivery modes

### Android PAD

| `deliveryType` | Fetch needed? | `getAssetPackPath` |
| --- | --- | --- |
| `install-time` | Usually no | Often `null` (APK_ASSETS) → `listBundledArchivesFromApkAssets('models')` |
| `fast-follow` | Sometimes on cold start | Path when `STORAGE_FILES` |
| `on-demand` | Yes (`ensureAssetPackReady`) | Path when `STORAGE_FILES` |

### iOS

| Source | APIs |
| --- | --- |
| Main bundle `models/` | `bundledModelFileSource`, `listAssetModels`, `listBundledArchives` on bundle path |
| ODR tag | `fetchAssetPack` / `ensureAssetPackReady`, `getAssetPackPath(tag)`, then extraction or `listModelsAtPath` |

`getAssetPackPath(tag)` returns the absolute `{tag}/models` directory (via bundle `pathForResource`) while ODR access is held; `null` without `ensureAssetPackReady` first.

**Debug (`__DEV__`):** `listOdrDeliverySnapshot(tag)`, `logOdrDeliveryDiagnostics(tag)`.

---

## API reference

Import from `react-native-sherpa-onnx/utils`:

```typescript
import {
  getAssetPackPath,
  getPlayAssetDeliveryModelsPath, // alias
  fetchAssetPack,
  ensureAssetPackReady,
  getAssetPackState,
  removeAssetPack,
  assetPackDownloadPercent,
  listOdrDeliverySnapshot,
  logOdrDeliveryDiagnostics,
} from 'react-native-sherpa-onnx/utils';
```

Android and iOS only. Web/other platforms: `fetchAssetPack` / `getAssetPackPath` no-op; `ensureAssetPackReady` throws.

### `getAssetPackPath(packName)`

```ts
function getAssetPackPath(packName: string): Promise<string | null>
```

Returns the absolute ship `models/` directory when the pack/tag is ready. Does not list or validate archive contents. Call `ensureAssetPackReady` first for on-demand PAD / ODR.

```ts
await ensureAssetPackReady('sherpa_models');
const dir = await getAssetPackPath('sherpa_models');
if (!dir) throw new Error('pack not ready');
// dir → …/models (archives or folders)
```

| Platform | Result |
| --- | --- |
| Android `STORAGE_FILES` | `assetsPath/models` |
| Android `APK_ASSETS` | `null` — use `listBundledArchivesFromApkAssets('models')` |
| iOS ODR | `pathForResource(packName)/models` while access is held |

Alias: `getPlayAssetDeliveryModelsPath(packName)`.

### `fetchAssetPack(packName)`

```ts
function fetchAssetPack(packName: string): Promise<boolean>
```

Starts PAD / ODR download without waiting. Use `ensureAssetPackReady` when you need a blocking ready state.

```ts
await fetchAssetPack('sherpa_models');
const state = await getAssetPackState('sherpa_models');
```

### `ensureAssetPackReady(packName, options?)`

```ts
function ensureAssetPackReady(
  packName: string,
  options?: EnsureAssetPackReadyOptions
): Promise<AssetPackStateSnapshot>

type EnsureAssetPackReadyOptions = {
  onProgress?: (state: AssetPackStateSnapshot, percent: number | null) => void;
};
```

Fetches if needed and resolves when the pack/tag is ready (Android: `completed`; iOS: `beginAccessingResources` succeeded). Progress also emits on `sherpaAssetPackDeliveryProgress` when `onProgress` is set.

```ts
const state = await ensureAssetPackReady('sherpa_models', {
  onProgress: (_s, percent) => console.log('download', percent),
});
console.log(state.status); // 'completed'
```

### `getAssetPackState(packName)`

```ts
function getAssetPackState(packName: string): Promise<AssetPackStateSnapshot>
```

Read-only snapshot for UI or debug. Does not start a download.

```ts
const state = await getAssetPackState('sherpa_models');
const pct = assetPackDownloadPercent(state);
```

### `removeAssetPack(packName)`

```ts
function removeAssetPack(packName: string): Promise<number>
```

Android: removes the pack from device storage (returns bytes freed). iOS: ends ODR access for the tag (return value `0`). Does not delete files your app extracted elsewhere.

```ts
await removeAssetPack('sherpa_models');
```

### `assetPackDownloadPercent(state)`

```ts
function assetPackDownloadPercent(state: AssetPackStateSnapshot): number | null
```

Maps `bytesDownloaded` / `totalBytes` to `0–100`, or `null` when total size is unknown.

```ts
const pct = assetPackDownloadPercent(await getAssetPackState('sherpa_models'));
```

### `listOdrDeliverySnapshot(tag)`

```ts
function listOdrDeliverySnapshot(tag: string): Promise<OdrDeliverySnapshot>
```

**iOS debug/diagnostics.** Delivery snapshot: resolved `models/` path, access flags, directory probes (`__DEV__` native builds). On Android returns `{ tag, resolvedModelsPath: null }`.

```ts
const snap = await listOdrDeliverySnapshot('sherpa_models');
console.log(snap.resolvedModelsPath, snap.isAccessingTag);
```

### `logOdrDeliveryDiagnostics(tag)`

```ts
function logOdrDeliveryDiagnostics(tag: string, phase?: string): Promise<void>
```

**iOS `__DEV__` only.** Logs `listOdrDeliverySnapshot` to the console when delivery fails.

```ts
try {
  await ensureAssetPackReady('sherpa_models');
} catch {
  await logOdrDeliveryDiagnostics('sherpa_models', 'ensureAssetPackReady');
}
```

### Types

```ts
type AssetPackDeliveryStatus =
  | 'unknown' | 'pending' | 'downloading' | 'transferring'
  | 'completed' | 'failed' | 'canceled' | 'waiting_for_wifi' | 'not_installed';

type AssetPackStateSnapshot = {
  packName: string;
  status: AssetPackDeliveryStatus;
  bytesDownloaded: number;
  totalBytes: number;
  errorCode: number;
};

type OdrDeliverySnapshot = {
  tag: string;
  resolvedModelsPath: string | null;
  // DEBUG native: bundlePath, resourcePath, expectedModelsPath, tagFolderPath,
  // isAccessingTag, hasActiveRequest, directoryProbe, …
};
```

---

## Delivery status

| `status` | Meaning |
| --- | --- |
| `pending` | Queued |
| `downloading` / `transferring` | In progress |
| `completed` | Ready |
| `failed` / `canceled` | Retry `fetchAssetPack` |
| `waiting_for_wifi` | Android unmetered gate |
| `not_installed` | Missing pack/tag — check native config |

```ts
type AssetPackDeliveryStatus =
  | 'unknown' | 'pending' | 'downloading' | 'transferring'
  | 'completed' | 'failed' | 'canceled' | 'waiting_for_wifi' | 'not_installed';
```

---

## Workflows

**On-demand:** `ensureAssetPackReady` → `getAssetPackPath` → list/extract ([extraction.md](./extraction.md)) → optional Android `removeAssetPack` → engines use `{ kind: 'fs', path }` in your sandbox.

**Install-time Android:** list archives (path or `listBundledArchivesFromApkAssets`) → extract; usually skip fetch and skip `removeAssetPack` if still reading from APK assets.

**iOS bundle:** `listAssetModels` / `bundledModelFileSource` — no PAD/ODR.

---

## Native setup

### Android

```gradle
assetPacks = [":sherpa_models"]

// sherpa_models/build.gradle
assetPack {
    packName = "sherpa_models"
    dynamicDelivery {
        deliveryType = "on-demand"  // or install-time | fast-follow
    }
}
```

Ship content under the pack module’s `src/main/assets/models/`.

### iOS ODR

1. Add a folder reference (e.g. `sherpa_models/`) to **Copy Bundle Resources**.
2. Set its **On Demand Resource Tags** to the same name (`sherpa_models`).
3. Ship archives under `sherpa_models/models/` (see [example tree](#example-trees-and-apis)).
4. Request with `fetchAssetPack('sherpa_models')` or `ensureAssetPackReady('sherpa_models')`.
5. Build: populate `sherpa_models/models/` **before** the Resources phase copies tagged folders into asset packs.

---

## Troubleshooting

| Issue | Check |
| --- | --- |
| `getAssetPackPath` is `null` (install-time Android) | Expected for APK_ASSETS — `listBundledArchivesFromApkAssets('models')` |
| `null` after on-demand fetch | Download incomplete; wrong `packName`/tag |
| Empty `listBundledArchives` | Wrong `…/models` path; ship layout; [extraction.md](./extraction.md) |
| iOS ODR `path=null` after fetch | Tag/layout wrong; empty `tag/models/` at build; call `listOdrDeliverySnapshot(tag)` in `__DEV__` |
| iOS Simulator (Debug) — ODR never mounts | In the **Debug** `.xcconfig` for the app target, enable embed + initial-install tags (see below) |
| iOS ODR fetch error | Tag missing from build variant; network (TestFlight/App Store builds) |
| Engine fails after extract | Init with extracted `fs` path, not pack path |
| `{ kind: 'pad' }` on iOS | Unsupported — [fileio.md](./fileio.md) |

### iOS Simulator (Debug) — required build settings

On the Simulator, a bare `beginAccessingResources` call often does not surface tagged folders unless asset packs are embedded for development. Add to your app target’s **Debug** `.xcconfig` (replace tag names with yours):

```xcconfig
ENABLE_ON_DEMAND_RESOURCES = YES
ON_DEMAND_RESOURCES_EMBED_ASSET_PACKS_IN_PRODUCT_BUNDLE = YES
ON_DEMAND_RESOURCES_INITIAL_INSTALL_TAGS = sherpa_models my_other_tag
```

Also ensure ship archives exist under `sherpa_models/models/` **before** Xcode’s **Resources** phase copies tagged folders (download/build script → Resources). Production / TestFlight builds typically omit embed and rely on real on-demand delivery.

---

## See also

- [model-setup.md](./model-setup.md) — `bundledModelFileSource`, `listModelsAtPath`, FileSource
- [extraction.md](./extraction.md) — `listBundledArchives`, `listBundledArchivesFromApkAssets`, `extractArchive`
- [fileio.md](./fileio.md) — Android `pad` FileSource
- [download-manager.md](./download-manager.md) — runtime downloads (not PAD/ODR)
