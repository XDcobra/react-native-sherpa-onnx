import { NativeEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  SynthesisOptions,
  GeneratedAudio,
  TTSModelInfo,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
} from './types';
import type { InitializeOptions } from '../types';
import { resolveModelPath } from '../utils';

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
 * // Simple string (auto-detect)
 * const result = await initializeTTS('models/sherpa-onnx-vits-piper-en_US-lessac-medium');
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
 * // With explicit model type
 * const result = await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/kokoro-en' },
 *   modelType: 'kokoro'
 * });
 * ```
 */
export async function initializeTTS(
  options: TTSInitializeOptions | InitializeOptions['modelPath']
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
}> {
  // Handle both object syntax and direct path syntax
  let modelPath: InitializeOptions['modelPath'];
  let modelType: string | undefined;
  let numThreads: number | undefined;
  let debug: boolean | undefined;

  if (typeof options === 'object' && 'modelPath' in options) {
    modelPath = options.modelPath;
    modelType = options.modelType;
    numThreads = options.numThreads;
    debug = options.debug;
  } else {
    modelPath = options as InitializeOptions['modelPath'];
    modelType = undefined;
    numThreads = undefined;
    debug = undefined;
  }

  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.initializeTts(
    resolvedPath,
    modelType ?? 'auto',
    numThreads ?? 2,
    debug ?? false
  );
}

/**
 * Generate speech from text.
 *
 * Returns raw audio samples as float array in range [-1.0, 1.0].
 * You can save these samples to a WAV file, stream them, or process them further.
 *
 * @param text - Text to convert to speech
 * @param options - Synthesis options (speaker ID, speed)
 * @returns Promise resolving to generated audio data
 * @example
 * ```typescript
 * // Basic usage
 * const audio = await generateSpeech('Hello, world!');
 * console.log(`Generated ${audio.samples.length} samples at ${audio.sampleRate} Hz`);
 *
 * // With options
 * const audio = await generateSpeech('Hello, world!', {
 *   sid: 0,      // Speaker ID (for multi-speaker models)
 *   speed: 1.2   // 20% faster
 * });
 *
 * // Slower speech
 * const audio = await generateSpeech('Speak slowly', { speed: 0.8 });
 * ```
 */
export async function generateSpeech(
  text: string,
  options?: SynthesisOptions
): Promise<GeneratedAudio> {
  return SherpaOnnx.generateTts(text, options?.sid ?? 0, options?.speed ?? 1.0);
}

const ttsEventEmitter = new NativeEventEmitter();

export type TtsStreamHandlers = {
  onChunk?: (chunk: TtsStreamChunk) => void;
  onEnd?: (event: TtsStreamEnd) => void;
  onError?: (event: TtsStreamError) => void;
};

/**
 * Generate speech in streaming mode (emits chunk events).
 *
 * Returns an unsubscribe function to remove event listeners.
 */
export async function generateSpeechStream(
  text: string,
  options: SynthesisOptions | undefined,
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

  await SherpaOnnx.generateTtsStream(
    text,
    options?.sid ?? 0,
    options?.speed ?? 1.0
  );

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
 * await initializeTTS('models/kokoro-en');
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
 * await initializeTTS('models/vits-piper-en');
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
 * import RNFS from 'react-native-fs';
 *
 * const audio = await generateSpeech('Hello, world!');
 *
 * // Save to documents directory
 * const documentsPath = Platform.OS === 'ios'
 *   ? RNFS.DocumentDirectoryPath
 *   : RNFS.ExternalDirectoryPath;
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

// Export types
export type {
  TTSInitializeOptions,
  TTSModelType,
  SynthesisOptions,
  GeneratedAudio,
  TTSModelInfo,
} from './types';
