import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineTextToAudioPipeline } from '../pipeline/offlineOrchestrator';
import type { TextToAudioOrchestrationResult } from '../pipeline/offlineOrchestrator';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import { validateSegmentationConfig } from '../segment/validation';
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
  const segmentation = validateSegmentationConfig({
    mode: options.segmentation?.mode,
    policy: options.segmentation?.policy,
    featureName: 'offline TTS',
    domain: 'text',
    supportsManual: false,
    defaultPolicy: DEFAULT_TTS_SEGMENTATION_POLICY,
  });

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
