import SherpaOnnx from './NativeSherpaOnnx';

// Export common types and utilities
export type { InitializeOptions, ModelPathConfig, ModelType } from './types';
export {
  assetModelPath,
  autoModelPath,
  fileModelPath,
  getDefaultModelPath,
  listAssetModels,
  resolveModelPath,
} from './utils';

// Note: Feature-specific exports are available via subpath imports:
// - import { ... } from 'react-native-sherpa-onnx/stt'
// - import { ... } from 'react-native-sherpa-onnx/tts'
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
