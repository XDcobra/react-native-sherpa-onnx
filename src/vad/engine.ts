import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import { resolveFileSourceForDetect } from '../detect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolvePipelineSegmentBufferId } from '../segmentbuffer';
import { subscribeVadEvents } from './events';
import type {
  DetectedModelEntry,
  DetectionSource,
  VADDetectResult,
  VADEngine,
  VADEvent,
  VADInitializeOptions,
  VADLiveProcessInput,
  VADOfflineProcessInput,
  VADOfflineResult,
  VADPipelineHandle,
  VADPipelineStatus,
  VADModelType,
  VADSummary,
} from './types';
import type { FileSource } from '../fileio/types';
import { isDetectionSource } from './types';

let vadInstanceCounter = 0;

function toStatus(raw: any): VADPipelineStatus {
  return {
    pipelineId: String(raw?.pipelineId ?? ''),
    isRunning: raw?.isRunning === true,
    isFlushing: raw?.isFlushing === true,
    queueDepth:
      typeof raw?.queueDepth === 'number' ? Math.trunc(raw.queueDepth) : 0,
    chunksProcessed:
      typeof raw?.chunksProcessed === 'number'
        ? Math.trunc(raw.chunksProcessed)
        : 0,
    unitsRead:
      typeof raw?.unitsRead === 'number' ? Math.trunc(raw.unitsRead) : 0,
    unitsWritten:
      typeof raw?.unitsWritten === 'number' ? Math.trunc(raw.unitsWritten) : 0,
    error: typeof raw?.error === 'string' ? raw.error : null,
  };
}

function toSummary(raw: any): VADSummary {
  return {
    chunksProcessed:
      typeof raw?.chunksProcessed === 'number'
        ? Math.trunc(raw.chunksProcessed)
        : 0,
    unitsRead:
      typeof raw?.unitsRead === 'number' ? Math.trunc(raw.unitsRead) : 0,
    unitsWritten:
      typeof raw?.unitsWritten === 'number' ? Math.trunc(raw.unitsWritten) : 0,
    segmentCount:
      typeof raw?.segmentCount === 'number' ? Math.trunc(raw.segmentCount) : 0,
    speechDurationMs:
      typeof raw?.speechDurationMs === 'number'
        ? Math.trunc(raw.speechDurationMs)
        : 0,
  };
}

export async function detectVadModel(
  source: FileSource,
  options?: {
    modelType?: VADInitializeOptions['modelType'];
    assetName?: string;
  }
): Promise<VADDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectVadModel(
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
    domain: ModelCategory.Vad,
    modelType: raw.modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelPath =
    raw.paths != null &&
    typeof raw.paths === 'object' &&
    typeof raw.paths.model === 'string' &&
    raw.paths.model.length > 0
      ? raw.paths.model
      : undefined;
  return {
    success: raw.success,
    isStreaming: raw.isStreaming === true,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(modelPath != null ? { paths: { model: modelPath } } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
  };
}

export async function createStreamingVAD(
  options: VADInitializeOptions
): Promise<VADEngine> {
  const instanceId = `vad_${++vadInstanceCounter}`;
  const modelDir = await resolveModelPath(options.modelPath);
  let resolvedModelType: 'auto' | VADModelType = options.modelType ?? 'auto';
  if (resolvedModelType === 'auto') {
    const detect = await SherpaOnnx.detectVadModel(modelDir, null, 'auto');
    if (
      !detect.success ||
      detect.modelType == null ||
      detect.modelType === ''
    ) {
      const reason =
        (typeof detect.error === 'string' ? detect.error.trim() : '') ||
        'Failed to detect VAD model type in auto mode';
      throw Object.assign(new Error(reason), {
        code: 'VAD_MODEL_INIT_FAILED',
      });
    }
    resolvedModelType = detect.modelType as VADModelType;
  }
  await SherpaOnnx.initializeVad(instanceId, {
    modelDir,
    modelType: resolvedModelType,
    sampleRate: options.sampleRate,
    silenceDurationMs: options.silenceDurationMs,
    speechDurationMs: options.speechDurationMs,
    maxSpeechDurationS: options.maxSpeechDurationS,
    minSpeechDurationMs: options.minSpeechDurationMs,
    threshold: options.threshold,
    windowSize: options.windowSize,
    provider: options.provider,
    numThreads: options.numThreads,
    debug: options.debug,
  });

  let destroyed = false;
  let activePipelineId: string | null = null;
  const listeners = new Set<(event: VADEvent) => void>();
  const unsubscribeNative = subscribeVadEvents(instanceId, (event) => {
    if (
      event.type === 'pipeline.completed' ||
      event.type === 'pipeline.error'
    ) {
      if (activePipelineId === event.pipelineId) {
        activePipelineId = null;
      }
    }
    listeners.forEach((listener) => listener(event));
  });

  const ensureUsable = () => {
    if (destroyed) {
      throw new Error(`VAD engine ${instanceId} is destroyed`);
    }
  };

  const engine: VADEngine = {
    get instanceId() {
      return instanceId;
    },
    async process(
      input: VADLiveProcessInput | VADOfflineProcessInput
    ): Promise<VADPipelineHandle | VADOfflineResult> {
      ensureUsable();
      const audioInBufferId = resolvePipelineAudioBufferId(input.audioIn);
      const segmentOutBufferId = resolvePipelineSegmentBufferId(
        input.segmentOut
      );

      if (audioInBufferId.startsWith('live_')) {
        if (activePipelineId != null) {
          const status = toStatus(
            await SherpaOnnx.getVadPipelineStatus(activePipelineId)
          );
          if (status.isRunning) {
            throw Object.assign(
              new Error(`VAD pipeline already running for ${instanceId}`),
              { code: 'VAD_INVALID_STATE' }
            );
          }
          activePipelineId = null;
        }
        const started = await SherpaOnnx.startVadPipeline(
          instanceId,
          audioInBufferId,
          segmentOutBufferId,
          (input as VADLiveProcessInput).options ?? {}
        );
        const pipelineId = started.pipelineId;
        activePipelineId = pipelineId;
        const completed = new Promise<VADSummary>((resolve, reject) => {
          const off = engine.addListener((event) => {
            if (event.pipelineId !== pipelineId) return;
            if (event.type === 'pipeline.completed') {
              off();
              resolve(event.summary);
            } else if (event.type === 'pipeline.error') {
              off();
              reject(
                Object.assign(new Error(event.error), {
                  code: 'VAD_INTERNAL_ERROR',
                })
              );
            }
          });
        });
        return {
          instanceId,
          pipelineId,
          completed,
          async stop() {
            await SherpaOnnx.stopVadPipeline(pipelineId);
          },
          async flush() {
            await SherpaOnnx.flushVad(pipelineId);
          },
          async reset() {
            await SherpaOnnx.resetVad(pipelineId);
          },
          async getStatus() {
            return toStatus(await SherpaOnnx.getVadPipelineStatus(pipelineId));
          },
        };
      }

      const result = await SherpaOnnx.runVadOffline(
        instanceId,
        audioInBufferId,
        segmentOutBufferId,
        (input as VADOfflineProcessInput).options ?? {}
      );
      return {
        summary: toSummary(result),
        segmentBufferId: segmentOutBufferId,
      };
    },
    addListener(listener: (event: VADEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async isSpeechDetected(): Promise<boolean> {
      ensureUsable();
      return SherpaOnnx.isVadSpeechDetected(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      if (activePipelineId != null) {
        try {
          await SherpaOnnx.stopVadPipeline(activePipelineId);
        } catch {
          // Ignore teardown races.
        }
      }
      unsubscribeNative();
      listeners.clear();
      await SherpaOnnx.unloadVad(instanceId);
    },
  };
  return engine;
}
