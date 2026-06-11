/**
 * Source Separation feature module.
 *
 * Offline batch separation via `createSeparation` + `engine.separate(audioIn, audioOuts)`.
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectedModelEntry,
  type DetectionSource,
} from '../types/modelDetect';
import {
  resolvePipelineAudioBufferId,
  releasePipelineAudioBuffer,
  subscribeLiveAudioBufferEvents,
} from '../audiobuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type {
  LiveAudioBufferIdSource,
  LiveAudioBufferRef,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import { validateLiveOfflinePipelineOptions } from '../livePipeline/validation';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import type { SpeechSegment } from '../segment/segment';
import type {
  SeparationDetectResult,
  SeparationEngine,
  SeparationInitializeOptions,
  SeparationLivePipelineOptions,
  SeparationModelType,
  SeparateOptions,
  SeparationResult,
} from './types';
import type { SeparationPipelineHandle } from './streamingTypes';
import { SeparationErrorCode } from './customConfig';
import { buildSeparationInitBridgeOptions } from './separationNativeBridge';
import {
  runOfflineSeparationDirect,
  runOfflineSeparationPipeline,
} from './orchestrate';

let separationInstanceCounter = 0;

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

function createSeparationPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId?: string
): SeparationPipelineHandle {
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

async function separateLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  audioOuts: readonly LiveAudioBufferIdSource[],
  options: SeparationLivePipelineOptions
): Promise<SeparationPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline source separation',
    domain: 'speech',
    supportedEvaluators: ['continuous_frames'],
    segmentation: options.segmentation,
  });

  const numStems = await SherpaOnnx.getSeparationNumStems(instanceId);
  if (audioOuts.length !== numStems) {
    throw new Error(
      `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects ${numStems} output buffers, got ${audioOuts.length}`
    );
  }

  const inId = resolvePipelineAudioBufferId(audioIn);
  const outIds = audioOuts.map(resolvePipelineAudioBufferId);

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
      'SEPARATION_ERROR: segmentation engine did not produce a segment buffer for speech domain'
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startSeparationOfflineLivePipeline(
      instanceId,
      inId,
      outIds,
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

  const handle = createSeparationPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId
  );

  if (options.onSegment) {
    const cb = options.onSegment;
    const stem0OutId = outIds[0];
    if (stem0OutId != null) {
      const unsub = subscribeLiveAudioBufferEvents(stem0OutId, {
        onSegment: (event) => cb(event.segment as SpeechSegment),
      });
      handle.completed.then(unsub, unsub);
    }
  }

  return handle;
}

function readNonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Detect source separation model layout (Spleeter vs UVR) without running inference.
 * Offline only — `isStreaming` is always `false`.
 */
export async function detectSeparationModel(
  source: FileSource,
  options?: {
    modelType?: SeparationModelType | 'auto';
    assetName?: string;
  }
): Promise<SeparationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectSeparationModel(
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
  const resolvedLanguages = publicLanguageHintsFromNative({
    domain: ModelCategory.Separation,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const vocals = readNonEmptyPath(raw.paths?.vocals);
  const accompaniment = readNonEmptyPath(raw.paths?.accompaniment);
  const model = readNonEmptyPath(raw.paths?.model);
  const paths =
    vocals != null || accompaniment != null || model != null
      ? {
          ...(vocals != null ? { vocals } : {}),
          ...(accompaniment != null ? { accompaniment } : {}),
          ...(model != null ? { model } : {}),
        }
      : undefined;
  return {
    success: raw.success,
    isStreaming: false,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(paths != null ? { paths } : {}),
  };
}

/**
 * Create an offline source-separation engine.
 *
 * @throws Error if native init fails (`Separation initialization failed: …`)
 */
export async function createSeparation(
  options: SeparationInitializeOptions
): Promise<SeparationEngine> {
  const instanceId = `separation_${++separationInstanceCounter}`;
  const bridgeOptions = await buildSeparationInitBridgeOptions(options);
  const init = await SherpaOnnx.initializeSeparation(instanceId, bridgeOptions);

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Separation initialization failed: ${nativeError}`
        : `Separation initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Separation instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    separate: (async (
      audioIn: OfflineAudioBufferIdSource | LiveAudioBufferIdSource,
      audioOuts: readonly (
        | OfflineAudioBufferIdSource
        | LiveAudioBufferIdSource
      )[],
      separateOptions?: SeparateOptions | SeparationLivePipelineOptions
    ): Promise<SeparationResult | SeparationPipelineHandle> => {
      guard();

      const inIsLive = isLiveAudioSource(audioIn);
      const outsAreLive = audioOuts.every(isLiveAudioSource);

      if (inIsLive || outsAreLive) {
        if (!(inIsLive && outsAreLive)) {
          throw new Error(
            `${SeparationErrorCode.INVALID_ARGUMENT}: separate() overload mismatch. Use (OfflineAudio, OfflineAudio[], options?) or (LiveAudio, LiveAudio[], options).`
          );
        }
        return separateLiveOverload(
          instanceId,
          audioIn as LiveAudioBufferIdSource,
          audioOuts as readonly LiveAudioBufferIdSource[],
          separateOptions as SeparationLivePipelineOptions
        );
      }

      const mode =
        (separateOptions as SeparateOptions | undefined)?.segmentation?.mode ??
        'off';

      const numStems = await SherpaOnnx.getSeparationNumStems(instanceId);
      if (audioOuts.length !== numStems) {
        throw new Error(
          `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects ${numStems} output buffers, got ${audioOuts.length}`
        );
      }

      resolvePipelineAudioBufferId(audioIn);
      for (const out of audioOuts) {
        resolvePipelineAudioBufferId(out);
      }

      if (mode === 'off') {
        const startedAtMs = Date.now();
        await runOfflineSeparationDirect(
          instanceId,
          audioIn as OfflineAudioBufferIdSource,
          audioOuts as readonly OfflineAudioBufferIdSource[]
        );
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: Date.now() - startedAtMs,
        };
      }

      const orchestrated = await runOfflineSeparationPipeline(
        audioIn as OfflineAudioBufferIdSource,
        instanceId,
        audioOuts as readonly OfflineAudioBufferIdSource[],
        (separateOptions as SeparateOptions | undefined) ?? {}
      );

      const outputBuffers = orchestrated.outputBuffers;
      if (outputBuffers) {
        for (let i = 0; i < outputBuffers.length; i++) {
          const callerOut = audioOuts[i];
          const orchestratedOut = outputBuffers[i];
          if (callerOut == null || orchestratedOut == null) continue;
          const callerOutId = resolvePipelineAudioBufferId(callerOut);
          try {
            await SherpaOnnx.populateOfflineAudioBufferIfEmpty(
              callerOutId,
              orchestratedOut.bufferId,
              undefined
            );
          } finally {
            await releasePipelineAudioBuffer(orchestratedOut.bufferId).catch(
              () => undefined
            );
          }
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
    }) as SeparationEngine['separate'],
    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getSeparationSampleRate(instanceId);
    },
    async getNumStems(): Promise<number> {
      guard();
      return SherpaOnnx.getSeparationNumStems(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadSeparation(instanceId);
    },
  };
}

export type {
  SeparationModelType,
  SeparationConcreteModelType,
  SeparationInitOptionsShared,
  SeparationAutoInitializeOptions,
  SeparationCustomInitializeOptions,
  SeparationInitializeOptions,
  SeparateSegmentationConfig,
  SeparateOptions,
  SeparationResult,
  SeparationStemIndex,
  SeparationEngineInfo,
  SeparationEngine,
  SeparationLivePipelineOptions,
  SeparationDetectResult,
  SeparationDetectModelResult,
} from './types';
export type { SeparationPipelineHandle } from './streamingTypes';
export { SEPARATION_MODEL_TYPES, SEPARATION_STEM_LABELS } from './types';

export {
  assertSeparationCustomConfig,
  resolveSeparationCustomConfigPaths,
  resolveSpleeterCustomConfigPaths,
  resolveUvrCustomConfigPaths,
  SeparationErrorCode,
  type SpleeterCustomConfig,
  type UvrCustomConfig,
  type SpleeterCustomPathKey,
  type UvrCustomPathKey,
} from './customConfig';
