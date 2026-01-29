import SherpaOnnx from './NativeSherpaOnnx';

// Export types and utilities
export type { InitializeOptions, ModelPathConfig, ModelType } from './types';
export {
  assetModelPath,
  autoModelPath,
  fileModelPath,
  getDefaultModelPath,
  listAssetModels,
  resolveModelPath,
} from './utils';

// Re-export STT functionality
export { initializeSTT, transcribeFile, unloadSTT } from './stt';
export type { STTInitializeOptions, TranscriptionResult } from './stt';

// TODO: Uncomment these exports once the features are implemented
// Re-export other features (when implemented)
// export * from './tts';
// export * from './vad';
// export * from './diarization';
// export * from './enhancement';
// export * from './separation';

/**
 * Test method to verify sherpa-onnx native library is loaded.
 */
export function testSherpaInit(): Promise<string> {
  return SherpaOnnx.testSherpaInit();
}
