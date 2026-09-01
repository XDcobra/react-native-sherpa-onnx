import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { runOfflineAudioMultiOutputPipeline } from '../pipeline/offlineOrchestrator';
import type { OrchestrationResult } from '../pipeline/offlineOrchestrator';
import type {
  OfflineAudioBufferIdSource,
  OfflineAudioBufferRef,
} from '../audiobuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import { validateSegmentationConfig } from '../segment/validation';
import type { SeparateOptions, SeparationResult } from './types';
import { SeparationErrorCode } from './customConfig';

const DEFAULT_SEPARATION_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 120000,
  hangoverMs: 300,
};

/** Single batch call — used by MVP direct path and as orchestrator primitive. */
export async function runOfflineSeparationDirect(
  instanceId: string,
  audioIn: OfflineAudioBufferIdSource,
  audioOuts: readonly OfflineAudioBufferIdSource[]
): Promise<void> {
  const inId = resolvePipelineAudioBufferId(audioIn);
  const outIds = audioOuts.map(resolvePipelineAudioBufferId);
  await SherpaOnnx.separateOfflineAudioBuffers(instanceId, inId, outIds);
}

export type SeparationPipelineOrchestrationResult = SeparationResult & {
  outputBuffers?: readonly OfflineAudioBufferRef[];
};

export async function runOfflineSeparationPipeline(
  audioIn: OfflineAudioBufferIdSource,
  instanceId: string,
  audioOuts: readonly OfflineAudioBufferIdSource[],
  options: SeparateOptions = {}
): Promise<SeparationPipelineOrchestrationResult> {
  const numStems = await SherpaOnnx.getSeparationNumStems(instanceId);
  if (audioOuts.length !== numStems) {
    throw new Error(
      `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects ${numStems} output buffers, got ${audioOuts.length}`
    );
  }

  const segmentation = validateSegmentationConfig({
    mode: options.segmentation?.mode,
    policy: options.segmentation?.policy,
    featureName: 'offline source separation',
    domain: 'speech',
    supportsManual: false,
    defaultPolicy: DEFAULT_SEPARATION_SEGMENTATION_POLICY,
  });

  const orchestrated: OrchestrationResult<readonly OfflineAudioBufferRef[]> =
    await runOfflineAudioMultiOutputPipeline(
      audioIn,
      numStems,
      async (segIn, segOuts) => {
        await SherpaOnnx.separateOfflineAudioBuffers(
          instanceId,
          segIn.bufferId,
          segOuts.map((out) => out.bufferId)
        );
      },
      {
        segmentation,
        errorRecovery: options.errorRecovery,
        maxRetriesPerSegment: options.maxRetriesPerSegment,
        retryExhaustedFallback: options.retryExhaustedFallback,
        onProgress: options.onProgress,
        overlapSamples: options.overlapSamples,
      }
    );

  return {
    status: orchestrated.status,
    totalSegments: orchestrated.totalSegments,
    completedSegments: orchestrated.completedSegments,
    skippedSegments: orchestrated.skippedSegments,
    ...(orchestrated.failedSegment
      ? { failedSegment: orchestrated.failedSegment }
      : {}),
    processingTimeMs: orchestrated.processingTimeMs,
    ...(orchestrated.outputBuffer != null
      ? { outputBuffers: orchestrated.outputBuffer }
      : {}),
  };
}
