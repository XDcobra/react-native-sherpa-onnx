import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  SynthesisOptions,
  GeneratedAudio,
  TTSModelInfo,
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
 * @example
 * ```typescript
 * // Simple string (auto-detect)
 * await initializeTTS('models/sherpa-onnx-vits-piper-en_US-lessac-medium');
 *
 * // Asset model
 * await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' }
 * });
 *
 * // File system model with options
 * await initializeTTS({
 *   modelPath: { type: 'file', path: '/path/to/model' },
 *   numThreads: 4,
 *   debug: true
 * });
 *
 * // With explicit model type
 * await initializeTTS({
 *   modelPath: { type: 'asset', path: 'models/kokoro-en' },
 *   modelType: 'kokoro'
 * });
 * ```
 */
export async function initializeTTS(
  options: TTSInitializeOptions | InitializeOptions['modelPath']
): Promise<void> {
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
  return SherpaOnnx.generateTts(
    text,
    options?.sid ?? 0,
    options?.speed ?? 1.0
  );
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

// Export types
export type {
  TTSInitializeOptions,
  TTSModelType,
  SynthesisOptions,
  GeneratedAudio,
  TTSModelInfo,
} from './types';

