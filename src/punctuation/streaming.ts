import SherpaOnnx from '../NativeSherpaOnnx';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import { attachSegmentationEngine, detachSegmentationEngine } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import {
  getPipelineTextBufferInfo,
  resolvePipelineTextBufferId,
} from '../textbuffer';
import { resolveModelPath } from '../utils';
import { createOnlinePunctuationConfig } from './detect';
import type {
  PunctuationPipelineHandle,
  StreamingPunctuationEngine,
  StreamingPunctuationInitializeOptions,
  StreamingPunctuationOptions,
} from './streamingTypes';

let streamingPunctuationInstanceCounter = 0;

function createPunctuationPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedSegmentationEngineId?: string
): PunctuationPipelineHandle {
  let detached = false;
  const detachIfNeeded = async () => {
    if (!attachedSegmentationEngineId || detached) return;
    detached = true;
    try {
      await detachSegmentationEngine(attachedSegmentationEngineId, {
        flushFinal: true,
      });
    } catch {
      // Best-effort cleanup; pipeline completion remains authoritative.
    }
  };

  const completed = createStreamingPipelineCompletionPromise(pipelineId)
    .finally(detachIfNeeded)
    .then(() => undefined);

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

export async function createStreamingPunctuation(
  options: StreamingPunctuationInitializeOptions
): Promise<StreamingPunctuationEngine> {
  const instanceId = `punc_on_${++streamingPunctuationInstanceCounter}`;
  const resolvedPath = await resolveModelPath(options.modelPath);
  await createOnlinePunctuationConfig(resolvedPath, {
    modelType: options.modelType ?? 'auto',
  });
  const result = await SherpaOnnx.initializeOnlinePunctuation(
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
        ? `Streaming punctuation initialization failed: ${nativeError}`
        : `Streaming punctuation initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Streaming punctuation instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    async punctuate(
      textIn,
      textOut,
      punctuateOptions?: StreamingPunctuationOptions
    ): Promise<PunctuationPipelineHandle> {
      guard();

      const inputId = resolvePipelineTextBufferId(textIn);
      const outputId = resolvePipelineTextBufferId(textOut);
      const inputInfo = await getPipelineTextBufferInfo(inputId);
      const outputInfo = await getPipelineTextBufferInfo(outputId);
      if (inputInfo.kind !== 'liveTextBuffer') {
        throw new Error(
          'PUNCTUATION_INVALID_ARGUMENT: streaming punctuation input buffer must be txt_live_*'
        );
      }
      if (outputInfo.kind !== 'liveTextBuffer') {
        throw new Error(
          'PUNCTUATION_INVALID_ARGUMENT: streaming punctuation output buffer must be txt_live_*'
        );
      }

      const segmentation = validateSegmentationConfig({
        mode: punctuateOptions?.segmentation?.mode,
        policy: punctuateOptions?.segmentation?.policy,
        featureName: 'streaming punctuation',
        domain: 'text',
        supportsManual: true,
        defaultPolicy: {
          evaluator: 'text_punctuation_assisted',
          punctuationInstanceId: instanceId,
          sentenceBoundary: true,
          maxLengthChars: 500,
        },
      });

      let attachedSegmentationEngineId: string | undefined;
      if (segmentation.mode === 'auto') {
        const attached = await attachSegmentationEngine(inputId, {
          policy: segmentation.policy,
        });
        attachedSegmentationEngineId = attached.engineId;
      }

      try {
        const raw = await SherpaOnnx.startStreamingPunctuationPipeline(
          instanceId,
          inputId,
          outputId
        );
        return createPunctuationPipelineHandle(
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
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadOnlinePunctuation(instanceId);
    },
  };
}

export type {
  StreamingPunctuationEngine,
  PunctuationPipelineHandle,
} from './streamingTypes';
