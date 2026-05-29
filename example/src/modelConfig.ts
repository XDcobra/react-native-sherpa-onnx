/**
 * Model configuration helpers for the example app.
 * This is app-specific and not part of the library.
 *
 * These helpers work with any model name - use listAssetModels() to discover
 * available models dynamically instead of hardcoding model names.
 */

import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { bundledModelFileSource } from 'react-native-sherpa-onnx/utils';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

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
 * FileSource for a model folder shipped inside the app package.
 * Delegates to SDK {@link bundledModelFileSource} from `react-native-sherpa-onnx/utils`.
 */
export function getBundledModelFileSource(modelName: string): FileSource {
  return bundledModelFileSource(`models/${modelName}`.replace(/\/+/g, '/'));
}

/**
 * @deprecated Use {@link getBundledModelFileSource}; kept for call-site stability.
 */
export function getModelPath(modelName: string): FileSource {
  return getBundledModelFileSource(modelName);
}

/**
 * @deprecated Use {@link getBundledModelFileSource}; kept for call-site stability.
 */
export function getAssetModelPath(modelName: string): FileSource {
  return getBundledModelFileSource(modelName);
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
): FileSource {
  const resolvedBase = basePath
    ? basePath.replace(/\/+$/, '')
    : category
    ? `${DocumentDirectoryPath}/sherpa-onnx/models/${category}`
    : `${DocumentDirectoryPath}/sherpa-onnx/models`;
  const path = `${resolvedBase}/${modelName}`.replace(/\/+/g, '/');
  return { kind: 'fs', path };
}

/**
 * Identity helper kept for call-site stability while example screens migrate.
 */
export async function toDetectSource(config: FileSource): Promise<FileSource> {
  return config;
}
