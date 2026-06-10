import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveAlignmentCustomConfigPaths } from './customConfig';
import type {
  AlignTextToAudioOptionsAccurate,
  AlignmentAccurateModelConfig,
} from './types';

export async function resolveAlignmentOnnxPath(
  model: AlignmentAccurateModelConfig
): Promise<string> {
  if (model.initMode === 'custom') {
    const paths = await resolveAlignmentCustomConfigPaths(
      model.modelType,
      model.customConfig
    );
    const onnxPath = paths.model?.trim() ?? '';
    if (!onnxPath) {
      throw new Error(
        'ALIGNMENT_MODEL_LOAD_FAILED: Custom alignment model path is missing after validation.'
      );
    }
    return onnxPath;
  }

  const modelDir = (
    await resolveFileSourceForModelInit(model.modelSource)
  ).trim();
  if (!modelDir) {
    throw new Error(
      'ALIGNMENT_MODEL_MISSING: Provide modelSource for accurate alignment.'
    );
  }
  const det = await SherpaOnnx.detectAlignmentModel(modelDir, 'auto');
  const onnxPath =
    typeof det.paths?.model === 'string' ? det.paths.model.trim() : '';
  if (!det.success || !onnxPath) {
    const err =
      typeof det.error === 'string' && det.error.trim().length > 0
        ? det.error.trim()
        : 'Alignment model detection failed: no ONNX path.';
    throw new Error(`ALIGNMENT_MODEL_LOAD_FAILED: ${err}`);
  }
  return onnxPath;
}

export function accurateOptionsToModelConfig(
  options: AlignTextToAudioOptionsAccurate
): AlignmentAccurateModelConfig {
  if (options.initMode === 'custom') {
    return {
      initMode: 'custom',
      modelType: options.modelType,
      customConfig: options.customConfig,
    };
  }
  return {
    initMode: 'auto',
    modelSource: options.modelSource,
  };
}
