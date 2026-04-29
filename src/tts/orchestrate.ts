import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineTextToAudioPipeline } from '../pipeline/offlineOrchestrator';
import type { TextToAudioOrchestrationResult } from '../pipeline/offlineOrchestrator';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import { toNativeSynthesisOptions } from './ttsNativeBridge';
import type { TtsSynthesisOptions } from './types';

const DEFAULT_TTS_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'text_synthetic_auto',
  sentenceBoundary: true,
  maxLengthChars: 500,
};

export async function runOfflineTtsPipeline(
  textIn: OfflineTextBufferIdSource,
  instanceId: string,
  options: TtsSynthesisOptions = {}
): Promise<TextToAudioOrchestrationResult> {
  const mode = options.segmentation?.mode ?? 'off';
  if (mode === 'manual') {
    throw new Error(
      'SEGMENTATION_POLICY_INVALID: offline TTS does not support segmentation.mode=manual'
    );
  }
  if (mode === 'off' && options.segmentation?.policy != null) {
    throw new Error(
      "SEGMENTATION_POLICY_INVALID: offline TTS ignores segmentation.policy when segmentation.mode='off'; use mode='auto'"
    );
  }
  const segmentation =
    mode === 'off'
      ? { mode: 'off' as const }
      : {
          mode,
          policy:
            options.segmentation?.policy ?? DEFAULT_TTS_SEGMENTATION_POLICY,
        };

  if (segmentation.mode !== 'off') {
    const evaluator = segmentation.policy.evaluator;
    if (
      evaluator !== 'text_synthetic_auto' &&
      evaluator !== 'text_punctuation_assisted'
    ) {
      throw new Error(
        `SEGMENTATION_POLICY_INVALID: offline TTS requires a text segmentation evaluator; received ${evaluator}`
      );
    }
    if (
      evaluator === 'text_punctuation_assisted' &&
      !segmentation.policy.punctuationInstanceId
    ) {
      throw new Error(
        'SEGMENTATION_POLICY_INVALID: text_punctuation_assisted requires policy.punctuationInstanceId'
      );
    }
  }

  const sampleRate = await SherpaOnnx.getTtsSampleRate(instanceId);

  return runOfflineTextToAudioPipeline(
    textIn,
    async (segIn, segOut) => {
      await SherpaOnnx.synthesizeTts(
        instanceId,
        segIn.bufferId,
        segOut.bufferId,
        toNativeSynthesisOptions(options) ?? undefined
      );
    },
    {
      segmentation,
      errorRecovery: options.errorRecovery,
      maxRetriesPerSegment: options.maxRetriesPerSegment,
      retryExhaustedFallback: options.retryExhaustedFallback,
      abortSignal: options.abortSignal,
      onProgress: options.onProgress,
      overlapChars: options.overlapChars,
      textSkipPlaceholder: options.textSkipPlaceholder,
      linkMap: options.linkMap,
      sampleRate,
      channels: 1,
    }
  );
}
