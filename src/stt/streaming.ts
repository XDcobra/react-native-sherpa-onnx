import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect';
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
        `Model type "${t}" is not supported for streaming STT. Use createSTT() for offline recognition, or pass a supported modelType: transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc.`
      );
  }
}

function flattenInitOptionsForNative(options: StreamingSttInitOptions): {
  modelDir: string;
  modelType: string;
  enableEndpoint: boolean;
  decodingMethod: string;
  maxActivePaths: number;
  hotwordsFile?: string;
  hotwordsScore?: number;
  numThreads?: number;
  provider?: string;
  ruleFsts?: string;
  ruleFars?: string;
  dither?: number;
  blankPenalty?: number;
  debug?: boolean;
  rule1MustContainNonSilence?: boolean;
  rule1MinTrailingSilence?: number;
  rule1MinUtteranceLength?: number;
  rule2MustContainNonSilence?: boolean;
  rule2MinTrailingSilence?: number;
  rule2MinUtteranceLength?: number;
  rule3MustContainNonSilence?: boolean;
  rule3MinTrailingSilence?: number;
  rule3MinUtteranceLength?: number;
} {
  const ep = options.endpointConfig;
  return {
    modelDir: '',
    modelType: options.modelType,
    enableEndpoint: options.enableEndpoint ?? true,
    decodingMethod: options.decodingMethod ?? 'greedy_search',
    maxActivePaths: options.maxActivePaths ?? 4,
    hotwordsFile: options.hotwordsFile,
    hotwordsScore: options.hotwordsScore,
    numThreads: options.numThreads,
    provider: options.provider,
    ruleFsts: options.ruleFsts,
    ruleFars: options.ruleFars,
    dither: options.dither,
    blankPenalty: options.blankPenalty,
    debug: options.debug,
    rule1MustContainNonSilence: ep?.rule1?.mustContainNonSilence,
    rule1MinTrailingSilence: ep?.rule1?.minTrailingSilence,
    rule1MinUtteranceLength: ep?.rule1?.minUtteranceLength,
    rule2MustContainNonSilence: ep?.rule2?.mustContainNonSilence,
    rule2MinTrailingSilence: ep?.rule2?.minTrailingSilence,
    rule2MinUtteranceLength: ep?.rule2?.minUtteranceLength,
    rule3MustContainNonSilence: ep?.rule3?.mustContainNonSilence,
    rule3MinTrailingSilence: ep?.rule3?.minTrailingSilence,
    rule3MinUtteranceLength: ep?.rule3?.minUtteranceLength,
  };
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
    effectiveModelType = options.modelType;
  }

  const optionsWithResolvedType = { ...options, modelType: effectiveModelType };
  const flat = flattenInitOptionsForNative(optionsWithResolvedType);
  flat.modelDir = resolvedPath;

  const nativeOptions: Parameters<
    typeof SherpaOnnx.initializeOnlineSttWithOptions
  >[1] = {
    modelDir: flat.modelDir,
    modelType: flat.modelType,
    enableEndpoint: flat.enableEndpoint,
    decodingMethod: flat.decodingMethod,
    maxActivePaths: flat.maxActivePaths,
  };
  if (flat.hotwordsFile !== undefined)
    nativeOptions.hotwordsFile = flat.hotwordsFile;
  if (flat.hotwordsScore !== undefined)
    nativeOptions.hotwordsScore = flat.hotwordsScore;
  if (flat.numThreads !== undefined) nativeOptions.numThreads = flat.numThreads;
  if (flat.provider !== undefined) nativeOptions.provider = flat.provider;
  if (flat.ruleFsts !== undefined) nativeOptions.ruleFsts = flat.ruleFsts;
  if (flat.ruleFars !== undefined) nativeOptions.ruleFars = flat.ruleFars;
  if (flat.dither !== undefined) nativeOptions.dither = flat.dither;
  if (flat.blankPenalty !== undefined)
    nativeOptions.blankPenalty = flat.blankPenalty;
  if (flat.debug !== undefined) nativeOptions.debug = flat.debug;
  if (flat.rule1MustContainNonSilence !== undefined)
    nativeOptions.rule1MustContainNonSilence = flat.rule1MustContainNonSilence;
  if (flat.rule1MinTrailingSilence !== undefined)
    nativeOptions.rule1MinTrailingSilence = flat.rule1MinTrailingSilence;
  if (flat.rule1MinUtteranceLength !== undefined)
    nativeOptions.rule1MinUtteranceLength = flat.rule1MinUtteranceLength;
  if (flat.rule2MustContainNonSilence !== undefined)
    nativeOptions.rule2MustContainNonSilence = flat.rule2MustContainNonSilence;
  if (flat.rule2MinTrailingSilence !== undefined)
    nativeOptions.rule2MinTrailingSilence = flat.rule2MinTrailingSilence;
  if (flat.rule2MinUtteranceLength !== undefined)
    nativeOptions.rule2MinUtteranceLength = flat.rule2MinUtteranceLength;
  if (flat.rule3MustContainNonSilence !== undefined)
    nativeOptions.rule3MustContainNonSilence = flat.rule3MustContainNonSilence;
  if (flat.rule3MinTrailingSilence !== undefined)
    nativeOptions.rule3MinTrailingSilence = flat.rule3MinTrailingSilence;
  if (flat.rule3MinUtteranceLength !== undefined)
    nativeOptions.rule3MinUtteranceLength = flat.rule3MinUtteranceLength;

  const result = await SherpaOnnx.initializeOnlineSttWithOptions(
    instanceId,
    nativeOptions
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
