import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineTextPipeline } from '../pipeline/offlineOrchestrator';
import type { OrchestrationResult } from '../pipeline/offlineOrchestrator';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import { validateSegmentationConfig } from '../segment/validation';
import type { OfflinePunctuateOptions } from './types';
import { resolveTextInputNormalization } from './textInputNormalization';

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
  const segmentation = validateSegmentationConfig({
    mode: options.segmentation?.mode,
    policy: options.segmentation?.policy,
    featureName: 'offline punctuation',
    domain: 'text',
    supportsManual: false,
    defaultPolicy: DEFAULT_PUNCTUATION_SEGMENTATION_POLICY,
  });

  const textInputNormalization = resolveTextInputNormalization(
    options.textInputNormalization
  );

  return runOfflineTextPipeline(
    input,
    async (segIn, segOut) => {
      await SherpaOnnx.punctuateOfflineTextBuffers(
        instanceId,
        segIn.bufferId,
        segOut.bufferId,
        textInputNormalization
      );
    },
    {
      segmentation,
      errorRecovery: options.errorRecovery,
      maxRetriesPerSegment: options.maxRetriesPerSegment,
      retryExhaustedFallback: options.retryExhaustedFallback,
      onProgress: options.onProgress,
      overlapChars: options.overlapChars,
      textSkipPlaceholder: options.textSkipPlaceholder,
      linkMap: options.linkMap,
    }
  );
}
