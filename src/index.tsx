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

/** QNN support details: providerCompiled (QNN in ORT providers), canInitQnn (HTP backend init succeeds). */
export type QnnSupport = {
  providerCompiled: boolean;
  canInitQnn: boolean;
};

/**
 * Extended QNN support info. Use for UI (e.g. show "QNN available" vs "QNN compiled but not usable").
 */
export function getQnnSupport(): Promise<QnnSupport> {
  return SherpaOnnx.getQnnSupport();
}

/**
 * Return the list of available ONNX Runtime execution providers
 * (e.g. "CPU", "NNAPI", "QNN", "XNNPACK").
 * Requires the ORT Java bridge from the onnxruntime AAR.
 */
export function getAvailableProviders(): Promise<string[]> {
  return SherpaOnnx.getAvailableProviders();
}

/** NNAPI support details: providerCompiled, hasAccelerator, canInitNnapi (latter requires optional model test). */
export type NnapiSupport = {
  providerCompiled: boolean;
  hasAccelerator: boolean;
  canInitNnapi: boolean;
};

/**
 * Extended NNAPI support info (Android). Optional modelBase64: if provided, canInitNnapi tests a real session with NNAPI.
 * On iOS always returns { providerCompiled: false, hasAccelerator: false, canInitNnapi: false }.
 */
export function getNnapiSupport(modelBase64?: string): Promise<NnapiSupport> {
  return SherpaOnnx.getNnapiSupport(modelBase64);
}

/** XNNPACK support details: providerCompiled, canInit (latter requires optional model test). */
export type XnnpackSupport = {
  providerCompiled: boolean;
  canInit: boolean;
};

/**
 * XNNPACK support info. Optional modelBase64: if provided, canInit tests a real session with XNNPACK.
 * On iOS returns { providerCompiled: false, canInit: false } (stub).
 */
export function getXnnpackSupport(
  modelBase64?: string
): Promise<XnnpackSupport> {
  return SherpaOnnx.getXnnpackSupport(modelBase64);
}
