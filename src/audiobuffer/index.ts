/**
 * Pipeline audio buffers — public API for react-native-sherpa-onnx/audiobuffer.
 *
 * Two core buffer types:
 * - Offline: immutable, fully populated PCM data
 * - Live: streaming PCM with ring buffer, spool, mic capture
 *
 * Buffers are pipeline building blocks: pass handles to STT, TTS, Enhancement, Alignment, PCM Player.
 */

import { NativeEventEmitter, TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import {
  advanceAudioCommitStart,
  annotateSpeechSegment,
  consumeSpeechSegmentAnnotation,
  getLiveAudioSegmentation,
  registerAttachedSegmentationEngine,
  normalizeSegmentationMode,
  registerLiveAudioSegmentation,
  releaseSegmentationStateForBuffer,
  setAssociatedAudioSegmentBuffer,
} from '../segment/runtime-state';
import {
  installJSI as installJSIBindings,
  isJSIAvailable,
  requireJSI,
} from './jsi';
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
  CreateEmptyLiveAudioBufferOptions,
  StartMicToLiveOptions,
  OfflineFromLiveMode,
  OfflineTransferFromLiveMode,
  LiveAudioBufferCallbacks,
  LiveAudioBufferFramesAppendedEvent,
  LiveAudioBufferSegmentEvent,
  LiveAudioBufferErrorEvent,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const AUDIO_BUFFER_ID_PATTERN =
  /^(off|live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

let opIdCounter = 0;

const DEFAULT_SPEECH_SEGMENTATION_POLICY = {
  evaluator: 'speech_energy_silence' as const,
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
  hangoverMs: 300,
};

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

function getFloat32ArrayBuffer(samples: Float32Array): ArrayBuffer {
  const backing = samples.buffer;
  if (
    backing instanceof ArrayBuffer &&
    samples.byteOffset === 0 &&
    samples.byteLength === backing.byteLength
  ) {
    return backing;
  }

  // Preserve only the visible view when caller passes a subarray.
  const copy = new Float32Array(samples.length);
  copy.set(samples);
  return copy.buffer;
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
const segmentCallbacks = new Map<
  string,
  Set<(event: LiveAudioBufferSegmentEvent) => void>
>();

let framesSubscription: NativeSubscription | null = null;
let errorSubscription: NativeSubscription | null = null;
let segmentSubscription: NativeSubscription | null = null;

function toSegmentReason(
  raw: unknown
):
  | 'endpoint'
  | 'punctuation'
  | 'length_limit'
  | 'vad_boundary'
  | 'energy_silence'
  | 'manual_commit'
  | 'finalize'
  | 'policy_checkpoint' {
  return raw === 'endpoint' ||
    raw === 'punctuation' ||
    raw === 'length_limit' ||
    raw === 'vad_boundary' ||
    raw === 'energy_silence' ||
    raw === 'manual_commit' ||
    raw === 'finalize' ||
    raw === 'policy_checkpoint'
    ? raw
    : 'manual_commit';
}

function toSegmentSource(
  raw: unknown
): 'segmentation_engine' | 'manual' | 'external' {
  return raw === 'segmentation_engine' || raw === 'manual' || raw === 'external'
    ? raw
    : 'manual';
}

function ensureLiveEventSubscriptions(): void {
  if (framesSubscription && errorSubscription && segmentSubscription) return;

  const emitter = new NativeEventEmitter();

  if (!framesSubscription) {
    framesSubscription = emitter.addListener(
      'pipelineLiveAudioChunk',
      (rawEvent: {
        liveBufferId?: string;
        source?: string;
        sampleRate?: number;
        frameCount?: number;
        totalSamplesWritten?: number;
      }) => {
        const liveBufferId = rawEvent?.liveBufferId;
        if (!liveBufferId) return;

        const callbacks = framesCallbacks.get(liveBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const source =
          rawEvent.source === 'mic' ||
          rawEvent.source === 'append' ||
          rawEvent.source === 'append_offline' ||
          rawEvent.source === 'file_ingest' ||
          rawEvent.source === 'mixed' ||
          rawEvent.source === 'unknown'
            ? rawEvent.source
            : 'unknown';

        const event: LiveAudioBufferFramesAppendedEvent = {
          liveBufferId,
          source,
          sampleRate: rawEvent.sampleRate ?? 0,
          frameCount: rawEvent.frameCount ?? 0,
          totalSamplesWritten: rawEvent.totalSamplesWritten ?? 0,
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

  if (!segmentSubscription) {
    segmentSubscription = emitter.addListener(
      'pipelineLiveSegmentAppended',
      (rawEvent: {
        sourceAudioBufferId?: string;
        segmentId?: string;
        segmentIndex?: number;
        totalSegments?: number;
        startSample?: number;
        endSample?: number;
        sampleRate?: number;
        durationMs?: number;
        confidence?: number;
        payload?: Record<string, unknown>;
        reason?: string;
        source?: string;
        createdAtMs?: number;
      }) => {
        const sourceAudioBufferId = rawEvent?.sourceAudioBufferId;
        if (!sourceAudioBufferId) return;

        const callbacks = segmentCallbacks.get(sourceAudioBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const segmentId =
          typeof rawEvent.segmentId === 'string' ? rawEvent.segmentId : '';
        const segmentIndex =
          typeof rawEvent.segmentIndex === 'number'
            ? Math.trunc(rawEvent.segmentIndex)
            : 0;
        const eventReason = toSegmentReason(rawEvent.reason);
        const eventSource = toSegmentSource(rawEvent.source);
        const eventCreatedAtMs =
          typeof rawEvent.createdAtMs === 'number'
            ? Math.trunc(rawEvent.createdAtMs)
            : Date.now();

        if (segmentId.length > 0 && rawEvent.reason && rawEvent.source) {
          annotateSpeechSegment(
            segmentId,
            {
              reason: eventReason,
              source: eventSource,
              createdAtMs: eventCreatedAtMs,
              segmentIndex,
            },
            sourceAudioBufferId
          );
        }

        const annotation =
          segmentId.length > 0
            ? consumeSpeechSegmentAnnotation(segmentId)
            : undefined;

        const segment = {
          segmentId,
          domain: 'speech' as const,
          startOffset:
            typeof rawEvent.startSample === 'number'
              ? Math.trunc(rawEvent.startSample)
              : 0,
          endOffset:
            typeof rawEvent.endSample === 'number'
              ? Math.trunc(rawEvent.endSample)
              : 0,
          reason: annotation?.reason ?? eventReason,
          source: annotation?.source ?? eventSource,
          createdAtMs: annotation?.createdAtMs ?? eventCreatedAtMs,
          segmentIndex,
          sourceAudioBufferId,
          sampleRate:
            typeof rawEvent.sampleRate === 'number'
              ? Math.trunc(rawEvent.sampleRate)
              : 0,
          durationMs:
            typeof rawEvent.durationMs === 'number' ? rawEvent.durationMs : 0,
          ...(typeof rawEvent.confidence === 'number'
            ? { confidence: rawEvent.confidence }
            : {}),
          ...(rawEvent.payload != null
            ? { meta: { payload: rawEvent.payload } }
            : {}),
        };

        const totalSegments =
          typeof rawEvent.totalSegments === 'number'
            ? Math.trunc(rawEvent.totalSegments)
            : Math.max(1, segmentIndex + 1);

        const event: LiveAudioBufferSegmentEvent = {
          bufferId: sourceAudioBufferId,
          segment,
          totalSegments,
        };

        for (const cb of callbacks) {
          cb(event);
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
  const hasSegmentCallbacks = [...segmentCallbacks.values()].some(
    (set) => set.size > 0
  );

  if (hasFrameCallbacks || hasErrorCallbacks || hasSegmentCallbacks) return;

  framesSubscription?.remove();
  errorSubscription?.remove();
  segmentSubscription?.remove();
  framesSubscription = null;
  errorSubscription = null;
  segmentSubscription = null;
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

function addSegmentCallback(
  liveBufferId: string,
  callback: (event: LiveAudioBufferSegmentEvent) => void
): void {
  const set = segmentCallbacks.get(liveBufferId) ?? new Set();
  set.add(callback);
  segmentCallbacks.set(liveBufferId, set);
}

function clearLiveAudioBufferCallbacks(liveBufferId: string): void {
  framesCallbacks.delete(liveBufferId);
  errorCallbacks.delete(liveBufferId);
  segmentCallbacks.delete(liveBufferId);
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
  if (callbacks.onSegment) {
    addSegmentCallback(id, callbacks.onSegment);
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
    if (callbacks.onSegment) {
      const segmentSet = segmentCallbacks.get(id);
      segmentSet?.delete(callbacks.onSegment);
      if (segmentSet && segmentSet.size === 0) {
        segmentCallbacks.delete(id);
      }
    }

    maybeTearDownLiveEventSubscriptions();
  };
}

async function commitFinalizeSegmentIfNeeded(
  liveBufferId: string
): Promise<void> {
  const segmentationMode = normalizeSegmentationMode(
    getLiveAudioSegmentation(liveBufferId)?.mode,
    'off'
  );
  if (segmentationMode !== 'manual') return;

  const info = await getPipelineAudioBufferInfo(liveBufferId);
  if (info.kind !== 'livePcmBuffer') return;

  const state = getLiveAudioSegmentation(liveBufferId);
  const startSample = state?.nextCommitStartSample ?? 0;
  const endSample = Math.trunc(info.totalSamplesWritten);
  if (endSample <= startSample) return;

  let segmentBufferId = state?.associatedSegmentBufferId;
  if (!segmentBufferId) {
    const created = await getNative().createLiveSegmentBuffer({
      sourceAudioBufferId: liveBufferId,
      emitSegmentAppendedEvents: true,
      segmentEventMinIntervalMs: 0,
    });
    segmentBufferId = created.bufferId;
    setAssociatedAudioSegmentBuffer(liveBufferId, segmentBufferId);
  }

  const durationMs = ((endSample - startSample) / info.sampleRate) * 1000;
  const appendResult = await getNative().appendLiveSegment(
    segmentBufferId,
    'speech',
    liveBufferId,
    startSample,
    endSample,
    info.sampleRate,
    durationMs,
    undefined,
    undefined
  );

  const totalSegments = await getNative().getLiveSegmentBufferSegmentCount(
    segmentBufferId
  );
  annotateSpeechSegment(
    appendResult.segmentId,
    {
      reason: 'finalize',
      source: 'manual',
      createdAtMs: Date.now(),
      segmentIndex: Math.max(0, totalSegments - 1),
    },
    liveBufferId
  );
  advanceAudioCommitStart(liveBufferId, endSample);
}

// ==================== Offline Audio Buffer ====================

/**
 * Decode an audio file into an immutable offline pipeline buffer.
 *
 * Accepts any audio format supported by FFmpeg (wav, mp3, flac, aac, opus, ogg, etc.).
 * Format is auto-detected from file content (no format hint needed).
 *
 * Small files (<10 MB decoded PCM) are stored in memory.
 * Large files are file-backed (streaming reader, no full memory load).
 *
 * File source resolution uses the fileio resolver for all FileSource kinds.
 * Decode + resample + downmix happen in a single native pass (FFmpeg + SwrContext).
 *
 * @param source - Any FileSource: fs, app, contentUri, securityScoped, pad.
 * @param options - Decode options (sample rate, mono, cancellation, progress).
 * @returns Immutable offline buffer reference.
 */
export async function createOfflineAudioBufferFromFile(
  source: import('../fileio/types').FileSource,
  options?: import('./types').AudioDecodeOptions
): Promise<OfflineAudioBufferRef> {
  const operationId = `decode_${Date.now()}_${++opIdCounter}`;
  const targetSampleRateHz = options?.targetSampleRateHz ?? 0;
  const forceMono = options?.forceMono ?? true;

  let progressSubscription: NativeSubscription | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    if (options?.onProgress) {
      const emitter = new NativeEventEmitter();
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener(
        'decodeProgress',
        (event: any) => {
          if (event?.operationId === operationId) {
            onProgress({
              framesDecoded: event.framesDecoded,
              totalFramesEstimate: event.totalFramesEstimate,
              percent: event.percent,
              sourceSampleRate: event.sourceSampleRate,
              sourceChannels: event.sourceChannels,
            });
          }
        }
      );
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        throw Object.assign(new Error('Operation cancelled'), {
          code: 'DECODE_CANCELLED',
        });
      }
      abortHandler = () => {
        getNative().cancelDecode(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    const result = await getNative().decodeFileToOfflineBuffer(
      source as any,
      targetSampleRateHz,
      forceMono,
      operationId
    );
    const info = result as unknown as OfflineAudioBufferInfo;
    return { info, bufferId: info.bufferId as OfflineBufferHandle };
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Create an offline audio buffer from Float32 PCM samples.
 */
export function createOfflineAudioBufferFromSamples(
  samples: Float32Array,
  sampleRate: number,
  channelCount?: number
): OfflineAudioBufferRef {
  const jsi = requireJSI();
  const json = jsi.createOfflineFromSamples(
    getFloat32ArrayBuffer(samples),
    sampleRate,
    channelCount ?? 1
  );

  let info: OfflineAudioBufferInfo;
  try {
    info = JSON.parse(json) as OfflineAudioBufferInfo;
  } catch {
    throw new Error(
      `${PipelineAudioErrorCode.INTERNAL_ERROR}: Failed to parse offline buffer info from JSI.`
    );
  }

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
 * Transfer ownership of a finalized live spool into a new offline buffer without copying.
 *
 * On success, the source live buffer becomes invalidated and must no longer be used.
 */
export async function transferOfflineAudioBufferFromLive(
  liveBufferId: LiveAudioBufferIdSource,
  mode: OfflineTransferFromLiveMode = 'fullIfSpooled'
): Promise<OfflineAudioBufferRef> {
  const id = resolveLiveAudioBufferId(liveBufferId);
  const result = await getNative().transferOfflineAudioBufferFromLive(id, mode);
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
export async function createEmptyLiveAudioBuffer(
  options: CreateEmptyLiveAudioBufferOptions
): Promise<LiveAudioBufferRef> {
  const { onFramesAppended, onSegment, onError, streamEvents, retention } =
    options;

  const fr = streamEvents?.framesAppended;
  const nativeEmitAppendedEvents =
    fr !== undefined ? fr.enabled === true : Boolean(onFramesAppended);
  const appendEventMinIntervalMs =
    fr !== undefined
      ? typeof fr.minIntervalMs === 'number' &&
        Number.isFinite(fr.minIntervalMs)
        ? Math.max(0, Math.trunc(fr.minIntervalMs))
        : 0
      : 0;

  // Parse retention union into flat native args
  let retentionMode: string | undefined;
  let retentionSeconds: number | undefined;
  let retentionPath: string | undefined;
  let retentionTrim: string | undefined;
  let retentionTrimMaxSeconds: number | undefined;

  if (retention === undefined || retention === 'auto') {
    retentionMode = 'auto';
  } else if (retention === 'session') {
    retentionMode = 'session';
  } else if (retention === 'none') {
    retentionMode = 'none';
  } else if (typeof retention === 'object' && retention.mode === 'maxSeconds') {
    retentionMode = 'maxSeconds';
    retentionSeconds = retention.seconds;
    retentionPath = retention.path;
  } else if (typeof retention === 'object' && retention.mode === 'path') {
    retentionMode = 'path';
    retentionPath = retention.path;
    if (retention.trim === 'auto' || retention.trim === 'session') {
      retentionTrim = retention.trim;
    } else if (
      typeof retention.trim === 'object' &&
      'maxSeconds' in retention.trim
    ) {
      retentionTrim = 'maxSeconds';
      retentionTrimMaxSeconds = retention.trim.maxSeconds;
    }
  }

  const result = await getNative().createEmptyLiveAudioBuffer({
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    ringSeconds: options.ringSeconds,
    retentionMode,
    retentionSeconds,
    retentionPath,
    retentionTrim,
    retentionTrimMaxSeconds,
    emitAppendedEvents: nativeEmitAppendedEvents,
    appendEventMinIntervalMs,
  });

  const info = result as unknown as LiveAudioBufferInfo;

  const segmentationMode = normalizeSegmentationMode(
    options.segmentation?.mode,
    'off'
  );
  registerLiveAudioSegmentation(info.bufferId, segmentationMode);

  if (segmentationMode === 'auto') {
    try {
      const attached = await getNative().attachSegmentationEngine(
        info.bufferId,
        'speech',
        options.segmentation?.policy ?? DEFAULT_SPEECH_SEGMENTATION_POLICY
      );
      registerAttachedSegmentationEngine(
        info.bufferId,
        attached.engineId,
        'speech',
        {
          associatedSegmentBufferId:
            typeof attached.segmentBufferId === 'string'
              ? attached.segmentBufferId
              : undefined,
        }
      );
      if (typeof attached.segmentBufferId === 'string') {
        setAssociatedAudioSegmentBuffer(
          info.bufferId,
          attached.segmentBufferId
        );
      }
    } catch (error) {
      await getNative()
        .releasePipelineAudioBuffer(info.bufferId)
        .catch(() => {
          // Best-effort cleanup if native engine attachment fails.
        });
      throw error;
    }
  }

  const unsubscribeEvents =
    onFramesAppended || onSegment || onError
      ? subscribeLiveAudioBufferEvents(info.bufferId, {
          onFramesAppended,
          onSegment,
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
export function appendSamplesToLiveAudioBuffer(
  liveBufferId: LiveAudioBufferRecordingSource,
  samples: Float32Array,
  sampleRate: number
): void {
  const jsi = requireJSI();
  const id = resolveLiveAudioBufferId(liveBufferId);
  jsi.appendSamplesToLive(id, getFloat32ArrayBuffer(samples), sampleRate);
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
  await commitFinalizeSegmentIfNeeded(id);
  await getNative().finalizeLiveAudioBuffer(id);
  return id as LiveBufferHandleFinished;
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
  releaseSegmentationStateForBuffer(id);
  await getNative().releasePipelineAudioBuffer(id);
  clearLiveAudioBufferCallbacks(id);
}

// ==================== Samples Slice (debug/export) ====================

/**
 * Get a slice of Float32 samples from an offline in-memory buffer.
 */
export function getOfflineAudioBufferSamplesSlice(
  offlineBufferId: OfflineAudioBufferIdSource,
  startFrame: number,
  frameCount: number
): Float32Array {
  const jsi = requireJSI();
  const id = resolveOfflineAudioBufferId(offlineBufferId);
  const buffer = jsi.getOfflineBufferSamples(id, startFrame, frameCount);
  return new Float32Array(buffer);
}

/**
 * Get a slice of Float32 samples from a live buffer's ring.
 * Useful for debug visualization or export.
 */
export function getLiveAudioBufferSamplesSlice(
  liveBufferId: LiveAudioBufferIdSource,
  startFrame: number,
  frameCount: number
): Float32Array {
  const jsi = requireJSI();
  const id = resolveLiveAudioBufferId(liveBufferId);
  const buffer = jsi.getLiveBufferSamples(id, startFrame, frameCount);
  return new Float32Array(buffer);
}

/**
 * Install JSI bindings manually as fallback.
 * Usually not needed because native auto-installs during module setup.
 */
export function installJSI(): boolean {
  if (isJSIAvailable()) {
    return true;
  }
  return installJSIBindings();
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
    options
      ? {
          emitToJs: options.emitToJs,
        }
      : undefined
  );
}

/**
 * Stop microphone capture to a live audio buffer.
 */
export async function stopMicToLiveAudioBuffer(): Promise<void> {
  await getNative().stopMicToLiveAudioBuffer();
}

// ==================== File Ingest to Live Buffer ====================

/**
 * Decode an audio file and stream its PCM chunks into an existing live buffer.
 *
 * The live buffer must be in `recording` state. Chunks are appended as they
 * are decoded — downstream pipeline consumers (STT, enhancement) can start
 * processing before the file is fully decoded.
 *
 * Spool is automatically enabled for the duration of file ingest to prevent
 * data loss (ring overwrite during fast decode).
 *
 * `onFramesAppended` fires per decoded chunk with `source: 'file_ingest'`.
 *
 * @param liveBuffer - Live buffer in recording state.
 * @param source - Any FileSource: fs, app, contentUri, securityScoped, pad.
 * @param options - Decode + ingest options.
 * @returns Handle to monitor/cancel the ingest operation.
 */
export async function ingestFileToLiveAudioBuffer(
  liveBuffer: LiveAudioBufferRecordingSource,
  source: import('../fileio/types').FileSource,
  options?: import('./types').FileIngestOptions
): Promise<import('./types').FileIngestHandle> {
  const operationId = `ingest_${Date.now()}_${++opIdCounter}`;
  const liveBufferId = resolveLiveAudioBufferId(liveBuffer);
  const targetSampleRateHz = options?.targetSampleRateHz ?? 0;
  const forceMono = options?.forceMono ?? true;
  const autoFinalize = options?.autoFinalize ?? false;
  const backpressure = options?.backpressure ?? 'block';

  let progressSubscription: NativeSubscription | null = null;
  let abortHandler: (() => void) | null = null;
  const abortController = new AbortController();

  if (options?.onProgress) {
    const emitter = new NativeEventEmitter();
    const onProgress = options.onProgress;
    progressSubscription = emitter.addListener(
      'decodeProgress',
      (event: any) => {
        if (event?.operationId === operationId) {
          onProgress({
            framesDecoded: event.framesDecoded,
            totalFramesEstimate: event.totalFramesEstimate,
            percent: event.percent,
            sourceSampleRate: event.sourceSampleRate,
            sourceChannels: event.sourceChannels,
          });
        }
      }
    );
  }

  if (options?.signal) {
    if (options.signal.aborted) {
      progressSubscription?.remove();
      throw Object.assign(new Error('Operation cancelled'), {
        code: 'DECODE_CANCELLED',
      });
    }
    abortHandler = () => {
      abortController.abort();
      getNative().cancelDecode(operationId);
    };
    options.signal.addEventListener('abort', abortHandler);
  }

  const { ingestId } = await getNative().startFileIngestToLiveBuffer(
    liveBufferId,
    source as any,
    targetSampleRateHz,
    forceMono,
    autoFinalize,
    backpressure,
    operationId
  );

  // The done promise listens for the native completion event
  const done = new Promise<import('./types').FileIngestResult>(
    (resolve, reject) => {
      const emitter = new NativeEventEmitter();
      const sub = emitter.addListener('decodeComplete', (event: any) => {
        if (event?.operationId !== operationId) return;
        sub.remove();
        progressSubscription?.remove();
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        if (event.success) {
          resolve({
            totalFramesIngested: event.totalFramesIngested ?? 0,
            sourceSampleRate: event.sourceSampleRate ?? 0,
            sourceChannels: event.sourceChannels ?? 0,
            autoFinalized: event.autoFinalized ?? false,
          });
        } else {
          reject(
            Object.assign(new Error(event.error ?? 'File ingest failed'), {
              code: event.errorCode ?? 'DECODE_INTERNAL_ERROR',
            })
          );
        }
      });

      // Also listen to abort
      abortController.signal.addEventListener('abort', () => {
        sub.remove();
        progressSubscription?.remove();
        reject(
          Object.assign(new Error('Operation cancelled'), {
            code: 'DECODE_CANCELLED',
          })
        );
      });
    }
  );

  return {
    ingestId,
    liveBufferId,
    done,
    cancel: () => {
      abortController.abort();
      getNative().cancelDecode(operationId);
    },
    getStatus: () => getNative().getFileIngestStatus(ingestId),
  };
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
  CreateEmptyLiveAudioBufferOptions,
  StartMicToLiveOptions,
  OfflineFromLiveMode,
  OfflineTransferFromLiveMode,
  LiveBufferAppendSource,
  LiveAudioBufferCallbacks,
  LiveAudioBufferFramesAppendedEvent,
  LiveAudioBufferSegmentEvent,
  LiveAudioBufferErrorEvent,
  AudioSegmentationMode,
  AudioSegmentationConfig,
  PipelineAudioErrorCodeValue,
  AudioDecodeOptions,
  DecodeProgressEvent,
  FileIngestHandle,
  FileIngestResult,
  FileIngestStatus,
  FileIngestOptions,
  DecodeErrorCodeValue,
} from './types';

export { PipelineAudioErrorCode, DecodeErrorCode } from './types';
export type { StreamEventSpec } from '../pipeline/streamEvents';
export { isJSIAvailable } from './jsi';

export type {
  StreamingPipelineCompletion,
  StreamingPipelineCompletionReason,
  StreamingPipelineStatus,
  StreamingPipelineHandle,
} from './streamingPipelineTypes';

/**
 * Resolve an audio buffer source to a native buffer ID string.
 * Accepts buffer references, info objects, handles, or raw strings.
 */
export { resolvePipelineAudioBufferId };
