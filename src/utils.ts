import { Platform } from 'react-native';
import type { ModelPathConfig } from './types';
import SherpaOnnx from './NativeSherpaOnnx';

/**
 * Utility functions for model path handling
 */

/**
 * Predefined model identifiers
 */
export const MODELS = {
  ZIPFORMER_EN: 'sherpa-onnx-zipformer-small-en',
  PARAFORMER_ZH: 'sherpa-onnx-paraformer-zh-small',
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

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
 * @param config - Model path configuration or simple string path
 * @returns Promise resolving to absolute path usable by native code
 */
export async function resolveModelPath(
  config: ModelPathConfig | string
): Promise<string> {
  // Backward compatibility: if string is passed, treat as auto
  if (typeof config === 'string') {
    return SherpaOnnx.resolveModelPath({
      type: 'auto',
      path: config,
    });
  }

  return SherpaOnnx.resolveModelPath(config);
}
