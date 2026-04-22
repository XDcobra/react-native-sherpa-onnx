import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { PipelineSegmentErrorCode } from './types';
import type {
  CreateEmptyOfflineSegmentBufferOptions,
  CreateLiveSegmentBufferOptions,
  LiveSegmentBufferInfo,
  LiveSegmentBufferRef,
  LiveSegmentBufferSpoolInfo,
  LiveSegmentBufferIdSource,
  LiveSegmentBufferRecordingSource,
  OfflineSegmentBufferFromLiveMode,
  OfflineSegmentBufferIdSource,
  OfflineSegmentBufferInfo,
  OfflineSegmentBufferRef,
  PipelineSegmentBufferIdSource,
  PipelineSegmentBufferInfo,
  SegmentInput,
  SegmentMeta,
  SegmentBufferSpoolingMode,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const SEGMENT_BUFFER_ID_PATTERN =
  /^(seg_off|seg_live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertValidSegmentBufferId(value: string, sourceName: string): string {
  const id = value.trim();
  if (!SEGMENT_BUFFER_ID_PATTERN.test(id)) {
    throw new Error(
      `${PipelineSegmentErrorCode.INVALID_ARGUMENT}: ${sourceName} must be a pipeline segment buffer id in the form seg_off_<uuid> or seg_live_<uuid>; received "${value}".`
    );
  }
  return id;
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

export async function createLiveSegmentBuffer(
  options: CreateLiveSegmentBufferOptions = {}
): Promise<LiveSegmentBufferRef> {
  const raw = await getNative().createLiveSegmentBuffer({
    sourceAudioBufferId: options.sourceAudioBufferId,
    maxSegments: options.maxSegments,
    spoolingMode: options.spooling?.mode,
    spoolingPath: options.spooling?.path,
    spoolingTemporary: options.spooling?.temporary,
    spoolingThresholdBytes: options.spooling?.thresholdBytes,
  });
  return {
    info: mapLiveInfo(raw),
    bufferId: raw.bufferId as LiveSegmentBufferRef['bufferId'],
  };
}

export async function createEmptyOfflineSegmentBuffer(
  options: CreateEmptyOfflineSegmentBufferOptions = {}
): Promise<OfflineSegmentBufferRef> {
  const raw = await getNative().createEmptyOfflineSegmentBuffer({
    sourceAudioBufferId: options.sourceAudioBufferId,
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
  return getNative().appendLiveSegment(
    id,
    segment.kind ?? 'speech',
    segment.sourceAudioBufferId,
    segment.startSample,
    segment.endSample,
    segment.sampleRate,
    segment.durationMs,
    segment.confidence,
    segment.payload
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
    kind: 'speech',
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
    kind: 'speech',
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
  PipelineSegmentErrorCodeValue,
} from './types';
export { PipelineSegmentErrorCode } from './types';
