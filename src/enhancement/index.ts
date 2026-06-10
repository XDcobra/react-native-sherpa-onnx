import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import { isDetectionSource } from './types';
import {
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import type { SpeechSegment } from '../segment/segment';
import type {
  DetectedModelEntry,
  DetectionSource,
  EnhancementDetectResult,
  EnhancementEngine,
  EnhancementInitializeOptions,
  EnhanceOptions,
  EnhancementResult,
} from './types';
import type {
  OfflineAudioBufferIdSource,
  LiveAudioBufferIdSource,
  LiveAudioBufferRef,
} from '../audiobuffer/types';
import { runOfflineEnhancementPipeline } from './orchestrate';
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import { subscribeLiveAudioBufferEvents } from '../audiobuffer';
import type { EnhancementLivePipelineOptions } from './types';
import type { EnhancementPipelineHandle } from './streamingTypes';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import { buildEnhancementInitBridgeOptions } from './enhancementNativeBridge';

let enhancementInstanceCounter = 0;

function isLiveAudioSource(buffer: unknown): buffer is LiveAudioBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveAudioBufferRef).info === 'object' &&
    (buffer as LiveAudioBufferRef).info?.kind === 'livePcmBuffer'
  ) {
    return true;
  }
  return false;
}

function createEnhancementPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId?: string
): EnhancementPipelineHandle {
  const completed = createStreamingPipelineCompletionPromise(pipelineId);
  return {
    instanceId,
    pipelineId,
    completed,
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
      if (attachedEngineId) {
        await detachSegmentationEngine(attachedEngineId).catch(() => undefined);
      }
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

async function enhanceLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  audioOut: LiveAudioBufferIdSource,
  options: EnhancementLivePipelineOptions
): Promise<EnhancementPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline enhancement',
    domain: 'speech',
    supportedEvaluators: ['continuous_frames'],
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineAudioBufferId(audioIn);
  const outId = resolvePipelineAudioBufferId(audioOut);

  const attached = await attachSegmentationEngine(audioIn, { policy });
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
      'ENHANCEMENT_ERROR: segmentation engine did not produce a segment buffer for speech domain'
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startEnhancementOfflineLivePipeline(
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

  const handle = createEnhancementPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId
  );

  if (options.onSegment) {
    const cb = options.onSegment;
    const unsub = subscribeLiveAudioBufferEvents(outId, {
      onSegment: (event) => cb(event.segment as SpeechSegment),
    });
    handle.completed.then(unsub, unsub);
  }

  return handle;
}

export async function detectEnhancementModel(
  source: FileSource,
  options?: {
    modelType?: EnhancementInitializeOptions['modelType'];
    assetName?: string;
  }
): Promise<EnhancementDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectEnhancementModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const detectionSources: DetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Enhancement,
    modelType: raw.modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelFilePath =
    typeof raw.paths?.model === 'string' ? raw.paths.model.trim() : '';
  const isStreaming = raw.isStreaming === true;
  return {
    success: raw.success,
    isStreaming,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(modelFilePath.length > 0 ? { paths: { model: modelFilePath } } : {}),
  };
}

export async function createEnhancement(
  options: EnhancementInitializeOptions
): Promise<EnhancementEngine> {
  const instanceId = `enhancement_${++enhancementInstanceCounter}`;
  const bridgeOptions = await buildEnhancementInitBridgeOptions(options);
  const init = await SherpaOnnx.initializeEnhancement(
    instanceId,
    bridgeOptions
  );

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Enhancement initialization failed: ${nativeError}`
        : `Enhancement initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Enhancement instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    enhance: (async (
      audioIn: OfflineAudioBufferIdSource | LiveAudioBufferIdSource,
      audioOut: OfflineAudioBufferIdSource | LiveAudioBufferIdSource,
      enhanceOptions?: EnhanceOptions | EnhancementLivePipelineOptions
    ): Promise<EnhancementResult | EnhancementPipelineHandle> => {
      guard();

      const inIsLive = isLiveAudioSource(audioIn);
      const outIsLive = isLiveAudioSource(audioOut);

      if (inIsLive || outIsLive) {
        if (!(inIsLive && outIsLive)) {
          throw new Error(
            'ENHANCE_INVALID_ARGUMENT: enhance() overload mismatch. Use (OfflineAudio, OfflineAudio, options?) or (LiveAudio, LiveAudio, options).'
          );
        }
        return enhanceLiveOverload(
          instanceId,
          audioIn as LiveAudioBufferIdSource,
          audioOut as LiveAudioBufferIdSource,
          enhanceOptions as EnhancementLivePipelineOptions
        );
      }

      const startedAtMs = Date.now();
      const inId = resolvePipelineAudioBufferId(
        audioIn as OfflineAudioBufferIdSource
      );
      const outId = resolvePipelineAudioBufferId(
        audioOut as OfflineAudioBufferIdSource
      );

      const segmentationMode = enhanceOptions?.segmentation?.mode ?? 'off';
      if (segmentationMode === 'off') {
        await SherpaOnnx.enhanceOfflineAudioBuffers(instanceId, inId, outId);
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: Date.now() - startedAtMs,
        };
      }

      const orchestrated = await runOfflineEnhancementPipeline(
        inId,
        instanceId,
        enhanceOptions ?? {}
      );

      const outputBuffer = orchestrated.outputBuffer;
      if (outputBuffer) {
        try {
          await SherpaOnnx.populateOfflineAudioBufferIfEmpty(
            outId,
            outputBuffer.bufferId,
            undefined
          );
        } finally {
          // Source may already be consumed by populate; release is best-effort cleanup.
          await releasePipelineAudioBuffer(outputBuffer.bufferId).catch(
            () => undefined
          );
        }
      }

      return {
        status: orchestrated.status,
        totalSegments: orchestrated.totalSegments,
        completedSegments: orchestrated.completedSegments,
        skippedSegments: orchestrated.skippedSegments,
        ...(orchestrated.failedSegment
          ? { failedSegment: orchestrated.failedSegment }
          : {}),
        processingTimeMs: orchestrated.processingTimeMs,
      };
    }) as EnhancementEngine['enhance'],
    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getEnhancementSampleRate(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadEnhancement(instanceId);
    },
  };
}

export { createStreamingEnhancement } from './streaming';
export type {
  StreamingEnhancementEngine,
  StreamingEnhancementInitializeOptions,
  StreamingEnhancementEnhanceOptions,
  EnhancementPipelineHandle,
} from './streamingTypes';

export type {
  EnhancementModelType,
  EnhancementConcreteModelType,
  EnhancementInitOptionsShared,
  EnhancementAutoInitializeOptions,
  EnhancementCustomInitializeOptions,
  EnhancementInitializeOptions,
  EnhancementDetectResult,
  EnhancementEngine,
  EnhanceOptions,
  EnhancementResult,
  EnhanceSegmentationConfig,
} from './types';
export {
  assertEnhancementCustomConfig,
  resolveEnhancementCustomConfigPaths,
  EnhancementErrorCode,
  type EnhancementCustomConfig,
  type EnhancementCustomPathKey,
} from './customConfig';
export { ENHANCEMENT_MODEL_TYPES } from './types';
