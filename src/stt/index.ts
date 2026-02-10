import SherpaOnnx from '../NativeSherpaOnnx';
import type { STTInitializeOptions } from './types';
import type { InitializeOptions } from '../types';
import { resolveModelPath } from '../utils';

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
 * // Simple string (auto-detect)
 * const result = await initializeSTT('models/sherpa-onnx-model');
 * console.log('Detected models:', result.detectedModels);
 * // result.detectedModels = [{ type: 'transducer', modelDir: '/path/to/model' }]
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
  options: STTInitializeOptions | InitializeOptions['modelPath']
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
}> {
  // Handle both object syntax and direct path syntax
  let modelPath: InitializeOptions['modelPath'];
  let preferInt8: boolean | undefined;
  let modelType: string | undefined;

  if (typeof options === 'object' && 'modelPath' in options) {
    modelPath = options.modelPath;
    preferInt8 = options.preferInt8;
    modelType = options.modelType;
  } else {
    modelPath = options as InitializeOptions['modelPath'];
    preferInt8 = undefined;
    modelType = undefined;
  }

  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.initializeSherpaOnnx(resolvedPath, preferInt8, modelType);
}

/**
 * Transcribe an audio file.
 *
 * @param filePath - Path to WAV file (16kHz, mono, 16-bit PCM)
 * @returns Promise resolving to transcribed text
 * @example
 * ```typescript
 * const transcription = await transcribeFile('path/to/audio.wav');
 * console.log('Transcription:', transcription);
 * ```
 */
export function transcribeFile(filePath: string): Promise<string> {
  return SherpaOnnx.transcribeFile(filePath);
}

/**
 * Release STT resources.
 */
export function unloadSTT(): Promise<void> {
  return SherpaOnnx.unloadSherpaOnnx();
}

// Export types
export type { STTInitializeOptions, TranscriptionResult } from './types';
