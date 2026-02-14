import { Platform } from 'react-native';
import type { ModelPathConfig } from './types';
import SherpaOnnx from './NativeSherpaOnnx';

/**
 * Utility functions for model path handling
 */

/**
 * Get the default model directory path for the current platform.
 * This is a helper for apps that want to use a standard location.
 *
 * @returns Platform-specific default path
 */
export function getDefaultModelPath(): string {
  if (Platform.OS === 'ios') {
    // iOS: Documents directory
    return 'Documents/models';
  } else {
    // Android: Internal storage
    return 'models';
  }
}

/**
 * Create a model path configuration for asset models.
 * Use this when models are bundled in your app's assets.
 *
 * @param assetPath - Path relative to assets (e.g., "models/sherpa-onnx-model")
 * @returns Model path configuration
 */
export function assetModelPath(assetPath: string): ModelPathConfig {
  return {
    type: 'asset',
    path: assetPath,
  };
}

/**
 * Create a model path configuration for file system models.
 * Use this when models are downloaded or stored in file system.
 *
 * @param filePath - Absolute path to model directory
 * @returns Model path configuration
 */
export function fileModelPath(filePath: string): ModelPathConfig {
  return {
    type: 'file',
    path: filePath,
  };
}

/**
 * Create a model path configuration with auto-detection.
 * Tries asset first, then file system.
 *
 * @param path - Path to try (will be checked as both asset and file)
 * @returns Model path configuration
 */
export function autoModelPath(path: string): ModelPathConfig {
  return {
    type: 'auto',
    path: path,
  };
}

/**
 * Resolve model path based on configuration.
 * This handles different path types (asset, file, auto) and returns
 * a platform-specific absolute path that can be used by native code.
 *
 * @param config - Model path configuration
 * @returns Promise resolving to absolute path usable by native code
 */
export async function resolveModelPath(
  config: ModelPathConfig
): Promise<string> {
  return SherpaOnnx.resolveModelPath(config);
}

/**
 * List all model folders in the assets/models directory.
 * Scans the platform-specific model directory and returns folder names.
 *
 * This is useful for discovering models at runtime without hardcoding paths.
 * You can then use the returned folder names with resolveModelPath and initialize.
 *
 * @returns Promise resolving to array of model info objects
 *
 * @example
 * ```typescript
 * import { listAssetModels, resolveModelPath } from 'react-native-sherpa-onnx';
 *
 * // Get all model folders
 * const models = await listAssetModels();
 * console.log('Found models:', models);
 * // Example output: [{ folder: 'sherpa-onnx-streaming-zipformer-en-2023-06-26', hint: 'stt' }, { folder: 'sherpa-onnx-matcha-icefall-en_US-ljspeech', hint: 'tts' }]
 *
 * // Initialize each model to detect types
 * for (const model of models) {
 *   const path = await resolveModelPath({ type: 'asset', path: `models/${model.folder}` });
 *   const result = await initializeSherpaOnnx(path);
 *   if (result.success) {
 *     console.log(`Found models in ${model.folder}:`, result.detectedModels);
 *   }
 * }
 * ```
 */
export async function listAssetModels(): Promise<
  Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>
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
): Promise<Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>> {
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
