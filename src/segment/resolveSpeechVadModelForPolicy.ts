import { detectVadModel } from '../vad/engine';
import { resolveVadCustomConfigPaths } from '../vad/customConfig';
import type { VADConcreteModelType } from '../vad/types';
import type {
  SpeechVadModelConfig,
  SpeechVadSegmentationPolicy,
} from './engine-types';

export async function resolveSpeechVadModelForPolicy(
  config: SpeechVadModelConfig
): Promise<{ modelPath: string; modelType: string }> {
  if (config.initMode === 'custom') {
    const paths = await resolveVadCustomConfigPaths(
      config.modelType,
      config.customConfig
    );
    const onnxPath = paths.model?.trim() ?? '';
    if (!onnxPath) {
      throw Object.assign(
        new Error(
          'POLICY_MODEL_UNAVAILABLE: Custom VAD model path is missing after validation.'
        ),
        { code: 'POLICY_MODEL_UNAVAILABLE' }
      );
    }
    return { modelPath: onnxPath, modelType: config.modelType };
  }

  const detect = await detectVadModel(config.modelPath, { modelType: 'auto' });
  const onnxPath = detect.paths?.model?.trim();
  if (
    !detect.success ||
    onnxPath == null ||
    onnxPath.length === 0 ||
    detect.modelType == null ||
    detect.modelType === ''
  ) {
    const detail =
      typeof detect.error === 'string' && detect.error.trim().length > 0
        ? detect.error.trim()
        : 'VAD model detection failed';
    throw Object.assign(
      new Error(
        `POLICY_MODEL_UNAVAILABLE: speech_vad_model requires a detectable VAD bundle (${detail})`
      ),
      { code: 'POLICY_MODEL_UNAVAILABLE' }
    );
  }
  return { modelPath: onnxPath, modelType: detect.modelType };
}

export function speechVadPolicyToModelConfig(
  policy: SpeechVadSegmentationPolicy
): SpeechVadModelConfig {
  if (policy.initMode === 'custom') {
    return {
      initMode: 'custom',
      modelType: policy.modelType,
      customConfig: policy.customConfig,
    };
  }
  return {
    initMode: 'auto',
    modelPath: policy.modelPath,
  };
}

export function isSpeechVadSegmentationPolicy(policy: {
  evaluator: string;
}): policy is SpeechVadSegmentationPolicy {
  return policy.evaluator === 'speech_vad_model';
}

export type { VADConcreteModelType };
