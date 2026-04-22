import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolvePipelineSegmentBufferId } from '../segmentbuffer';
import { subscribeVadEvents } from './events';
import type {
  VADEngine,
  VADEvent,
  VADInitializeOptions,
  VADLiveProcessInput,
  VADOfflineProcessInput,
  VADOfflineResult,
  VADPipelineHandle,
  VADPipelineStatus,
  VADSummary,
} from './types';

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

export async function createStreamingVAD(
  options: VADInitializeOptions
): Promise<VADEngine> {
  const instanceId = `vad_${++vadInstanceCounter}`;
  const modelDir = await resolveModelPath(options.modelPath);
  await SherpaOnnx.initializeVad(instanceId, {
    modelDir,
    modelType: options.modelType ?? 'auto',
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
