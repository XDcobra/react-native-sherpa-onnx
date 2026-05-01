import type { SegmentationPolicy } from './engine-types';

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
      evaluator !== 'speech_vad_model'
    ) {
      throw new Error(
        `${errorPrefix}: ${featureName} requires a speech segmentation evaluator; received ${evaluator}`
      );
    }
    if (evaluator === 'speech_vad_model' && !policy.modelPath) {
      throw new Error(
        `${errorPrefix}: speech_vad_model requires policy.modelPath`
      );
    }
  }

  return { mode: 'auto', policy };
}
