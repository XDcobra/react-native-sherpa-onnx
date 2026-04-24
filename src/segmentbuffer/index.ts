import { NativeEventEmitter, TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { PipelineSegmentErrorCode } from './types';
import type {
  AlignmentSegmentPayload,
  AlignmentGranularity,
  AlignmentTimingMode,
  CreateEmptyOfflineSegmentBufferOptions,
  CreateLiveSegmentBufferOptions,
  LiveSegmentBufferInfo,
  LiveSegmentBufferRef,
  LiveSegmentBufferSpoolInfo,
  LiveSegmentBufferIdSource,
  LiveSegmentBufferRecordingSource,
  LiveSegmentBufferErrorEvent,
  LiveSegmentBufferSegmentAppendedEvent,
  OfflineSegmentBufferFromLiveMode,
  OfflineSegmentBufferIdSource,
  OfflineSegmentBufferInfo,
  OfflineSegmentBufferRef,
  PipelineSegmentBufferIdSource,
  PipelineSegmentBufferInfo,
  SegmentInput,
  SegmentMeta,
  SegmentKind,
  SegmentBufferSpoolingMode,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const SEGMENT_BUFFER_ID_PATTERN =
  /^(seg_off|seg_live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SEGMENT_KIND_VALUES = new Set<SegmentKind>(['speech', 'alignment']);
const ALIGNMENT_TIMING_MODE_VALUES = new Set<AlignmentTimingMode>([
  'proportional',
  'estimated',
  'accurate',
  'vad',
]);
const ALIGNMENT_GRANULARITY_VALUES = new Set<AlignmentGranularity>([
  'sentence',
  'word',
  'character',
]);
const ALIGNMENT_PAYLOAD_ALLOWED_KEYS = new Set([
  'text',
  'timingMode',
  'granularity',
  'confidence',
  'tokenMetadata',
  'wordMetadata',
  'languageHints',
]);

function assertValidSegmentBufferId(value: string, sourceName: string): string {
  const id = value.trim();
  if (!SEGMENT_BUFFER_ID_PATTERN.test(id)) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName} must be a pipeline segment buffer id in the form seg_off_<uuid> or seg_live_<uuid>; received "${value}".`
    );
  }
  return id;
}

function assertValidSegmentKind(
  value: unknown,
  sourceName: string
): SegmentKind {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (SEGMENT_KIND_VALUES.has(kind as SegmentKind)) return kind as SegmentKind;
  throw new Error(
    `${
      PipelineSegmentErrorCode.INVALID_ARGUMENT
    }: ${sourceName} must be one of "speech" or "alignment"; received "${String(
      value
    )}".`
  );
}

function assertAlignmentPayload(
  payload: unknown,
  sourceName: string
): AlignmentSegmentPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName} must be an object for alignment segments.`
    );
  }
  const obj = payload as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALIGNMENT_PAYLOAD_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.${key} is not allowed for alignment payloads.`
      );
    }
  }
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (text.length === 0) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.text must be a non-empty string.`
    );
  }
  if (
    !ALIGNMENT_TIMING_MODE_VALUES.has(obj.timingMode as AlignmentTimingMode)
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.timingMode must be one of proportional, estimated, accurate, vad.`
    );
  }
  if (
    !ALIGNMENT_GRANULARITY_VALUES.has(obj.granularity as AlignmentGranularity)
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.granularity must be one of sentence, word, character.`
    );
  }
  if (
    obj.confidence !== undefined &&
    (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence))
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.confidence must be a finite number when provided.`
    );
  }
  if (
    obj.tokenMetadata !== undefined &&
    (typeof obj.tokenMetadata !== 'object' ||
      obj.tokenMetadata === null ||
      Array.isArray(obj.tokenMetadata))
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.tokenMetadata must be an object when provided.`
    );
  }
  if (
    obj.wordMetadata !== undefined &&
    (typeof obj.wordMetadata !== 'object' ||
      obj.wordMetadata === null ||
      Array.isArray(obj.wordMetadata))
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.wordMetadata must be an object when provided.`
    );
  }
  if (obj.languageHints !== undefined) {
    if (!Array.isArray(obj.languageHints)) {
      throw new Error(
        `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.languageHints must be an array of strings when provided.`
      );
    }
    if (!obj.languageHints.every((it) => typeof it === 'string' && it.trim())) {
      throw new Error(
        `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName}.languageHints must only contain non-empty strings.`
      );
    }
  }
  return obj as unknown as AlignmentSegmentPayload;
}

function assertValidSegmentInput(segment: SegmentInput): {
  kind: SegmentKind;
  payload?: Record<string, unknown> | AlignmentSegmentPayload;
} {
  const kind = assertValidSegmentKind(segment.kind ?? 'speech', 'segment.kind');
  if (kind === 'alignment') {
    return {
      kind,
      payload: assertAlignmentPayload(segment.payload, 'segment.payload'),
    };
  }
  if (
    segment.payload !== undefined &&
    (typeof segment.payload !== 'object' ||
      segment.payload === null ||
      Array.isArray(segment.payload))
  ) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: segment.payload must be an object when provided.`
    );
  }
  return {
    kind,
    payload: segment.payload as Record<string, unknown> | undefined,
  };
}

function normalizeSpoolingMode(value: unknown): SegmentBufferSpoolingMode {
  if (value === 'off' || value === 'auto' || value === 'on') return value;
  return 'off';
}

function mapSpoolInfo(raw: {
  spoolMode?: string;
  spoolEnabled?: boolean;
  spoolReady?: boolean;
  spoolBytes?: number;
  spoolPath?: string;
}): LiveSegmentBufferSpoolInfo {
  const mode = normalizeSpoolingMode(raw.spoolMode);
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

function mapOfflineInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  segmentCount?: number;
  sourceAudioBufferId?: string;
}): OfflineSegmentBufferInfo {
  return {
    bufferId: raw.bufferId,
    kind: 'offlineSegmentBuffer',
    state: 'immutable',
    segmentCount: raw.segmentCount ?? 0,
    ...(typeof raw.sourceAudioBufferId === 'string' &&
    raw.sourceAudioBufferId.length > 0
      ? { sourceAudioBufferId: raw.sourceAudioBufferId }
      : {}),
  };
}

function mapLiveInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  segmentCount?: number;
  totalSegmentsWritten?: number;
  spoolMode?: string;
  spoolEnabled?: boolean;
  spoolReady?: boolean;
  spoolBytes?: number;
  spoolPath?: string;
}): LiveSegmentBufferInfo {
  return {
    bufferId: raw.bufferId,
    kind: 'liveSegmentBuffer',
    state: raw.state === 'finished' ? 'finished' : 'recording',
    segmentCount: raw.segmentCount ?? 0,
    totalSegmentsWritten: raw.totalSegmentsWritten ?? 0,
    spool: mapSpoolInfo(raw),
  };
}

function mapPipelineInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  segmentCount?: number;
  sourceAudioBufferId?: string;
  totalSegmentsWritten?: number;
  spoolMode?: string;
  spoolEnabled?: boolean;
  spoolReady?: boolean;
  spoolBytes?: number;
  spoolPath?: string;
}): PipelineSegmentBufferInfo {
  if (raw.kind === 'liveSegmentBuffer') return mapLiveInfo(raw);
  return mapOfflineInfo(raw);
}

export function resolveOfflineSegmentBufferId(
  source: OfflineSegmentBufferIdSource
): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidSegmentBufferId(
      String((source as OfflineSegmentBufferRef).bufferId),
      'offline segment buffer source'
    );
  }
  return assertValidSegmentBufferId(
    String(source),
    'offline segment buffer source'
  );
}

export function resolveLiveSegmentBufferId(
  source: LiveSegmentBufferIdSource
): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return assertValidSegmentBufferId(
      String((source as LiveSegmentBufferRef).bufferId),
      'live segment buffer source'
    );
  }
  return assertValidSegmentBufferId(
    String(source),
    'live segment buffer source'
  );
}

export function resolvePipelineSegmentBufferId(
  source: PipelineSegmentBufferIdSource
): string {
  if (typeof source === 'object' && source !== null) {
    if ('info' in source) {
      return assertValidSegmentBufferId(
        String(
          (source as LiveSegmentBufferRef | OfflineSegmentBufferRef).bufferId
        ),
        'pipeline segment buffer source'
      );
    }
    if ('kind' in source && 'bufferId' in source) {
      return assertValidSegmentBufferId(
        String((source as PipelineSegmentBufferInfo).bufferId),
        'pipeline segment buffer source'
      );
    }
  }
  return assertValidSegmentBufferId(
    String(source),
    'pipeline segment buffer source'
  );
}

type NativeSubscription = { remove: () => void };

const segmentAppendedCallbacks = new Map<
  string,
  Set<(event: LiveSegmentBufferSegmentAppendedEvent) => void>
>();
const segmentErrorCallbacks = new Map<
  string,
  Set<(event: LiveSegmentBufferErrorEvent) => void>
>();

let segmentAppendedSub: NativeSubscription | null = null;
let segmentErrorSub: NativeSubscription | null = null;

function ensureLiveSegmentEventSubscriptions(): void {
  if (segmentAppendedSub && segmentErrorSub) return;
  const emitter = new NativeEventEmitter();

  if (!segmentAppendedSub) {
    segmentAppendedSub = emitter.addListener(
      'pipelineLiveSegmentAppended',
      (raw: {
        liveBufferId?: string;
        segmentId?: string;
        segmentIndex?: number;
        sourceAudioBufferId?: string;
        kind?: string;
        startSample?: number;
        endSample?: number;
        sampleRate?: number;
        durationMs?: number;
        confidence?: number;
        payload?: Record<string, unknown>;
      }) => {
        const liveBufferId = raw?.liveBufferId;
        if (!liveBufferId) return;
        const cbs = segmentAppendedCallbacks.get(liveBufferId);
        if (!cbs || cbs.size === 0) return;
        const event: LiveSegmentBufferSegmentAppendedEvent = {
          liveBufferId,
          segmentId: typeof raw.segmentId === 'string' ? raw.segmentId : '',
          segmentIndex:
            typeof raw.segmentIndex === 'number'
              ? Math.trunc(raw.segmentIndex)
              : 0,
          kind: assertValidSegmentKind(raw.kind ?? 'speech', 'event.kind'),
          sourceAudioBufferId:
            typeof raw.sourceAudioBufferId === 'string'
              ? raw.sourceAudioBufferId
              : '',
          startSample:
            typeof raw.startSample === 'number'
              ? Math.trunc(raw.startSample)
              : 0,
          endSample:
            typeof raw.endSample === 'number' ? Math.trunc(raw.endSample) : 0,
          sampleRate:
            typeof raw.sampleRate === 'number' ? Math.trunc(raw.sampleRate) : 0,
          durationMs:
            typeof raw.durationMs === 'number' ? Math.trunc(raw.durationMs) : 0,
          ...(typeof raw.confidence === 'number'
            ? { confidence: raw.confidence }
            : {}),
          ...(raw.payload && typeof raw.payload === 'object'
            ? { payload: raw.payload }
            : {}),
        };
        for (const cb of cbs) {
          cb(event);
        }
      }
    );
  }

  if (!segmentErrorSub) {
    segmentErrorSub = emitter.addListener(
      'pipelineLiveSegmentError',
      (raw: { liveBufferId?: string; message?: string }) => {
        const id = raw?.liveBufferId;
        if (typeof id !== 'string' || id.length === 0) return;
        const cbs = segmentErrorCallbacks.get(id);
        if (!cbs || cbs.size === 0) return;
        const e: LiveSegmentBufferErrorEvent = {
          liveBufferId: id,
          message: raw?.message ?? 'Unknown live segment buffer error',
        };
        for (const cb of cbs) cb(e);
      }
    );
  }
}

function registerLiveSegmentBufferCallbacks(
  liveBufferId: string,
  callbacks: {
    onSegmentAppended?: (event: LiveSegmentBufferSegmentAppendedEvent) => void;
    onError?: (event: LiveSegmentBufferErrorEvent) => void;
  }
): () => void {
  if (callbacks.onSegmentAppended) {
    ensureLiveSegmentEventSubscriptions();
    let set = segmentAppendedCallbacks.get(liveBufferId);
    if (!set) {
      set = new Set();
      segmentAppendedCallbacks.set(liveBufferId, set);
    }
    set.add(callbacks.onSegmentAppended);
  }
  if (callbacks.onError) {
    ensureLiveSegmentEventSubscriptions();
    let setE = segmentErrorCallbacks.get(liveBufferId);
    if (!setE) {
      setE = new Set();
      segmentErrorCallbacks.set(liveBufferId, setE);
    }
    setE.add(callbacks.onError);
  }
  return () => {
    if (callbacks.onSegmentAppended) {
      const set = segmentAppendedCallbacks.get(liveBufferId);
      if (set) {
        set.delete(callbacks.onSegmentAppended);
        if (set.size === 0) segmentAppendedCallbacks.delete(liveBufferId);
      }
    }
    if (callbacks.onError) {
      const setE = segmentErrorCallbacks.get(liveBufferId);
      if (setE) {
        setE.delete(callbacks.onError);
        if (setE.size === 0) segmentErrorCallbacks.delete(liveBufferId);
      }
    }
  };
}

export async function createLiveSegmentBuffer(
  options: CreateLiveSegmentBufferOptions = {}
): Promise<LiveSegmentBufferRef> {
  const sa = options.streamEvents?.segmentAppended;
  const emitSegmentAppendedEvents =
    sa !== undefined ? sa.enabled === true : Boolean(options.onSegmentAppended);
  const segmentEventMinIntervalMs =
    sa !== undefined
      ? typeof sa.minIntervalMs === 'number' &&
        Number.isFinite(sa.minIntervalMs)
        ? Math.max(0, Math.trunc(sa.minIntervalMs))
        : 0
      : 0;

  const sourceAudioBufferId =
    options.sourceAudioBufferId !== undefined
      ? resolvePipelineAudioBufferId(options.sourceAudioBufferId)
      : undefined;

  const raw = await getNative().createLiveSegmentBuffer({
    sourceAudioBufferId,
    maxSegments: options.maxSegments,
    spoolingMode: options.spooling?.mode,
    spoolingPath: options.spooling?.path,
    spoolingTemporary: options.spooling?.temporary,
    spoolingThresholdBytes: options.spooling?.thresholdBytes,
    emitSegmentAppendedEvents,
    segmentEventMinIntervalMs,
  });

  const liveBufferId = raw.bufferId as string;

  const unsubscribeEvents = registerLiveSegmentBufferCallbacks(liveBufferId, {
    onSegmentAppended: options.onSegmentAppended,
    onError: options.onError,
  });

  return {
    info: mapLiveInfo(raw),
    bufferId: raw.bufferId as LiveSegmentBufferRef['bufferId'],
    unsubscribeEvents,
  };
}

export async function createEmptyOfflineSegmentBuffer(
  options: CreateEmptyOfflineSegmentBufferOptions = {}
): Promise<OfflineSegmentBufferRef> {
  const sourceAudioBufferId =
    options.sourceAudioBufferId !== undefined
      ? resolvePipelineAudioBufferId(options.sourceAudioBufferId)
      : undefined;

  const raw = await getNative().createEmptyOfflineSegmentBuffer({
    sourceAudioBufferId,
  });
  return {
    info: mapOfflineInfo(raw),
    bufferId: raw.bufferId as OfflineSegmentBufferRef['bufferId'],
  };
}

export async function appendLiveSegment(
  buffer: LiveSegmentBufferRecordingSource,
  segment: SegmentInput
): Promise<{ segmentId: string; segmentIndex: number }> {
  const id =
    typeof buffer === 'object' && buffer !== null && 'info' in buffer
      ? resolveLiveSegmentBufferId(buffer as LiveSegmentBufferRef)
      : assertValidSegmentBufferId(
          String(buffer),
          'live segment buffer recording source'
        );
  const sourceAudioBufferId = resolvePipelineAudioBufferId(
    segment.sourceAudioBufferId
  );

  const normalized = assertValidSegmentInput(segment);
  return getNative().appendLiveSegment(
    id,
    normalized.kind,
    sourceAudioBufferId,
    segment.startSample,
    segment.endSample,
    segment.sampleRate,
    segment.durationMs,
    segment.confidence,
    normalized.payload
  );
}

export async function finalizeLiveSegmentBuffer(
  buffer: LiveSegmentBufferRecordingSource
): Promise<void> {
  const id =
    typeof buffer === 'object' && buffer !== null && 'info' in buffer
      ? resolveLiveSegmentBufferId(buffer as LiveSegmentBufferRef)
      : assertValidSegmentBufferId(
          String(buffer),
          'live segment buffer recording source'
        );
  await getNative().finalizeLiveSegmentBuffer(id);
}

export async function createOfflineSegmentBufferFromLive(
  liveBuffer: LiveSegmentBufferIdSource,
  mode: OfflineSegmentBufferFromLiveMode = 'fullIfSpooled'
): Promise<OfflineSegmentBufferRef> {
  const id = resolveLiveSegmentBufferId(liveBuffer);
  const raw = await getNative().createOfflineSegmentBufferFromLive(id, mode);
  return {
    info: mapOfflineInfo(raw),
    bufferId: raw.bufferId as OfflineSegmentBufferRef['bufferId'],
  };
}

export async function getPipelineSegmentBufferInfo(
  buffer: PipelineSegmentBufferIdSource
): Promise<PipelineSegmentBufferInfo> {
  const id = resolvePipelineSegmentBufferId(buffer);
  const raw = await getNative().getPipelineSegmentBufferInfo(id);
  return mapPipelineInfo(raw);
}

export async function getOfflineSegmentBufferSegments(
  buffer: OfflineSegmentBufferIdSource,
  start = 0,
  maxCount = 1024
): Promise<SegmentMeta[]> {
  const id = resolveOfflineSegmentBufferId(buffer);
  const raw = await getNative().getOfflineSegmentBufferSegments(
    id,
    start,
    maxCount
  );
  return raw.segments.map((segment) => ({
    id: segment.id,
    kind: assertValidSegmentKind(segment.kind, 'segment.kind'),
    sourceAudioBufferId: segment.sourceAudioBufferId,
    startSample: segment.startSample,
    endSample: segment.endSample,
    sampleRate: segment.sampleRate,
    durationMs: segment.durationMs,
    ...(segment.confidence != null ? { confidence: segment.confidence } : {}),
    ...(segment.payload != null
      ? { payload: segment.payload as unknown as Record<string, unknown> }
      : {}),
  }));
}

export async function getLiveSegmentBufferSegments(
  liveBuffer: LiveSegmentBufferIdSource,
  startIndex: number,
  maxCount: number
): Promise<SegmentMeta[]> {
  const id = resolveLiveSegmentBufferId(liveBuffer);
  const raw = await getNative().getLiveSegmentBufferSegments(
    id,
    startIndex,
    maxCount
  );
  return raw.segments.map((segment) => ({
    id: segment.id,
    kind: assertValidSegmentKind(segment.kind, 'segment.kind'),
    sourceAudioBufferId: segment.sourceAudioBufferId,
    startSample: segment.startSample,
    endSample: segment.endSample,
    sampleRate: segment.sampleRate,
    durationMs: segment.durationMs,
    ...(segment.confidence != null ? { confidence: segment.confidence } : {}),
    ...(segment.payload != null
      ? { payload: segment.payload as unknown as Record<string, unknown> }
      : {}),
  }));
}

export async function getLiveSegmentBufferSegmentCount(
  liveBuffer: LiveSegmentBufferIdSource
): Promise<number> {
  const id = resolveLiveSegmentBufferId(liveBuffer);
  return getNative().getLiveSegmentBufferSegmentCount(id);
}

export async function releasePipelineSegmentBuffer(
  buffer: PipelineSegmentBufferIdSource
): Promise<void> {
  const id = resolvePipelineSegmentBufferId(buffer);
  await getNative().releasePipelineSegmentBuffer(id);
}

export type {
  AlignmentTimingMode,
  AlignmentGranularity,
  AlignmentSegmentPayload,
  PipelineSegmentBufferKind,
  SegmentKind,
  SegmentMeta,
  SegmentInput,
  SegmentBufferSpoolingMode,
  SegmentBufferSpoolingOptions,
  LiveSegmentBufferSpoolInfo,
  OfflineSegmentBufferState,
  LiveSegmentBufferState,
  OfflineSegmentBufferInfo,
  LiveSegmentBufferInfo,
  PipelineSegmentBufferInfo,
  OfflineSegmentBufferHandle,
  LiveSegmentBufferHandleRecording,
  LiveSegmentBufferHandleFinished,
  LiveSegmentBufferHandle,
  OfflineSegmentBufferRef,
  LiveSegmentBufferRef,
  OfflineSegmentBufferIdSource,
  LiveSegmentBufferIdSource,
  PipelineSegmentBufferIdSource,
  LiveSegmentBufferRecordingSource,
  OfflineSegmentBufferFromLiveMode,
  CreateLiveSegmentBufferOptions,
  CreateEmptyOfflineSegmentBufferOptions,
  LiveSegmentBufferSegmentAppendedEvent,
  LiveSegmentBufferErrorEvent,
  PipelineSegmentErrorCodeValue,
} from './types';
export { PipelineSegmentErrorCode } from './types';
export type { StreamEventSpec } from '../pipeline/streamEvents';
