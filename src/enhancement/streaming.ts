import SherpaOnnx from '../NativeSherpaOnnx';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import { resolveModelPath } from '../utils';
import type { EnhancementModelType } from './types';
import type {
  EnhancementPipelineHandle,
  StreamingEnhancementEngine,
  StreamingEnhancementInitializeOptions,
} from './streamingTypes';

let streamingEnhancementInstanceCounter = 0;

function createEnhancementPipelineHandle(
  instanceId: string,
  pipelineId: string
): EnhancementPipelineHandle {
  return {
    instanceId,
    get pipelineId() {
      return pipelineId;
    },
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
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
  const resolvedPath = await resolveModelPath(options.modelPath);
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
      outputBufferId: string
    ): Promise<EnhancementPipelineHandle> {
      guard();
      const raw = await SherpaOnnx.startEnhancementPipeline(
        instanceId,
        inputBufferId,
        outputBufferId
      );
      return createEnhancementPipelineHandle(instanceId, raw.pipelineId);
    },
  };
}

export type {
  StreamingEnhancementEngine,
  EnhancementPipelineHandle,
} from './streamingTypes';
export type { EnhancementModelType };
