import SherpaOnnx from '../NativeSherpaOnnx';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';
import type { AudioOutputFormat } from './types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';

/**
 * Convert a pipeline audio buffer to an encoded audio file.
 *
 * Accepts any offline or finalized live buffer. Live buffers in `recording` state
 * are rejected with BUFFER_NOT_FINALIZED.
 *
 * @param input       - Offline or finalized live audio buffer (ref, handle, or raw ID string).
 * @param outputPath  - Absolute local file path for the output. Parent directory must exist.
 * @param format      - Target audio format.
 * @param outputSampleRateHz - Target sample rate. Semantics depend on format:
 *   - WAV:  0 or omitted = buffer's native sample rate. Explicit value = resample.
 *   - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
 *   - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
 *   - FLAC/AAC/M4A: 0 = buffer's native rate. Explicit value = resample.
 */
export function convertAudioToFormat(
  input: PipelineAudioBufferIdSource,
  outputPath: string,
  format: AudioOutputFormat,
  outputSampleRateHz?: number
): Promise<void> {
  return SherpaOnnx.convertPipelineAudioBufferToFormat(
    resolvePipelineAudioBufferId(input),
    outputPath,
    format,
    outputSampleRateHz ?? 0
  );
}

/**
 * Convert a pipeline audio buffer to WAV 16 kHz mono 16-bit PCM.
 * Shortcut for convertAudioToFormat(input, outputPath, 'wav', 16000).
 */
export function convertAudioToWav16k(
  input: PipelineAudioBufferIdSource,
  outputPath: string
): Promise<void> {
  return convertAudioToFormat(input, outputPath, 'wav', 16000);
}

export type { AudioOutputFormat } from './types';
export { ConversionErrorCode } from './types';
export type { ConversionErrorCodeValue } from './types';
