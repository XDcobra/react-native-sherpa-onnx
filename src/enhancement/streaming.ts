import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import { attachSegmentationEngine, detachSegmentationEngine } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import { resolveFileSourceForModelInit } from '../detect';
import type { EnhancementModelType } from './types';
import type {
  EnhancementPipelineHandle,
  StreamingEnhancementEngine,
  StreamingEnhancementEnhanceOptions,
  StreamingEnhancementInitializeOptions,
} from './streamingTypes';

let streamingEnhancementInstanceCounter = 0;

function createEnhancementPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedSegmentationEngineId?: string
): EnhancementPipelineHandle {
  let detached = false;
  const detachIfNeeded = async () => {
    if (!attachedSegmentationEngineId || detached) return;
    detached = true;
    try {
      await detachSegmentationEngine(attachedSegmentationEngineId, {
        flushFinal: true,
      });
    } catch {
      // Best effort: segmentation detach must not mask pipeline shutdown.
    }
  };

  const completed =
    createStreamingPipelineCompletionPromise(pipelineId).finally(
      detachIfNeeded
    );

  return {
    instanceId,
    get pipelineId() {
      return pipelineId;
    },
    completed,
    async stop(): Promise<void> {
      try {
        await SherpaOnnx.stopStreamingPipeline(pipelineId);
      } finally {
        await detachIfNeeded();
      }
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus(): Promise<StreamingPipelineStatus> {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

export async function createStreamingEnhancement(
  options: StreamingEnhancementInitializeOptions
): Promise<StreamingEnhancementEngine> {
  const instanceId = `streaming_enhancement_${++streamingEnhancementInstanceCounter}`;
  const resolvedPath = await resolveFileSourceForModelInit(options.modelSource);
  const result = await SherpaOnnx.initializeOnlineEnhancement(
    instanceId,
    resolvedPath,
    options.modelType ?? 'auto',
    options.numThreads,
    options.provider,
    options.debug
  );

  if (!result.success) {
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Streaming enhancement initialization failed: ${nativeError}`
        : `Streaming enhancement initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Streaming enhancement instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },

    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getEnhancementSampleRate(instanceId);
    },

    async getFrameShiftInSamples(): Promise<number> {
      guard();
      return Number(result.frameShiftInSamples ?? 0);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadOnlineEnhancement(instanceId);
    },

    async enhance(
      inputBufferId: string,
      outputBufferId: string,
      enhanceOptions?: StreamingEnhancementEnhanceOptions
    ): Promise<EnhancementPipelineHandle> {
      guard();

      const normalizedInputId = resolvePipelineAudioBufferId(inputBufferId);
      if (!normalizedInputId.startsWith('live_')) {
        throw new Error(
          'ENHANCEMENT_INVALID_ARGUMENT: streaming enhancement input buffer must be live_*'
        );
      }

      const normalizedOutputId = resolvePipelineAudioBufferId(outputBufferId);
      if (!normalizedOutputId.startsWith('live_')) {
        throw new Error(
          'ENHANCEMENT_INVALID_ARGUMENT: streaming enhancement output buffer must be live_*'
        );
      }

      const segmentation = validateSegmentationConfig({
        mode: enhanceOptions?.segmentation?.mode,
        policy: enhanceOptions?.segmentation?.policy,
        featureName: 'streaming enhancement',
        domain: 'speech',
        supportsManual: true,
        defaultPolicy: {
          evaluator: 'continuous_frames',
          checkpointIntervalMs: 1000,
        },
        supportedEvaluators: ['continuous_frames'],
        errorPrefix: 'ENHANCEMENT_INVALID_SEGMENTATION',
      });

      let attachedSegmentationEngineId: string | undefined;
      if (segmentation.mode === 'auto') {
        const attached = await attachSegmentationEngine(normalizedInputId, {
          policy: segmentation.policy,
        });
        attachedSegmentationEngineId = attached.engineId;
      }

      try {
        const raw = await SherpaOnnx.startEnhancementPipeline(
          instanceId,
          normalizedInputId,
          normalizedOutputId
        );
        return createEnhancementPipelineHandle(
          instanceId,
          raw.pipelineId,
          attachedSegmentationEngineId
        );
      } catch (err) {
        if (attachedSegmentationEngineId) {
          await detachSegmentationEngine(attachedSegmentationEngineId, {
            flushFinal: true,
          }).catch(() => undefined);
        }
        throw err;
      }
    },
  };
}

export type {
  StreamingEnhancementEngine,
  EnhancementPipelineHandle,
} from './streamingTypes';
export type { EnhancementModelType };
