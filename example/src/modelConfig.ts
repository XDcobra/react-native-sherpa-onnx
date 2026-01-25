/**
 * Model configuration for the example app.
 * This is app-specific and not part of the library.
 * Users should create their own model configuration based on their needs.
 */

import {
  autoModelPath,
  assetModelPath,
  fileModelPath,
  getDefaultModelPath,
  type ModelPathConfig,
} from 'react-native-sherpa-onnx';

/**
 * Predefined model identifiers for this example app
 */
export const MODELS = {
  ZIPFORMER_EN: 'sherpa-onnx-zipformer-small-en',
  PARAFORMER_ZH: 'sherpa-onnx-paraformer-zh-small',
  NEMO_CTC_EN: 'sherpa-onnx-nemo-parakeet-tdt-ctc-en',
  WHISPER_EN: 'sherpa-onnx-whisper-tiny-en',
  WENET_CTC_ZH_EN_CANTONESE: 'sherpa-onnx-wenetspeech-ctc-zh-en-cantonese',
  SENSE_VOICE_ZH_EN_JA_KO_YUE: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8',
  FUNASR_NANO_INT8: 'sherpa-onnx-funasr-nano-int8',
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Get model path for a predefined model identifier.
 * Uses auto-detection (tries asset first, then file system).
 *
 * @param modelId - Predefined model identifier (e.g., MODELS.ZIPFORMER_EN)
 * @returns Model path configuration
 */
export function getModelPath(modelId: ModelId): ModelPathConfig {
  return autoModelPath(`models/${modelId}`);
}

/**
 * Get asset model path for a predefined model identifier.
 *
 * @param modelId - Predefined model identifier (e.g., MODELS.ZIPFORMER_EN)
 * @returns Model path configuration
 */
export function getAssetModelPath(modelId: ModelId): ModelPathConfig {
  return assetModelPath(`models/${modelId}`);
}

/**
 * Get file system model path for a predefined model identifier.
 *
 * @param modelId - Predefined model identifier (e.g., MODELS.ZIPFORMER_EN)
 * @param basePath - Base path for file system models (default: platform-specific)
 * @returns Model path configuration
 */
export function getFileModelPath(
  modelId: ModelId,
  basePath?: string
): ModelPathConfig {
  const path = basePath
    ? `${basePath}/${modelId}`
    : `${getDefaultModelPath()}/${modelId}`;
  return fileModelPath(path);
}
