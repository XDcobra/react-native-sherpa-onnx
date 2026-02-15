import SherpaOnnx from '../NativeSherpaOnnx';

/**
 * Convert any supported audio file to a requested format (e.g. "mp3", "flac", "wav").
 * On Android this requires FFmpeg prebuilts. Resolves on success, rejects with an error message on failure.
 */
export function convertAudioToFormat(
  inputPath: string,
  outputPath: string,
  format: string
): Promise<void> {
  return SherpaOnnx.convertAudioToFormat(inputPath, outputPath, format);
}

/**
 * Convert any supported audio file to WAV 16 kHz mono 16-bit PCM.
 * On Android this requires FFmpeg prebuilts. Resolves on success, rejects with an error message on failure.
 */
export function convertAudioToWav16k(
  inputPath: string,
  outputPath: string
): Promise<void> {
  return SherpaOnnx.convertAudioToWav16k(inputPath, outputPath);
}
