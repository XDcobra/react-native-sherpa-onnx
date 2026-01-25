/**
 * Speaker Diarization feature module
 *
 * @remarks
 * This feature is not yet implemented. This module serves as a placeholder
 * for future speaker diarization functionality.
 *
 * @example
 * ```typescript
 * // Future usage:
 * import { initializeDiarization, diarizeAudio } from 'react-native-sherpa-onnx/diarization';
 *
 * await initializeDiarization({ modelPath: 'models/diarization-model' });
 * const segments = await diarizeAudio('path/to/audio.wav');
 * ```
 */

/**
 * Diarization initialization options (placeholder)
 */
export interface DiarizationInitializeOptions {
  modelPath: string;
  // Additional diarization-specific options will be added here
}

/**
 * Speaker segment with speaker ID
 */
export interface SpeakerSegment {
  speakerId: string;
  start: number;
  end: number;
  // Additional segment fields will be added here
}

/**
 * Initialize Speaker Diarization with model directory.
 *
 * @throws {Error} Not yet implemented
 */
export async function initializeDiarization(
  _options: DiarizationInitializeOptions
): Promise<void> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Perform speaker diarization on an audio file.
 *
 * @throws {Error} Not yet implemented
 */
export function diarizeAudio(_filePath: string): Promise<SpeakerSegment[]> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Release diarization resources.
 *
 * @throws {Error} Not yet implemented
 */
export function unloadDiarization(): Promise<void> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}
