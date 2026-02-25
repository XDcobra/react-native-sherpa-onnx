import SherpaOnnx from './NativeSherpaOnnx';

// Export common types and utilities
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
// - import { ... } from 'react-native-sherpa-onnx/stt'
// - import { ... } from 'react-native-sherpa-onnx/tts'
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
 * Check whether the sherpa-onnx build has QNN (Qualcomm NPU) support.
 * This reflects whether the native shared libraries were built with QNN (e.g. libQnnHtp.so is present),
 * not whether the device has QNN-capable hardware.
 */
export function isQnnSupported(): Promise<boolean> {
  return SherpaOnnx.isQnnSupported();
}

/**
 * Return the list of available ONNX Runtime execution providers
 * (e.g. "CPU", "NNAPI", "QNN", "XNNPACK").
 * Requires the ORT Java bridge from the onnxruntime AAR.
 */
export function getAvailableProviders(): Promise<string[]> {
  return SherpaOnnx.getAvailableProviders();
}
