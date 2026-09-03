/**
 * Speaker Diarization feature module.
 *
 * Offline batch diarization via `createDiarization` + `engine.diarize(audioIn, segmentOut)`.
 * Detect for pyannote / reverb segmentation packs is also exported.
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
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getPipelineSegmentBufferInfo,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import type {
  OfflineSegmentBufferIdSource,
  OfflineSegmentBufferInfo,
  OfflineSegmentBufferRef,
} from '../segmentbuffer/types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import { isDetectionSource } from './types';
import type {
  DetectedModelEntry,
  DetectionSource,
  DiarizationClusterEmbedding,
  DiarizationDetectResult,
  DiarizationEngine,
  DiarizationInitializeOptions,
  DiarizationModelKind,
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
  DiarizationDetectResult,
  DiarizationEmbeddingOptions,
  DiarizationEngine,
  DiarizationInitializeOptions,
  DiarizationModelKind,
  DiarizationReclusterOptions,
  DiarizationSegmentationOptions,
  DiarizeOptions,
  DiarizeResult,
} from './types';

export {
  DETECTION_SOURCES,
  DIARIZATION_MODEL_KINDS,
  DiarizationErrorCode,
  isDetectionSource,
} from './types';

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

export async function detectDiarizationModel(
  source: FileSource,
  options?: {
    modelType?: DiarizationModelKind | 'auto';
    assetName?: string;
  }
): Promise<DiarizationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectDiarizationModel(
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
    domain: ModelCategory.Diarization,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
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

async function materializeSegmentsIntoOfflineBuffer(params: {
  audioInBufferId: string;
  segmentOutBufferId: string;
  sampleRate: number;
  segments: Array<{ start: number; end: number; speaker: number }>;
}): Promise<number> {
  const live = await createLiveSegmentBuffer({
    sourceAudioBufferId: params.audioInBufferId,
  });
  try {
    for (const seg of params.segments) {
      const startSample = Math.max(
        0,
        Math.round(seg.start * params.sampleRate)
      );
      const endSample = Math.max(
        startSample,
        Math.round(seg.end * params.sampleRate)
      );
      const durationMs =
        params.sampleRate > 0
          ? ((endSample - startSample) / params.sampleRate) * 1000
          : 0;
      await appendLiveSegment(live.bufferId, {
        kind: 'diarization',
        sourceAudioBufferId: params.audioInBufferId,
        startSample,
        endSample,
        sampleRate: params.sampleRate,
        durationMs,
        payload: {
          source: 'diarization',
          speaker: seg.speaker,
        },
      });
    }
    await finalizeLiveSegmentBuffer(live.bufferId);
    await populateOfflineSegmentBufferIfEmpty(
      params.segmentOutBufferId,
      live.bufferId
    );
  } finally {
    await releasePipelineSegmentBuffer(live.bufferId).catch(() => undefined);
  }
  return params.segments.length;
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
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Diarization instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const runMaterialize = async (
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource | OfflineSegmentBufferRef,
    nativeResult: {
      success: boolean;
      error?: string;
      errorCode?: string;
      segments: Array<{ start: number; end: number; speaker: number }>;
      numSpeakers: number;
      sampleRate: number;
      speakersPerFrame?: number[];
    },
    startedAtMs: number,
    materializeOptions?: DiarizeOptions
  ): Promise<DiarizeResult> => {
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
          sampleRate: nativeResult.sampleRate || sampleRate,
          processingTimeMs: Date.now() - startedAtMs,
        };
      }
      throw new Error(
        `${code}: ${nativeResult.error?.trim() || 'diarization failed'}`
      );
    }

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

    const sr =
      nativeResult.sampleRate > 0 ? nativeResult.sampleRate : sampleRate;
    const count = await materializeSegmentsIntoOfflineBuffer({
      audioInBufferId,
      segmentOutBufferId,
      sampleRate: sr,
      segments: nativeResult.segments ?? [],
    });

    if (materializeOptions?.onProgress) {
      const progress: OrchestrationProgress = {
        currentSegment: Math.max(1, count),
        totalSegments: Math.max(1, count),
        fraction: 1,
        currentSegmentDurationMs: 0,
        elapsedMs: Date.now() - startedAtMs,
      };
      materializeOptions.onProgress(progress);
    }

    return {
      status: 'complete',
      numSpeakers: nativeResult.numSpeakers ?? 0,
      segmentCount: count,
      sampleRate: sr,
      processingTimeMs: Date.now() - startedAtMs,
      ...(materializeOptions?.includeOverlap &&
      Array.isArray(nativeResult.speakersPerFrame)
        ? { speakersPerFrame: nativeResult.speakersPerFrame }
        : {}),
    };
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

      let abortHandler: (() => void) | null = null;
      try {
        if (diarizeOptions?.signal) {
          if (diarizeOptions.signal.aborted) {
            throw Object.assign(new Error('Operation cancelled'), {
              code: DiarizationErrorCode.CANCELLED,
            });
          }
          abortHandler = () => {
            SherpaOnnx.cancelDiarization(instanceId).catch(() => undefined);
          };
          diarizeOptions.signal.addEventListener('abort', abortHandler);
        }

        const nativeResult = await SherpaOnnx.diarizeOffline(
          instanceId,
          audioInBufferId,
          diarizeOptions?.includeOverlap === true
        );
        return runMaterialize(
          audioIn,
          segmentOut,
          nativeResult,
          startedAtMs,
          diarizeOptions
        );
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
      const nativeResult = await SherpaOnnx.reclusterDiarization(
        instanceId,
        numClusters,
        threshold
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
