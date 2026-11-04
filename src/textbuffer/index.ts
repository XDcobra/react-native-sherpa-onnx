/**
 * Pipeline text buffers — public API for react-native-sherpa-onnx/textbuffer.
 *
 * Two core buffer types:
 * - Offline: immutable, fully populated text data (STT results, imported text)
 * - Live: streaming text with partial updates, recording/finished state machine
 *
 * Text buffers are pipeline building blocks: STT writes results into them,
 * future TTS will consume them as input.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import {
  getLiveTextSegmentation,
  normalizeSegmentationMode,
  registerAttachedSegmentationEngine,
  registerLiveTextSegmentation,
  releaseSegmentationStateForBuffer,
} from '../segment/runtime-state';
import { PipelineTextErrorCode, TEXT_MAX_SLICE_COUNT } from './types';
import { sanitizeJsonMeta } from './jsonMeta';
import type { TextSegment } from '../segment/segment';
import {
  toSegmentReason,
  toSegmentSource,
  inferSegmentReasonFromSource,
} from '../segment/utils';
import type {
  OfflineTextBufferInfo,
  OfflineTextBufferRef,
  LiveTextBufferInfo,
  LiveTextBufferRef,
  PipelineTextBufferInfo,
  OfflineTextBufferHandle,
  LiveTextBufferHandleRecording,
  LiveTextBufferHandleFinished,
  OfflineTextBufferIdSource,
  LiveTextBufferIdSource,
  PipelineTextBufferIdSource,
  LiveTextBufferRecordingSource,
  CreateLiveTextBufferOptions,
  OfflineTextBufferFromLiveMode,
  LiveTextBufferCallbacks,
  LiveTextBufferPartialEvent,
  LiveTextBufferErrorEvent,
  LiveTextBufferSegmentEvent,
  LiveTextSegment,
  LiveTextBufferPartialSource,
  TextBufferSpoolingMode,
  LiveTextBufferSpoolInfo,
  TextSpatialSpan,
  TextSpatialSpanLevel,
  TextSpatialSpanOrigin,
} from './types';

const DEFAULT_TEXT_SEGMENTATION_POLICY = {
  evaluator: 'text_synthetic_auto' as const,
  sentenceBoundary: true,
  maxLengthChars: 500,
};

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const TEXT_BUFFER_ID_PATTERN =
  /^(txt_off|txt_live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalizeSpoolingMode(
  value: unknown,
  spoolEnabled?: boolean
): TextBufferSpoolingMode {
  if (value === 'off' || value === 'auto' || value === 'on') {
    return value;
  }
  return spoolEnabled === false ? 'off' : 'on';
}

function mapLiveTextSpoolInfo(raw: {
  spoolMode?: string;
  spoolEnabled?: boolean;
  spoolReady?: boolean;
  spoolBytes?: number;
  spoolPath?: string;
}): LiveTextBufferSpoolInfo {
  const mode = normalizeSpoolingMode(raw.spoolMode, raw.spoolEnabled);
  return {
    mode,
    enabled: raw.spoolEnabled ?? mode !== 'off',
    ready: raw.spoolReady ?? false,
    bytes: raw.spoolBytes ?? 0,
    ...(typeof raw.spoolPath === 'string' && raw.spoolPath.length > 0
      ? { path: raw.spoolPath }
      : {}),
  };
}

function createInvalidTextBufferIdError(
  sourceName: string,
  rawValue: string
): Error {
  return new Error(
    `${PipelineTextErrorCode.INVALID_ARGUMENT}: ${sourceName} must be a pipeline text buffer id in the form txt_off_<uuid> or txt_live_<uuid>; received "${rawValue}".`
  );
}

function assertValidTextBufferId(value: string, sourceName: string): string {
  const id = value.trim();
  if (!TEXT_BUFFER_ID_PATTERN.test(id)) {
    throw createInvalidTextBufferIdError(sourceName, value);
  }
  return id;
}

function resolveOfflineTextBufferId(source: OfflineTextBufferIdSource): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidTextBufferId(
      String((source as OfflineTextBufferRef).bufferId),
      'offline text buffer source'
    );
  }
  return assertValidTextBufferId(String(source), 'offline text buffer source');
}

function resolveLiveTextBufferId(source: LiveTextBufferIdSource): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidTextBufferId(
      String((source as LiveTextBufferRef).bufferId),
      'live text buffer source'
    );
  }
  return assertValidTextBufferId(String(source), 'live text buffer source');
}

function resolvePipelineTextBufferId(
  source: PipelineTextBufferIdSource
): string {
  if (typeof source === 'object' && source !== null) {
    if ('info' in source) {
      return assertValidTextBufferId(
        String((source as OfflineTextBufferRef | LiveTextBufferRef).bufferId),
        'pipeline text buffer source'
      );
    }
    if ('kind' in source && 'bufferId' in source) {
      return assertValidTextBufferId(
        String((source as PipelineTextBufferInfo).bufferId),
        'pipeline text buffer source'
      );
    }
  }
  return assertValidTextBufferId(String(source), 'pipeline text buffer source');
}

type NativeSubscription = { remove: () => void };

const partialCallbacks = new Map<
  string,
  Set<(event: LiveTextBufferPartialEvent) => void>
>();
const textErrorCallbacks = new Map<
  string,
  Set<(event: LiveTextBufferErrorEvent) => void>
>();
const textSegmentCallbacks = new Map<
  string,
  Set<(event: LiveTextBufferSegmentEvent) => void>
>();
const textLastSegmentIndexByBuffer = new Map<string, number>();

let partialSubscription: NativeSubscription | null = null;
let textErrorSubscription: NativeSubscription | null = null;
let textSegmentSubscription: NativeSubscription | null = null;

function normalizeLiveTextPartialSource(
  value: unknown
): LiveTextBufferPartialSource {
  return value === 'stt_stream' ||
    value === 'kws_stream' ||
    value === 'append' ||
    value === 'replace' ||
    value === 'mixed' ||
    value === 'unknown'
    ? value
    : 'unknown';
}

function dispatchLiveTextSegmentNotify(
  event: LiveTextBufferSegmentEvent
): void {
  const callbacks = textSegmentCallbacks.get(event.liveBufferId);
  if (!callbacks || callbacks.size === 0) return;

  const lastSegmentIndex = textLastSegmentIndexByBuffer.get(event.liveBufferId);
  if (
    typeof lastSegmentIndex === 'number' &&
    event.segmentIndex <= lastSegmentIndex
  ) {
    return;
  }
  textLastSegmentIndexByBuffer.set(event.liveBufferId, event.segmentIndex);

  for (const cb of callbacks) {
    try {
      cb(event);
    } catch {
      /* swallow callback errors */
    }
  }
}

function ensureLiveTextEventSubscriptions(): void {
  if (partialSubscription && textErrorSubscription && textSegmentSubscription)
    return;

  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);

  if (!partialSubscription) {
    partialSubscription = emitter.addListener(
      'pipelineLiveTextPartial',
      (rawEvent: {
        liveBufferId?: string;
        source?: string;
        utf16Length?: number;
        revision?: number;
        isEndpoint?: boolean;
      }) => {
        const liveBufferId = rawEvent?.liveBufferId;
        if (!liveBufferId) return;

        const callbacks = partialCallbacks.get(liveBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const event: LiveTextBufferPartialEvent = {
          liveBufferId,
          source: normalizeLiveTextPartialSource(rawEvent.source),
          utf16Length: Math.max(0, Math.trunc(rawEvent.utf16Length ?? 0)),
          revision: rawEvent.revision ?? 0,
          ...(rawEvent.isEndpoint != null
            ? { isEndpoint: rawEvent.isEndpoint }
            : {}),
        };

        for (const cb of callbacks) {
          try {
            cb(event);
          } catch {
            /* swallow callback errors */
          }
        }
      }
    );
  }

  if (!textErrorSubscription) {
    textErrorSubscription = emitter.addListener(
      'pipelineLiveTextError',
      (rawEvent: { liveBufferId?: string; message?: string }) => {
        const liveBufferId = rawEvent?.liveBufferId;
        if (!liveBufferId) return;

        const callbacks = textErrorCallbacks.get(liveBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const event: LiveTextBufferErrorEvent = {
          liveBufferId,
          message: rawEvent.message ?? 'Unknown error',
        };

        for (const cb of callbacks) {
          try {
            cb(event);
          } catch {
            /* swallow callback errors */
          }
        }
      }
    );
  }

  if (!textSegmentSubscription) {
    textSegmentSubscription = emitter.addListener(
      'pipelineLiveTextSegmentAppended',
      (rawEvent: {
        liveBufferId?: string;
        bufferId?: string;
        totalSegments?: number;
        source?: string;
        segmentIndex?: number;
        utf16Length?: number;
      }) => {
        const liveBufferId = rawEvent?.liveBufferId ?? rawEvent?.bufferId;
        if (!liveBufferId) return;
        if (typeof rawEvent.segmentIndex !== 'number') return;

        const segmentIndex = Math.trunc(rawEvent.segmentIndex);
        const totalSegments =
          typeof rawEvent.totalSegments === 'number'
            ? Math.trunc(rawEvent.totalSegments)
            : segmentIndex + 1;

        dispatchLiveTextSegmentNotify({
          liveBufferId,
          segmentIndex,
          totalSegments,
          utf16Length: Math.max(0, Math.trunc(rawEvent.utf16Length ?? 0)),
          source: normalizeLiveTextPartialSource(rawEvent.source),
        });
      }
    );
  }
}

function registerLiveTextCallbacks(
  liveBufferId: string,
  callbacks: LiveTextBufferCallbacks
): () => void {
  ensureLiveTextEventSubscriptions();
  let registered = false;

  if (callbacks.onPartial) {
    let set = partialCallbacks.get(liveBufferId);
    if (!set) {
      set = new Set();
      partialCallbacks.set(liveBufferId, set);
    }
    set.add(callbacks.onPartial);
    registered = true;
  }

  if (callbacks.onError) {
    let set = textErrorCallbacks.get(liveBufferId);
    if (!set) {
      set = new Set();
      textErrorCallbacks.set(liveBufferId, set);
    }
    set.add(callbacks.onError);
    registered = true;
  }

  if (callbacks.onSegment) {
    let set = textSegmentCallbacks.get(liveBufferId);
    if (!set) {
      set = new Set();
      textSegmentCallbacks.set(liveBufferId, set);
    }
    set.add(callbacks.onSegment);
    registered = true;
  }

  return () => {
    if (!registered) return;
    if (callbacks.onPartial) {
      const set = partialCallbacks.get(liveBufferId);
      if (set) {
        set.delete(callbacks.onPartial);
        if (set.size === 0) partialCallbacks.delete(liveBufferId);
      }
    }
    if (callbacks.onError) {
      const set = textErrorCallbacks.get(liveBufferId);
      if (set) {
        set.delete(callbacks.onError);
        if (set.size === 0) textErrorCallbacks.delete(liveBufferId);
      }
    }
    if (callbacks.onSegment) {
      const set = textSegmentCallbacks.get(liveBufferId);
      if (set) {
        set.delete(callbacks.onSegment);
        if (set.size === 0) textSegmentCallbacks.delete(liveBufferId);
      }
    }
  };
}

// ==================== Offline Text Buffer ====================

/**
 * Create an empty offline text buffer as output target for offline STT.
 * Native allocates the buffer; STT materializes results into it during recognition.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native create failed.
 */
export async function createEmptyOfflineTextBuffer(): Promise<OfflineTextBufferRef> {
  const raw = await getNative().createEmptyOfflineTextBuffer();
  const info: OfflineTextBufferInfo = {
    bufferId: raw.bufferId,
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: raw.utf16Length ?? 0,
    tokenCount: raw.tokenCount ?? 0,
    timestampCount: raw.timestampCount ?? 0,
    durationCount: raw.durationCount ?? 0,
    spatialSpanCount: raw.spatialSpanCount ?? 0,
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
    hasSpatialSpans: raw.hasSpatialSpans ?? false,
  };
  return {
    info,
    bufferId: raw.bufferId as OfflineTextBufferHandle,
  };
}

/**
 * Create an offline text buffer from a live text buffer (snapshot or finalized spool equivalent).
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — live buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native create failed.
 */
export async function createOfflineTextBufferFromLive(
  liveBufferId: LiveTextBufferIdSource,
  mode: OfflineTextBufferFromLiveMode = 'fullIfSpooled'
): Promise<OfflineTextBufferRef> {
  const id = resolveLiveTextBufferId(liveBufferId);
  const raw = await getNative().createOfflineTextBufferFromLive(id, mode);
  const info: OfflineTextBufferInfo = {
    bufferId: raw.bufferId,
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: raw.utf16Length ?? 0,
    tokenCount: raw.tokenCount ?? 0,
    timestampCount: raw.timestampCount ?? 0,
    durationCount: raw.durationCount ?? 0,
    spatialSpanCount: raw.spatialSpanCount ?? 0,
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
    hasSpatialSpans: raw.hasSpatialSpans ?? false,
  };
  return {
    info,
    bufferId: raw.bufferId as OfflineTextBufferHandle,
  };
}

/**
 * Create an offline text buffer pre-populated with the given text.
 * Use as TTS input source (e.g. `tts.synthesize(textIn, audioOut)`).
 *
 * @param text - Text to populate the buffer with. Empty is allowed (TTS
 *   `phonemeCodepoints` / `tokens` ignore the text buffer contents).
 * @param options - Optional metadata: `lang`, `emotion`, `event`.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native create failed.
 */
export async function createOfflineTextBufferFromText(
  text: string,
  options?: { lang?: string; emotion?: string; event?: string }
): Promise<OfflineTextBufferRef> {
  const raw = await getNative().createOfflineTextBufferFromText(
    text,
    options ?? undefined
  );
  const info: OfflineTextBufferInfo = {
    bufferId: raw.bufferId,
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: raw.utf16Length ?? 0,
    tokenCount: raw.tokenCount ?? 0,
    timestampCount: raw.timestampCount ?? 0,
    durationCount: raw.durationCount ?? 0,
    spatialSpanCount: raw.spatialSpanCount ?? 0,
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
    hasSpatialSpans: raw.hasSpatialSpans ?? false,
  };
  return {
    info,
    bufferId: raw.bufferId as OfflineTextBufferHandle,
  };
}

// ==================== Live Text Buffer ====================

/**
 * Create a live text buffer for streaming/incremental text.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native create failed.
 */
export async function createLiveTextBuffer(
  options: CreateLiveTextBufferOptions = {}
): Promise<LiveTextBufferRef> {
  const p = options.streamEvents?.partial;
  const emitPartialEvents =
    p !== undefined ? p.enabled === true : Boolean(options.onPartial);
  const partialEventMinIntervalMs =
    p !== undefined
      ? typeof p.minIntervalMs === 'number' && Number.isFinite(p.minIntervalMs)
        ? Math.max(0, Math.trunc(p.minIntervalMs))
        : 0
      : 0;

  const raw = await getNative().createLiveTextBuffer({
    windowMaxChars: options.windowMaxChars,
    maxSegments: options.maxSegments,
    spoolingMode: options.spooling?.mode,
    spoolingPath: options.spooling?.path,
    spoolingTemporary: options.spooling?.temporary,
    spoolingThresholdBytes: options.spooling?.thresholdBytes,
    emitPartialEvents,
    partialEventMinIntervalMs,
  });

  const liveBufferId = raw.bufferId;

  const info: LiveTextBufferInfo = {
    bufferId: liveBufferId,
    kind: 'liveTextBuffer',
    state: raw.state === 'finished' ? 'finished' : 'recording',
    totalCharsWritten: raw.totalCharsWritten ?? 0,
    revision: raw.revision ?? 0,
    segmentCount: raw.segmentCount ?? 0,
    spool: mapLiveTextSpoolInfo(raw),
  };

  const segmentationMode = normalizeSegmentationMode(
    options.segmentation?.mode,
    'manual'
  );
  registerLiveTextSegmentation(liveBufferId, segmentationMode);

  if (segmentationMode === 'auto') {
    try {
      const attached = await getNative().attachSegmentationEngine(
        liveBufferId,
        'text',
        options.segmentation?.policy ?? DEFAULT_TEXT_SEGMENTATION_POLICY
      );
      registerAttachedSegmentationEngine(
        liveBufferId,
        attached.engineId,
        'text'
      );
    } catch (error) {
      await getNative()
        .releasePipelineTextBuffer(liveBufferId)
        .catch(() => {
          // Best-effort cleanup if native engine attachment fails.
        });
      throw error;
    }
  }

  const unsubscribeEvents = registerLiveTextCallbacks(liveBufferId, {
    onPartial: options.onPartial,
    onSegment: options.onSegment,
    onError: options.onError,
  });

  return {
    info,
    bufferId: liveBufferId as LiveTextBufferHandleRecording,
    unsubscribeEvents,
  };
}

/**
 * Subscribe to events for an existing live text buffer.
 * Use this to attach listeners after creation, or to attach multiple listeners to the same buffer.
 * Returns a function to unsubscribe only the listeners provided in this call.
 *
 * @param liveBufferId The live text buffer to subscribe to.
 * @param callbacks The callback functions to invoke when events occur.
 * @returns A function to remove these specific event listeners.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — id is not `txt_off_<uuid>` or `txt_live_<uuid>`.
 */
export function subscribeLiveTextBufferEvents(
  liveBufferId: LiveTextBufferIdSource,
  callbacks: LiveTextBufferCallbacks
): () => void {
  const id = resolveLiveTextBufferId(liveBufferId);
  return registerLiveTextCallbacks(id, callbacks);
}

/**
 * Create a live text buffer seeded from an offline text buffer (for UI streaming / editing).
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — offline buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native create failed.
 */
export async function createLiveTextBufferFromOffline(
  offlineBufferId: OfflineTextBufferIdSource
): Promise<LiveTextBufferRef> {
  const id = resolveOfflineTextBufferId(offlineBufferId);
  const raw = await getNative().createLiveTextBufferFromOffline(id);

  const liveBufferId = raw.bufferId;

  const info: LiveTextBufferInfo = {
    bufferId: liveBufferId,
    kind: 'liveTextBuffer',
    state: raw.state === 'finished' ? 'finished' : 'recording',
    totalCharsWritten: raw.totalCharsWritten ?? 0,
    revision: raw.revision ?? 0,
    segmentCount: raw.segmentCount ?? 0,
    spool: mapLiveTextSpoolInfo(raw),
  };

  registerLiveTextSegmentation(liveBufferId, 'manual');

  return {
    info,
    bufferId: liveBufferId as LiveTextBufferHandleRecording,
    unsubscribeEvents: () => {},
  };
}

/**
 * Finalize a live text buffer (recording → finished). No more writes allowed after this.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_ALREADY_FINALIZED` — buffer is already finished.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native finalize failed.
 */
export async function finalizeLiveTextBuffer(
  liveBufferId: LiveTextBufferRecordingSource
): Promise<LiveTextBufferHandleFinished> {
  const id = resolveLiveTextBufferId(liveBufferId);

  const segmentationMode = normalizeSegmentationMode(
    getLiveTextSegmentation(id)?.mode,
    'manual'
  );
  if (segmentationMode === 'manual') {
    const partial = await getNative().getLiveTextBufferPartialSlice(
      id,
      0,
      2_000_000_000
    );
    if (partial.length > 0) {
      await appendLiveTextSegment(id, partial, undefined, undefined, {
        __segmentReason: 'finalize',
        __segmentSource: 'manual',
        __segmentCreatedAtMs: Date.now(),
      });
      await getNative().setLiveTextBufferPartial(id, '');
    }
  }

  await getNative().finalizeLiveTextBuffer(id);
  return id as unknown as LiveTextBufferHandleFinished;
}

// ==================== Info / Release ====================

/**
 * Get metadata for any pipeline text buffer (offline or live).
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed buffer id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native info lookup failed.
 */
export async function getPipelineTextBufferInfo(
  bufferId: PipelineTextBufferIdSource
): Promise<PipelineTextBufferInfo> {
  const id = resolvePipelineTextBufferId(bufferId);
  const raw = await getNative().getPipelineTextBufferInfo(id);

  if (raw.kind === 'liveTextBuffer') {
    return {
      bufferId: raw.bufferId,
      kind: 'liveTextBuffer',
      state: raw.state === 'finished' ? 'finished' : 'recording',
      totalCharsWritten: raw.totalCharsWritten ?? 0,
      revision: raw.revision ?? 0,
      segmentCount: raw.segmentCount ?? 0,
      spool: mapLiveTextSpoolInfo(raw),
    } as LiveTextBufferInfo;
  }

  return {
    bufferId: raw.bufferId,
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: raw.utf16Length ?? 0,
    tokenCount: raw.tokenCount ?? 0,
    timestampCount: raw.timestampCount ?? 0,
    durationCount: raw.durationCount ?? 0,
    spatialSpanCount: raw.spatialSpanCount ?? 0,
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
    hasSpatialSpans: raw.hasSpatialSpans ?? false,
  } as OfflineTextBufferInfo;
}

/**
 * Release any pipeline text buffer (offline or live). Frees native memory.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed buffer id.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native release failed.
 */
export async function releasePipelineTextBuffer(
  bufferId: PipelineTextBufferIdSource
): Promise<void> {
  const id = resolvePipelineTextBufferId(bufferId);
  // Clean up JS-side callback maps
  partialCallbacks.delete(id);
  textErrorCallbacks.delete(id);
  textSegmentCallbacks.delete(id);
  textLastSegmentIndexByBuffer.delete(id);
  releaseSegmentationStateForBuffer(id);
  await getNative().releasePipelineTextBuffer(id);
}

// ==================== Offline Getters (heavy payload, slices) ====================

/**
 * Native caps each bridge read at {@link TEXT_MAX_SLICE_COUNT} UTF-16 units (or array elements).
 * These helpers issue multiple native calls and concatenate results — not exported.
 */
async function readOfflineTextSliceUsingNativeChunks(
  nativeId: string,
  startUtf16: number,
  maxUtf16: number
): Promise<string> {
  const chunkCap = TEXT_MAX_SLICE_COUNT;
  if (maxUtf16 <= chunkCap) {
    return getNative().getOfflineTextBufferTextSlice(
      nativeId,
      startUtf16,
      maxUtf16
    );
  }
  let result = '';
  let offset = startUtf16;
  let remaining = maxUtf16;
  while (remaining > 0) {
    const requestLen = Math.min(remaining, chunkCap);
    const piece = await getNative().getOfflineTextBufferTextSlice(
      nativeId,
      offset,
      requestLen
    );
    result += piece;
    const taken = piece.length;
    offset += taken;
    remaining -= taken;
    if (taken < requestLen) {
      break;
    }
  }
  return result;
}

async function readOfflineStringArraySliceUsingNativeChunks(
  readChunk: (id: string, start: number, maxCount: number) => Promise<string[]>,
  nativeId: string,
  start: number,
  maxCount: number
): Promise<string[]> {
  const chunkCap = TEXT_MAX_SLICE_COUNT;
  if (maxCount <= chunkCap) {
    return readChunk(nativeId, start, maxCount);
  }
  const result: string[] = [];
  let offset = start;
  let remaining = maxCount;
  while (remaining > 0) {
    const requestLen = Math.min(remaining, chunkCap);
    const piece = await readChunk(nativeId, offset, requestLen);
    result.push(...piece);
    const taken = piece.length;
    offset += taken;
    remaining -= taken;
    if (taken < requestLen) {
      break;
    }
  }
  return result;
}

async function readOfflineNumberArraySliceUsingNativeChunks(
  readChunk: (id: string, start: number, maxCount: number) => Promise<number[]>,
  nativeId: string,
  start: number,
  maxCount: number
): Promise<number[]> {
  const chunkCap = TEXT_MAX_SLICE_COUNT;
  if (maxCount <= chunkCap) {
    return readChunk(nativeId, start, maxCount);
  }
  const result: number[] = [];
  let offset = start;
  let remaining = maxCount;
  while (remaining > 0) {
    const requestLen = Math.min(remaining, chunkCap);
    const piece = await readChunk(nativeId, offset, requestLen);
    result.push(...piece);
    const taken = piece.length;
    offset += taken;
    remaining -= taken;
    if (taken < requestLen) {
      break;
    }
  }
  return result;
}

async function readOfflineObjectArraySliceUsingNativeChunks<T>(
  readChunk: (id: string, start: number, maxCount: number) => Promise<T[]>,
  nativeId: string,
  start: number,
  maxCount: number
): Promise<T[]> {
  const chunkCap = TEXT_MAX_SLICE_COUNT;
  if (maxCount <= chunkCap) {
    return readChunk(nativeId, start, maxCount);
  }
  const result: T[] = [];
  let offset = start;
  let remaining = maxCount;
  while (remaining > 0) {
    const requestLen = Math.min(remaining, chunkCap);
    const piece = await readChunk(nativeId, offset, requestLen);
    result.push(...piece);
    const taken = piece.length;
    offset += taken;
    remaining -= taken;
    if (taken < requestLen) {
      break;
    }
  }
  return result;
}

const SPATIAL_SPAN_LEVELS = new Set<TextSpatialSpanLevel>([
  'line',
  'word',
  'block',
]);
const SPATIAL_SPAN_ORIGINS = new Set<TextSpatialSpanOrigin>([
  'ocr',
  'textLayer',
  'markup',
]);

function mapNativeSpatialSpan(raw: {
  utf16Start: number;
  utf16End: number;
  level: string;
  sourceImageBufferId?: string;
  frameIndex: number;
  quad: number[];
  confidence?: number;
  origin: string;
  pageNumber?: number;
  ptsMs?: number;
  pageWidth?: number;
  pageHeight?: number;
  sectionIndex?: number;
  href?: string;
}): TextSpatialSpan {
  const level: TextSpatialSpanLevel = SPATIAL_SPAN_LEVELS.has(
    raw.level as TextSpatialSpanLevel
  )
    ? (raw.level as TextSpatialSpanLevel)
    : 'line';
  const origin: TextSpatialSpanOrigin = SPATIAL_SPAN_ORIGINS.has(
    raw.origin as TextSpatialSpanOrigin
  )
    ? (raw.origin as TextSpatialSpanOrigin)
    : 'ocr';
  const q = Array.isArray(raw.quad) ? raw.quad : [];
  const quad: TextSpatialSpan['quad'] = [
    Number(q[0] ?? 0),
    Number(q[1] ?? 0),
    Number(q[2] ?? 0),
    Number(q[3] ?? 0),
    Number(q[4] ?? 0),
    Number(q[5] ?? 0),
    Number(q[6] ?? 0),
    Number(q[7] ?? 0),
  ];
  const imageId = String(raw.sourceImageBufferId ?? '');
  const span: TextSpatialSpan = {
    utf16Start: Math.trunc(raw.utf16Start),
    utf16End: Math.trunc(raw.utf16End),
    level,
    frameIndex: Math.trunc(raw.frameIndex),
    quad,
    origin,
  };
  if (imageId.length > 0) {
    span.sourceImageBufferId = imageId;
  }
  if (raw.confidence != null && Number.isFinite(raw.confidence)) {
    span.confidence = raw.confidence;
  }
  if (raw.pageNumber != null && Number.isFinite(raw.pageNumber)) {
    span.pageNumber = Math.trunc(raw.pageNumber);
  }
  if (raw.ptsMs != null && Number.isFinite(raw.ptsMs)) {
    span.ptsMs = raw.ptsMs;
  }
  if (raw.pageWidth != null && Number.isFinite(raw.pageWidth)) {
    span.pageWidth = raw.pageWidth;
  }
  if (raw.pageHeight != null && Number.isFinite(raw.pageHeight)) {
    span.pageHeight = raw.pageHeight;
  }
  if (raw.sectionIndex != null && Number.isFinite(raw.sectionIndex)) {
    span.sectionIndex = Math.trunc(raw.sectionIndex);
  }
  const href = typeof raw.href === 'string' ? raw.href : '';
  if (href.length > 0) {
    span.href = href;
  }
  return span;
}

/**
 * Get a slice of the hypothesis text from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested slice exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferTextSlice(
  bufferId: OfflineTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return readOfflineTextSliceUsingNativeChunks(
    id,
    Math.trunc(startUtf16),
    Math.trunc(maxUtf16)
  );
}

/**
 * Get a slice of tokens from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested slice exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferTokensSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<string[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return readOfflineStringArraySliceUsingNativeChunks(
    (buffer, s, m) => getNative().getOfflineTextBufferTokensSlice(buffer, s, m),
    id,
    Math.trunc(start),
    Math.trunc(maxCount)
  );
}

/**
 * Get a slice of timestamps from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested slice exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferTimestampsSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return readOfflineNumberArraySliceUsingNativeChunks(
    (buffer, s, m) =>
      getNative().getOfflineTextBufferTimestampsSlice(buffer, s, m),
    id,
    Math.trunc(start),
    Math.trunc(maxCount)
  );
}

/**
 * Get a slice of durations from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested slice exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferDurationsSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return readOfflineNumberArraySliceUsingNativeChunks(
    (buffer, s, m) =>
      getNative().getOfflineTextBufferDurationsSlice(buffer, s, m),
    id,
    Math.trunc(start),
    Math.trunc(maxCount)
  );
}

/**
 * Get a slice of spatial spans from an offline text buffer (OCR / text-layer).
 * Empty when the buffer has no spatial metadata (typical for STT results).
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested slice exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferSpatialSpansSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<TextSpatialSpan[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  const raw = await readOfflineObjectArraySliceUsingNativeChunks(
    (buffer, s, m) =>
      getNative().getOfflineTextBufferSpatialSpansSlice(buffer, s, m),
    id,
    Math.trunc(start),
    Math.trunc(maxCount)
  );
  return raw.map(mapNativeSpatialSpan);
}

/**
 * Get the language string from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferLang(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferLang(id);
}

/**
 * Get the emotion string from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferEmotion(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferEmotion(id);
}

/**
 * Get the event string from an offline text buffer.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed offline id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getOfflineTextBufferEvent(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferEvent(id);
}

/**
 * Get a slice of partial text from a live text buffer (for debug/UI).
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getLiveTextBufferPartialSlice(
  liveBufferId: LiveTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string> {
  const id = resolveLiveTextBufferId(liveBufferId);
  return getNative().getLiveTextBufferPartialSlice(id, startUtf16, maxUtf16);
}

/**
 * Commit a text segment to a live text buffer segment log.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native append failed.
 */
export async function appendLiveTextSegment(
  liveBufferId: LiveTextBufferIdSource,
  text: string,
  tokens?: string[],
  timestamps?: number[],
  meta?: Record<string, unknown>
): Promise<{ segmentIndex: number }> {
  const id = resolveLiveTextBufferId(liveBufferId);
  const sanitizedMeta = sanitizeJsonMeta(meta);
  const out = await getNative().appendLiveTextSegment(
    id,
    text,
    tokens,
    timestamps,
    sanitizedMeta
  );

  // Local notify for JS-side append when native may also emit — dedupe by index.
  dispatchLiveTextSegmentNotify({
    liveBufferId: id,
    segmentIndex: out.segmentIndex,
    totalSegments: out.segmentIndex + 1,
    utf16Length: text.length,
    source: 'append',
  });

  return out;
}

/**
 * Pull the current partial window for a notify-only partial event.
 */
export async function readLiveTextPartial(
  event: LiveTextBufferPartialEvent,
  options?: { startUtf16?: number; maxUtf16?: number }
): Promise<string> {
  const startUtf16 = options?.startUtf16 ?? 0;
  const maxUtf16 =
    options?.maxUtf16 ?? Math.max(0, event.utf16Length - startUtf16);
  return getLiveTextBufferPartialSlice(
    event.liveBufferId,
    startUtf16,
    maxUtf16
  );
}

/**
 * Pull one committed segment for a notify-only segment event.
 */
export async function readLiveTextSegment(
  event: LiveTextBufferSegmentEvent,
  options?: {
    includeTokens?: boolean;
    includeTimestamps?: boolean;
    includeMeta?: boolean;
  }
): Promise<LiveTextSegment | undefined> {
  const segments = await getLiveTextBufferSegments(
    event.liveBufferId,
    event.segmentIndex,
    1,
    options
  );
  return segments[0];
}

/**
 * Map a notify event + pulled LiveTextSegment into a domain TextSegment
 * for feature facades that keep a rich onSegment product callback.
 */
export function liveTextNotifyToTextSegment(
  event: LiveTextBufferSegmentEvent,
  segment: LiveTextSegment,
  previousEndOffset = 0
): TextSegment {
  const rawMeta = segment.meta;
  const source = toSegmentSource(
    typeof rawMeta?.__segmentSource === 'string'
      ? rawMeta.__segmentSource
      : undefined,
    segment.source === 'append' ? 'manual' : 'segmentation_engine'
  );
  const reason = toSegmentReason(
    typeof rawMeta?.__segmentReason === 'string'
      ? rawMeta.__segmentReason
      : undefined,
    inferSegmentReasonFromSource(segment.source)
  );
  const createdAtMsRaw = rawMeta?.__segmentCreatedAtMs;
  const segmentIdRaw = rawMeta?.__segmentId;
  const langRaw = rawMeta?.__segmentLang;
  const utf16Length =
    event.utf16Length > 0 ? event.utf16Length : segment.text.length;

  return {
    segmentId:
      typeof segmentIdRaw === 'string' && segmentIdRaw.length > 0
        ? segmentIdRaw
        : `txtseg_${event.liveBufferId}_${event.segmentIndex}`,
    domain: 'text',
    startOffset: previousEndOffset,
    endOffset: previousEndOffset + utf16Length,
    reason,
    source,
    createdAtMs:
      typeof createdAtMsRaw === 'number' && Number.isFinite(createdAtMsRaw)
        ? Math.trunc(createdAtMsRaw)
        : Date.now(),
    segmentIndex: event.segmentIndex,
    text: segment.text,
    utf16Length,
    ...(Array.isArray(segment.tokens) ? { tokens: segment.tokens } : {}),
    ...(Array.isArray(segment.timestamps)
      ? { timestamps: segment.timestamps }
      : {}),
    ...(typeof langRaw === 'string' && langRaw.length > 0
      ? { lang: langRaw }
      : {}),
    ...(rawMeta ? { meta: rawMeta } : {}),
  };
}

/**
 * Read committed live text segments by index window.
 * tokens/timestamps are omitted by default unless explicitly requested.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_SLICE_INVALID` — start or count is out of range.
 * @throws {Error} `TEXT_SLICE_TOO_LARGE` — requested window exceeds the native cap.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native read failed.
 */
export async function getLiveTextBufferSegments(
  liveBufferId: LiveTextBufferIdSource,
  startIndex: number,
  maxCount: number,
  options?: {
    includeTokens?: boolean;
    includeTimestamps?: boolean;
    includeMeta?: boolean;
  }
): Promise<LiveTextSegment[]> {
  const id = resolveLiveTextBufferId(liveBufferId);
  const raw = await getNative().getLiveTextBufferSegments(
    id,
    startIndex,
    maxCount,
    options
  );
  return raw.segments.map((segment) => ({
    text: segment.text,
    source:
      segment.source === 'stt_stream' ||
      segment.source === 'kws_stream' ||
      segment.source === 'append' ||
      segment.source === 'replace' ||
      segment.source === 'mixed' ||
      segment.source === 'unknown'
        ? segment.source
        : 'unknown',
    segmentIndex: segment.segmentIndex,
    ...(Array.isArray(segment.tokens) ? { tokens: segment.tokens } : {}),
    ...(Array.isArray(segment.timestamps)
      ? { timestamps: segment.timestamps }
      : {}),
    ...(segment.meta != null ? { meta: sanitizeJsonMeta(segment.meta) } : {}),
  }));
}

/**
 * Return number of committed segments currently retained in the live segment log.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — malformed live id.
 * @throws {Error} `TEXT_BUFFER_NOT_FOUND` — buffer was released.
 * @throws {Error} `TEXT_INTERNAL_ERROR` — native count failed.
 */
export async function getLiveTextBufferSegmentCount(
  liveBufferId: LiveTextBufferIdSource
): Promise<number> {
  const id = resolveLiveTextBufferId(liveBufferId);
  return getNative().getLiveTextBufferSegmentCount(id);
}

// ==================== Exports ====================

export type {
  OfflineTextBufferInfo,
  OfflineTextBufferRef,
  LiveTextBufferInfo,
  LiveTextBufferRef,
  PipelineTextBufferInfo,
  OfflineTextBufferIdSource,
  LiveTextBufferIdSource,
  PipelineTextBufferIdSource,
  LiveTextBufferRecordingSource,
  OfflineTextBufferHandle,
  LiveTextBufferHandleRecording,
  LiveTextBufferHandleFinished,
  LiveTextBufferHandle,
  PipelineTextBufferHandle,
  OfflineTextBufferState,
  LiveTextBufferState,
  PipelineTextBufferKind,
  TextBufferSpoolingMode,
  TextBufferSpoolingOptions,
  LiveTextBufferSpoolInfo,
  LiveTextBufferPartialSource,
  LiveTextSegment,
  LiveTextBufferPartialEvent,
  LiveTextBufferErrorEvent,
  LiveTextBufferCallbacks,
  LiveTextBufferSegmentEvent,
  CreateLiveTextBufferOptions,
  TextSegmentationMode,
  TextSegmentationConfig,
  OfflineTextBufferFromLiveMode,
  PipelineTextErrorCodeValue,
  TextSpatialSpan,
  TextSpatialSpanLevel,
  TextSpatialSpanOrigin,
} from './types';

export type { StreamEventSpec } from '../pipeline/streamEvents';

export {
  PipelineTextErrorCode,
  TEXT_DEFAULT_SLICE_COUNT,
  TEXT_MAX_SLICE_COUNT,
} from './types';

export type {
  JsonScalar,
  JsonValue,
  SanitizeJsonMetaOptions,
} from './jsonMeta';

export {
  sanitizeJsonMeta,
  JSON_META_MAX_DEPTH,
  JSON_META_MAX_ARRAY_LENGTH,
  JSON_META_MAX_OBJECT_KEYS,
  RESERVED_SEGMENT_META_KEYS,
} from './jsonMeta';

/**
 * Resolve a text buffer source to a native buffer ID string.
 * Accepts buffer references, info objects, handles, or raw strings.
 * @throws {Error} `TEXT_INVALID_ARGUMENT` — id is not `txt_off_<uuid>` or `txt_live_<uuid>`.
 */
export { resolvePipelineTextBufferId, resolveOfflineTextBufferId };
