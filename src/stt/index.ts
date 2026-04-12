import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
} from '../textbuffer/types';
import type {
  STTInitializeOptions,
  STTModelType,
  SttEngine,
  SttModelOptions,
  SttRuntimeConfig,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath, deriveAssetNameFromModelPath } from '../utils';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SttDetectModelResult,
} from '../types/modelDetect';

let sttInstanceCounter = 0;

// TODO: Not only string check but also if string is a valid buffer id
function normalizeOfflineBufferInput(
  buffer: OfflineAudioBufferRef | OfflineBufferHandle | string
): string {
  if (typeof buffer === 'string') {
    return buffer;
  }
  return buffer.bufferId;
}

/**
 * Detect STT model type and structure without initializing the recognizer.
 * Uses the same native file-based detection as createSTT. Stateless; no instance required.
 *
 * @param modelPath - Model path configuration (asset, file, or auto)
 * @param options - Optional preferInt8/modelType plus optional assetName and debug flag
 * @returns Object with success, detectedModels (array of { type, modelDir }), modelType (primary detected type), optional **languages** (`iso6391Hint` for coarse tags; **`id`** for `modelOptions` where applicable), optional error when success is false, and optionally isHardwareSpecificUnsupported
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
  options?: {
    preferInt8?: boolean;
    modelType?: STTModelType;
    assetName?: string;
    debug?: boolean;
  }
): Promise<SttDetectModelResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : deriveAssetNameFromModelPath(modelPath);
  const raw = await SherpaOnnx.detectSttModel(
    resolvedPath,
    assetName,
    options?.modelType ?? null,
    options?.preferInt8,
    options?.debug
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const modelType =
    raw.modelType != null && raw.modelType !== '' ? raw.modelType : undefined;
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
    domain: ModelCategory.Stt,
    modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  return {
    success: raw.success,
    ...(err.length > 0 ? { error: err } : {}),
    ...(raw.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
    detectedModels,
    ...(modelType != null ? { modelType } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
  };
}

/**
 * Create an STT engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - STT initialization options or model path configuration
 * @returns Promise resolving to an SttEngine instance
 * @example
 * ```typescript
 * import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
 * import {
 *   createEmptyOfflineTextBuffer,
 *   getOfflineTextBufferTextSlice,
 * } from 'react-native-sherpa-onnx/textbuffer';
 * const stt = await createSTT({
 *   modelPath: { type: 'asset', path: 'models/whisper-tiny' },
 * });
 * const audio = await createOfflineAudioBufferFromFile('/path/to.wav');
 * const textOut = await createEmptyOfflineTextBuffer();
 * await stt.transcribe(audio, textOut);
 * const text = await getOfflineTextBufferTextSlice(textOut, 0, 4096);
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
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    const detected = JSON.stringify(result.detectedModels ?? []);
    throw new Error(
      nativeError.length > 0
        ? `STT initialization failed: ${nativeError}`
        : `STT initialization failed: ${detected}`
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

    async transcribe(
      buffer: OfflineAudioBufferRef | OfflineBufferHandle | string,
      textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string
    ): Promise<void> {
      guard();
      const bufferId = normalizeOfflineBufferInput(buffer);
      const textOutBufferId =
        typeof textOut === 'string' ? textOut : textOut.bufferId;
      await SherpaOnnx.transcribe(instanceId, bufferId, textOutBufferId);
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

// Streaming (online) STT
export {
  createStreamingSTT,
  mapDetectedToOnlineType,
  getOnlineTypeOrNull,
} from './streaming';
export type {
  OnlineSTTModelType,
  StreamingSttEngine,
  StreamingSttInitOptions,
  StreamingSttResult,
  SttStream,
  EndpointConfig,
  EndpointRule,
} from './streamingTypes';
export { ONLINE_STT_MODEL_TYPES } from './streamingTypes';

// Export types and runtime type list
export type {
  STTInitializeOptions,
  STTModelType,
  SttModelOptions,
  SttQwen3AsrModelOptions,
  SttCohereTranscribeModelOptions,
  SttTranscribeRef,
  SttRuntimeConfig,
  SttEngine,
  SttInitResult,
  SttErrorCodeValue,
} from './types';
export type { SttDetectModelResult } from '../types/modelDetect';
export {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
} from './types';
