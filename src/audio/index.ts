import SherpaOnnx from '../NativeSherpaOnnx';

/**
 * Convert any supported audio file to a requested format (e.g. "mp3", "flac", "wav").
 * On Android this requires FFmpeg prebuilts. WAV output is always 16 kHz mono (sherpa-onnx).
 * For MP3, optional outputSampleRateHz: 32000, 44100, or 48000; 0/undefined = 44100.
 * Resolves on success, rejects with an error message on failure.
 */
export function convertAudioToFormat(
  inputPath: string,
  outputPath: string,
  format: string,
  outputSampleRateHz?: number
): Promise<void> {
  return SherpaOnnx.convertAudioToFormat(
    inputPath,
    outputPath,
    format,
    outputSampleRateHz ?? 0
  );
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
