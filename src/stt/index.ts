import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  STTInitializeOptions,
  STTModelType,
  SttInitResult,
  SttModelOptions,
  SttRecognitionResult,
  SttRuntimeConfig,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';

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
 * Uses the same native file-based detection as initializeSTT. Call this to show
 * model-specific options before init or to query the type for a given path.
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
 * Initialize Speech-to-Text (STT) with model directory.
 *
 * Supports multiple model source types:
 * - Asset models (bundled in app)
 * - File system models (downloaded or user-provided)
 * - Auto-detection (tries asset first, then file system)
 *
 * @param options - STT initialization options or model path configuration
 * @returns Object with success status and array of detected models (each with type and modelDir)
 * @example
 * ```typescript
 * // Auto-detect model path
 * const result = await initializeSTT({ type: 'auto', path: 'models/sherpa-onnx-model' });
 * console.log('Detected models:', result.detectedModels);
 *
 * // Asset model
 * const result = await initializeSTT({
 *   modelPath: { type: 'asset', path: 'models/sherpa-onnx-model' }
 * });
 *
 * // File system model with preferInt8 option
 * const result = await initializeSTT({
 *   modelPath: { type: 'file', path: '/path/to/model' },
 *   preferInt8: true  // Prefer quantized int8 models (smaller, faster)
 * });
 *
 * // With explicit model type
 * const result = await initializeSTT({
 *   modelPath: { type: 'asset', path: 'models/sherpa-onnx-nemo-parakeet-tdt-ctc-en' },
 *   modelType: 'nemo_ctc'
 * });
 * ```
 */
export async function initializeSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<SttInitResult> {
  // Handle both object syntax and direct config syntax
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
  }

  const debug = 'modelPath' in options ? options.debug : undefined;
  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.initializeStt(
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
    modelOptions
  );
}

/**
 * Transcribe an audio file.
 *
 * @param filePath - Path to WAV file (16kHz, mono, 16-bit PCM)
 * @returns Promise resolving to full recognition result (text, tokens, timestamps, lang, emotion, event, durations)
 * @example
 * ```typescript
 * const result = await transcribeFile('path/to/audio.wav');
 * console.log('Transcription:', result.text);
 * console.log('Tokens:', result.tokens);
 * ```
 */
export async function transcribeFile(
  filePath: string
): Promise<SttRecognitionResult> {
  const raw = await SherpaOnnx.transcribeFile(filePath);
  return normalizeSttResult(raw);
}

/**
 * Transcribe from float PCM samples (e.g. from microphone or another decoder).
 *
 * @param samples - Float samples in [-1, 1], mono
 * @param sampleRate - Sample rate in Hz (e.g. 16000)
 * @returns Promise resolving to full recognition result (same shape as transcribeFile)
 */
export async function transcribeSamples(
  samples: number[],
  sampleRate: number
): Promise<SttRecognitionResult> {
  const raw = await SherpaOnnx.transcribeSamples(samples, sampleRate);
  return normalizeSttResult(raw);
}

/**
 * Update recognizer config at runtime (decodingMethod, maxActivePaths, hotwordsFile, hotwordsScore, blankPenalty, ruleFsts, ruleFars).
 * Merged with the config from initialization.
 */
export function setSttConfig(options: SttRuntimeConfig): Promise<void> {
  const map: Record<string, string | number> = {};
  if (options.decodingMethod != null)
    map.decodingMethod = options.decodingMethod;
  if (options.maxActivePaths != null)
    map.maxActivePaths = options.maxActivePaths;
  if (options.hotwordsFile != null) map.hotwordsFile = options.hotwordsFile;
  if (options.hotwordsScore != null) map.hotwordsScore = options.hotwordsScore;
  if (options.blankPenalty != null) map.blankPenalty = options.blankPenalty;
  if (options.ruleFsts != null) map.ruleFsts = options.ruleFsts;
  if (options.ruleFars != null) map.ruleFars = options.ruleFars;
  return SherpaOnnx.setSttConfig(map);
}

/**
 * Release STT resources.
 */
export function unloadSTT(): Promise<void> {
  return SherpaOnnx.unloadStt();
}

// Export types and runtime type list
export type {
  STTInitializeOptions,
  STTModelType,
  SttModelOptions,
  SttRecognitionResult,
  SttRuntimeConfig,
  TranscriptionResult,
} from './types';
export {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
} from './types';
