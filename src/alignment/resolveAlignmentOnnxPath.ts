import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveAlignmentCustomConfigPaths } from './customConfig';
import {
  resolveAlignmentPackProfile,
  type AlignmentConcreteModelFamily,
  type AlignmentModelProfile,
} from './modelProfiles';
import type {
  AlignTextToAudioOptionsAccurate,
  AlignmentAccurateModelConfig,
} from './types';

export interface AlignmentResolvedModelPaths {
  modelPath: string;
  /** Absolute path to vocab.json when detected / provided; empty otherwise. */
  vocabPath: string;
  family: AlignmentConcreteModelFamily;
  profile: AlignmentModelProfile;
  /** Basename / hint used for profile resolution (logging). */
  profileHint: string;
}

export async function resolveAlignmentOnnxPath(
  model: AlignmentAccurateModelConfig
): Promise<AlignmentResolvedModelPaths> {
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
    const vocabPath = paths.vocab?.trim() ?? '';
    const profileHint =
      typeof model.customConfig.model === 'object' &&
      model.customConfig.model != null &&
      'path' in model.customConfig.model
        ? String(
            (model.customConfig.model as { path?: string }).path ?? onnxPath
          )
        : onnxPath;
    const profile = resolveAlignmentPackProfile(profileHint);
    return {
      modelPath: onnxPath,
      vocabPath,
      family: model.modelType,
      profile,
      profileHint,
    };
  }

  const modelDir = (
    await resolveFileSourceForModelInit(model.modelSource)
  ).trim();
  if (!modelDir) {
    throw new Error(
      'ALIGNMENT_MODEL_MISSING: Provide modelSource for accurate alignment.'
    );
  }
  const det = await SherpaOnnx.detectAlignmentModel(
    modelDir,
    'auto',
    model.quantization ?? null
  );
  const onnxPath =
    typeof det.paths?.model === 'string' ? det.paths.model.trim() : '';
  if (!det.success || !onnxPath) {
    const err =
      typeof det.error === 'string' && det.error.trim().length > 0
        ? det.error.trim()
        : 'Alignment model detection failed: no ONNX path.';
    throw new Error(`ALIGNMENT_MODEL_LOAD_FAILED: ${err}`);
  }
  const vocabPath =
    typeof det.paths?.vocab === 'string' ? det.paths.vocab.trim() : '';
  const profileHint = modelDir;
  const profile = resolveAlignmentPackProfile(profileHint);
  return {
    modelPath: onnxPath,
    vocabPath,
    family: 'wav2vec2',
    profile,
    profileHint,
  };
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
    ...(options.quantization != null
      ? { quantization: options.quantization }
      : {}),
  };
}
