import { Buffer } from 'buffer';
import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';

/**
 * Decode base64-encoded Int16 PCM to float array in [-1, 1].
 * Uses a preallocated Float32Array to avoid GC pressure on the live-mic hot path.
 */
function base64PcmToFloatArray(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength / 2;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export type PcmLiveStreamOptions = {
  sampleRate?: number;
  channelCount?: number;
  bufferSizeFrames?: number;
};

export type PcmLiveStreamHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onData: (
    callback: (samples: Float32Array, sampleRate: number) => void
  ) => () => void;
  onError: (callback: (message: string) => void) => () => void;
};

/**
 * Create a PCM live stream from the device microphone. Native capture and resampling ensure
 * PCM is always delivered at the requested sampleRate (e.g. 16000 for STT). The app must have
 * RECORD_AUDIO (Android) and NSMicrophoneUsageDescription (iOS) and grant permission before start().
 */
export function createPcmLiveStream(
  options?: PcmLiveStreamOptions
): PcmLiveStreamHandle {
  const sampleRate = options?.sampleRate ?? 16000;
  const channelCount = options?.channelCount ?? 1;
  const bufferSizeFrames = options?.bufferSizeFrames ?? 0;

  return {
    start: () =>
      SherpaOnnx.startPcmLiveStream({
        sampleRate,
        channelCount,
        bufferSizeFrames,
      }),

    stop: () => SherpaOnnx.stopPcmLiveStream(),

    onData: (callback: (samples: Float32Array, sampleRate: number) => void) => {
      const sub = DeviceEventEmitter.addListener(
        'pcmLiveStreamData',
        (event: { base64Pcm?: string; sampleRate?: number }) => {
          const base64 = event?.base64Pcm ?? '';
          const sr = event?.sampleRate ?? sampleRate;
          if (base64) {
            const samples = base64PcmToFloatArray(base64);
            callback(samples, sr);
          }
        }
      );
      return () => sub.remove();
    },

    onError: (callback: (message: string) => void) => {
      const sub = DeviceEventEmitter.addListener(
        'pcmLiveStreamError',
        (event: { message?: string }) => {
          callback(event?.message ?? 'Unknown error');
        }
      );
      return () => sub.remove();
    },
  };
}

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
