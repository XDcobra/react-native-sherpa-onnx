import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import { resolveOfflineTextBufferId } from '../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type {
  OfflinePunctuateResult,
  OfflinePunctuationEngine,
  OfflinePunctuationInitializeOptions,
} from './types';

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

  return {
    get instanceId() {
      return instanceId;
    },
    async punctuate(
      textIn: OfflineTextBufferIdSource,
      textOut: OfflineTextBufferIdSource
    ): Promise<OfflinePunctuateResult> {
      guard();
      const inId = resolveOfflineTextBufferId(textIn);
      const outId = resolveOfflineTextBufferId(textOut);
      const raw = await SherpaOnnx.punctuateOfflineTextBuffers(
        instanceId,
        inId,
        outId
      );
      return { processingTimeMs: raw.processingTimeMs };
    },
    async punctuateString(
      plain: string,
      textOut: OfflineTextBufferRef
    ): Promise<OfflinePunctuateResult> {
      guard();
      const outId = resolveOfflineTextBufferId(textOut);
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
