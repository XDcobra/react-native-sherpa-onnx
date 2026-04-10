import SherpaOnnx from '../NativeSherpaOnnx';

/**
 * Convert any supported audio file to a requested format (e.g. "mp3", "flac", "wav", "m4a", "opus", "webm").
 * On Android this requires FFmpeg prebuilts. WAV output is always 16 kHz mono (sherpa-onnx).
 * For MP3, optional outputSampleRateHz: 32000, 44100, or 48000; 0/undefined = 44100.
 * For Opus, optional outputSampleRateHz: 8000, 12000, 16000, 24000, or 48000.
 * For M4A/AAC, standard bitrates apply.
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

export type DecodedAudioFloatSamples = {
  samples: number[];
  sampleRate: number;
};

/**
 * Decode a supported audio file to mono float PCM in [-1, 1] plus sample rate.
 * Same decode coverage as {@link convertAudioToFormat} (FFmpeg-backed on Android when not WAV).
 * @param targetSampleRateHz - Resample to this rate when > 0; use native decoded rate when 0 or omitted.
 */
export function decodeAudioFileToFloatSamples(
  inputPath: string,
  targetSampleRateHz?: number
): Promise<DecodedAudioFloatSamples> {
  return SherpaOnnx.decodeAudioFileToFloatSamples(
    inputPath,
    targetSampleRateHz ?? 0
  );
}
