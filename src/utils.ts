import { Platform } from 'react-native';
import SherpaOnnx from './NativeSherpaOnnx';
import type { FileSource, FileSourceAutoTryTarget } from './fileio/types';
/**
 * {@link FileSource} for a model folder shipped inside the app package.
 *
 * - Android: `app:apkAsset` (APK `assets/<path>`, materialized to a readable dir)
 * - iOS: `app:appBundle` (main bundle resources at `<path>`)
 */
export function bundledModelFileSource(relativePath: string): FileSource {
  const path = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (Platform.OS === 'android') {
    return { kind: 'app', base: 'apkAsset', path };
  }
  return { kind: 'app', base: 'appBundle', path };
}

/**
 * {@link FileSource} that tries multiple location kinds in order until one resolves
 * to an existing model directory. Requires an explicit {@link FileSourceAutoTryTarget} list.
 */
export function autoModelFileSource(
  path: string,
  tryOrder: FileSourceAutoTryTarget[]
): FileSource {
  return {
    kind: 'auto',
    path: path.replace(/\\/g, '/').trim(),
    tryOrder,
  };
}

/**
 * List all model folders in the assets/models directory.
 * Scans the platform-specific model directory and returns folder names.
 *
 * This is useful for discovering models at runtime without hardcoding paths.
 * You can then use the returned folder names to construct FileSource inputs for detect/init APIs.
 *
 * @returns Promise resolving to array of model info objects
 *
 * @example
 * ```typescript
 * import { listAssetModels } from 'react-native-sherpa-onnx/utils';
 * import { detectSttModel } from 'react-native-sherpa-onnx/stt';
 *
 * const models = await listAssetModels();
 * for (const model of models) {
 *   const result = await detectSttModel(
 *     bundledModelFileSource(`models/${model.folder}`)
 *   );
 *   if (result.success) {
 *     console.log(`Found models in ${model.folder}:`, result.detectedModels);
 *   }
 * }
 * ```
 */
export async function listAssetModels(): Promise<
  Array<{
    folder: string;
    hint: 'stt' | 'tts' | 'alignment' | 'enhancement' | 'unknown';
  }>
> {
  return SherpaOnnx.listAssetModels();
}

/**
 * List model folders under a specific filesystem path.
 * When recursive is true, returns relative folder paths under the base path.
 */
export async function listModelsAtPath(
  path: string,
  recursive = false
): Promise<
  Array<{
    folder: string;
    hint: 'stt' | 'tts' | 'alignment' | 'enhancement' | 'unknown';
  }>
> {
  return SherpaOnnx.listModelsAtPath(path, recursive);
}

/**
 * **PAD / ODR:** Returns the canonical `…/models` directory when the pack is
 * installed (Android) or ODR access is active (iOS), regardless of contents.
 * For on-demand / ODR, call {@link ensureAssetPackReady} first; list archives via {@link listBundledArchives} from `react-native-sherpa-onnx/extraction`.
 * @see docs/model-delivery-pad-odr.md
 */
export async function getAssetPackPath(
  packName: string
): Promise<string | null> {
  return SherpaOnnx.getAssetPackPath(packName);
}

/**
 * Alias for {@link getAssetPackPath}. Use for PAD (Play Asset Delivery) model discovery.
 */
export const getPlayAssetDeliveryModelsPath = getAssetPackPath;

export {
  fetchAssetPack,
  getAssetPackState,
  removeAssetPack,
  ensureAssetPackReady,
  assetPackDownloadPercent,
} from './pad/assetPack';
export { discoverShipContentAtPack } from './pad/shipContent';
export type {
  ShipContentDiscovery,
  ShipModelFolderListing,
} from './pad/shipContent';
export {
  listOdrDeliverySnapshot,
  logOdrDeliveryDiagnostics,
} from './pad/odrDiagnostics';
export type {
  OdrDeliverySnapshot,
  OdrDirectoryProbe,
} from './pad/odrDiagnostics';
export type {
  AssetPackDeliveryStatus,
  AssetPackStateSnapshot,
  EnsureAssetPackReadyOptions,
} from './pad/assetPack';
