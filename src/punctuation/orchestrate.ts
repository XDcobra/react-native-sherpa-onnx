import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineTextPipeline } from '../pipeline/offlineOrchestrator';
import type { OrchestrationResult } from '../pipeline/offlineOrchestrator';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { OfflinePunctuateOptions } from './types';

const DEFAULT_PUNCTUATION_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'text_synthetic_auto',
  sentenceBoundary: true,
  maxLengthChars: 500,
};

export async function runOfflinePunctuationPipeline(
  input: OfflineTextBufferIdSource,
  instanceId: string,
  options: OfflinePunctuateOptions = {}
): Promise<OrchestrationResult<OfflineTextBufferRef>> {
  const mode = options.segmentation?.mode ?? 'off';
  const segmentation =
    mode === 'off'
      ? { mode: 'off' as const }
      : {
          mode,
          policy:
            options.segmentation?.policy ??
            DEFAULT_PUNCTUATION_SEGMENTATION_POLICY,
        };

  if (segmentation.mode !== 'off') {
    const evaluator = segmentation.policy.evaluator;
    if (
      evaluator !== 'text_synthetic_auto' &&
      evaluator !== 'text_punctuation_assisted'
    ) {
      throw new Error(
        `PUNCTUATION_INVALID_SEGMENTATION: offline punctuation requires a text segmentation evaluator; received ${evaluator}`
      );
    }
  }

  return runOfflineTextPipeline(
    input,
    async (segIn, segOut) => {
      await SherpaOnnx.punctuateOfflineTextBuffers(
        instanceId,
        segIn.bufferId,
        segOut.bufferId
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
    }
  );
}
