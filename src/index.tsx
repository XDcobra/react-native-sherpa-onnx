// Package root: `testSherpaInit` only. Import feature APIs from subpaths (e.g.
// `react-native-sherpa-onnx/fileio`, `react-native-sherpa-onnx/utils`, `react-native-sherpa-onnx/provider`).

import SherpaOnnx from './NativeSherpaOnnx';
export {
  LIVE_OFFLINE_SEGMENTATION_REQUIRED,
  LiveOfflinePipelineError,
} from './livePipeline';

export function testSherpaInit(): Promise<string> {
  return SherpaOnnx.testSherpaInit();
}
