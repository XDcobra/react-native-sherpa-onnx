/**
 * Pipeline audio buffers — public API for react-native-sherpa-onnx/audiobuffer.
 *
 * Two core buffer types:
 * - Offline: immutable, fully populated PCM data
 * - Live: streaming PCM with ring buffer, spool, mic capture
 *
 * Buffers are pipeline building blocks: pass handles to STT, TTS, Enhancement, Alignment, PCM Player.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
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
  LiveAudioBufferCallbacks,
  LiveAudioBufferFramesAppendedEvent,
  LiveAudioBufferErrorEvent,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

type NativeSubscription = { remove: () => void };

const framesCallbacks = new Map<
  string,
  Set<(event: LiveAudioBufferFramesAppendedEvent) => void>
>();
const errorCallbacks = new Map<
  string,
  Set<(event: LiveAudioBufferErrorEvent) => void>
>();

let framesSubscription: NativeSubscription | null = null;
let errorSubscription: NativeSubscription | null = null;

function ensureLiveEventSubscriptions(): void {
  if (framesSubscription && errorSubscription) return;

  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx);

  if (!framesSubscription) {
    framesSubscription = emitter.addListener(
      'pipelineLiveAudioChunk',
      (rawEvent: {
        liveBufferId?: string;
        source?: string;
        sampleRate?: number;
        frameCount?: number;
        totalSamplesWritten?: number;
        samples?: number[];
      }) => {
        const liveBufferId = rawEvent?.liveBufferId;
        if (!liveBufferId) return;

        const callbacks = framesCallbacks.get(liveBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const source =
          rawEvent.source === 'mic' ||
          rawEvent.source === 'append' ||
          rawEvent.source === 'append_offline' ||
          rawEvent.source === 'mixed' ||
          rawEvent.source === 'unknown'
            ? rawEvent.source
            : 'unknown';

        const event: LiveAudioBufferFramesAppendedEvent = {
          liveBufferId,
          source,
          sampleRate: rawEvent.sampleRate ?? 0,
          frameCount: rawEvent.frameCount ?? rawEvent.samples?.length ?? 0,
          totalSamplesWritten: rawEvent.totalSamplesWritten ?? 0,
          samples: rawEvent.samples,
        };

        for (const cb of callbacks) {
          cb(event);
        }
      }
    );
  }

  if (!errorSubscription) {
    errorSubscription = emitter.addListener(
      'pipelineLiveAudioError',
      (rawEvent: { liveBufferId?: string; message?: string }) => {
        const event: LiveAudioBufferErrorEvent = {
          liveBufferId: rawEvent?.liveBufferId,
          message: rawEvent?.message ?? 'Unknown live audio buffer error',
        };

        const targetLiveBufferId = event.liveBufferId;
        if (targetLiveBufferId) {
          const callbacks = errorCallbacks.get(targetLiveBufferId);
          if (!callbacks || callbacks.size === 0) return;
          for (const cb of callbacks) {
            cb(event);
          }
          return;
        }

        // If liveBufferId is missing, broadcast to all registered error listeners.
        for (const callbacks of errorCallbacks.values()) {
          for (const cb of callbacks) {
            cb(event);
          }
        }
      }
    );
  }
}

function maybeTearDownLiveEventSubscriptions(): void {
  const hasFrameCallbacks = [...framesCallbacks.values()].some(
    (set) => set.size > 0
  );
  const hasErrorCallbacks = [...errorCallbacks.values()].some(
    (set) => set.size > 0
  );

  if (hasFrameCallbacks || hasErrorCallbacks) return;

  framesSubscription?.remove();
  errorSubscription?.remove();
  framesSubscription = null;
  errorSubscription = null;
}

function addFramesCallback(
  liveBufferId: string,
  callback: (event: LiveAudioBufferFramesAppendedEvent) => void
): void {
  const set = framesCallbacks.get(liveBufferId) ?? new Set();
  set.add(callback);
  framesCallbacks.set(liveBufferId, set);
}

function addErrorCallback(
  liveBufferId: string,
  callback: (event: LiveAudioBufferErrorEvent) => void
): void {
  const set = errorCallbacks.get(liveBufferId) ?? new Set();
  set.add(callback);
  errorCallbacks.set(liveBufferId, set);
}

function clearLiveAudioBufferCallbacks(liveBufferId: string): void {
  framesCallbacks.delete(liveBufferId);
  errorCallbacks.delete(liveBufferId);
  maybeTearDownLiveEventSubscriptions();
}

/**
 * Subscribe callbacks for a live audio buffer.
 * Returns an unsubscribe function.
 */
export function subscribeLiveAudioBufferEvents(
  liveBufferId: string,
  callbacks: LiveAudioBufferCallbacks
): () => void {
  ensureLiveEventSubscriptions();

  if (callbacks.onFramesAppended) {
    addFramesCallback(liveBufferId, callbacks.onFramesAppended);
  }
  if (callbacks.onError) {
    addErrorCallback(liveBufferId, callbacks.onError);
  }

  return () => {
    if (callbacks.onFramesAppended) {
      const frameSet = framesCallbacks.get(liveBufferId);
      frameSet?.delete(callbacks.onFramesAppended);
      if (frameSet && frameSet.size === 0) {
        framesCallbacks.delete(liveBufferId);
      }
    }
    if (callbacks.onError) {
      const errorSet = errorCallbacks.get(liveBufferId);
      errorSet?.delete(callbacks.onError);
      if (errorSet && errorSet.size === 0) {
        errorCallbacks.delete(liveBufferId);
      }
    }

    maybeTearDownLiveEventSubscriptions();
  };
}

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
  unsubscribeEvents: () => void;
}> {
  const {
    onFramesAppended,
    onError,
    emitAppendedEvents,
    emitAppendedSamples,
    appendEventMinIntervalMs,
  } = options;

  const nativeEmitAppendedEvents =
    emitAppendedEvents ?? Boolean(onFramesAppended);

  const result = await getNative().createLiveAudioBuffer({
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    windowSeconds: options.windowSeconds,
    persistencePath: options.persistencePath,
    persistenceFormat: options.persistenceFormat,
    emitAppendedEvents: nativeEmitAppendedEvents,
    emitAppendedSamples,
    appendEventMinIntervalMs,
  });

  const info = result as unknown as LiveAudioBufferInfo;

  const unsubscribeEvents =
    onFramesAppended || onError
      ? subscribeLiveAudioBufferEvents(info.bufferId, {
          onFramesAppended,
          onError,
        })
      : () => {};

  return {
    info,
    bufferId: info.bufferId as LiveBufferHandleRecording,
    unsubscribeEvents,
  };
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
  clearLiveAudioBufferCallbacks(bufferId);
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
  LiveBufferAppendSource,
  LiveAudioBufferCallbacks,
  LiveAudioBufferFramesAppendedEvent,
  LiveAudioBufferErrorEvent,
  PipelineAudioErrorCodeValue,
} from './types';

export { PipelineAudioErrorCode } from './types';
