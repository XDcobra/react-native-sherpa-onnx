import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
} from '../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type {
  OfflinePunctuateResult,
  OfflinePunctuateOptions,
  OfflinePunctuationEngine,
  OfflinePunctuationInitializeOptions,
} from './types';
import { runOfflinePunctuationPipeline } from './orchestrate';

let offlinePunctInstanceCounter = 0;

/**
 * Create an offline punctuation engine using sherpa-onnx `OfflinePunctuation` (CT-Transformer).
 * Initialization fails deterministically if the model directory is not a valid **offline** CT layout
 * (see native detect with `ct_transformer`).
 */
export async function createOfflinePunctuation(
  options: OfflinePunctuationInitializeOptions
): Promise<OfflinePunctuationEngine> {
  const instanceId = `punc_off_${++offlinePunctInstanceCounter}`;
  const resolvedPath = await resolveModelPath(options.modelPath);
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
    punctuate: punctuateOffline,
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
