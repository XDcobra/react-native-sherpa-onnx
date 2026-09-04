import { detectDiarizationModel } from '../diarization';
import type { FileSource } from '../fileio/types';
import type { SpeechPyannoteSegmentationPolicy } from './engine-types';

export async function resolveSpeechPyannoteModelForPolicy(
  modelPath: FileSource
): Promise<{ modelPath: string; modelType: string }> {
  const detect = await detectDiarizationModel(modelPath, {
    modelType: 'auto',
  });
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
        : 'diarization segmentation model detection failed';
    throw Object.assign(
      new Error(
        `POLICY_MODEL_UNAVAILABLE: speech_pyannote_segmentation requires a detectable pyannote/reverb pack (${detail})`
      ),
      { code: 'POLICY_MODEL_UNAVAILABLE' }
    );
  }
  return { modelPath: onnxPath, modelType: detect.modelType };
}

export function isSpeechPyannoteSegmentationPolicy(policy: {
  evaluator: string;
}): policy is SpeechPyannoteSegmentationPolicy {
  return policy.evaluator === 'speech_pyannote_segmentation';
}
