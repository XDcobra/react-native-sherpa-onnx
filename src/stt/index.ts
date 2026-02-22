import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  STTInitializeOptions,
  STTModelType,
  SttEngine,
  SttModelOptions,
  SttRecognitionResult,
  SttRuntimeConfig,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';

let sttInstanceCounter = 0;

function normalizeSttResult(raw: {
  text?: string;
  tokens?: string[] | unknown;
  timestamps?: number[] | unknown;
  lang?: string;
  emotion?: string;
  event?: string;
  durations?: number[] | unknown;
}): SttRecognitionResult {
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    tokens: Array.isArray(raw.tokens) ? (raw.tokens as string[]) : [],
    timestamps: Array.isArray(raw.timestamps)
      ? (raw.timestamps as number[])
      : [],
    lang: typeof raw.lang === 'string' ? raw.lang : '',
    emotion: typeof raw.emotion === 'string' ? raw.emotion : '',
    event: typeof raw.event === 'string' ? raw.event : '',
    durations: Array.isArray(raw.durations) ? (raw.durations as number[]) : [],
  };
}

/**
 * Detect STT model type and structure without initializing the recognizer.
 * Uses the same native file-based detection as createSTT. Stateless; no instance required.
 *
 * @param modelPath - Model path configuration (asset, file, or auto)
 * @param options - Optional preferInt8 and modelType (default: auto)
 * @returns Object with success, detectedModels (array of { type, modelDir }), and modelType (primary detected type)
 * @example
 * ```typescript
 * const path = { type: 'asset' as const, path: 'models/sherpa-onnx-whisper-tiny-en' };
 * const result = await detectSttModel(path);
 * if (result.success && result.detectedModels.length > 0) {
 *   console.log('Detected type:', result.modelType, result.detectedModels);
 * }
 * ```
 */
export async function detectSttModel(
  modelPath: ModelPathConfig,
  options?: { preferInt8?: boolean; modelType?: STTModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
}> {
  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.detectSttModel(
    resolvedPath,
    options?.preferInt8,
    options?.modelType
  );
}

/**
 * Create an STT engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - STT initialization options or model path configuration
 * @returns Promise resolving to an SttEngine instance
 * @example
 * ```typescript
 * const stt = await createSTT({
 *   modelPath: { type: 'asset', path: 'models/whisper-tiny' },
 * });
 * const result = await stt.transcribeFile('/path/to/audio.wav');
 * console.log(result.text);
 * await stt.destroy();
 * ```
 */
export async function createSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<SttEngine> {
  const instanceId = `stt_${++sttInstanceCounter}`;

  let modelPath: ModelPathConfig;
  let preferInt8: boolean | undefined;
  let modelType: STTModelType | undefined;
  let hotwordsFile: string | undefined;
  let hotwordsScore: number | undefined;
  let numThreads: number | undefined;
  let provider: string | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let dither: number | undefined;
  let modelOptions: SttModelOptions | undefined;
  let modelingUnit: string | undefined;
  let bpeVocab: string | undefined;

  if ('modelPath' in options) {
    modelPath = options.modelPath;
    preferInt8 = options.preferInt8;
    modelType = options.modelType;
    hotwordsFile = options.hotwordsFile;
    hotwordsScore = options.hotwordsScore;
    numThreads = options.numThreads;
    provider = options.provider;
    ruleFsts = options.ruleFsts;
    ruleFars = options.ruleFars;
    dither = options.dither;
    modelOptions = options.modelOptions;
    modelingUnit = options.modelingUnit;
    bpeVocab = options.bpeVocab;
  } else {
    modelPath = options;
    preferInt8 = undefined;
    modelType = undefined;
    hotwordsFile = undefined;
    hotwordsScore = undefined;
    numThreads = undefined;
    provider = undefined;
    ruleFsts = undefined;
    ruleFars = undefined;
    dither = undefined;
    modelOptions = undefined;
    modelingUnit = undefined;
    bpeVocab = undefined;
  }

  const debug = 'modelPath' in options ? options.debug : undefined;
  const resolvedPath = await resolveModelPath(modelPath);

  const result = await SherpaOnnx.initializeStt(
    instanceId,
    resolvedPath,
    preferInt8,
    modelType,
    debug,
    hotwordsFile,
    hotwordsScore,
    numThreads,
    provider,
    ruleFsts,
    ruleFars,
    dither,
    modelOptions,
    modelingUnit,
    bpeVocab
  );

  if (!result.success) {
    throw new Error(
      `STT initialization failed: ${JSON.stringify(
        result.detectedModels ?? []
      )}`
    );
  }

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `STT instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: SttEngine = {
    get instanceId() {
      return instanceId;
    },

    async transcribeFile(filePath: string): Promise<SttRecognitionResult> {
      guard();
      const raw = await SherpaOnnx.transcribeFile(instanceId, filePath);
      return normalizeSttResult(raw);
    },

    async transcribeSamples(
      samples: number[],
      sampleRate: number
    ): Promise<SttRecognitionResult> {
      guard();
      const raw = await SherpaOnnx.transcribeSamples(
        instanceId,
        samples,
        sampleRate
      );
      return normalizeSttResult(raw);
    },

    async setConfig(config: SttRuntimeConfig): Promise<void> {
      guard();
      const map: Record<string, string | number> = {};
      if (config.decodingMethod != null)
        map.decodingMethod = config.decodingMethod;
      if (config.maxActivePaths != null)
        map.maxActivePaths = config.maxActivePaths;
      if (config.hotwordsFile != null) map.hotwordsFile = config.hotwordsFile;
      if (config.hotwordsScore != null)
        map.hotwordsScore = config.hotwordsScore;
      if (config.blankPenalty != null) map.blankPenalty = config.blankPenalty;
      if (config.ruleFsts != null) map.ruleFsts = config.ruleFsts;
      if (config.ruleFars != null) map.ruleFars = config.ruleFars;
      return SherpaOnnx.setSttConfig(instanceId, map);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadStt(instanceId);
    },
  };

  return engine;
}

// Export types and runtime type list
export type {
  STTInitializeOptions,
  STTModelType,
  SttModelOptions,
  SttRecognitionResult,
  SttRuntimeConfig,
  SttEngine,
  SttInitResult,
} from './types';
export {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
} from './types';
export {
  getWhisperLanguages,
  WHISPER_LANGUAGES,
  getSenseVoiceLanguages,
  SENSEVOICE_LANGUAGES,
  getCanaryLanguages,
  CANARY_LANGUAGES,
  getFunasrNanoLanguages,
  FUNASR_NANO_LANGUAGES,
  getFunasrMltNanoLanguages,
  FUNASR_MLT_NANO_LANGUAGES,
} from './sttModelLanguages';
export type { SttModelLanguage, WhisperLanguage } from './sttModelLanguages';
