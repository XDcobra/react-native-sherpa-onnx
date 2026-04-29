import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineAudioPipeline } from '../pipeline/offlineOrchestrator';
import type { OrchestrationResult } from '../pipeline/offlineOrchestrator';
import type {
  OfflineAudioBufferIdSource,
  OfflineAudioBufferRef,
} from '../audiobuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { EnhanceOptions } from './types';

const DEFAULT_ENHANCEMENT_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
  hangoverMs: 300,
};

export async function runOfflineEnhancementPipeline(
  input: OfflineAudioBufferIdSource,
  instanceId: string,
  options: EnhanceOptions = {}
): Promise<OrchestrationResult<OfflineAudioBufferRef>> {
  const mode = options.segmentation?.mode ?? 'off';
  const segmentation =
    mode === 'off'
      ? { mode: 'off' as const }
      : {
          mode,
          policy:
            options.segmentation?.policy ??
            DEFAULT_ENHANCEMENT_SEGMENTATION_POLICY,
        };

  return runOfflineAudioPipeline(
    input,
    async (segIn, segOut) => {
      await SherpaOnnx.enhanceOfflineAudioBuffers(
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
      overlapSamples: options.overlapSamples,
    }
  );
}
