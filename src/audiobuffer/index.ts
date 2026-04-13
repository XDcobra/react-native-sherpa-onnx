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
import { PipelineAudioErrorCode } from './types';
import type {
  OfflineAudioBufferInfo,
  OfflineAudioBufferRef,
  LiveAudioBufferInfo,
  LiveAudioBufferRef,
  PipelineAudioBufferInfo,
  OfflineBufferHandle,
  LiveBufferHandleRecording,
  LiveBufferHandleFinished,
  OfflineAudioBufferIdSource,
  LiveAudioBufferIdSource,
  PipelineAudioBufferIdSource,
  LiveAudioBufferRecordingSource,
  CreateLiveAudioBufferOptions,
  StartMicToLiveOptions,
  OfflineFromLiveMode,
  LiveAudioBufferCallbacks,
  LiveAudioBufferFramesAppendedEvent,
  LiveAudioBufferErrorEvent,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const AUDIO_BUFFER_ID_PATTERN =
  /^(off|live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function createInvalidAudioBufferIdError(
  sourceName: string,
  rawValue: string
): Error {
  return new Error(
    `${PipelineAudioErrorCode.INVALID_ARGUMENT}: ${sourceName} must be a pipeline audio buffer id in the form off_<uuid> or live_<uuid>; received "${rawValue}".`
  );
}

function assertValidAudioBufferId(value: string, sourceName: string): string {
  const id = value.trim();
  if (!AUDIO_BUFFER_ID_PATTERN.test(id)) {
    throw createInvalidAudioBufferIdError(sourceName, value);
  }
  return id;
}

function resolveOfflineAudioBufferId(
  source: OfflineAudioBufferIdSource
): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidAudioBufferId(
      String((source as OfflineAudioBufferRef).bufferId),
      'offline audio buffer source'
    );
  }
  return assertValidAudioBufferId(
    String(source),
    'offline audio buffer source'
  );
}

function resolveLiveAudioBufferId(source: LiveAudioBufferIdSource): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidAudioBufferId(
      String((source as LiveAudioBufferRef).bufferId),
      'live audio buffer source'
    );
  }
  return assertValidAudioBufferId(String(source), 'live audio buffer source');
}

function resolvePipelineAudioBufferId(
  source: PipelineAudioBufferIdSource
): string {
  if (typeof source === 'object' && source !== null) {
    if ('info' in source) {
      return assertValidAudioBufferId(
        String((source as OfflineAudioBufferRef | LiveAudioBufferRef).bufferId),
        'pipeline audio buffer source'
      );
    }
    if ('kind' in source && 'bufferId' in source) {
      return assertValidAudioBufferId(
        String((source as PipelineAudioBufferInfo).bufferId),
        'pipeline audio buffer source'
      );
    }
  }
  return assertValidAudioBufferId(
    String(source),
    'pipeline audio buffer source'
  );
}

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
  liveBufferId: LiveAudioBufferIdSource,
  callbacks: LiveAudioBufferCallbacks
): () => void {
  ensureLiveEventSubscriptions();
  const id = resolveLiveAudioBufferId(liveBufferId);

  if (callbacks.onFramesAppended) {
    addFramesCallback(id, callbacks.onFramesAppended);
  }
  if (callbacks.onError) {
    addErrorCallback(id, callbacks.onError);
  }

  return () => {
    if (callbacks.onFramesAppended) {
      const frameSet = framesCallbacks.get(id);
      frameSet?.delete(callbacks.onFramesAppended);
      if (frameSet && frameSet.size === 0) {
        framesCallbacks.delete(id);
      }
    }
    if (callbacks.onError) {
      const errorSet = errorCallbacks.get(id);
      errorSet?.delete(callbacks.onError);
      if (errorSet && errorSet.size === 0) {
        errorCallbacks.delete(id);
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
): Promise<OfflineAudioBufferRef> {
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
): Promise<OfflineAudioBufferRef> {
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
  liveBufferId: LiveAudioBufferIdSource,
  mode?: OfflineFromLiveMode
): Promise<OfflineAudioBufferRef> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  const result = await getNative().createOfflineAudioBufferFromLive(id, mode);
  const info = result as unknown as OfflineAudioBufferInfo;
  return { info, bufferId: info.bufferId as OfflineBufferHandle };
}

/**
 * Create an empty offline audio buffer as output target (e.g. for TTS synthesis).
 * The buffer starts unpopulated (numSamples=0); native synthesis fills it exactly once.
 *
 * @param sampleRate - Expected sample rate. For TTS: must match model output rate (use `tts.getSampleRate()`).
 * @param channelCount - Channel count (only 1/mono supported, default 1).
 */
export async function createEmptyOfflineAudioBuffer(
  sampleRate: number,
  channelCount?: 1
): Promise<OfflineAudioBufferRef> {
  const result = await getNative().createEmptyOfflineAudioBuffer(
    sampleRate,
    channelCount
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
): Promise<LiveAudioBufferRef> {
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
  liveBufferId: LiveAudioBufferRecordingSource,
  samples: number[],
  sampleRate: number
): Promise<void> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  await getNative().appendSamplesToLiveAudioBuffer(id, samples, sampleRate);
}

/**
 * Append all samples from an offline buffer to a live buffer.
 */
export async function appendOfflineToLiveAudioBuffer(
  liveBufferId: LiveAudioBufferRecordingSource,
  offlineBufferId: OfflineAudioBufferIdSource
): Promise<void> {
  await getNative().appendOfflineToLiveAudioBuffer(
    resolveLiveAudioBufferId(liveBufferId),
    resolveOfflineAudioBufferId(offlineBufferId)
  );
}

/**
 * Finalize a live audio buffer (recording → finished).
 * Returns a finished handle. No more appends allowed after this.
 */
export async function finalizeLiveAudioBuffer(
  liveBufferId: LiveAudioBufferRecordingSource
): Promise<LiveBufferHandleFinished> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  await getNative().finalizeLiveAudioBuffer(id);
  return id as LiveBufferHandleFinished;
}

// ==================== Save ====================

/**
 * Save an offline audio buffer as 16-bit PCM WAV.
 */
export async function saveOfflineAudioBufferToWav(
  bufferId: OfflineAudioBufferIdSource,
  outputPath: string
): Promise<void> {
  await getNative().saveOfflineAudioBufferToWav(
    resolveOfflineAudioBufferId(bufferId),
    outputPath
  );
}

/**
 * Save a live audio buffer as 16-bit PCM WAV.
 */
export async function saveLiveAudioBufferToWav(
  liveBufferId: LiveAudioBufferIdSource,
  outputPath: string
): Promise<void> {
  await getNative().saveLiveAudioBufferToWav(
    resolveLiveAudioBufferId(liveBufferId),
    outputPath
  );
}

// ==================== Info / Release ====================

/**
 * Get info for any pipeline audio buffer (offline or live).
 */
export async function getPipelineAudioBufferInfo(
  bufferId: PipelineAudioBufferIdSource
): Promise<PipelineAudioBufferInfo> {
  const id = resolvePipelineAudioBufferId(bufferId);
  const result = await getNative().getPipelineAudioBufferInfo(id);
  return result as unknown as PipelineAudioBufferInfo;
}

/**
 * Release any pipeline audio buffer (offline or live).
 */
export async function releasePipelineAudioBuffer(
  bufferId: PipelineAudioBufferIdSource
): Promise<void> {
  const id = resolvePipelineAudioBufferId(bufferId);
  await getNative().releasePipelineAudioBuffer(id);
  clearLiveAudioBufferCallbacks(id);
}

// ==================== Live Samples Slice (debug/export) ====================

/**
 * Get a slice of Float32 samples from a live buffer's ring.
 * Useful for debug visualization or export.
 */
export async function getLiveAudioBufferSamplesSlice(
  liveBufferId: LiveAudioBufferIdSource,
  startFrame: number,
  frameCount: number
): Promise<number[]> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  return await getNative().getLiveAudioBufferSamplesSlice(
    id,
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
  liveBufferId: LiveAudioBufferRecordingSource,
  options?: StartMicToLiveOptions
): Promise<void> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  await getNative().startMicToLiveAudioBuffer(
    id,
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
  OfflineAudioBufferRef,
  LiveAudioBufferInfo,
  LiveAudioBufferRef,
  PipelineAudioBufferInfo,
  OfflineAudioBufferIdSource,
  LiveAudioBufferIdSource,
  PipelineAudioBufferIdSource,
  LiveAudioBufferRecordingSource,
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

export type {
  StreamingPipelineStatus,
  StreamingPipelineHandle,
} from './streamingPipelineTypes';

/**
 * Resolve an audio buffer source to a native buffer ID string.
 * Accepts buffer references, info objects, handles, or raw strings.
 */
export { resolvePipelineAudioBufferId };
