import { NativeEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsUpdateOptions,
  TtsGenerationOptions,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TTSModelInfo,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';

/**
 * Flatten model-specific options for the given model type to native init/update params.
 * When modelType is 'auto' or missing, returns undefined for all (native uses defaults).
 */
function flattenTtsModelOptionsForNative(
  modelType: TTSModelType | undefined,
  modelOptions: TtsModelOptions | undefined
): {
  noiseScale: number | undefined;
  noiseScaleW: number | undefined;
  lengthScale: number | undefined;
} {
  if (
    !modelOptions ||
    !modelType ||
    modelType === 'auto' ||
    modelType === 'zipvoice'
  )
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  const block =
    modelType === 'vits'
      ? modelOptions.vits
      : modelType === 'matcha'
      ? modelOptions.matcha
      : modelType === 'kokoro'
      ? modelOptions.kokoro
      : modelType === 'kitten'
      ? modelOptions.kitten
      : modelType === 'pocket'
      ? modelOptions.pocket
      : undefined;
  if (!block)
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  const out: {
    noiseScale: number | undefined;
    noiseScaleW: number | undefined;
    lengthScale: number | undefined;
  } = {
    noiseScale: undefined,
    noiseScaleW: undefined,
    lengthScale: undefined,
  };
  const n = block as {
    noiseScale?: number;
    noiseScaleW?: number;
    lengthScale?: number;
  };
  if (n.noiseScale !== undefined && typeof n.noiseScale === 'number')
    out.noiseScale = n.noiseScale;
  if (n.noiseScaleW !== undefined && typeof n.noiseScaleW === 'number')
    out.noiseScaleW = n.noiseScaleW;
  if (n.lengthScale !== undefined && typeof n.lengthScale === 'number')
    out.lengthScale = n.lengthScale;
  return out;
}

/**
 * Detect TTS model type and structure without initializing the engine.
 * Uses the same native file-based detection as initializeTTS.
 *
 * @param modelPath - Model path configuration (asset, file, or auto)
 * @param options - Optional modelType (default: 'auto')
 * @returns Object with success, detectedModels (array of { type, modelDir }), and modelType (primary detected type)
 * @example
 * ```typescript
 * const result = await detectTtsModel({ type: 'asset', path: 'models/vits-piper-en' });
 * if (result.success) console.log('Detected type:', result.modelType, result.detectedModels);
 * ```
 */
export async function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
}> {
  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.detectTtsModel(resolvedPath, options?.modelType);
}

/**
 * Initialize Text-to-Speech (TTS) with model directory.
 *
 * Supports multiple model source types:
 * - Asset models (bundled in app)
 * - File system models (downloaded or user-provided)
 * - Auto-detection (tries asset first, then file system)
 *
 * Supported model types (auto-detected or explicit):
 * - VITS (includes Piper, Coqui, MeloTTS, MMS)
 * - Matcha (acoustic model + vocoder)
 * - Kokoro (multi-speaker, multi-language)
 * - KittenTTS (lightweight, multi-speaker)
 * - Zipvoice (voice cloning capable)
 *
 * @param options - TTS initialization options or model path configuration
 * @returns Promise resolving to result with success and detected models
 * @example
 * ```typescript
 * // Auto-detect model path
 * const result = await initializeTTS({ type: 'auto', path: 'models/sherpa-onnx-vits-piper-en_US-lessac-medium' });
 * console.log('Detected models:', result.detectedModels);
 *
 * // Asset model
 * const result = await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' }
 * });
 *
 * // File system model with options
 * const result = await initializeTTS({
 *   modelPath: { type: 'file', path: '/path/to/model' },
 *   numThreads: 4,
 *   debug: true
 * });
 *
 * // With explicit model type and model-specific options
 * const result = await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/kokoro-en' },
 *   modelType: 'kokoro',
 *   modelOptions: { kokoro: { lengthScale: 1.2 } }
 * });
 *
 * // VITS with noise/length scales
 * const result = await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' },
 *   modelType: 'vits',
 *   modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } }
 * });
 * ```
 */
export async function initializeTTS(
  options: TTSInitializeOptions | ModelPathConfig
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
}> {
  // Handle both object syntax and direct config syntax
  let modelPath: ModelPathConfig;
  let modelType: TTSModelType | undefined;
  let numThreads: number | undefined;
  let debug: boolean | undefined;
  let modelOptions: TtsModelOptions | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let maxNumSentences: number | undefined;
  let silenceScale: number | undefined;

  if ('modelPath' in options) {
    modelPath = options.modelPath;
    modelType = options.modelType;
    numThreads = options.numThreads;
    debug = options.debug;
    modelOptions = options.modelOptions;
    ruleFsts = options.ruleFsts;
    ruleFars = options.ruleFars;
    maxNumSentences = options.maxNumSentences;
    silenceScale = options.silenceScale;
  } else {
    modelPath = options;
    modelType = undefined;
    numThreads = undefined;
    debug = undefined;
    modelOptions = undefined;
    ruleFsts = undefined;
    ruleFars = undefined;
    maxNumSentences = undefined;
    silenceScale = undefined;
  }

  const flat = flattenTtsModelOptionsForNative(modelType, modelOptions);

  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.initializeTts(
    resolvedPath,
    modelType ?? 'auto',
    numThreads ?? 2,
    debug ?? false,
    flat.noiseScale,
    flat.noiseScaleW,
    flat.lengthScale,
    ruleFsts,
    ruleFars,
    maxNumSentences,
    silenceScale
  );
}

/**
 * Update TTS parameters by re-initializing with stored config.
 * Pass modelType and modelOptions; only the block for modelType is applied and flattened to native.
 */
export async function updateTtsParams(options: TtsUpdateOptions): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
}> {
  const flat = flattenTtsModelOptionsForNative(
    options.modelType,
    options.modelOptions
  );
  const noiseArg = flat.noiseScale === undefined ? Number.NaN : flat.noiseScale;
  const noiseWArg =
    flat.noiseScaleW === undefined ? Number.NaN : flat.noiseScaleW;
  const lengthArg =
    flat.lengthScale === undefined ? Number.NaN : flat.lengthScale;

  return SherpaOnnx.updateTtsParams(noiseArg, noiseWArg, lengthArg);
}

/**
 * Convert TtsGenerationOptions to a flat object for the native bridge.
 * Flattens referenceAudio { samples, sampleRate } to referenceAudio array + referenceSampleRate.
 */
function toNativeTtsOptions(
  options?: TtsGenerationOptions
): Record<string, unknown> {
  if (options == null) return {};
  const out: Record<string, unknown> = {};
  if (options.sid !== undefined) out.sid = options.sid;
  if (options.speed !== undefined) out.speed = options.speed;
  if (options.silenceScale !== undefined)
    out.silenceScale = options.silenceScale;
  if (options.referenceAudio != null) {
    out.referenceAudio = options.referenceAudio.samples;
    out.referenceSampleRate = options.referenceAudio.sampleRate;
  }
  if (options.referenceText !== undefined)
    out.referenceText = options.referenceText;
  if (options.numSteps !== undefined) out.numSteps = options.numSteps;
  if (options.extra != null && Object.keys(options.extra).length > 0)
    out.extra = options.extra;
  return out;
}

/**
 * Generate speech from text.
 *
 * Returns raw audio samples as float array in range [-1.0, 1.0].
 * Supports simple options (sid, speed) and voice cloning / GenerationConfig
 * (referenceAudio, referenceText, numSteps, silenceScale, extra) when the model supports it.
 *
 * @param text - Text to convert to speech
 * @param options - Generation options (maps to Kotlin GenerationConfig when using reference audio)
 * @returns Promise resolving to generated audio data
 * @example
 * ```typescript
 * // Basic usage
 * const audio = await generateSpeech('Hello, world!');
 *
 * // With sid/speed
 * const audio = await generateSpeech('Hello, world!', { sid: 0, speed: 1.2 });
 *
 * // Voice cloning (Zipvoice or Kotlin generateWithConfig)
 * const audio = await generateSpeech('Target text', {
 *   referenceAudio: { samples: refSamples, sampleRate: 22050 },
 *   referenceText: 'Transcript of reference',
 *   numSteps: 20,
 * });
 * ```
 */
export async function generateSpeech(
  text: string,
  options?: TtsGenerationOptions
): Promise<GeneratedAudio> {
  return SherpaOnnx.generateTts(text, toNativeTtsOptions(options));
}

/**
 * Generate speech from text and return subtitle/timestamp metadata.
 *
 * Timestamps are estimated based on the output duration when models do not
 * provide native timing information. Accepts the same options as generateSpeech
 * (including reference audio for voice cloning).
 */
export async function generateSpeechWithTimestamps(
  text: string,
  options?: TtsGenerationOptions
): Promise<GeneratedAudioWithTimestamps> {
  return SherpaOnnx.generateTtsWithTimestamps(
    text,
    toNativeTtsOptions(options)
  );
}

const nativeTtsEventModule =
  SherpaOnnx &&
  typeof (SherpaOnnx as any).addListener === 'function' &&
  typeof (SherpaOnnx as any).removeListeners === 'function'
    ? (SherpaOnnx as any)
    : undefined;

const ttsEventEmitter = new NativeEventEmitter(nativeTtsEventModule);
export type TtsStreamHandlers = {
  onChunk?: (chunk: TtsStreamChunk) => void;
  onEnd?: (event: TtsStreamEnd) => void;
  onError?: (event: TtsStreamError) => void;
};

/**
 * Generate speech in streaming mode (emits chunk events).
 *
 * Returns an unsubscribe function to remove event listeners.
 * Supports the same options as generateSpeech; note: streaming with reference
 * audio is not supported for Zipvoice (use generateSpeech for that case).
 */
export async function generateSpeechStream(
  text: string,
  options: TtsGenerationOptions | undefined,
  handlers: TtsStreamHandlers
): Promise<() => void> {
  const subscriptions = [
    ttsEventEmitter.addListener('ttsStreamChunk', (event) => {
      handlers.onChunk?.(event as TtsStreamChunk);
    }),
    ttsEventEmitter.addListener('ttsStreamEnd', (event) => {
      handlers.onEnd?.(event as TtsStreamEnd);
    }),
    ttsEventEmitter.addListener('ttsStreamError', (event) => {
      handlers.onError?.(event as TtsStreamError);
    }),
  ];

  try {
    await SherpaOnnx.generateTtsStream(text, toNativeTtsOptions(options));
  } catch (error) {
    // Clean up listeners if native call fails
    subscriptions.forEach((sub) => sub.remove());
    throw error;
  }

  return () => {
    subscriptions.forEach((sub) => sub.remove());
  };
}

/**
 * Cancel ongoing streaming TTS generation.
 */
export function cancelSpeechStream(): Promise<void> {
  return SherpaOnnx.cancelTtsStream();
}

/**
 * Start PCM playback for streaming TTS.
 */
export function startTtsPcmPlayer(
  sampleRate: number,
  channels: number
): Promise<void> {
  return SherpaOnnx.startTtsPcmPlayer(sampleRate, channels);
}

/**
 * Write PCM samples to the streaming TTS player.
 */
export function writeTtsPcmChunk(samples: number[]): Promise<void> {
  return SherpaOnnx.writeTtsPcmChunk(samples);
}

/**
 * Stop PCM playback for streaming TTS.
 */
export function stopTtsPcmPlayer(): Promise<void> {
  return SherpaOnnx.stopTtsPcmPlayer();
}

/**
 * Get TTS model information.
 *
 * Returns the sample rate and number of available speakers/voices.
 * Call this after initialization to check model capabilities.
 *
 * @returns Promise resolving to model information
 * @example
 * ```typescript
 * await initializeTTS({ type: 'auto', path: 'models/kokoro-en' });
 * const info = await getModelInfo();
 *
 * console.log(`Sample rate: ${info.sampleRate} Hz`);
 * console.log(`Available speakers: ${info.numSpeakers}`);
 *
 * if (info.numSpeakers > 1) {
 *   // Multi-speaker model, can use different voices
 *   const audio = await generateSpeech('Hello', { sid: 1 });
 * }
 * ```
 */
export async function getModelInfo(): Promise<TTSModelInfo> {
  const [sampleRate, numSpeakers] = await Promise.all([
    SherpaOnnx.getTtsSampleRate(),
    SherpaOnnx.getTtsNumSpeakers(),
  ]);

  return {
    sampleRate,
    numSpeakers,
  };
}

/**
 * Get the sample rate of the initialized TTS model.
 *
 * @returns Promise resolving to sample rate in Hz
 * @example
 * ```typescript
 * const sampleRate = await getSampleRate();
 * console.log(`Model outputs audio at ${sampleRate} Hz`);
 * ```
 */
export function getSampleRate(): Promise<number> {
  return SherpaOnnx.getTtsSampleRate();
}

/**
 * Get the number of speakers/voices available in the model.
 *
 * @returns Promise resolving to number of speakers
 * - 0 or 1: Single-speaker model
 * - >1: Multi-speaker model
 * @example
 * ```typescript
 * const numSpeakers = await getNumSpeakers();
 *
 * if (numSpeakers > 1) {
 *   console.log(`Model has ${numSpeakers} different voices`);
 *   // Generate with different voices
 *   for (let i = 0; i < numSpeakers; i++) {
 *     const audio = await generateSpeech('Hello', { sid: i });
 *     // ... use audio
 *   }
 * }
 * ```
 */
export function getNumSpeakers(): Promise<number> {
  return SherpaOnnx.getTtsNumSpeakers();
}

/**
 * Release TTS resources.
 *
 * Call this when you're done using TTS to free up memory.
 * After calling this, you must call `initializeTTS()` again before
 * using TTS functions.
 *
 * @example
 * ```typescript
 * await initializeTTS({ type: 'auto', path: 'models/vits-piper-en' });
 * const audio = await generateSpeech('Hello');
 * // ... use audio
 * await unloadTTS(); // Free resources
 * ```
 */
export function unloadTTS(): Promise<void> {
  return SherpaOnnx.unloadTts();
}

/**
 * Save generated TTS audio to a WAV file.
 *
 * @param audio - Generated audio from generateSpeech()
 * @param filePath - Absolute path where to save the WAV file
 * @returns Promise resolving to the file path where audio was saved
 * @example
 * ```typescript
 * import { Platform } from 'react-native';
 * import {DocumentDirectoryPath, ExternalDirectoryPath} from '@dr.pogodin/react-native-fs';
 *
 * const audio = await generateSpeech('Hello, world!');
 *
 * // Save to documents directory
 * const documentsPath = Platform.OS === 'ios'
 *   ? DocumentDirectoryPath
 *   : ExternalDirectoryPath;
 * const filePath = `${documentsPath}/speech_${Date.now()}.wav`;
 *
 * const savedPath = await saveAudioToFile(audio, filePath);
 * console.log('Audio saved to:', savedPath);
 * ```
 */
export function saveAudioToFile(
  audio: GeneratedAudio,
  filePath: string
): Promise<string> {
  return SherpaOnnx.saveTtsAudioToFile(
    audio.samples,
    audio.sampleRate,
    filePath
  );
}

/**
 * Save generated TTS audio to a WAV file via Android SAF content URI.
 *
 * @param audio - Generated audio from generateSpeech()
 * @param directoryUri - Directory content URI from SAF
 * @param filename - Desired file name
 * @returns Promise resolving to content URI of the saved file
 */
export function saveAudioToContentUri(
  audio: GeneratedAudio,
  directoryUri: string,
  filename: string
): Promise<string> {
  return SherpaOnnx.saveTtsAudioToContentUri(
    audio.samples,
    audio.sampleRate,
    directoryUri,
    filename
  );
}

/**
 * Save a text file via Android SAF content URI.
 *
 * @param text - Text content to write
 * @param directoryUri - Directory content URI from SAF
 * @param filename - Desired file name
 * @param mimeType - MIME type (default: text/plain)
 * @returns Promise resolving to content URI of the saved file
 */
export function saveTextToContentUri(
  text: string,
  directoryUri: string,
  filename: string,
  mimeType = 'text/plain'
): Promise<string> {
  return SherpaOnnx.saveTtsTextToContentUri(
    text,
    directoryUri,
    filename,
    mimeType
  );
}

/**
 * Copy a SAF content URI to a cache file for local playback (Android only).
 *
 * @param fileUri - Content URI of the saved WAV file
 * @param filename - Desired cache filename
 * @returns Promise resolving to absolute path of the cached file
 */
export function copyContentUriToCache(
  fileUri: string,
  filename: string
): Promise<string> {
  return SherpaOnnx.copyTtsContentUriToCache(fileUri, filename);
}

/**
 * Share a TTS audio file (file path or content URI).
 *
 * @param fileUri - File path or content URI
 * @param mimeType - MIME type (default: audio/wav)
 */
export function shareAudioFile(
  fileUri: string,
  mimeType = 'audio/wav'
): Promise<void> {
  return SherpaOnnx.shareTtsAudio(fileUri, mimeType);
}

// Export types and runtime type list
export type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsVitsModelOptions,
  TtsMatchaModelOptions,
  TtsKokoroModelOptions,
  TtsKittenModelOptions,
  TtsPocketModelOptions,
  TtsUpdateOptions,
  TtsGenerationOptions,
  SynthesisOptions,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TtsSubtitleItem,
  TTSModelInfo,
} from './types';
export { TTS_MODEL_TYPES } from './types';
