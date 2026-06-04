# Ship Model Delivery (PAD & ODR)

Ship speech models with the app via **Android Play Asset Delivery (PAD)** and **iOS On-Demand Resources (ODR)** — including **install-time**, **fast-follow**, and **on-demand** delivery on Android, plus **main-bundle** and **ODR-tagged** content on iOS.

The same TypeScript APIs apply to every mode; what changes is **when** content is on disk and whether you must call `fetchAssetPack`.

| Platform | Mechanisms | SDK identifier |
| --- | --- | --- |
| **Android** | PAD `install-time`, `fast-follow`, `on-demand` | `packName` (e.g. `sherpa_models`, `core_models`) |
| **iOS** | Main bundle `models/` (install-time) or **ODR tags** | ODR: tag name (e.g. `core_models`); bundle: `listAssetModels` / `bundledModelFileSource` |

**Import path:** `react-native-sherpa-onnx/utils` (path + delivery APIs) and `react-native-sherpa-onnx/extraction` (compressed archives).

---

## Quick start — on-demand (small store listing)

Use this when Tier-0/1 ship archives live in a **PAD `on-demand`** pack or an **iOS ODR tag**, not in the base APK/IPA. Flow: **fetch → wait → discover → extract → (Android) optional remove pack**. After extract, engines use **`{ kind: 'fs', path }`** under `targetDir` — not the pack/tag path ([model-setup.md](./model-setup.md)).

```typescript
import {
  fetchAssetPack,
  waitForAssetPackReady,
  getAssetPackPath,
  removeAssetPack,
} from 'react-native-sherpa-onnx/utils';
import {
  getBundledArchives,
  listBundledArchives,
  extractArchive,
} from 'react-native-sherpa-onnx/extraction';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { Platform } from 'react-native';

// Must match Gradle assetPack name (Android) or Xcode ODR tag (iOS).
const PACK = 'core_models';
// Stable runtime location — survives Android removeAssetPack / iOS ODR eviction.
const targetDir = `${DocumentDirectoryPath}/models`;

// 1) Start or resume download (safe on every cold start).
await fetchAssetPack(PACK);
// 2) Block until pack/tag is on disk; drive UI from onProgress (percent may be null).
await waitForAssetPackReady(PACK, {
  onProgress: (_state, percent) => console.log('download', percent),
});

// 3) Directory containing ship archives (…/models). Still null on Android APK_ASSETS — see install-time quick start.
const packPath = await getAssetPackPath(PACK);
if (!packPath) throw new Error(`${PACK} not available after fetch`);

// 4) List .tar.zst / .tar.bz2 in the pack/tag (Android: pack name; iOS: filesystem path).
const archives =
  Platform.OS === 'android'
    ? await getBundledArchives(PACK)
    : await listBundledArchives(packPath);

if (archives?.length) {
  for (const archive of archives) {
    // 5) Unpack to targetDir; keep a manifest in app code so re-run is idempotent.
    await extractArchive(archive, targetDir, {
      onProgress: (e) => console.log(archive.modelId, e.percent),
    });
  }
}

// 6) Android only: drop PAD bytes after extract (Play Core). iOS: optional — ends ODR access, may evict cache.
if (Platform.OS === 'android') {
  await removeAssetPack(PACK);
}

// 7) Init engines, e.g. detectSttModel({ kind: 'fs', path: `${targetDir}/<modelId>` })
```

---

## Quick start — install-time PAD (Android)

Content is delivered **with the app install** (or merged into the APK as **APK_ASSETS**). Usually **no** `fetchAssetPack` / `waitForAssetPackReady` on first launch.

```typescript
import { getBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { getAssetPackPath } from 'react-native-sherpa-onnx/utils';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

const PACK = 'sherpa_models';
const targetDir = `${DocumentDirectoryPath}/models`;

// Works for install-time, fast-follow, and on-demand once the pack is present.
// APK_ASSETS install-time: getAssetPackPath often returns null — use getBundledArchives.
const archives = await getBundledArchives(PACK);
if (!archives?.length) {
  throw new Error(`PAD pack ${PACK} has no archives (not installed yet?)`);
}

for (const archive of archives) {
  await extractArchive(archive, targetDir);
}

// Optional: if getAssetPackPath returns a STORAGE_FILES path, list uncompressed folders:
const packPath = await getAssetPackPath(PACK);
if (packPath) {
  // listModelsAtPath(packPath, true) — see model-setup.md
}
```

Gradle: `deliveryType = "install-time"` (or `"fast-follow"`) on the asset pack module. See [Native app setup](#native-app-setup-summary).

---

## Quick start — install-time iOS (main bundle)

Models ship in the app target (**Copy Bundle Resources**), not via ODR. Use bundle helpers from [model-setup.md](./model-setup.md); use extraction only for **compressed** archives in `models/`.

```typescript
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { bundledModelFileSource, listAssetModels } from 'react-native-sherpa-onnx/utils';
import { MainBundlePath, DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

// Uncompressed folders in the bundle
const bundled = await listAssetModels();

// Compressed .tar.zst in bundle models/
const archives = await listBundledArchives(`${MainBundlePath}/models`);
for (const archive of archives ?? []) {
  await extractArchive(archive, `${DocumentDirectoryPath}/models`);
}

// Init from bundle (no PAD/ODR)
const source = bundledModelFileSource('models/sherpa-onnx-whisper-tiny');
```

For **ODR-tagged** install-time-sized tiers, use the [on-demand quick start](#quick-start--on-demand-small-store-listing) with `fetchAssetPack` only when the tag is not already local.

---

## Table of Contents

- [Delivery modes](#delivery-modes)
- [Overview](#overview)
- [When to use](#when-to-use)
- [How this relates to other APIs](#how-this-relates-to-other-apis)
- [API Reference](#api-reference)
- [Delivery status values](#delivery-status-values)
- [Recommended workflows](#recommended-workflows)
- [Native app setup (summary)](#native-app-setup-summary)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Delivery modes

### Android PAD

| `deliveryType` | When available | `fetchAssetPack` | Typical storage | `getAssetPackPath` |
| --- | --- | --- | --- | --- |
| **`install-time`** | With app install from Play / bundletool | Usually **not** needed | Often **APK_ASSETS** (archives under app asset root `models/`) | Often `null` → use `getBundledArchives` |
| **`fast-follow`** | Automatically soon after install | Optional; poll `getAssetPackState` if not ready at first launch | STORAGE_FILES or APK_ASSETS | Path when STORAGE_FILES |
| **`on-demand`** | After `fetchAssetPack` + download | **Required** before use | Usually **STORAGE_FILES** after download | Path when completed |

`getBundledArchives(packName)` handles both **STORAGE_FILES** (filesystem scan) and **APK_ASSETS** (AssetManager stream) — see [extraction.md](./extraction.md).

### iOS

| Delivery | When available | APIs |
| --- | --- | --- |
| **Main bundle** (`models/` in app target) | At install | `bundledModelFileSource`, `listAssetModels`, `listBundledArchives(MainBundlePath + '/models')` |
| **ODR tag** | After resources are local (often pre-cached or after `fetchAssetPack`) | Same as Android pack name: `fetchAssetPack(tag)`, `getAssetPackPath(tag)`, `listBundledArchives(packPath)` |

There is no Android-style `install-time` PAD on iOS; the analogue is **Copy Bundle Resources** or a **non-optional ODR tag** included in the IPA variant.

---

## Overview

```
                         ┌──────────────────────────────┐
                         │  Content already on device?   │
                         └──────────────┬───────────────┘
                    yes ───────────────┼────────────── no (on-demand / ODR)
                         │                              │
                         ▼                              ▼
              getBundledArchives /              fetchAssetPack
              getAssetPackPath /                  waitForAssetPackReady
              listBundledArchives(bundle)                 │
                         │                              │
                         └──────────────┬───────────────┘
                                        ▼
                         extractArchive → Documents/models/
                                        ▼
              Android on-demand: optional removeAssetPack
                                        ▼
                         Engines: { kind: 'fs', path } (extracted dir)
```

| Topic | Android PAD | iOS |
| --- | --- | --- |
| **Install-time ship** | PAD `install-time` / APK assets | Main bundle `models/` |
| **Deferred ship** | `on-demand`, `fast-follow` | ODR tags + `fetchAssetPack` |
| **List compressed archives** | `getBundledArchives(pack)` | `listBundledArchives(packPath or bundle)` |
| **Progress** | `getAssetPackState` (meaningful bytes on Play) | ODR `NSBundleResourceRequest` progress |
| **Free ship copy after extract** | `removeAssetPack` (on-demand typical) | `removeAssetPack` ends ODR access; bundle unchanged |
| **Runtime source of truth** | Extracted sandbox (recommended) | Same |

---

## When to use

| Approach | Store / install size | When |
| --- | --- | --- |
| **Bundled** (`bundledModelFileSource`, `listAssetModels`) | Large base APK/IPA | Small models always in main `assets/` or bundle |
| **PAD install-time** | Medium; not in base module split | Legacy/simple: models available at first launch without fetch |
| **PAD fast-follow** | Medium base; pack follows install | Automatic background delivery right after install |
| **PAD on-demand** | Small base listing | Tiered models; first-run or feature-gated download |
| **iOS main bundle** | Large IPA | Same as small bundled ship |
| **iOS ODR** | Smaller IPA | Tagged archives; fetch when needed |
| **Download manager** | Small base | User-initiated HF/GitHub ([download-manager.md](./download-manager.md)) |

Use **this guide** when models live in a **PAD pack** or **ODR tag** (any `deliveryType`), or when you list/extract **compressed ship archives** from those locations.

Use **`fetchAssetPack` / `waitForAssetPackReady`** when:

- Android pack is **`on-demand`** (or not yet present for **`fast-follow`**), or
- iOS **ODR tag** is not yet on disk (`getAssetPackPath` returns `null`).

Skip fetch when:

- Android **install-time** pack is already installed and `getBundledArchives` returns archives, or
- iOS models are in the **main bundle** only.

---

## How this relates to other APIs

| API | Role |
| --- | --- |
| **This doc** | PAD / ODR delivery modes, fetch/progress/remove, when to skip fetch |
| [`getAssetPackPath`](./model-setup.md#getassetpackpathpackname) | Resolve `…/models` when pack uses STORAGE_FILES or ODR is ready |
| [`getBundledArchives` / `extractArchive`](./extraction.md) | Compressed archives (install-time APK_ASSETS and on-demand STORAGE_FILES) |
| [`bundledModelFileSource`](./model-setup.md) | iOS/Android main package assets (not PAD pack name) |
| `{ kind: 'pad', packName, path }` in [fileio.md](./fileio.md) | **Android only** — read/copy from installed pack path |
| `kind: 'auto'` + `{ pad: 'pack' }` | Probe installed PAD during detect/init (Android) |

---

## API Reference

Exported from `react-native-sherpa-onnx/utils`:

```typescript
import {
  getAssetPackPath,
  fetchAssetPack,
  getAssetPackState,
  removeAssetPack,
  waitForAssetPackReady,
  assetPackDownloadPercent,
} from 'react-native-sherpa-onnx/utils';
```

On web and other platforms, delivery APIs are no-ops or throw (`waitForAssetPackReady`).

### `getAssetPackPath(packName)`

```ts
function getAssetPackPath(packName: string): Promise<string | null>;
```

Returns `…/models` for the pack or ODR tag when content is on disk as a **directory**.

| Platform | Behavior |
| --- | --- |
| **Android** | Path when pack uses **STORAGE_FILES** and is installed. **`null`** for **APK_ASSETS** install-time packs — use `getBundledArchives(packName)` instead. |
| **iOS** | `<resourcePath>/<tag>/models` when tag is available; legacy fallback `<resourcePath>/models`. **`null`** until ODR resources are present. |

Alias: `getPlayAssetDeliveryModelsPath`.

### `fetchAssetPack(packName)`

```ts
function fetchAssetPack(packName: string): Promise<boolean>;
```

| Mode | Typical use |
| --- | --- |
| **PAD on-demand** | **Required** to start download |
| **PAD fast-follow** | Safe to call; resumes if not finished |
| **PAD install-time** | Usually unnecessary (already installed); harmless no-op if present |
| **iOS ODR** | Request tag download when not local |

Does not block until complete — use `waitForAssetPackReady` or poll `getAssetPackState`.

### `getAssetPackState(packName)` / `assetPackDownloadPercent`

Poll delivery state. Install-time packs from Play often report `completed` immediately. Fast-follow may show `downloading` / `transferring` on first launch.

### `waitForAssetPackReady(packName, options?)`

Calls `fetchAssetPack` if `getAssetPackPath` is empty, then polls until the pack/tag is usable (`completed` + path, or archives discoverable via `getBundledArchives` on Android APK_ASSETS).

**Install-time Android:** if `getBundledArchives` already returns data, you can skip this helper entirely.

### `removeAssetPack(packName)`

| Platform | Behavior |
| --- | --- |
| **Android** | Removes pack from device (including install-time / on-demand). Use **after** extract when you only need `Documents/models/`. |
| **iOS** | Ends ODR access; system may evict cache. Does not remove main bundle or extracted dirs. |

Avoid removing **install-time** packs if the app still reads archives directly from the pack without extracting.

### Types

```ts
type AssetPackDeliveryStatus =
  | 'unknown'
  | 'pending'
  | 'downloading'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'waiting_for_wifi'
  | 'not_installed';
```

---

## Delivery status values

| `status` | Meaning | UI hint |
| --- | --- | --- |
| `pending` | Queued / known but not local | Indeterminate |
| `downloading` | Active download | Progress % |
| `transferring` | Android: applying pack to storage | Progress % |
| `completed` | Installed / ready | Extract or list archives |
| `failed` | Error — see `errorCode` | Retry `fetchAssetPack` |
| `canceled` | Canceled | Retry |
| `waiting_for_wifi` | Android: unmetered required | Wi‑Fi hint |
| `not_installed` | Pack/tag missing | Fetch or fix Gradle/Xcode |

---

## Recommended workflows

### Install-time PAD (Android)

1. At first launch, call `getBundledArchives(pack)` (no fetch).
2. `extractArchive` → sandbox; engines use `{ kind: 'fs', path }`.
3. Usually **do not** `removeAssetPack` if you rely on APK_ASSETS paths for updates/re-reads.

### On-demand PAD / ODR

1. `fetchAssetPack` + `waitForAssetPackReady` (progress UI).
2. `getBundledArchives` or `listBundledArchives(await getAssetPackPath(tag))`.
3. Extract + manifest ([extraction.md](./extraction.md)).
4. **Android:** `removeAssetPack` after successful extract (optional).
5. **Eviction:** missing extracted dirs + no pack path → fetch again, clear stale manifest, re-extract.

### iOS main bundle only

1. `listAssetModels` or `listBundledArchives` on bundle `models/`.
2. Extract if needed; init with `bundledModelFileSource` or `fs` to extracted dir.

---

## Native app setup (summary)

### Android PAD

```gradle
// settings.gradle / app build.gradle — example
assetPacks = [":sherpa_models"]

// sherpa_models/build.gradle
assetPack {
    packName = "sherpa_models"
    dynamicDelivery {
        deliveryType = "install-time"  // or "fast-follow" | "on-demand"
    }
}
```

Ship `.tar.zst` under `src/main/assets/models/` in the pack module.

| `deliveryType` | Notes |
| --- | --- |
| `install-time` | Delivered with install; often **APK_ASSETS** → `getBundledArchives`, not `getAssetPackPath` |
| `fast-follow` | Auto after install; may need short wait on first cold start |
| `on-demand` | Requires Play Core fetch; local testing via bundletool + PAD local testing |

### iOS

| Ship style | Xcode setup |
| --- | --- |
| **Install-time (bundle)** | Add `models/` to app target → Copy Bundle Resources |
| **ODR** | Asset catalog tags (e.g. `core_models`); folders `core_models/models/*.tar.zst`; request with `fetchAssetPack('core_models')` |

---

## Troubleshooting

| Issue | What to check |
| --- | --- |
| Install-time: `getAssetPackPath` is `null` | **Expected** for APK_ASSETS — use `getBundledArchives` |
| Install-time: `getBundledArchives` is `null` | Pack name typo; app not installed from bundle/APK that includes the pack |
| On-demand: path still `null` after fetch | Download not finished; wrong pack name; Play / network |
| iOS bundle empty | Models not in Copy Bundle Resources |
| iOS ODR: fetch fails | Tag not in variant; simulator limitations; `ODR_FETCH_FAILED` |
| Extract OK but engine fails | Use extracted `fs` path, not pack path after `removeAssetPack` |
| `{ kind: 'pad' }` on iOS | Unsupported — bundle or ODR + `fs` ([fileio.md](./fileio.md)) |

---

## See also

- [model-setup.md](./model-setup.md) — `bundledModelFileSource`, `listModelsAtPath`, `auto` try order
- [extraction.md](./extraction.md) — APK_ASSETS vs STORAGE_FILES, `getBundledArchives`
- [fileio.md](./fileio.md) — `pad` FileSource (Android)
- [download-manager.md](./download-manager.md) — runtime HF/GitHub downloads
