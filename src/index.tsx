import SherpaOnnx from './NativeSherpaOnnx';
import type { AccelerationSupport } from './NativeSherpaOnnx';

// Export common types and utilities
export type { AccelerationSupport } from './NativeSherpaOnnx';
export type { ModelPathConfig } from './types';
export {
  assetModelPath,
  autoModelPath,
  fileModelPath,
  getAssetPackPath,
  getDefaultModelPath,
  getPlayAssetDeliveryModelsPath,
  listAssetModels,
  listModelsAtPath,
  resolveModelPath,
} from './utils';

// Note: Feature-specific exports are available via subpath imports:
// - import { createSTT, createStreamingSTT, ... } from 'react-native-sherpa-onnx/stt'
// - import { createTTS, ... } from 'react-native-sherpa-onnx/tts'
// - import { ... } from 'react-native-sherpa-onnx/download'
// - import { ... } from 'react-native-sherpa-onnx/vad' (planned)
// - import { ... } from 'react-native-sherpa-onnx/diarization' (planned)
// - import { ... } from 'react-native-sherpa-onnx/enhancement' (planned)
// - import { ... } from 'react-native-sherpa-onnx/separation' (planned)

/**
 * Test method to verify sherpa-onnx native library is loaded.
 */
export function testSherpaInit(): Promise<string> {
  return SherpaOnnx.testSherpaInit();
}

/**
 * QNN support (Android). Optional modelBase64 for canInit (session test); if omitted, SDK uses embedded test model.
 */
export function getQnnSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getQnnSupport(modelBase64);
}

/**
 * Return the list of available ONNX Runtime execution providers
 * (e.g. "CPU", "NNAPI", "QNN", "XNNPACK").
 * Requires the ORT Java bridge from the onnxruntime AAR.
 */
export function getAvailableProviders(): Promise<string[]> {
  return SherpaOnnx.getAvailableProviders();
}

/**
 * NNAPI support (Android). Optional modelBase64 for canInit (session test). On iOS returns all false.
 */
export function getNnapiSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getNnapiSupport(modelBase64);
}

/**
 * XNNPACK support. hasAccelerator = true when providerCompiled (CPU-optimized). Optional modelBase64 for canInit. On iOS returns all false.
 */
export function getXnnpackSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getXnnpackSupport(modelBase64);
}

/**
 * Core ML support (iOS). providerCompiled = true (Core ML on iOS 11+), hasAccelerator = Apple Neural Engine. Optional modelBase64 for canInit. On Android returns all false.
 */
export function getCoreMlSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getCoreMlSupport(modelBase64);
}
