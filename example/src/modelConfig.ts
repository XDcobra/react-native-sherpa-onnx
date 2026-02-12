/**
 * Model configuration helpers for the example app.
 * This is app-specific and not part of the library.
 *
 * These helpers work with any model name - use listAssetModels() to discover
 * available models dynamically instead of hardcoding model names.
 */

import {
  autoModelPath,
  assetModelPath,
  fileModelPath,
  getDefaultModelPath,
  type ModelPathConfig,
} from 'react-native-sherpa-onnx';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import RNFS from 'react-native-fs';

const titleCase = (value: string) =>
  value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;

/**
 * Convert a model folder name into a more readable display name.
 */
export function getModelDisplayName(modelFolder: string): string {
  if (!modelFolder) return 'Unknown model';
  const cleaned = modelFolder.replace(/^sherpa-onnx-/, '');
  const tokens = cleaned.split(/[-_]+/g).filter(Boolean);

  const mapped = tokens.map((token) => {
    const lower = token.toLowerCase();
    if (['en', 'zh', 'ja', 'ko', 'yue'].includes(lower)) {
      return lower.toUpperCase();
    }
    if (['us', 'gb'].includes(lower)) {
      return lower.toUpperCase();
    }
    if (['ctc', 'asr', 'tts', 'vits', 'mms'].includes(lower)) {
      return lower.toUpperCase();
    }
    return titleCase(lower);
  });

  return mapped.join(' ');
}

/**
 * Get model path with auto-detection (tries asset first, then file system).
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @returns Model path configuration
 *
 * @example
 * // Discover models first
 * const models = await listAssetModels();
 * const modelPath = getModelPath(models[0].folder);
 */
export function getModelPath(modelName: string): ModelPathConfig {
  return autoModelPath(`models/${modelName}`);
}

/**
 * Get asset model path for a model folder name.
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @returns Model path configuration
 */
export function getAssetModelPath(modelName: string): ModelPathConfig {
  return assetModelPath(`models/${modelName}`);
}

/**
 * Get file system model path for a model folder name.
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @param basePath - Base path for file system models (default: platform-specific)
 * @returns Model path configuration
 */
export function getFileModelPath(
  modelName: string,
  category?: ModelCategory,
  basePath?: string
): ModelPathConfig {
  const resolvedBase = basePath
    ? basePath
    : category
    ? `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/${category}`
    : getDefaultModelPath();
  const path = `${resolvedBase}/${modelName}`;
  return fileModelPath(path);
}
