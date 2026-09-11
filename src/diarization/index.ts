/**
 * Speaker Diarization feature module.
 *
 * Offline batch diarization via `createDiarization` + `engine.diarize(audioIn, segmentOut)`.
 * Detect for pyannote / reverb segmentation packs is also exported.
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import {
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import {
  getPipelineSegmentBufferInfo,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import type { OfflineSegmentBufferInfo } from '../segmentbuffer/types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type {
  DiarizationClusterEmbedding,
  DiarizationEngine,
  DiarizationInitializeOptions,
  DiarizationReclusterOptions,
  DiarizeOptions,
  DiarizeResult,
} from './types';
import { DiarizationErrorCode } from './types';
import { buildDiarizationInitBridgeOptions } from './diarizationNativeBridge';

export type {
  DetectedModelEntry,
  DetectionSource,
  DiarizationClusterEmbedding,
  DiarizationConcreteModelType,
  DiarizationDetectResult,
  DiarizationEmbeddingOptions,
  DiarizationEngine,
  DiarizationInitializeOptions,
  DiarizationModelKind,
  DiarizationNameSearch,
  DiarizationReclusterOptions,
  DiarizationSegmentationOptions,
  DiarizeOptions,
  DiarizeResult,
  MapDiarizationToNamesOptions,
  MapDiarizationToNamesResult,
  NamedDiarizationSpan,
} from './types';

export {
  DETECTION_SOURCES,
  DIARIZATION_MODEL_KINDS,
  DiarizationErrorCode,
  isDetectionSource,
} from './types';

export type {
  DiarizationCustomConfig,
  DiarizationCustomPathKey,
} from './customConfig';

export {
  assertDiarizationCustomConfig,
  resolveDiarizationCustomConfigPaths,
} from './customConfig';

export { mapDiarizationToNames } from './mapDiarizationToNames';

let diarizationInstanceCounter = 0;

function asOfflineSegmentBufferInfo(
  info: { kind?: string; segmentCount?: number; bufferId?: string },
  label: string
): OfflineSegmentBufferInfo {
  if (info.kind !== 'offlineSegmentBuffer') {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: ${label} must be an offline segment buffer`
    );
  }
  return info as OfflineSegmentBufferInfo;
}

function validateInitOptions(options: DiarizationInitializeOptions): void {
  if (options == null || typeof options !== 'object') {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: options must be an object`
    );
  }
  if (options.segmentation?.modelSource == null) {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: segmentation.modelSource is required`
    );
  }
  if (options.embedding?.modelSource == null) {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: embedding.modelSource is required`
    );
  }
  if (
    options.segmentation.windowShiftRatio != null &&
    (typeof options.segmentation.windowShiftRatio !== 'number' ||
      !(options.segmentation.windowShiftRatio >= 0) ||
      options.segmentation.windowShiftRatio > 1)
  ) {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: windowShiftRatio must be in [0, 1]`
    );
  }
}

export { detectDiarizationModel } from './detectDiarizationModel';

async function finishDiarizeResult(params: {
  nativeResult: {
    success: boolean;
    error?: string;
    errorCode?: string;
    segments?: Array<{ start: number; end: number; speaker: number }>;
    segmentCount?: number;
    numSpeakers: number;
    sampleRate: number;
    speakersPerFrame?: number[];
  };
  startedAtMs: number;
  engineSampleRate: number;
  diarizeOptions?: DiarizeOptions;
}): Promise<DiarizeResult> {
  const { nativeResult, startedAtMs, engineSampleRate, diarizeOptions } =
    params;

  if (!nativeResult.success) {
    const code =
      typeof nativeResult.errorCode === 'string' &&
      nativeResult.errorCode.length > 0
        ? nativeResult.errorCode
        : DiarizationErrorCode.INVALID_ARGUMENT;
    if (
      code === DiarizationErrorCode.CANCELLED ||
      code === 'DIARIZATION_CANCELLED'
    ) {
      return {
        status: 'cancelled',
        numSpeakers: 0,
        segmentCount: 0,
        sampleRate: nativeResult.sampleRate || engineSampleRate,
        processingTimeMs: Date.now() - startedAtMs,
      };
    }
    throw new Error(
      `${code}: ${nativeResult.error?.trim() || 'diarization failed'}`
    );
  }

  const sr =
    nativeResult.sampleRate > 0 ? nativeResult.sampleRate : engineSampleRate;
  const count =
    typeof nativeResult.segmentCount === 'number' &&
    Number.isFinite(nativeResult.segmentCount)
      ? Math.max(0, nativeResult.segmentCount)
      : nativeResult.segments?.length ?? 0;

  if (diarizeOptions?.onProgress) {
    const progress: OrchestrationProgress = {
      currentSegment: Math.max(1, count),
      totalSegments: Math.max(1, count),
      fraction: 1,
      currentSegmentDurationMs: 0,
      elapsedMs: Date.now() - startedAtMs,
    };
    diarizeOptions.onProgress(progress);
  }

  const numSpeakers =
    Array.isArray(nativeResult.segments) && nativeResult.segments.length > 0
      ? new Set(nativeResult.segments.map((s) => s.speaker)).size
      : nativeResult.numSpeakers ?? 0;

  return {
    status: 'complete',
    numSpeakers,
    segmentCount: count,
    sampleRate: sr,
    processingTimeMs: Date.now() - startedAtMs,
    ...(Array.isArray(nativeResult.segments)
      ? { segments: nativeResult.segments }
      : {}),
    ...(diarizeOptions?.includeOverlap &&
    Array.isArray(nativeResult.speakersPerFrame)
      ? { speakersPerFrame: nativeResult.speakersPerFrame }
      : {}),
  };
}

export async function createDiarization(
  options: DiarizationInitializeOptions
): Promise<DiarizationEngine> {
  validateInitOptions(options);

  const instanceId = `diarization_${++diarizationInstanceCounter}`;
  const bridgeOptions = await buildDiarizationInitBridgeOptions(options);
  const init = await SherpaOnnx.initializeDiarization(
    instanceId,
    bridgeOptions
  );

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Diarization initialization failed: ${nativeError}`
        : `Diarization initialization failed for ${instanceId}`
    );
  }

  const sampleRate =
    typeof init.sampleRate === 'number' && init.sampleRate > 0
      ? init.sampleRate
      : 0;

  let destroyed = false;
  /** Effective clustering confidence flag (init default false; recluster may override). */
  let computeConfidence = options.clustering?.computeConfidence === true;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Diarization instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    instanceId,
    sampleRate,

    async diarize(audioIn, segmentOut, diarizeOptions) {
      guard();
      if (
        diarizeOptions?.onProgress != null &&
        typeof diarizeOptions.onProgress !== 'function'
      ) {
        throw new Error(
          `${DiarizationErrorCode.INVALID_ARGUMENT}: options.onProgress must be a function`
        );
      }

      const startedAtMs = Date.now();
      const audioInBufferId = resolvePipelineAudioBufferId(audioIn);
      const segmentOutBufferId = resolveOfflineSegmentBufferId(segmentOut);

      const audioInfo = await getPipelineAudioBufferInfo(audioInBufferId);
      if (audioInfo.kind !== 'offlinePcmBuffer') {
        throw new Error(
          `${DiarizationErrorCode.INVALID_ARGUMENT}: audioIn must be an offline audio buffer`
        );
      }
      const segmentOutInfo = asOfflineSegmentBufferInfo(
        await getPipelineSegmentBufferInfo(segmentOutBufferId),
        'segmentOut'
      );
      if ((segmentOutInfo.segmentCount ?? 0) > 0) {
        throw new Error(
          `${DiarizationErrorCode.INVALID_ARGUMENT}: segmentOut must be an empty offline segment buffer`
        );
      }

      let abortHandler: (() => void) | null = null;
      try {
        if (diarizeOptions?.signal) {
          if (diarizeOptions.signal.aborted) {
            throw Object.assign(new Error('Operation cancelled'), {
              code: DiarizationErrorCode.CANCELLED,
            });
          }
          abortHandler = () => {
            Promise.resolve(SherpaOnnx.cancelDiarization(instanceId)).catch(
              () => undefined
            );
          };
          diarizeOptions.signal.addEventListener('abort', abortHandler);
        }

        const nativeResult = await SherpaOnnx.diarizeOffline(
          instanceId,
          audioInBufferId,
          segmentOutBufferId,
          diarizeOptions?.includeOverlap === true
        );
        return finishDiarizeResult({
          nativeResult,
          startedAtMs,
          engineSampleRate: sampleRate,
          diarizeOptions,
        });
      } finally {
        if (abortHandler && diarizeOptions?.signal) {
          diarizeOptions.signal.removeEventListener('abort', abortHandler);
        }
      }
    },

    async recluster(reclusterOptions?: DiarizationReclusterOptions) {
      guard();
      const startedAtMs = Date.now();
      const numClusters =
        typeof reclusterOptions?.numClusters === 'number'
          ? reclusterOptions.numClusters
          : -1;
      const threshold =
        typeof reclusterOptions?.threshold === 'number'
          ? reclusterOptions.threshold
          : 0.5;
      if (typeof reclusterOptions?.computeConfidence === 'boolean') {
        computeConfidence = reclusterOptions.computeConfidence;
      }
      const nativeResult = await SherpaOnnx.reclusterDiarization(
        instanceId,
        numClusters,
        threshold,
        computeConfidence
      );
      if (!nativeResult.success) {
        throw new Error(
          `${
            nativeResult.errorCode ?? DiarizationErrorCode.INVALID_ARGUMENT
          }: ${nativeResult.error?.trim() || 'recluster failed'}`
        );
      }
      // Recluster updates native cache only — caller re-reads via a fresh
      // diarize() into a new empty segment buffer, or uses getClusterEmbeddings.
      return {
        status: 'complete' as const,
        numSpeakers: nativeResult.numSpeakers ?? 0,
        segmentCount: nativeResult.segments?.length ?? 0,
        sampleRate: nativeResult.sampleRate || sampleRate,
        processingTimeMs: Date.now() - startedAtMs,
        ...(Array.isArray(nativeResult.segments)
          ? { segments: nativeResult.segments }
          : {}),
      };
    },

    async getClusterEmbeddings(): Promise<DiarizationClusterEmbedding[]> {
      guard();
      const rows = await SherpaOnnx.getDiarizationClusterEmbeddings(instanceId);
      return (rows ?? []).map((row) => ({
        speaker: row.speaker,
        embedding: Float32Array.from(row.embedding ?? []),
      }));
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadDiarization(instanceId);
    },
  };
}

export { createStreamingDiarization } from './streaming';
export type {
  StreamingDiarizationConcreteModelType,
  StreamingDiarizationModelType,
  StreamingDiarizationInitOptionsShared,
  StreamingDiarizationAutoInitializeOptions,
  StreamingDiarizationCustomInitializeOptions,
  StreamingDiarizationInitializeOptions,
  StreamingDiarizationOptions,
  DiarizationPipelineHandle,
  StreamingDiarizationEngine,
} from './streamingTypes';
