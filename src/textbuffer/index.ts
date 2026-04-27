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

import { NativeEventEmitter, TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { PipelineTextErrorCode } from './types';
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
  LiveTextSegment,
  TextBufferSpoolingMode,
  LiveTextBufferSpoolInfo,
} from './types';

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

let partialSubscription: NativeSubscription | null = null;
let textErrorSubscription: NativeSubscription | null = null;

function ensureLiveTextEventSubscriptions(): void {
  if (partialSubscription && textErrorSubscription) return;

  const emitter = new NativeEventEmitter();

  if (!partialSubscription) {
    partialSubscription = emitter.addListener(
      'pipelineLiveTextPartial',
      (rawEvent: {
        liveBufferId?: string;
        source?: string;
        partialText?: string;
        revision?: number;
        isEndpoint?: boolean;
      }) => {
        const liveBufferId = rawEvent?.liveBufferId;
        if (!liveBufferId) return;

        const callbacks = partialCallbacks.get(liveBufferId);
        if (!callbacks || callbacks.size === 0) return;

        const source =
          rawEvent.source === 'stt_stream' ||
          rawEvent.source === 'append' ||
          rawEvent.source === 'replace' ||
          rawEvent.source === 'mixed' ||
          rawEvent.source === 'unknown'
            ? rawEvent.source
            : 'unknown';

        const event: LiveTextBufferPartialEvent = {
          liveBufferId,
          source,
          partialText: rawEvent.partialText ?? '',
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
  };
}

// ==================== Offline Text Buffer ====================

/**
 * Create an empty offline text buffer as output target for offline STT.
 * Native allocates the buffer; STT materializes results into it during recognition.
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
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
  };
  return {
    info,
    bufferId: raw.bufferId as OfflineTextBufferHandle,
  };
}

/**
 * Create an offline text buffer from a live text buffer (snapshot or finalized spool equivalent).
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
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
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
 * @param text - The text content to populate the buffer with (must not be empty).
 * @param options - Optional metadata: `lang`, `emotion`, `event`.
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
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
  };
  return {
    info,
    bufferId: raw.bufferId as OfflineTextBufferHandle,
  };
}

// ==================== Live Text Buffer ====================

/**
 * Create a live text buffer for streaming/incremental text.
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

  const unsubscribeEvents = registerLiveTextCallbacks(liveBufferId, {
    onPartial: options.onPartial,
    onError: options.onError,
  });

  return {
    info,
    bufferId: liveBufferId as LiveTextBufferHandleRecording,
    unsubscribeEvents,
  };
}

/**
 * Create a live text buffer seeded from an offline text buffer (for UI streaming / editing).
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

  return {
    info,
    bufferId: liveBufferId as LiveTextBufferHandleRecording,
    unsubscribeEvents: () => {},
  };
}

/**
 * Finalize a live text buffer (recording → finished). No more writes allowed after this.
 */
export async function finalizeLiveTextBuffer(
  liveBufferId: LiveTextBufferRecordingSource
): Promise<LiveTextBufferHandleFinished> {
  const id = resolveLiveTextBufferId(liveBufferId);
  await getNative().finalizeLiveTextBuffer(id);
  return id as unknown as LiveTextBufferHandleFinished;
}

// ==================== Info / Release ====================

/**
 * Get metadata for any pipeline text buffer (offline or live).
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
    hasLang: raw.hasLang ?? false,
    hasEmotion: raw.hasEmotion ?? false,
    hasEvent: raw.hasEvent ?? false,
  } as OfflineTextBufferInfo;
}

/**
 * Release any pipeline text buffer (offline or live). Frees native memory.
 */
export async function releasePipelineTextBuffer(
  bufferId: PipelineTextBufferIdSource
): Promise<void> {
  const id = resolvePipelineTextBufferId(bufferId);
  // Clean up JS-side callback maps
  partialCallbacks.delete(id);
  textErrorCallbacks.delete(id);
  await getNative().releasePipelineTextBuffer(id);
}

// ==================== Offline Getters (heavy payload, slices) ====================

/**
 * Get a slice of the hypothesis text from an offline text buffer.
 */
export async function getOfflineTextBufferTextSlice(
  bufferId: OfflineTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferTextSlice(id, startUtf16, maxUtf16);
}

/**
 * Get a slice of tokens from an offline text buffer.
 */
export async function getOfflineTextBufferTokensSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<string[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferTokensSlice(id, start, maxCount);
}

/**
 * Get a slice of timestamps from an offline text buffer.
 */
export async function getOfflineTextBufferTimestampsSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferTimestampsSlice(id, start, maxCount);
}

/**
 * Get a slice of durations from an offline text buffer.
 */
export async function getOfflineTextBufferDurationsSlice(
  bufferId: OfflineTextBufferIdSource,
  start: number,
  maxCount: number
): Promise<number[]> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferDurationsSlice(id, start, maxCount);
}

/**
 * Get the language string from an offline text buffer.
 */
export async function getOfflineTextBufferLang(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferLang(id);
}

/**
 * Get the emotion string from an offline text buffer.
 */
export async function getOfflineTextBufferEmotion(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferEmotion(id);
}

/**
 * Get the event string from an offline text buffer.
 */
export async function getOfflineTextBufferEvent(
  bufferId: OfflineTextBufferIdSource
): Promise<string> {
  const id = resolveOfflineTextBufferId(bufferId);
  return getNative().getOfflineTextBufferEvent(id);
}

/**
 * Get a slice of partial text from a live text buffer (for debug/UI).
 */
export async function getLiveTextBufferPartialSlice(
  liveBufferId: LiveTextBufferIdSource,
  startUtf16: number,
  maxUtf16: number
): Promise<string> {
  const id = resolveLiveTextBufferId(liveBufferId);
  return getNative().getLiveTextBufferPartialSlice(id, startUtf16, maxUtf16);
}

/** Commit a text segment to a live text buffer segment log. */
export async function appendLiveTextSegment(
  liveBufferId: LiveTextBufferIdSource,
  text: string,
  tokens?: string[],
  timestamps?: number[],
  meta?: Record<string, unknown>
): Promise<{ segmentIndex: number }> {
  const id = resolveLiveTextBufferId(liveBufferId);
  return getNative().appendLiveTextSegment(id, text, tokens, timestamps, meta);
}

/**
 * Read committed live text segments by index window.
 * tokens/timestamps are omitted by default unless explicitly requested.
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
    ...(segment.meta != null
      ? { meta: segment.meta as Record<string, unknown> }
      : {}),
  }));
}

/** Return number of committed segments currently retained in the live segment log. */
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
  CreateLiveTextBufferOptions,
  OfflineTextBufferFromLiveMode,
  PipelineTextErrorCodeValue,
} from './types';

export type { StreamEventSpec } from '../pipeline/streamEvents';

export {
  PipelineTextErrorCode,
  TEXT_DEFAULT_SLICE_COUNT,
  TEXT_MAX_SLICE_COUNT,
} from './types';

/**
 * Resolve a text buffer source to a native buffer ID string.
 * Accepts buffer references, info objects, handles, or raw strings.
 */
export { resolvePipelineTextBufferId, resolveOfflineTextBufferId };
