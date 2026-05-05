import SherpaOnnx from '../NativeSherpaOnnx';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import { resolveFileSourceForModelInit } from '../detect';
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
  resolvePipelineTextBufferId,
  subscribeLiveTextBufferEvents,
} from '../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
  LiveTextBufferIdSource,
  LiveTextBufferRef,
  PipelineTextBufferIdSource,
} from '../textbuffer/types';
import type {
  OfflinePunctuateResult,
  OfflinePunctuateOptions,
  OfflinePunctuationEngine,
  OfflinePunctuationInitializeOptions,
  PunctuationLivePipelineOptions,
} from './types';
import { runOfflinePunctuationPipeline } from './orchestrate';
import type { TextSegment } from '../segment/segment';
import type { PunctuationPipelineHandle } from './streamingTypes';

let offlinePunctInstanceCounter = 0;

function isLiveTextSource(buffer: unknown): buffer is LiveTextBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('txt_live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveTextBufferRef).info === 'object' &&
    (buffer as LiveTextBufferRef).info?.kind === 'liveTextBuffer'
  ) {
    return true;
  }
  return false;
}

function createPunctuationPipelineHandle(
  instanceId: string,
  pipelineId: string
): PunctuationPipelineHandle {
  const completed = createStreamingPipelineCompletionPromise(pipelineId).then(
    () => undefined
  );

  return {
    instanceId,
    pipelineId,
    completed,
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus() {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

async function punctuateLiveOverload(
  instanceId: string,
  textIn: LiveTextBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: PunctuationLivePipelineOptions
): Promise<PunctuationPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline punctuation',
    domain: 'text',
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineTextBufferId(
    textIn as PipelineTextBufferIdSource
  );
  const outId = resolvePipelineTextBufferId(
    textOut as PipelineTextBufferIdSource
  );

  const attached = await attachSegmentationEngine(
    textIn as PipelineTextBufferIdSource,
    { policy }
  );

  let engineInfo: Awaited<ReturnType<typeof getSegmentationEngineInfo>>;
  try {
    engineInfo = await getSegmentationEngineInfo(attached.engineId);
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const segmentLiveBufferId = engineInfo.segmentBufferId;
  if (!segmentLiveBufferId) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw new Error(
      'PUNCTUATION_ERROR: segmentation engine did not produce a segment buffer for text domain'
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startPunctuationOfflineLivePipeline(
      instanceId,
      inId,
      outId,
      {
        attachedSegmentationEngineId: attached.engineId,
        segmentLiveBufferId,
      }
    );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const handle = createPunctuationPipelineHandle(instanceId, pipelineId);

  if (options.onSegment) {
    const cb = options.onSegment;
    const unsub = subscribeLiveTextBufferEvents(textOut, {
      onSegment: (event) => cb(event.segment as TextSegment),
    });
    handle.completed.then(unsub, unsub);
  }

  return handle;
}

/**
 * Create an offline punctuation engine using sherpa-onnx `OfflinePunctuation` (CT-Transformer).
 * Initialization fails deterministically if the model directory is not a valid **offline** CT layout
 * (see native detect with `ct_transformer`).
 */
export async function createOfflinePunctuation(
  options: OfflinePunctuationInitializeOptions
): Promise<OfflinePunctuationEngine> {
  const instanceId = `punc_off_${++offlinePunctInstanceCounter}`;
  const resolvedPath = await resolveFileSourceForModelInit(options.modelSource);
  const modelType = options.modelType ?? 'auto';

  const init = await SherpaOnnx.initializeOfflinePunctuation(
    instanceId,
    resolvedPath,
    modelType,
    options.numThreads,
    options.provider,
    options.debug
  );

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Offline punctuation initialization failed: ${nativeError}`
        : `Offline punctuation initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Offline punctuation instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const punctuateOffline = async (
    textIn: OfflineTextBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    punctuateOptions?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult> => {
    guard();
    const inId = resolveOfflineTextBufferId(textIn);
    const outId = resolveOfflineTextBufferId(textOut);
    const mode = punctuateOptions?.segmentation?.mode ?? 'off';
    if (mode !== 'off') {
      const result = await runOfflinePunctuationPipeline(
        inId,
        instanceId,
        punctuateOptions
      );
      if (result.outputBuffer) {
        const info = await getPipelineTextBufferInfo(result.outputBuffer);
        if (info.kind !== 'offlineTextBuffer') {
          throw new Error(
            'PUNCTUATION_ORCHESTRATION_ERROR: segmented punctuation produced a non-offline text output'
          );
        }
        const finalText =
          info.utf16Length > 0
            ? await getOfflineTextBufferTextSlice(
                result.outputBuffer,
                0,
                info.utf16Length
              )
            : '';
        await SherpaOnnx.populateOfflineTextBufferIfEmpty(outId, finalText, {});
        await releasePipelineTextBuffer(result.outputBuffer).catch(
          () => undefined
        );
      }
      return {
        processingTimeMs: result.processingTimeMs,
        status: result.status,
        totalSegments: result.totalSegments,
        completedSegments: result.completedSegments,
        skippedSegments: result.skippedSegments,
        ...(result.failedSegment
          ? { failedSegment: result.failedSegment }
          : {}),
      };
    }
    const raw = await SherpaOnnx.punctuateOfflineTextBuffers(
      instanceId,
      inId,
      outId
    );
    return { processingTimeMs: raw.processingTimeMs };
  };

  return {
    get instanceId() {
      return instanceId;
    },
    punctuate: (async (
      textIn: OfflineTextBufferIdSource | LiveTextBufferIdSource,
      textOut: OfflineTextBufferIdSource | LiveTextBufferIdSource,
      options?: OfflinePunctuateOptions | PunctuationLivePipelineOptions
    ): Promise<OfflinePunctuateResult | PunctuationPipelineHandle> => {
      guard();

      const inIsLive = isLiveTextSource(textIn);
      const outIsLive = isLiveTextSource(textOut);

      if (inIsLive || outIsLive) {
        if (!(inIsLive && outIsLive)) {
          throw new Error(
            'PUNCTUATION_INVALID_ARGUMENT: punctuate() overload mismatch. Use (OfflineText, OfflineText, options?) or (LiveText, LiveText, options).'
          );
        }
        return punctuateLiveOverload(
          instanceId,
          textIn,
          textOut,
          options as PunctuationLivePipelineOptions
        );
      }

      return punctuateOffline(
        textIn as OfflineTextBufferIdSource,
        textOut as OfflineTextBufferIdSource,
        options as OfflinePunctuateOptions | undefined
      );
    }) as OfflinePunctuationEngine['punctuate'],
    async punctuateString(
      plain: string,
      textOut: OfflineTextBufferRef,
      options?: OfflinePunctuateOptions
    ): Promise<OfflinePunctuateResult> {
      guard();
      const outId = resolveOfflineTextBufferId(textOut);
      const mode = options?.segmentation?.mode ?? 'off';
      if (mode !== 'off') {
        const input = await createEmptyOfflineTextBuffer();
        await SherpaOnnx.populateOfflineTextBufferIfEmpty(
          input.bufferId,
          plain,
          {}
        );
        try {
          return await punctuateOffline(input, outId, options);
        } finally {
          await releasePipelineTextBuffer(input).catch(() => undefined);
        }
      }
      const raw = await SherpaOnnx.punctuateOfflineString(
        instanceId,
        plain,
        outId
      );
      return { processingTimeMs: raw.processingTimeMs };
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadOfflinePunctuation(instanceId);
    },
  };
}
