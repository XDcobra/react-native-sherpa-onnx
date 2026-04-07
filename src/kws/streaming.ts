import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveModelPath } from '../utils';
import type {
  KwsInitOptions,
  KwsModelType,
  KeywordSpotterEngine,
  KwsResult,
  KwsStream,
} from './streamingTypes';

let keywordSpotterInstanceCounter = 0;
let kwsStreamCounter = 0;

function normalizeKwsResult(raw: {
  keyword?: string;
  tokens?: string[] | unknown;
  timestamps?: number[] | unknown;
}): KwsResult {
  return {
    keyword: typeof raw.keyword === 'string' ? raw.keyword : '',
    tokens: Array.isArray(raw.tokens) ? (raw.tokens as string[]) : [],
    timestamps: Array.isArray(raw.timestamps)
      ? (raw.timestamps as number[])
      : [],
  };
}

/**
 * Flatten KwsInitOptions to native initializeKwsWithOptions parameters.
 */
function flattenInitOptionsForNative(options: KwsInitOptions): {
  modelDir: string;
  modelType: KwsModelType;
  keywordsFile?: string;
  keywordsScore?: number;
  keywordsThreshold?: number;
  numTrailingBlanks?: number;
  maxActivePaths?: number;
  numThreads?: number;
  provider?: string;
  debug?: boolean;
} {
  return {
    modelDir: '', // filled by caller after resolveModelPath
    modelType: options.modelType ?? 'transducer',
    keywordsFile: options.keywordsPath ? '' : undefined, // filled by caller if provided
    keywordsScore: options.keywordsScore,
    keywordsThreshold: options.keywordsThreshold,
    numTrailingBlanks: options.numTrailingBlanks,
    maxActivePaths: options.maxActivePaths,
    numThreads: options.numThreads,
    provider: options.provider,
    debug: options.debug,
  };
}

/**
 * Create a keyword spotting engine for wake-word detection.
 * Call destroy() when done.
 *
 * @param options - KWS init options (modelPath required)
 * @returns Promise resolving to a KeywordSpotterEngine
 * @example
 * ```typescript
 * const engine = await createKeywordSpotter({
 *   modelPath: { type: 'asset', path: 'models/kws-zipformer-zh-en' },
 *   modelType: 'transducer',
 *   numTrailingBlanks: 1,
 *   keywordsThreshold: 0.25,
 * });
 * const stream = await engine.createStream();
 * while (listening) {
 *   const { keyword } = await stream.processAudioChunk(samples, 16000);
 *   if (keyword) {
 *     console.log('Spotted:', keyword);
 *   }
 * }
 * await stream.release();
 * await engine.destroy();
 * ```
 */
export async function createKeywordSpotter(
  options: KwsInitOptions
): Promise<KeywordSpotterEngine> {
  const instanceId = `kws_${++keywordSpotterInstanceCounter}`;
  const resolvedPath = await resolveModelPath(options.modelPath);

  let resolvedKeywordsPath: string | undefined;
  if (options.keywordsPath) {
    resolvedKeywordsPath = await resolveModelPath(options.keywordsPath);
  }

  const flat = flattenInitOptionsForNative(options);
  flat.modelDir = resolvedPath;
  if (resolvedKeywordsPath) {
    flat.keywordsFile = resolvedKeywordsPath;
  }

  // Build options with only defined values (no undefined) to avoid iOS TurboModule marshalling crash.
  const nativeOptions: Parameters<
    typeof SherpaOnnx.initializeKwsWithOptions
  >[1] = {
    modelDir: flat.modelDir,
    modelType: flat.modelType,
  };
  if (flat.keywordsFile !== undefined)
    nativeOptions.keywordsFile = flat.keywordsFile;
  if (flat.keywordsScore !== undefined)
    nativeOptions.keywordsScore = flat.keywordsScore;
  if (flat.keywordsThreshold !== undefined)
    nativeOptions.keywordsThreshold = flat.keywordsThreshold;
  if (flat.numTrailingBlanks !== undefined)
    nativeOptions.numTrailingBlanks = flat.numTrailingBlanks;
  if (flat.maxActivePaths !== undefined)
    nativeOptions.maxActivePaths = flat.maxActivePaths;
  if (flat.numThreads !== undefined) nativeOptions.numThreads = flat.numThreads;
  if (flat.provider !== undefined) nativeOptions.provider = flat.provider;
  if (flat.debug !== undefined) nativeOptions.debug = flat.debug;

  const result = await SherpaOnnx.initializeKwsWithOptions(
    instanceId,
    nativeOptions
  );

  if (!result.success) {
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Keyword spotter initialization failed: ${nativeError}`
        : `Keyword spotter initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Keyword spotter engine ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: KeywordSpotterEngine = {
    get instanceId() {
      return instanceId;
    },

    async createStream(keywords?: string): Promise<KwsStream> {
      guard();
      const streamId = `kws_stream_${++kwsStreamCounter}`;
      await SherpaOnnx.createKwsStream(instanceId, streamId, keywords);

      let released = false;
      const streamGuard = () => {
        if (destroyed) {
          throw new Error(
            `Keyword spotter engine ${instanceId} has been destroyed.`
          );
        }
        if (released) {
          throw new Error(
            `Stream ${streamId} has been released; cannot call methods on it.`
          );
        }
      };

      const stream: KwsStream = {
        get streamId() {
          return streamId;
        },

        async acceptWaveform(
          samples: number[],
          sampleRate: number
        ): Promise<void> {
          streamGuard();
          await SherpaOnnx.acceptKwsWaveform(streamId, samples, sampleRate);
        },

        async decode(): Promise<void> {
          streamGuard();
          await SherpaOnnx.decodeKwsStream(streamId);
        },

        async isReady(): Promise<boolean> {
          streamGuard();
          return SherpaOnnx.isKwsStreamReady(streamId);
        },

        async getResult(): Promise<KwsResult> {
          streamGuard();
          const raw = await SherpaOnnx.getKwsStreamResult(streamId);
          return normalizeKwsResult(raw);
        },

        async reset(): Promise<void> {
          streamGuard();
          await SherpaOnnx.resetKwsStream(streamId);
        },

        async release(): Promise<void> {
          if (released) return;
          released = true;
          await SherpaOnnx.releaseKwsStream(streamId);
        },

        async processAudioChunk(
          samples: number[] | Float32Array,
          sampleRate: number
        ): Promise<KwsResult> {
          streamGuard();
          // Bridge expects a plain array; Float32Array may not serialize as ReadableArray on all platforms.
          const samplesArray = Array.isArray(samples)
            ? samples
            : Array.from(samples);
          const raw = await SherpaOnnx.processKwsAudioChunk(
            streamId,
            samplesArray,
            sampleRate
          );
          return normalizeKwsResult(raw);
        },
      };

      return stream;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadKws(instanceId);
    },
  };

  return engine;
}
