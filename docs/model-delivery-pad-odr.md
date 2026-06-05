# Ship Model Delivery (PAD & ODR)

Fetch and resolve on-disk paths for models shipped via **Android Play Asset Delivery (PAD)** or **iOS On-Demand Resources (ODR)**.

| Platform | Identifier | Native layout |
| --- | --- | --- |
| **Android** | `packName` (Gradle `assetPack.packName`) | `{pack}/models/` when `STORAGE_FILES`; install-time may use APK assets at `models/` |
| **iOS** | ODR tag (Xcode tag on the `models` folder) | `{tag}/models/` after `beginAccessingResources` |

**Imports:** delivery — `react-native-sherpa-onnx/utils`; archives — `react-native-sherpa-onnx/extraction` ([extraction.md](./extraction.md)).

PAD/ODR APIs return a **path only** (no archive listing). Listing `.tar.zst` / `.tar.bz2` and `extractArchive` live in the extraction subpath.

---

## Table of Contents

- [Layout](#layout)
- [Quick start — on-demand PAD / ODR](#quick-start--on-demand-pad--odr)
- [Quick start — install-time PAD (Android)](#quick-start--install-time-pad-android)
- [Quick start — iOS main bundle](#quick-start--ios-main-bundle)
- [Delivery modes](#delivery-modes)
- [API reference](#api-reference)
- [Delivery status](#delivery-status)
- [Workflows](#workflows)
- [Native setup](#native-setup)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Layout

Ship under **`models/`** inside the pack or tag:

- **Archives** — `.tar.zst` / `.tar.bz2` in `models/` (list via [extraction.md](./extraction.md))
- **Folders** — `models/<modelId>/…` (list via `listModelsAtPath`)

`getAssetPackPath` returns `…/models` when the pack/tag is ready, **without checking contents**. Extract, copy, or init from paths is app responsibility ([model-setup.md](./model-setup.md)).

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

`getAssetPackPath(tag)` returns `resourcePath/{tag}/models` while ODR access is active; `null` without `ensureAssetPackReady` first.

**Debug (`__DEV__`):** `listOdrDeliverySnapshot(tag)`, `logOdrDeliveryDiagnostics(tag)`.

---

## API reference

From `react-native-sherpa-onnx/utils`:

```typescript
import {
  getAssetPackPath,
  fetchAssetPack,
  ensureAssetPackReady,
  getAssetPackState,
  removeAssetPack,
  assetPackDownloadPercent,
  listOdrDeliverySnapshot,
  logOdrDeliveryDiagnostics,
} from 'react-native-sherpa-onnx/utils';
```

Web/other platforms: delivery APIs no-op or throw on `ensureAssetPackReady`.

### `getAssetPackPath(packName)`

`Promise<string | null>` — canonical `…/models` directory.

| Platform | Result |
| --- | --- |
| Android | Path when pack is `STORAGE_FILES` and installed |
| Android APK_ASSETS | `null` — use [extraction](./extraction.md) `listBundledArchivesFromApkAssets` |
| iOS ODR | Path after successful access for that tag |

Alias: `getPlayAssetDeliveryModelsPath`.

### `fetchAssetPack` / `ensureAssetPackReady`

- `fetchAssetPack` — starts download; does not block.
- `ensureAssetPackReady` — fetch + wait; optional `onProgress` (also via `sherpaAssetPackDeliveryProgress`).

Ready: Android Play `completed`; iOS `beginAccessingResources` succeeded.

### `getAssetPackState` / `assetPackDownloadPercent`

Snapshot for UI/debug.

### `removeAssetPack`

Android: removes pack from device. iOS: ends ODR access (may evict cache). Does not delete extracted files.

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

1. Tag the `models` folder in Xcode (e.g. tag `sherpa_models`).
2. On-disk layout: `sherpa_models/models/…` in the tagged bundle.
3. Request with `fetchAssetPack('sherpa_models')` or `ensureAssetPackReady`.

---

## Troubleshooting

| Issue | Check |
| --- | --- |
| `getAssetPackPath` is `null` (install-time Android) | Expected for APK_ASSETS — `listBundledArchivesFromApkAssets('models')` |
| `null` after on-demand fetch | Download incomplete; wrong `packName`/tag |
| Empty `listBundledArchives` | Wrong `…/models` path; ship layout; [extraction.md](./extraction.md) |
| iOS ODR fetch fails | Tag not in build variant; simulator limits |
| Engine fails after extract | Init with extracted `fs` path, not pack path |
| `{ kind: 'pad' }` on iOS | Unsupported — [fileio.md](./fileio.md) |

---

## See also

- [model-setup.md](./model-setup.md) — `bundledModelFileSource`, `listModelsAtPath`, FileSource
- [extraction.md](./extraction.md) — `listBundledArchives`, `listBundledArchivesFromApkAssets`, `extractArchive`
- [fileio.md](./fileio.md) — Android `pad` FileSource
- [download-manager.md](./download-manager.md) — runtime downloads (not PAD/ODR)
