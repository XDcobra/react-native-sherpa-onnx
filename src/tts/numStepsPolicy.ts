import type { TTSModelType, TtsGenerationOptions } from './types';

const NUM_STEPS_MODEL_TYPES: ReadonlySet<TTSModelType> = new Set([
  'supertonic',
  'zipvoice',
  'pocket',
]);

const NUM_STEPS_REQUIRES_VOICE_CLONE: ReadonlySet<TTSModelType> = new Set([
  'zipvoice',
  'pocket',
]);

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
 * True when `numSteps` is only meaningful together with reference audio (Zipvoice / Pocket).
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

function hasValidReferenceAudio(
  options: TtsGenerationOptions | undefined
): boolean {
  const ref = options?.referenceAudio;
  if (ref == null) return false;
  if (!Array.isArray(ref.samples) || ref.samples.length === 0) return false;
  return Number.isFinite(ref.sampleRate) && ref.sampleRate > 0;
}

/**
 * Fail-fast before the native bridge when `numSteps` is set but not applicable.
 * No-op when `numSteps` is omitted (upstream default).
 *
 * @throws Error with code prefix TTS_NUM_STEPS_UNSUPPORTED or TTS_NUM_STEPS_REQUIRES_VOICE_CLONE
 */
export function assertNumStepsOptions(
  modelType: TTSModelType | undefined,
  options: TtsGenerationOptions | undefined
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
    !hasValidReferenceAudio(options)
  ) {
    throw new Error(
      `TTS_NUM_STEPS_REQUIRES_VOICE_CLONE: numSteps for "${modelType}" requires referenceAudio ` +
        '(non-empty samples and sampleRate > 0).'
    );
  }
}
