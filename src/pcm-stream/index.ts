/**
 * Pipeline Audio Buffers — public API for react-native-sherpa-onnx/pcm-stream.
 *
 * Two core buffer types:
 * - Offline: immutable, fully populated PCM data
 * - Live: streaming PCM with ring buffer, spool, mic capture
 *
 * Buffers are pipeline building blocks: pass handles to STT, TTS, Enhancement, Alignment, PCM Player.
 */

import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type {
  OfflineAudioBufferInfo,
  LiveAudioBufferInfo,
  PipelineAudioBufferInfo,
  OfflineBufferHandle,
  LiveBufferHandleRecording,
  LiveBufferHandleFinished,
  CreateLiveAudioBufferOptions,
  StartMicToLiveOptions,
  OfflineFromLiveMode,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

// ==================== Offline Audio Buffer ====================

/**
 * Create an offline audio buffer from a WAV file.
 * Small files are loaded into memory; large files (>10 MB) stay file-backed.
 */
export async function createOfflineAudioBufferFromFile(
  sourcePath: string,
  targetSampleRateHz?: number,
  forceMono?: boolean
): Promise<{ info: OfflineAudioBufferInfo; bufferId: OfflineBufferHandle }> {
  const result = await getNative().createOfflineAudioBufferFromFile(
    sourcePath,
    targetSampleRateHz,
    forceMono
  );
  const info = result as unknown as OfflineAudioBufferInfo;
  return { info, bufferId: info.bufferId as OfflineBufferHandle };
}

/**
 * Create an offline audio buffer from Float32 PCM samples.
 */
export async function createOfflineAudioBufferFromSamples(
  samples: number[],
  sampleRate: number,
  channelCount?: number
): Promise<{ info: OfflineAudioBufferInfo; bufferId: OfflineBufferHandle }> {
  const result = await getNative().createOfflineAudioBufferFromSamples(
    samples,
    sampleRate,
    channelCount
  );
  const info = result as unknown as OfflineAudioBufferInfo;
  return { info, bufferId: info.bufferId as OfflineBufferHandle };
}

/**
 * Create an offline audio buffer from a live buffer.
 *
 * - "fullIfSpooled" (default): uses spool file if available (no RAM duplication).
 *   Falls back to ring snapshot if no spool.
 * - "windowSnapshot": always snapshots the current ring window.
 */
export async function createOfflineAudioBufferFromLive(
  liveBufferId: string,
  mode?: OfflineFromLiveMode
): Promise<{ info: OfflineAudioBufferInfo; bufferId: OfflineBufferHandle }> {
  const result = await getNative().createOfflineAudioBufferFromLive(
    liveBufferId,
    mode
  );
  const info = result as unknown as OfflineAudioBufferInfo;
  return { info, bufferId: info.bufferId as OfflineBufferHandle };
}

// ==================== Live Audio Buffer ====================

/**
 * Create a live audio buffer with a rolling-window ring buffer.
 */
export async function createLiveAudioBuffer(
  options: CreateLiveAudioBufferOptions
): Promise<{
  info: LiveAudioBufferInfo;
  bufferId: LiveBufferHandleRecording;
}> {
  const result = await getNative().createLiveAudioBuffer({
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    windowSeconds: options.windowSeconds,
    persistencePath: options.persistencePath,
    persistenceFormat: options.persistenceFormat,
  });
  const info = result as unknown as LiveAudioBufferInfo;
  return { info, bufferId: info.bufferId as LiveBufferHandleRecording };
}

/**
 * Append Float32 samples to a live audio buffer (recording state only).
 */
export async function appendSamplesToLiveAudioBuffer(
  liveBufferId: string,
  samples: number[],
  sampleRate: number
): Promise<void> {
  await getNative().appendSamplesToLiveAudioBuffer(
    liveBufferId,
    samples,
    sampleRate
  );
}

/**
 * Append all samples from an offline buffer to a live buffer.
 */
export async function appendOfflineToLiveAudioBuffer(
  liveBufferId: string,
  offlineBufferId: string
): Promise<void> {
  await getNative().appendOfflineToLiveAudioBuffer(
    liveBufferId,
    offlineBufferId
  );
}

/**
 * Finalize a live audio buffer (recording → finished).
 * Returns a finished handle. No more appends allowed after this.
 */
export async function finalizeLiveAudioBuffer(
  liveBufferId: string
): Promise<LiveBufferHandleFinished> {
  await getNative().finalizeLiveAudioBuffer(liveBufferId);
  return liveBufferId as LiveBufferHandleFinished;
}

// ==================== Save ====================

/**
 * Save an offline audio buffer as 16-bit PCM WAV.
 */
export async function saveOfflineAudioBufferToWav(
  bufferId: string,
  outputPath: string
): Promise<void> {
  await getNative().saveOfflineAudioBufferToWav(bufferId, outputPath);
}

/**
 * Save a live audio buffer as 16-bit PCM WAV.
 */
export async function saveLiveAudioBufferToWav(
  liveBufferId: string,
  outputPath: string
): Promise<void> {
  await getNative().saveLiveAudioBufferToWav(liveBufferId, outputPath);
}

// ==================== Info / Release ====================

/**
 * Get info for any pipeline audio buffer (offline or live).
 */
export async function getPipelineAudioBufferInfo(
  bufferId: string
): Promise<PipelineAudioBufferInfo> {
  const result = await getNative().getPipelineAudioBufferInfo(bufferId);
  return result as unknown as PipelineAudioBufferInfo;
}

/**
 * Release any pipeline audio buffer (offline or live).
 */
export async function releasePipelineAudioBuffer(
  bufferId: string
): Promise<void> {
  await getNative().releasePipelineAudioBuffer(bufferId);
}

// ==================== Live Samples Slice (debug/export) ====================

/**
 * Get a slice of Float32 samples from a live buffer's ring.
 * Useful for debug visualization or export.
 */
export async function getLiveAudioBufferSamplesSlice(
  liveBufferId: string,
  startFrame: number,
  frameCount: number
): Promise<number[]> {
  return await getNative().getLiveAudioBufferSamplesSlice(
    liveBufferId,
    startFrame,
    frameCount
  );
}

// ==================== Mic Capture ====================

/**
 * Start microphone capture directly into a live audio buffer (no JS roundtrip).
 * Mic audio is resampled and written directly into the live buffer's ring.
 */
export async function startMicToLiveAudioBuffer(
  liveBufferId: string,
  options?: StartMicToLiveOptions
): Promise<void> {
  await getNative().startMicToLiveAudioBuffer(
    liveBufferId,
    options ? { emitToJs: options.emitToJs } : undefined
  );
}

/**
 * Stop microphone capture to a live audio buffer.
 */
export async function stopMicToLiveAudioBuffer(): Promise<void> {
  await getNative().stopMicToLiveAudioBuffer();
}

// ==================== Re-exports ====================

export type {
  OfflineAudioBufferInfo,
  LiveAudioBufferInfo,
  PipelineAudioBufferInfo,
  OfflineBufferHandle,
  LiveBufferHandleRecording,
  LiveBufferHandleFinished,
  LiveBufferHandle,
  PipelineBufferHandle,
  PipelineBufferKind,
  OfflineBufferState,
  LiveBufferState,
  CreateLiveAudioBufferOptions,
  StartMicToLiveOptions,
  OfflineFromLiveMode,
  PipelineAudioErrorCodeValue,
} from './types';

export { PipelineAudioErrorCode } from './types';
