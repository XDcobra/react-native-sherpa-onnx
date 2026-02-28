import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import type {
  OnlineSTTModelType,
  StreamingSttEngine,
  StreamingSttInitOptions,
  StreamingSttResult,
  SttStream,
} from './streamingTypes';

let streamingSttInstanceCounter = 0;

/**
 * Map detected STT model type (from detectSttModel) to an online (streaming) model type.
 * Throws if the detected type has no streaming support.
 */
function mapDetectedToOnlineType(detectedType: string | undefined): OnlineSTTModelType {
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
let sttStreamCounter = 0;

function normalizeStreamingResult(raw: {
  text?: string;
  tokens?: string[] | unknown;
  timestamps?: number[] | unknown;
}): StreamingSttResult {
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    tokens: Array.isArray(raw.tokens) ? (raw.tokens as string[]) : [],
    timestamps: Array.isArray(raw.timestamps) ? (raw.timestamps as number[]) : [],
  };
}

/**
 * Flatten StreamingSttInitOptions to native initializeOnlineStt parameters.
 * EndpointConfig (rule1, rule2, rule3) is expanded to 9 flat params.
 */
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
    modelDir: '', // filled by caller after resolveModelPath
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

/**
 * Create a streaming (online) STT engine. Use this for real-time recognition with
 * partial results and endpoint detection. Call destroy() when done.
 *
 * @param options - Streaming STT init options (modelPath required; modelType optional, use 'auto' to detect from directory)
 * @returns Promise resolving to a StreamingSttEngine
 * @example
 * ```typescript
 * // With explicit model type
 * const engine = await createStreamingSTT({
 *   modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
 *   modelType: 'transducer',
 * });
 * // With auto-detection
 * const engine = await createStreamingSTT({
 *   modelPath: { type: 'asset', path: 'models/sherpa-onnx-streaming-t-one-russian-2025-09-08' },
 *   modelType: 'auto',
 * });
 * const stream = await engine.createStream();
 * await stream.acceptWaveform(samples, 16000);
 * if (await stream.isReady()) {
 *   await stream.decode();
 *   const result = await stream.getResult();
 *   console.log(result.text);
 * }
 * await stream.release();
 * await engine.destroy();
 * ```
 */
export async function createStreamingSTT(
  options: StreamingSttInitOptions
): Promise<StreamingSttEngine> {
  const instanceId = `streaming_stt_${++streamingSttInstanceCounter}`;
  const resolvedPath = await resolveModelPath(options.modelPath);

  let effectiveModelType: OnlineSTTModelType;
  if (options.modelType === 'auto' || options.modelType === undefined) {
    const detectResult = await SherpaOnnx.detectSttModel(resolvedPath, undefined, undefined);
    if (!detectResult.success) {
      const errMsg = 'error' in detectResult && typeof (detectResult as { error?: string }).error === 'string'
        ? (detectResult as { error: string }).error
        : 'Unknown error';
      throw new Error(`Streaming STT auto-detection failed for ${resolvedPath}. ${errMsg}`);
    }
    effectiveModelType = mapDetectedToOnlineType(detectResult.modelType);
  } else {
    effectiveModelType = options.modelType;
  }

  const optionsWithResolvedType = { ...options, modelType: effectiveModelType };
  const flat = flattenInitOptionsForNative(optionsWithResolvedType);
  flat.modelDir = resolvedPath;

  const result = await SherpaOnnx.initializeOnlineStt(
    instanceId,
    flat.modelDir,
    flat.modelType,
    flat.enableEndpoint,
    flat.decodingMethod,
    flat.maxActivePaths,
    flat.hotwordsFile,
    flat.hotwordsScore,
    flat.numThreads,
    flat.provider,
    flat.ruleFsts,
    flat.ruleFars,
    flat.blankPenalty,
    flat.debug,
    flat.rule1MustContainNonSilence,
    flat.rule1MinTrailingSilence,
    flat.rule1MinUtteranceLength,
    flat.rule2MustContainNonSilence,
    flat.rule2MinTrailingSilence,
    flat.rule2MinUtteranceLength,
    flat.rule3MustContainNonSilence,
    flat.rule3MinTrailingSilence,
    flat.rule3MinUtteranceLength
  );

  if (!result.success) {
    throw new Error(`Streaming STT initialization failed for ${instanceId}`);
  }

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Streaming STT engine ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: StreamingSttEngine = {
    get instanceId() {
      return instanceId;
    },

    async createStream(hotwords?: string): Promise<SttStream> {
      guard();
      const streamId = `stt_stream_${++sttStreamCounter}`;
      await SherpaOnnx.createSttStream(instanceId, streamId, hotwords);

      let released = false;
      const streamGuard = () => {
        if (destroyed) {
          throw new Error(
            `Streaming STT engine ${instanceId} has been destroyed.`
          );
        }
        if (released) {
          throw new Error(
            `Stream ${streamId} has been released; cannot call methods on it.`
          );
        }
      };

      const stream: SttStream = {
        get streamId() {
          return streamId;
        },

        async acceptWaveform(samples: number[], sampleRate: number): Promise<void> {
          streamGuard();
          await SherpaOnnx.acceptSttWaveform(streamId, samples, sampleRate);
        },

        async inputFinished(): Promise<void> {
          streamGuard();
          await SherpaOnnx.sttStreamInputFinished(streamId);
        },

        async decode(): Promise<void> {
          streamGuard();
          await SherpaOnnx.decodeSttStream(streamId);
        },

        async isReady(): Promise<boolean> {
          streamGuard();
          return SherpaOnnx.isSttStreamReady(streamId);
        },

        async getResult(): Promise<StreamingSttResult> {
          streamGuard();
          const raw = await SherpaOnnx.getSttStreamResult(streamId);
          return normalizeStreamingResult(raw);
        },

        async isEndpoint(): Promise<boolean> {
          streamGuard();
          return SherpaOnnx.isSttStreamEndpoint(streamId);
        },

        async reset(): Promise<void> {
          streamGuard();
          await SherpaOnnx.resetSttStream(streamId);
        },

        async release(): Promise<void> {
          if (released) return;
          released = true;
          await SherpaOnnx.releaseSttStream(streamId);
        },

        async processAudioChunk(
          samples: number[],
          sampleRate: number
        ): Promise<{ result: StreamingSttResult; isEndpoint: boolean }> {
          streamGuard();
          const raw = await SherpaOnnx.processSttAudioChunk(
            streamId,
            samples,
            sampleRate
          );
          return {
            result: normalizeStreamingResult(raw),
            isEndpoint: Boolean(raw.isEndpoint),
          };
        },
      };

      return stream;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadOnlineStt(instanceId);
    },
  };

  return engine;
}
