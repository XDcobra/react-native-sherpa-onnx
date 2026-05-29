import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { buildOnlineSttInitBridgeOptions } from './sttNativeBridge';
import type {
  OnlineSTTModelType,
  LiveSttEngine,
  StreamingSttInitOptions,
  SttPipelineHandle,
} from './streamingTypes';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import { resolvePipelineTextBufferId } from '../textbuffer';

let streamingSttInstanceCounter = 0;

function logSttPipelineStart(args: {
  pipelineId: string;
  chunkSize: number | undefined;
  audioInLiveBufferId: string;
  textOutLiveBufferId: string;
}): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    return;
  }
  console.warn('[SherpaOnnx:SttPipeline] transcribe started', {
    pipelineId: args.pipelineId,
    chunkSize:
      args.chunkSize === undefined ? '(native default)' : args.chunkSize,
    audioInLiveBufferId: args.audioInLiveBufferId,
    textOutLiveBufferId: args.textOutLiveBufferId,
  });
}

/**
 * Normalize a raw detected model type string to an {@link OnlineSTTModelType}.
 * Used internally by `createStreamingSTT` for auto-detection.
 */
function normalizeToOnlineType(
  detectedType: string | undefined
): OnlineSTTModelType {
  const t = detectedType ?? '';
  switch (t) {
    case 'transducer':
      return 'transducer';
    case 'nemo_transducer':
      // NeMo/Nemotron streaming transducers use OnlineTransducer + NeMo impl (decoder outputs > 1).
      return 'nemo_transducer';
    case 'paraformer':
      return 'paraformer';
    case 'nemo_ctc':
      return 'nemo_ctc';
    case 'zipformer_ctc':
    case 'ctc':
      return 'zipformer2_ctc';
    case 'tone_ctc':
      return 'tone_ctc';
    default:
      throw new Error(
        `Model type "${t}" is not supported for streaming STT. Use createSTT() for offline recognition, or pass a supported modelType: transducer, nemo_transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc.`
      );
  }
}

export async function createStreamingSTT(
  options: StreamingSttInitOptions
): Promise<LiveSttEngine> {
  const instanceId = `streaming_stt_${++streamingSttInstanceCounter}`;
  const resolvedPath = await resolveFileSourceForModelInit(options.modelSource);

  let effectiveModelType: OnlineSTTModelType;
  if (options.modelType === 'auto' || options.modelType === undefined) {
    const detectResult = await SherpaOnnx.detectSttModel(
      resolvedPath,
      null,
      undefined,
      undefined,
      undefined
    );
    if (!detectResult.success) {
      const errMsg =
        'error' in detectResult &&
        typeof (detectResult as { error?: string }).error === 'string'
          ? (detectResult as { error: string }).error
          : 'Unknown error';
      throw new Error(
        `Streaming STT auto-detection failed for ${resolvedPath}. ${errMsg}`
      );
    }
    effectiveModelType = normalizeToOnlineType(detectResult.modelType);
  } else {
    effectiveModelType = normalizeToOnlineType(options.modelType);
  }

  const optionsWithResolvedType = { ...options, modelType: effectiveModelType };
  const bridgeOptions = buildOnlineSttInitBridgeOptions(
    resolvedPath,
    optionsWithResolvedType
  );

  const result = await SherpaOnnx.initializeOnlineStt(
    instanceId,
    bridgeOptions
  );

  if (!result.success) {
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Streaming STT initialization failed: ${nativeError}`
        : `Streaming STT initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  let activePipelineId: string | null = null;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Streaming STT engine ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: LiveSttEngine = {
    get instanceId() {
      return instanceId;
    },

    async transcribe(
      audioIn,
      textOut,
      pipelineOptions
    ): Promise<SttPipelineHandle> {
      guard();

      if (activePipelineId) {
        const status = await SherpaOnnx.getStreamingPipelineStatus(
          activePipelineId
        );
        if (status.isRunning) {
          throw new Error(
            `STT pipeline already running for engine ${instanceId}`
          );
        }
      }

      const audioInLiveBufferId = resolvePipelineAudioBufferId(audioIn);
      const textOutLiveBufferId = resolvePipelineTextBufferId(textOut);

      const started = await SherpaOnnx.startSttPipeline(
        instanceId,
        audioInLiveBufferId,
        textOutLiveBufferId,
        pipelineOptions?.chunkSize
      );
      logSttPipelineStart({
        pipelineId: started.pipelineId,
        chunkSize: pipelineOptions?.chunkSize,
        audioInLiveBufferId,
        textOutLiveBufferId,
      });
      activePipelineId = started.pipelineId;
      const completed = createStreamingPipelineCompletionPromise(
        started.pipelineId
      );

      completed.then(
        () => {
          if (activePipelineId === started.pipelineId) {
            activePipelineId = null;
          }
        },
        () => {
          if (activePipelineId === started.pipelineId) {
            activePipelineId = null;
          }
        }
      );

      const handle: SttPipelineHandle = {
        instanceId,
        get pipelineId() {
          return started.pipelineId;
        },
        completed,
        async stop(): Promise<void> {
          await SherpaOnnx.stopStreamingPipeline(started.pipelineId);
          if (activePipelineId === started.pipelineId) {
            activePipelineId = null;
          }
        },
        async flush(): Promise<void> {
          if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.warn('[SherpaOnnx:SttPipeline] flush', {
              pipelineId: started.pipelineId,
            });
          }
          await SherpaOnnx.flushStreamingPipeline(started.pipelineId);
        },
        async reset(): Promise<void> {
          await SherpaOnnx.resetStreamingPipeline(started.pipelineId);
        },
        async getStatus() {
          return SherpaOnnx.getStreamingPipelineStatus(started.pipelineId);
        },
      };

      return handle;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;

      if (activePipelineId) {
        try {
          await SherpaOnnx.stopStreamingPipeline(activePipelineId);
        } catch {
          // Ignore teardown race if already removed.
        }
        activePipelineId = null;
      }

      await SherpaOnnx.unloadOnlineStt(instanceId);
    },
  };

  return engine;
}

export const createLiveSTT = createStreamingSTT;
