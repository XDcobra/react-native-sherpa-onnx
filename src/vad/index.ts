/**
 * Voice Activity Detection (VAD) feature module
 *
 * @remarks
 * This feature is not yet implemented. This module serves as a placeholder
 * for future VAD functionality.
 *
 * @example
 * ```typescript
 * // Future usage:
 * import { initializeVAD, detectVoiceActivity } from 'react-native-sherpa-onnx/vad';
 *
 * await initializeVAD({ modelPath: 'models/vad-model' });
 * const segments = await detectVoiceActivity('path/to/audio.wav');
 * ```
 */

/**
 * VAD initialization options (placeholder)
 */
export interface VADInitializeOptions {
  modelPath: string;
  // Additional VAD-specific options will be added here
}

/**
 * Voice activity segment
 */
export interface VoiceSegment {
  start: number;
  end: number;
  // Additional segment fields will be added here
}

/**
 * Initialize Voice Activity Detection (VAD) with model directory.
 *
 * @throws {Error} Not yet implemented
 */
export async function initializeVAD(
  _options: VADInitializeOptions
): Promise<void> {
  throw new Error(
    'VAD feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Detect voice activity in an audio file.
 *
 * @throws {Error} Not yet implemented
 */
export function detectVoiceActivity(
  _filePath: string
): Promise<VoiceSegment[]> {
  throw new Error(
    'VAD feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Release VAD resources.
 *
 * @throws {Error} Not yet implemented
 */
export function unloadVAD(): Promise<void> {
  throw new Error(
    'VAD feature is not yet implemented. This is a placeholder module.'
  );
}
