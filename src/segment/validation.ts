import type { FileSource } from '../fileio/types';
import { assertVadCustomConfig } from '../vad/customConfig';
import type { SegmentationPolicy } from './engine-types';
import { isSpeechVadSegmentationPolicy } from './resolveSpeechVadModelForPolicy';
import { isSpeechPyannoteSegmentationPolicy } from './resolveSpeechPyannoteModelForPolicy';

function isFileSource(value: unknown): value is FileSource {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (kind === 'fs') {
    return typeof v.path === 'string' && v.path.trim().length > 0;
  }
  if (kind === 'app') {
    const base = v.base;
    return (
      (base === 'cache' ||
        base === 'documents' ||
        base === 'files' ||
        base === 'tmp' ||
        base === 'externalFiles' ||
        base === 'apkAsset' ||
        base === 'appBundle') &&
      typeof v.path === 'string' &&
      v.path.trim().length > 0
    );
  }
  if (kind === 'contentUri' || kind === 'securityScoped') {
    return typeof v.uri === 'string' && v.uri.trim().length > 0;
  }
  if (kind === 'pad') {
    return (
      typeof v.packName === 'string' &&
      v.packName.trim().length > 0 &&
      typeof v.path === 'string' &&
      v.path.trim().length > 0
    );
  }
  return false;
}

export interface ValidateSegmentationOptions {
  mode?: 'off' | 'manual' | 'auto';
  policy?: SegmentationPolicy;
  featureName: string;
  domain: 'text' | 'speech';
  supportsManual: boolean;
  defaultPolicy?: SegmentationPolicy;
  supportedEvaluators?: string[];
  errorPrefix?: string;
}

export function validateSegmentationConfig(
  options: ValidateSegmentationOptions
): {
  mode: 'off' | 'manual' | 'auto';
  policy?: SegmentationPolicy;
} {
  const mode = options.mode ?? 'off';
  const { featureName, domain, supportsManual, defaultPolicy } = options;

  const errorPrefix = options.errorPrefix ?? 'SEGMENTATION_POLICY_INVALID';

  if (mode === 'manual' && !supportsManual) {
    throw new Error(
      `${errorPrefix}: ${featureName} does not support segmentation.mode=manual`
    );
  }

  if (mode === 'off' && options.policy != null) {
    throw new Error(
      `${errorPrefix}: ${featureName} ignores segmentation.policy when segmentation.mode='off'; use mode='auto'`
    );
  }

  if (mode === 'manual' && options.policy != null) {
    throw new Error(
      `${errorPrefix}: ${featureName} ignores segmentation.policy when segmentation.mode='manual'; use mode='auto'`
    );
  }

  if (mode === 'off' || mode === 'manual') {
    return { mode };
  }

  const policy = options.policy ?? defaultPolicy;
  if (!policy) {
    throw new Error(
      `${errorPrefix}: ${featureName} requires a segmentation policy when mode='auto'`
    );
  }

  const evaluator = policy.evaluator;

  if (options.supportedEvaluators) {
    if (!options.supportedEvaluators.includes(evaluator)) {
      throw new Error(
        `${errorPrefix}: ${featureName} supports only ${options.supportedEvaluators.join(
          ', '
        )} policy; received ${evaluator}`
      );
    }
  } else if (domain === 'text') {
    if (
      evaluator !== 'text_synthetic_auto' &&
      evaluator !== 'text_punctuation_assisted'
    ) {
      throw new Error(
        `${errorPrefix}: ${featureName} requires a text segmentation evaluator; received ${evaluator}`
      );
    }
    if (
      evaluator === 'text_punctuation_assisted' &&
      !policy.punctuationInstanceId
    ) {
      throw new Error(
        `${errorPrefix}: text_punctuation_assisted requires policy.punctuationInstanceId`
      );
    }
  } else {
    if (
      evaluator !== 'speech_energy_silence' &&
      evaluator !== 'speech_vad_model' &&
      evaluator !== 'speech_pyannote_segmentation'
    ) {
      throw new Error(
        `${errorPrefix}: ${featureName} requires a speech segmentation evaluator; received ${evaluator}`
      );
    }
    if (
      'modelPath' in policy &&
      policy.modelPath != null &&
      evaluator !== 'speech_vad_model' &&
      evaluator !== 'speech_pyannote_segmentation'
    ) {
      throw new Error(
        `${errorPrefix}: policy.modelPath is only valid for speech_vad_model or speech_pyannote_segmentation`
      );
    }
    if (evaluator === 'speech_vad_model') {
      const speechVadPolicy = policy as SegmentationPolicy;
      if (!isSpeechVadSegmentationPolicy(speechVadPolicy)) {
        throw new Error(
          `${errorPrefix}: speech_vad_model policy shape is invalid`
        );
      }
      if (speechVadPolicy.initMode === 'custom') {
        if (
          speechVadPolicy.modelType !== 'silero_vad' &&
          speechVadPolicy.modelType !== 'ten_vad'
        ) {
          throw new Error(
            `${errorPrefix}: speech_vad_model custom mode requires modelType silero_vad or ten_vad`
          );
        }
        if (speechVadPolicy.customConfig == null) {
          throw new Error(
            `${errorPrefix}: speech_vad_model custom mode requires customConfig with model: FileSource`
          );
        }
        try {
          assertVadCustomConfig(
            speechVadPolicy.customConfig as unknown as Record<string, unknown>
          );
        } catch (error) {
          throw new Error(
            `${errorPrefix}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } else if (!isFileSource(speechVadPolicy.modelPath)) {
        throw new Error(
          `${errorPrefix}: speech_vad_model requires policy.modelPath to be a valid FileSource`
        );
      }
    }
    if (evaluator === 'speech_pyannote_segmentation') {
      if (!isSpeechPyannoteSegmentationPolicy(policy)) {
        throw new Error(
          `${errorPrefix}: speech_pyannote_segmentation policy shape is invalid`
        );
      }
      if (!isFileSource(policy.modelPath)) {
        throw new Error(
          `${errorPrefix}: speech_pyannote_segmentation requires policy.modelPath to be a valid FileSource`
        );
      }
      if (
        policy.windowShiftRatio != null &&
        (typeof policy.windowShiftRatio !== 'number' ||
          !Number.isFinite(policy.windowShiftRatio) ||
          policy.windowShiftRatio <= 0 ||
          policy.windowShiftRatio > 1)
      ) {
        throw new Error(
          `${errorPrefix}: speech_pyannote_segmentation windowShiftRatio must be in (0, 1]`
        );
      }
      if (
        policy.minDurationOn != null &&
        (typeof policy.minDurationOn !== 'number' ||
          !Number.isFinite(policy.minDurationOn) ||
          policy.minDurationOn < 0)
      ) {
        throw new Error(
          `${errorPrefix}: speech_pyannote_segmentation minDurationOn must be a non-negative number`
        );
      }
      if (
        policy.minDurationOff != null &&
        (typeof policy.minDurationOff !== 'number' ||
          !Number.isFinite(policy.minDurationOff) ||
          policy.minDurationOff < 0)
      ) {
        throw new Error(
          `${errorPrefix}: speech_pyannote_segmentation minDurationOff must be a non-negative number`
        );
      }
    }
  }

  return { mode: 'auto', policy };
}
