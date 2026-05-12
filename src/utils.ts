import SherpaOnnx from './NativeSherpaOnnx';
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
 *   const result = await detectSttModel({
 *     kind: 'app',
 *     base: 'files',
 *     path: `models/${model.folder}`,
 *   });
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
 * **Play Asset Delivery (PAD):** Returns the path to the models directory inside an
 * Android asset pack, or null if the pack is not available.
 * Use this to list and load models delivered via PAD (e.g. pack "sherpa_models").
 * On iOS returns null.
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
