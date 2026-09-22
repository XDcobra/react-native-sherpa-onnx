import type {
  TTSModelType,
  TtsLivePipelineOptions,
  TtsSynthesisOptions,
} from './types';

const NUM_STEPS_MODEL_TYPES: ReadonlySet<TTSModelType> = new Set([
  'supertonic',
  'zipvoice',
  'pocket',
]);

const NUM_STEPS_REQUIRES_VOICE_CLONE: ReadonlySet<TTSModelType> = new Set([
  'zipvoice',
  'pocket',
]);

export type TtsNumStepsOptions = Pick<
  TtsSynthesisOptions | TtsLivePipelineOptions,
  'numSteps' | 'voiceClone'
>;

/**
 * True when upstream sherpa-onnx honors `GenerationConfig.num_steps` for this model.
 * Supertonic uses steps without reference audio; Zipvoice/Pocket need voice cloning.
 */
export function supportsNumSteps(modelType: TTSModelType | undefined): boolean {
  return (
    modelType != null &&
    modelType !== 'auto' &&
    NUM_STEPS_MODEL_TYPES.has(modelType)
  );
}

/**
 * True when `numSteps` is only meaningful together with voice cloning (Zipvoice / Pocket).
 */
export function requiresVoiceCloneForNumSteps(
  modelType: TTSModelType | undefined
): boolean {
  return (
    modelType != null &&
    modelType !== 'auto' &&
    NUM_STEPS_REQUIRES_VOICE_CLONE.has(modelType)
  );
}

function hasVoiceCloneReferenceAudio(
  options: TtsNumStepsOptions | undefined
): boolean {
  return options?.voiceClone?.referenceAudio != null;
}

/**
 * Fail-fast before the native bridge when `numSteps` is set but not applicable.
 * No-op when `numSteps` is omitted (upstream default).
 *
 * @throws Error with code prefix TTS_NUM_STEPS_UNSUPPORTED or TTS_NUM_STEPS_REQUIRES_VOICE_CLONE
 */
export function assertNumStepsOptions(
  modelType: TTSModelType | undefined,
  options: TtsNumStepsOptions | undefined
): void {
  if (options?.numSteps === undefined) {
    return;
  }

  if (!supportsNumSteps(modelType)) {
    const typeLabel = modelType ?? 'unknown';
    throw new Error(
      `TTS_NUM_STEPS_UNSUPPORTED: numSteps is not supported for model type "${typeLabel}". ` +
        'Supported: supertonic, zipvoice, pocket.'
    );
  }

  if (
    requiresVoiceCloneForNumSteps(modelType) &&
    !hasVoiceCloneReferenceAudio(options)
  ) {
    throw new Error(
      `TTS_NUM_STEPS_REQUIRES_VOICE_CLONE: numSteps for "${modelType}" requires voiceClone.referenceAudio.`
    );
  }
}
